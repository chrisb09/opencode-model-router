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
  maxSteps: Record<Tier, number>
  quota: {
    maxAgeMs: number
    hardReservePp: number
    softReservePp: Record<string, number>
    estimatedRequestPp: Record<string, number>
    maxConcurrentPerAccount: Record<string, number>
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
