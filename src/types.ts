export const roles = ["explore", "research", "general", "debugger", "reviewer", "architect", "critic"] as const
export const tiers = ["LOW", "DEFAULT", "HARD", "EXCEPTIONAL"] as const
export type Role = typeof roles[number]
export type Tier = typeof tiers[number]
export type Family = "gemini" | "deepseek" | "sol" | "kimi" | "opus" | "unknown"
export type ModelRef = { providerID: string; id: string; variant?: string }
export interface CatalogModel extends ModelRef {
  modelID?: string
  package?: string
  enabled: boolean
  limit: { context: number; input?: number; output: number }
  variants: Array<{ id: string }>
  capabilities: { tools: boolean; input: string[]; output: string[] }
  cost: Array<{ input: number; output: number; cache: { read: number; write: number }; tier?: { type: string; size: number } }>
}
export interface QuotaWindow {
  key: string
  remainingPct: number | null
  resetAt: string | null
  source: "provider" | "estimate" | "unknown"
  checkedAt: number
  balanceUsd?: number
  expiresAt?: string
  availableUnits?: number
  limitUnits?: number
}
export interface Account {
  key: string
  providerID: string
  label: string
  credentialID: string
  active: boolean
  error: string | null
  windows: QuotaWindow[]
}
export interface Task {
  role: Role
  tier: Tier
  importance: "low" | "normal" | "high" | "critical"
  parentAgent: string
  parentSessionID: string
  directory: string
  inputTokens: number
  outputTokens?: number
  modalities: string[]
  originModel?: string
  requestedModel?: string
  /** Requested native OpenCode step budget. The actual bucket is recorded separately. */
  steps?: number
  /** Native step budget of the selected agent variant (30 default, 60 extended). */
  stepBudget?: number
  /** Test-only account pin. Rejected unless the router is in test mode. */
  accountKey?: string
  /** Test-only marker so probe traffic does not pollute normal performance statistics. */
  test?: boolean
}
export interface Candidate {
  model: string
  ref: ModelRef
  family: Family
  account: Account
  outputTokens: number
  estimatedRequestPp: number
  score: number
  reasons: string[]
  rejected: string[]
}
export interface Policy {
  version: number
  aliases: Record<string, string>
  roles: Record<Role, Record<Tier, string[]>>
  fallbacks: Record<Tier, string[]>
  criticPreferences: Partial<Record<Family, Family>>
  outputTokens: Record<Tier, number>
  /** Native OpenCode step budgets. Extended variants exist above the default. */
  steps: { default: number; extended: number }
  /** High runaway backstop; not a tier budget. Native steps normally stop first. */
  maxRequestsPerExecution: number
  /** Bounded wait when the only rejection is local concurrency admission. */
  queueTimeoutMs: number
  quota: {
    maxAgeMs: number
    hardReservePp: number
    softReservePp: Record<string, number>
    estimatedRequestPp: Record<string, number>
    maxConcurrentPerAccount: Record<string, number>
    /** Optional global cap across all managed accounts. */
    maxConcurrentTotal?: number
  }
  allowPaid: boolean
  allowKimi: boolean
  maxTaskUsd: number
  totalBudgetUsd: number
}
export interface Execution {
  id: string
  childSessionID: string | null
  state: "reserved" | "running" | "completed" | "failed" | "uncertain" | "cancelled" | "reconciled"
  task: Task
  candidate: Candidate
  createdAt: number
  updatedAt: number
}
export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens?: number | null
  cacheReadTokens?: number | null
  durationMs?: number
  status: "completed" | "failed" | "uncertain"
}
