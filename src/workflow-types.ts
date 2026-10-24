export const purposes = ["exploration", "research", "planning", "implementation", "debugging", "testing", "review", "criticism", "integration", "unknown"] as const
export type Purpose = typeof purposes[number]
export const taskStates = ["planned", "running", "completed", "failed", "blocked", "cancelled"] as const
export const contributions = ["unassessed", "incorporated", "partially_incorporated", "validation_only", "rejected", "superseded"] as const
export type Contribution = typeof contributions[number]

export interface WorkflowTask {
  source?: "automatic" | "coordinator"
  id: string
  parentTaskID: string | null
  dependsOn: string[]
  purpose: Purpose
  state: typeof taskStates[number]
  contribution: Contribution
  assessmentSource: "coordinator" | null
  evidenceIDs: string[]
  label?: string
  note?: string
  createdAt: number
  updatedAt: number
}
export interface WorkflowRequest {
  id: string
  state: string
  startedAt: number
  endedAt: number | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cacheReadTokens: number | null
  estimatedQuotaPp: number
}
export interface WorkflowSpan {
  modelSource?: "request_hook" | "routing_selection" | "session_snapshot" | "unknown"
  modelsObserved?: string[]
  accountRef?: string
  routingReasons?: string[]
  id: string
  taskID: string
  kind: "primary" | "delegation" | "denial"
  executionID: string | null
  childSessionID: string | null
  agent: string
  model: string | null
  tier: string | null
  purpose: Purpose
  state: string
  startedAt: number
  endedAt: number | null
  background: boolean
  continuationOf: string | null
  requests: WorkflowRequest[]
}
export interface WorkflowEvent {
  id: string
  at: number
  kind: string
  taskID: string | null
  spanID: string | null
}
export interface WorkflowSnapshot {
  schemaVersion: 1
  sessionID: string
  generatedAt: number
  localOnly: true
  includesLocalText: boolean
  tasks: WorkflowTask[]
  spans: WorkflowSpan[]
  events: WorkflowEvent[]
  truncated: boolean
  coverage: {
    primaryUsage: "not_collected"
    contribution: "explicit_coordinator_assessment"
    cost: "unavailable"
    history: "since_tracing_enabled"
  }
}
