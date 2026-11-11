import type { Account, CatalogModel, Policy, Usage } from "./types.ts"

export type MistralCostSnapshot = { budgetUsd: number; cost: CatalogModel["cost"] }
type Estimate = { estimatedRequestPp: number; mistralCost?: MistralCostSnapshot }

const legacyPp = (policy: Policy, providerID: string, inputBound: number, outputBound: number) =>
  Math.min(100, (policy.quota.estimatedRequestPp[providerID] ?? 100) * Math.max(1, (inputBound + outputBound) / 50000))
const validRate = (n: number) => Number.isFinite(n) && n >= 0

/** Accept only the catalog's documented untiered base plus context tiers. */
function prices(cost: CatalogModel["cost"]): CatalogModel["cost"] | null {
  if (!cost.length || cost.some(c => !validRate(c.input) || c.input === 0 || !validRate(c.output) || c.output === 0 || !validRate(c.cache.read) || c.cache.read > c.input)) return null
  const base = cost.filter(c => !c.tier)
  const tiers = cost.filter(c => c.tier)
  if (base.length !== 1 || tiers.some(c => c.tier!.type !== "context" || !Number.isSafeInteger(c.tier!.size) || c.tier!.size < 0)) return null
  if (new Set(tiers.map(c => c.tier!.size)).size !== tiers.length) return null
  return structuredClone(cost)
}

function atInput(cost: CatalogModel["cost"], inputTokens: number) {
  return cost.filter(c => !c.tier || inputTokens > c.tier.size)
    .sort((a, b) => (a.tier?.size ?? -1) - (b.tier?.size ?? -1)).at(-1)!
}

function budgetUsd(policy: Policy, account: Account): number | null {
  const configured = policy.quota.mistralBudgetUsd?.[account.key]
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : null
}

export function estimateRequest(policy: Policy, model: CatalogModel | undefined, account: Account, inputBound: number, outputBound: number): Estimate {
  const fallback = legacyPp(policy, account.providerID, inputBound, outputBound)
  if (account.providerID !== "mistral") return { estimatedRequestPp: fallback }
  const budget = budgetUsd(policy, account)
  const cost = model ? prices(model.cost) : null
  if (!budget || !cost) return { estimatedRequestPp: fallback }
  // Any tier reachable below the byte-derived upper bound may apply in flight.
  // Taking the highest applicable component rates keeps the hold conservative.
  const applicable = cost.filter(c => !c.tier || inputBound > c.tier.size)
  const inputRate = Math.max(...applicable.map(c => c.input))
  const outputRate = Math.max(...applicable.map(c => c.output))
  const usd = (inputBound * inputRate + outputBound * outputRate) / 1_000_000
  return { estimatedRequestPp: Math.min(100, 100 / budget * usd), mistralCost: { budgetUsd: budget, cost } }
}

/** Null means that the original conservative reservation must be retained. */
export function settledMistralPp(snapshot: MistralCostSnapshot, usage: Usage): number | null {
  if (usage.status !== "completed" || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens! < 0 ||
    !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens! < 0) return null
  const input = usage.inputTokens!, output = usage.outputTokens!, cached = usage.cacheReadTokens ?? 0
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > input) return null
  const cost = prices(snapshot.cost)
  if (!cost || !Number.isFinite(snapshot.budgetUsd) || snapshot.budgetUsd <= 0) return null
  // Native proxy input is inclusive of cache reads; output includes reasoning.
  const rate = atInput(cost, input)
  const usd = ((input - cached) * rate.input + cached * rate.cache.read + output * rate.output) / 1_000_000
  const pp = 100 / snapshot.budgetUsd * usd
  return Number.isFinite(pp) && pp >= 0 ? pp : null
}
