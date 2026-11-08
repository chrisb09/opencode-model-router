import type { Account, Candidate, CatalogModel, Family, ModelRef, Policy, Preference, Task } from "./types.ts"

export function parseModel(value: string): ModelRef {
  const match = /^([^/#]+)\/([^#]+)(?:#([^#]+))?$/.exec(value)
  if (!match) throw new Error("Invalid provider/model#variant reference")
  return { providerID: match[1], id: match[2], ...(match[3] ? { variant: match[3] } : {}) }
}
export const modelString = (r: ModelRef) => `${r.providerID}/${r.id}${r.variant ? `#${r.variant}` : ""}`
export function familyOf(model: string): Family {
  const id = model.toLowerCase()
  if (id.includes("gemini")) return "gemini"
  if (id.includes("deepseek")) return "deepseek"
  if (id.includes("gpt-6.1-sol")) return "sol"
  if (id.includes("kimi")) return "kimi"
  if (id.includes("opus")) return "opus"
  if (id.includes("glm")) return "glm"
  if (id.includes("mistral")) return "mistral"
  return "unknown"
}
export function taskErrors(t: Task): string[] {
  const errors: string[] = []
  if (!["plan", "build"].includes(t.parentAgent)) errors.push("Only Plan/Build coordinators can delegate")
  if (t.parentAgent === "plan" && t.role === "general") errors.push("Plan cannot delegate to write-capable general")
  if (t.role === "critic" && (!t.originModel || familyOf(t.originModel) === "unknown")) errors.push("Critic requires recognized original model provenance")
  if (!Number.isSafeInteger(t.inputTokens) || t.inputTokens < 0) errors.push("Invalid input token estimate")
  return errors
}

/** Pure deterministic eligibility/ranking. No credential lookup or LLM calls. */
export function recommend(policy: Policy, task: Task, models: CatalogModel[], accounts: Account[], now: number,
  pressure: (key: string, window: string, checkedAt: number) => number = () => 0,
  concurrency: (key: string) => number = () => 0,
  cooldown: (key: string, model: string) => number = () => 0,
  totalConcurrency: () => number = () => 0): { candidates: Candidate[]; errors: string[] } {
  const errors = taskErrors(task)
  if (errors.length) return { candidates: [], errors }
  // Nested arrays are same-rank groups: interchangeable models whose shared
  // preference rank is decided by quota pace rather than list order.
  const entries: Preference[] = task.requestedModel ? [task.requestedModel] : [...policy.roles[task.role][task.tier], ...policy.fallbacks[task.tier]]
  const refs: Array<{ name: string; rank: number }> = []
  const seen = new Set<string>()
  for (const [rank, entry] of entries.entries()) for (const alias of Array.isArray(entry) ? entry : [entry]) {
    const name = policy.aliases[alias] ?? alias
    if (seen.has(name)) continue
    seen.add(name)
    refs.push({ name, rank })
  }
  const candidates: Candidate[] = []
  for (const { name, rank } of refs) {
    const ref = parseModel(name)
    const family = familyOf(name)
    const model = models.find(m => m.providerID === ref.providerID && m.id === ref.id)
    const matching = accounts.filter(a => a.providerID === ref.providerID && (!task.accountKey || a.key === task.accountKey))
    const pinnedMissing = Boolean(task.accountKey && matching.length === 0)
    for (const account of matching.length ? matching : [{ key: `missing:${ref.providerID}`, providerID: ref.providerID, label: "Unavailable", credentialID: "", active: false, error: null, windows: [] }]) {
      const rejected: string[] = []
      const reasons = [`${task.role}/${task.tier} preference ${rank + 1}`]
      if (pinnedMissing) rejected.push("Requested test account unavailable")
      if (!model?.enabled) rejected.push("Model unavailable in caller location")
      if (ref.variant && !model?.variants.some(v => v.id === ref.variant)) rejected.push("Unsupported reasoning variant")
      // An allowlist prevents aliases, explicit overrides and future catalog
      // additions from turning a subscription fallback into an unapproved API call.
      const allowed = new Set(Object.values(policy.aliases))
      if (!allowed.has(name)) rejected.push("Model/variant not on routing allowlist")
      if (!["antigravity", "opencode-go", "openai", "mistral", ...(policy.allowPaid ? ["oneprovider"] : [])].includes(ref.providerID)) rejected.push("Paid or unverified provider dispatch locked")
      if (family === "opus" && !policy.allowPaid) rejected.push("Paid dispatch locked: per-physical-request paid transport not enabled")
      if (family === "kimi" && !policy.allowKimi) rejected.push("Kimi dispatch locked: separate allowance not configured")
      if (family === "sol" && !["medium", "high"].includes(ref.variant ?? "")) rejected.push("Sol requires medium/high")
      if (task.role === "critic" && family === familyOf(task.originModel!)) rejected.push("Not an independent model family")
      if (!account.active || !account.credentialID) rejected.push("Account not bound to an available credential")
      if (account.error) rejected.push("Quota source reports account error")
      if (!account.windows.length) rejected.push("Unknown quota windows")
      const outputTokens = task.outputTokens ?? policy.outputTokens[task.tier]
      if (!Number.isSafeInteger(outputTokens) || outputTokens <= 0) rejected.push("Invalid output token budget")
      const input = task.inputTokens + 8192 // instructions/tools/context-estimation headroom
      if (model) {
        if (["openai", "opencode-go", "mistral"].includes(ref.providerID) && model.package?.startsWith("aisdk:")) rejected.push("Custom AI SDK transport for a native subscription provider is not supported")
        if (!model.capabilities.tools || !model.capabilities.output.includes("text")) rejected.push("Required capabilities missing")
        if (task.modalities.some(m => !model.capabilities.input.includes(m))) rejected.push("Unsupported input modality")
        if (input > Math.min(model.limit.input ?? Infinity, model.limit.context - outputTokens) || outputTokens > model.limit.output) rejected.push("Insufficient usable context/output capacity")
      }
      const estimatedRequestPp = Math.min(100, (policy.quota.estimatedRequestPp[ref.providerID] ?? 100) * Math.max(1, (task.inputTokens + 8192 + outputTokens) / 50000))
      // Pace compares available quota against the pro-rata expectation for the
      // time left in each window: an account ahead of its monthly progression
      // wins same-rank ties so quota that would otherwise be forfeited at reset
      // is spent first. Windows without a published duration fall back to raw
      // availability. The cap keeps policy rank dominant over quota abundance.
      let pace = Infinity
      for (const w of account.windows) {
        const available = w.remainingPct === null ? null : w.remainingPct - pressure(account.key, w.key, w.checkedAt)
        if (w.source !== "provider" || available === null || !Number.isFinite(available)) rejected.push(`Unknown quota: ${w.key}`)
        else {
          let windowPace = available
          if (w.durationMs && w.resetAt) {
            const fraction = Math.min(1, Math.max(0.1, (Date.parse(w.resetAt) - now) / w.durationMs))
            windowPace = available / fraction
          }
          pace = Math.min(pace, Math.min(500, windowPace))
          const floor = task.importance === "critical" ? policy.quota.hardReservePp : Math.max(policy.quota.hardReservePp, policy.quota.softReservePp[ref.providerID] ?? 0)
          if (available - estimatedRequestPp < floor) rejected.push(`Quota reserve reached: ${w.key}`)
        }
        if (!Number.isFinite(w.checkedAt) || now - w.checkedAt > policy.quota.maxAgeMs) rejected.push(`Stale quota: ${w.key}`)
        if (w.checkedAt > now) rejected.push(`Future-dated quota: ${w.key}`)
        if (w.resetAt && Date.parse(w.resetAt) <= now) rejected.push(`Quota reset requires fresh observation: ${w.key}`)
        if (w.expiresAt && Date.parse(w.expiresAt) <= now) rejected.push(`Credits expired: ${w.key}`)
      }
      if (!Number.isFinite(pace)) pace = 0
      if (pace > 100) reasons.push("Quota ahead of window progression")
      if (concurrency(account.key) >= (policy.quota.maxConcurrentPerAccount[ref.providerID] ?? 1)) rejected.push("Concurrent account capacity reserved")
      if (policy.quota.maxConcurrentTotal && totalConcurrency() >= policy.quota.maxConcurrentTotal) rejected.push("Concurrent total capacity reached")
      if (cooldown(account.key, `${ref.providerID}/${ref.id}`) > now) rejected.push("Rate-limit/provider cooldown")
      const preferredCritic = task.role === "critic" && family === policy.criticPreferences[familyOf(task.originModel!)]
      // Policy order dominates quota abundance; critic family preference is explicit.
      const score = (preferredCritic ? 100_000 : 0) - rank * 1000 + pace
      if (preferredCritic) reasons.push("Preferred independent critic family")
      reasons.push("All applicable windows checked separately", "Quota reservation is a conservative estimate, not provider token capacity")
      candidates.push({ model: name, ref, family, account, outputTokens, estimatedRequestPp, score, reasons, rejected: [...new Set(rejected)] })
    }
  }
  return { candidates: candidates.sort((a, b) => Number(a.rejected.length > 0) - Number(b.rejected.length > 0) || b.score - a.score || a.account.key.localeCompare(b.account.key)), errors }
}
