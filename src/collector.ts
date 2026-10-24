import { readFile } from "node:fs/promises"
import type { Settings } from "./config.ts"
import type { Account, QuotaWindow } from "./types.ts"

export interface Binding { providerID: string; credentialID: string; label: string; accountKey: string; method: string; credentialFingerprint?: string; integrationID?: string; workspaceID?: string; authorizationFingerprint?: string; authorizationHistory?: Array<{ fingerprint: string; until: number }> }
export interface CollectorSnapshot { serverTime: string; accounts: any[] }

/** Normalize raw /api/usage, not rounded dashboard aggregates or MCP display rows. */
export function normalize(snapshot: CollectorSnapshot, bindings: Binding[]): Account[] {
  return bindings.map(binding => {
    const account = snapshot.accounts.find(a => a.accountKey === binding.accountKey)
    const keys = binding.providerID === "antigravity" ? ["gemini-5h", "gemini-weekly"]
      : binding.providerID === "openai" ? ["codex-5h", "codex-weekly"]
      : binding.providerID === "opencode-go" ? ["opencode-go-5h", "opencode-go-weekly", "opencode-go-monthly"]
      : ["oneprovider"]
    const windows: QuotaWindow[] = keys.map(key => {
      const q = account?.quotas?.find((q: any) => q.key === key)
      const checkedAt = Date.parse(account?.lastSuccessAt ?? "")
      let remainingPct = typeof q?.remaining === "number" && Number.isFinite(q.remaining) && q.remaining >= 0 && q.remaining <= 1 ? q.remaining * 100 : null
      // Go and Codex older collectors defaulted missing usage to zero. Raw fields
      // are required here; normalized display percentages are not sufficient.
      if (binding.providerID === "opencode-go" && !(typeof q?.raw?.usedMicroCents === "number" && typeof q?.raw?.limitMicroCents === "number" && q.raw.limitMicroCents > 0)) remainingPct = null
      if (binding.providerID === "openai" && typeof q?.raw?.usedPercent !== "number") remainingPct = null
      return { key, remainingPct, checkedAt, source: remainingPct === null ? "unknown" : "provider", resetAt: typeof q?.resetAt === "string" && Number.isFinite(Date.parse(q.resetAt)) ? q.resetAt : null,
        ...(typeof q?.raw?.balanceUsd === "number" ? { balanceUsd: q.raw.balanceUsd } : {}),
        ...(typeof q?.raw?.expiresAt === "string" ? { expiresAt: q.raw.expiresAt } : {}),
        ...(typeof q?.raw?.limitMicroCents === "number" ? { limitUnits: q.raw.limitMicroCents, availableUnits: q.raw.limitMicroCents - q.raw.usedMicroCents } : {}),
      }
    })
    return { key: binding.accountKey, providerID: binding.providerID, credentialID: binding.credentialID, label: binding.label,
      active: Boolean(account?.active) && (binding.providerID !== "openai" || binding.method === "oauth"),
      error: account?.lastError ? "Collector reports an account error" : null, windows }
  })
}

export class QuotaSource {
  lastError: string | null = null
  snapshot: CollectorSnapshot | null = null
  private pending: Promise<CollectorSnapshot> | null = null
  private lastFetched = 0
  private lastRefresh = 0
  constructor(readonly config: Settings, readonly fetcher: typeof fetch = fetch) {}
  async get(force = false): Promise<CollectorSnapshot> {
    if (this.pending) return this.pending
    if (!force && this.snapshot && Date.now() - this.lastFetched < 30_000) return this.snapshot
    this.pending = this.read(force)
    try { return await this.pending } finally { this.pending = null }
  }
  private async read(force: boolean): Promise<CollectorSnapshot> {
    const headers: Record<string, string> = {}
    if (this.config.collectorAuthorizationFile) headers.Authorization = (await readFile(this.config.collectorAuthorizationFile, "utf8")).trim()
    const base = this.config.collectorUrl.replace(/\/$/, "")
    if (!base.startsWith("https://") && !base.startsWith("http://127.0.0.1:")) throw new Error("Quota source must use HTTPS or local loopback")
    try {
      if (force && Date.now() - this.lastRefresh > 60_000) {
        this.lastRefresh = Date.now()
        const r = await this.fetcher(base + "/api/refresh", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(30_000), redirect: "error" })
        if (!r.ok) throw new Error(`Quota refresh failed: HTTP ${r.status}`)
      }
      const r = await this.fetcher(base + "/api/usage", { headers, signal: AbortSignal.timeout(15_000), redirect: "error" })
      if (!r.ok) throw new Error(`Quota status failed: HTTP ${r.status}`)
      const data = await r.json() as CollectorSnapshot
      if (!Array.isArray(data.accounts)) throw new Error("Invalid quota response")
      this.snapshot = data; this.lastFetched = Date.now(); this.lastError = null
      return data
    } catch {
      // Never log exceptions containing URLs, credentials or response bodies.
      this.lastError = "Quota source unavailable; dispatch fails closed"
      throw new Error(this.lastError)
    }
  }
}
