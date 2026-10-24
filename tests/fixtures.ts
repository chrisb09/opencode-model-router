import { defaultPolicy } from "../src/config.ts"
import { parseModel } from "../src/policy.ts"
import type { Account, CatalogModel, Task } from "../src/types.ts"
import type { Binding, CollectorSnapshot } from "../src/collector.ts"
import { credentialFingerprint } from "../src/identity.ts"

export const now = Date.now()
export const task = (patch: Partial<Task> = {}): Task => ({ role: "explore", tier: "DEFAULT", importance: "normal", parentAgent: "build", parentSessionID: "ses_parent", directory: "/test", inputTokens: 1000, modalities: ["text"], ...patch })
export const models = (): CatalogModel[] => [...new Set(Object.values(defaultPolicy().aliases).map(s => s.split("#")[0]))].map(name => {
  const ref = parseModel(name)
  return { ...ref, enabled: true, limit: ref.providerID === "openai" ? { context: 628000, input: 500000, output: 128000 } : { context: 1000000, output: 65536 },
    variants: (ref.providerID === "oneprovider" ? [] : ["low", "medium", "high", "max", "xhigh"]).map(id => ({ id })), capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, cost: [] }
})
export const jwt = (account = "test-account") => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.test-signature`
export const bindings = (secret?: string): Binding[] => [
  { providerID: "antigravity", credentialID: "cred_a", label: "a@example.com", accountKey: "google:a@example.com", method: "oauth" },
  { providerID: "antigravity", credentialID: "cred_b", label: "b@example.com", accountKey: "google:b@example.com", method: "oauth" },
  { providerID: "opencode-go", credentialID: "cred_go", label: "Go", accountKey: "opencode-go:default", method: "key" },
  { providerID: "openai", credentialID: "cred_sol", label: "Codex", accountKey: "codex:default", method: "oauth" },
  { providerID: "oneprovider", credentialID: "cred_opus", label: "OneProvider", accountKey: "oneprovider:default", method: "key" },
].map(b => ({ ...b, ...(secret ? { credentialFingerprint: credentialFingerprint(b.providerID, b.providerID === "openai" ? { type: "oauth", access: jwt() } : { type: "key", key: "test-go-key" }, secret) } : {}) }))
export const accounts = (): Account[] => bindings().map(b => ({ key: b.accountKey, providerID: b.providerID, credentialID: b.credentialID, label: b.label, active: true, error: null,
  windows: (b.providerID === "antigravity" ? ["gemini-5h", "gemini-weekly"] : b.providerID === "openai" ? ["codex-5h", "codex-weekly"] : b.providerID === "opencode-go" ? ["opencode-go-5h", "opencode-go-weekly", "opencode-go-monthly"] : ["oneprovider"]).map(key => ({ key, checkedAt: now, remainingPct: 90, resetAt: new Date(now + 86400000).toISOString(), source: "provider" as const })) }))
export const snapshot = (): CollectorSnapshot => ({ serverTime: new Date(now).toISOString(), accounts: accounts().map(a => ({ accountKey: a.key, active: true, lastSuccessAt: new Date(now).toISOString(), lastError: null, quotas: a.windows.map(w => ({ key: w.key, remaining: w.remainingPct! / 100, resetAt: w.resetAt, raw: { usedPercent: 10, usedMicroCents: 10, limitMicroCents: 100 } })) })) })
