import type { Policy, Role } from "./types.ts"

export interface StepSelection {
  /** What the coordinator asked for; defaults to the native base budget. */
  requested: number
  /** Native `steps` value of the selected agent variant. */
  budget: number
  extended: boolean
}

/** Map a requested native step budget to the installed agent variant. */
export function selectStepBudget(policy: Pick<Policy, "steps">, requested?: number): StepSelection {
  const target = requested ?? policy.steps.default
  if (!Number.isSafeInteger(target) || target < 1) throw new Error("Native step budget must be a positive integer")
  if (target > policy.steps.extended) throw new Error(`Requested native step budget exceeds the configured maximum of ${policy.steps.extended}; continue the child or use a new child with a handoff`)
  const budget = target <= policy.steps.default ? policy.steps.default : policy.steps.extended
  return { requested: target, budget, extended: budget > policy.steps.default }
}

/** Internal agent ID for a role at a given native step budget. */
export function agentVariant(role: Role | string, policy: Pick<Policy, "steps">, budget: number): string {
  return budget > policy.steps.default ? `${role}-extended` : role
}
