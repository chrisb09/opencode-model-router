import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Ledger } from "../src/ledger.ts"
import { Router } from "../src/router.ts"
import { defaultPolicy } from "../src/config.ts"
import { accounts, models, now, task } from "./fixtures.ts"

const open: Ledger[] = []
afterEach(() => { for (const l of open.splice(0)) l.close() })
function fixture() {
  const ledger = new Ledger(":memory:"); open.push(ledger)
  const policy = defaultPolicy(), catalog = models()
  const model = catalog.find(m => m.providerID === "mistral" && m.id === "deepseek-v4-1-flash-1017")!
  model.cost = [{ input: 2, output: 8, cache: { read: 0.2, write: 2 } }]
  const router = new Router(policy, ledger, () => now)
  const execution = router.reserve("mistral", task({ requestedModel: policy.aliases["deepseek-1017-high"] }), catalog, accounts())
  ledger.bind(execution.id, "ses_mistral", now)
  return { ledger, policy, catalog, model, router, execution }
}
const row = (ledger: Ledger): any => ledger.db.query("SELECT * FROM requests ORDER BY rowid DESC LIMIT 1").get()

describe("Mistral monetary quota reservations", () => {
  test("uses byte/output bounds and settles inclusive cached usage from the price snapshot", () => {
    const f = fixture()
    const request = f.router.preflight(f.execution.id, f.model, accounts(), 10_000, 2_000)
    expect(row(f.ledger).estimate_pp).toBeCloseTo(0.024, 12)
    f.model.cost[0].input = 2000
    f.router.record(request.requestID, { inputTokens: 6_000, cacheReadTokens: 1_000, outputTokens: 1_500, reasoningTokens: 500, status: "completed" })
    expect(row(f.ledger).estimate_pp).toBeCloseTo(0.0148, 12)
  })

  test("25 physical requests aggregate their measured monetary percentage", () => {
    const f = fixture()
    for (let i = 0; i < 25; i++) {
      const req = f.router.preflight(f.execution.id, f.model, accounts(), 1_000, 500)
      f.router.record(req.requestID, { inputTokens: 1_000, outputTokens: 500, status: "completed" })
    }
    const key = f.execution.candidate.account.key
    expect(f.ledger.pressure(key, "mistral-code", now - 1)).toBeCloseTo(0.1, 12)
    expect(f.ledger.pressure(key, "mistral-code", now)).toBe(0)
  })

  test("missing, invalid, failed and uncertain usage retain the full reservation", () => {
    const f = fixture()
    const usages: any[] = [
      { inputTokens: null, outputTokens: null, status: "completed" },
      { inputTokens: 100, outputTokens: 50, status: "failed" },
      { inputTokens: 100, outputTokens: 50, status: "uncertain" },
      { inputTokens: 100, cacheReadTokens: 101, outputTokens: 50, status: "completed" },
      { inputTokens: 100, cacheReadTokens: -1, outputTokens: 50, status: "completed" },
      { inputTokens: 100.5, outputTokens: 50, status: "completed" },
    ]
    for (const usage of usages) {
      const req = f.router.preflight(f.execution.id, f.model, accounts(), 1_000, 500)
      const reserved = row(f.ledger).estimate_pp
      f.router.record(req.requestID, usage)
      expect(row(f.ledger).estimate_pp).toBe(reserved)
    }
  })

  test("cache reads are an input subset and reasoning is not charged twice", () => {
    const f = fixture()
    const req = f.router.preflight(f.execution.id, f.model, accounts(), 1_000, 500)
    f.router.record(req.requestID, { inputTokens: 1_000, cacheReadTokens: 250, outputTokens: 500, reasoningTokens: 400, status: "completed" })
    expect(row(f.ledger).estimate_pp).toBeCloseTo(0.0037, 12)
  })

  test("actual context selects its price tier without changing the reserved upper bound", () => {
    const f = fixture()
    f.model.cost.push({ input: 4, output: 16, cache: { read: 0.4, write: 4 }, tier: { type: "context", size: 5_000 } })
    const req = f.router.preflight(f.execution.id, f.model, accounts(), 10_000, 500)
    expect(row(f.ledger).estimate_pp).toBeCloseTo(0.032, 12) // uncached upper bound at high-tier rates
    f.router.record(req.requestID, { inputTokens: 6_000, cacheReadTokens: 1_000, outputTokens: 500, status: "completed" })
    expect(row(f.ledger).estimate_pp).toBeCloseTo(0.018933333333333332, 12)
  })

  test("missing prices or account budget use only the legacy fallback", () => {
    const f = fixture()
    delete f.policy.quota.mistralBudgetUsd
    const result = f.router.recommend(task({ requestedModel: f.policy.aliases["deepseek-1017-high"] }), f.catalog, accounts())
    const candidate = result.candidates[0]
    expect(candidate.estimatedRequestPp).toBe(1)
    expect(candidate.mistralCost).toBeUndefined()
    f.policy.quota.mistralBudgetUsd = { "mistral-code:default": 150 }
    f.model.cost = []
    expect(f.router.recommend(task({ requestedModel: f.policy.aliases["deepseek-1017-high"] }), f.catalog, accounts()).candidates[0].estimatedRequestPp).toBe(1)
  })

  test("generic provider units do not override the configured USD allowance", () => {
    const f = fixture(), a = accounts()
    a.find(a => a.providerID === "mistral")!.windows[0].limitUnits = 30_000_000_000
    const e = f.router.reserve("provider-budget", task({ requestedModel: f.policy.aliases["deepseek-1017-high"] }), f.catalog, a)
    expect(e.candidate.mistralCost?.budgetUsd).toBe(150)
  })

  test("invalid and implausibly free catalog rates retain the legacy estimate", () => {
    const f = fixture()
    for (const rates of [
      { input: 0, output: 1, cache: { read: 0, write: 0 } },
      { input: 1, output: 0, cache: { read: 0, write: 0 } },
      { input: 1, output: 1, cache: { read: 2, write: 0 } },
    ]) {
      f.model.cost = [rates]
      const candidate = f.router.recommend(task({ requestedModel: f.policy.aliases["deepseek-1017-high"] }), f.catalog, accounts()).candidates[0]
      expect(candidate.estimatedRequestPp).toBe(1)
      expect(candidate.mistralCost).toBeUndefined()
    }
  })

  test("observed requests settle to the empirical total at actual DeepSeek prices", () => {
    const f = fixture()
    f.model.cost = [{ input: 0.3, output: 1.2, cache: { read: 0.007, write: 0 } }]
    const req = f.router.preflight(f.execution.id, f.model, accounts(), 800_000, 8_192)
    f.router.record(req.requestID, { inputTokens: 720_078, cacheReadTokens: 433_152, outputTokens: 5_336, status: "completed" })
    expect(row(f.ledger).estimate_pp).toBeCloseTo(0.063675376, 12)
  })

  test("fresh snapshots release measured debt but reconciliation preserves uncertain debt", () => {
    const f = fixture(), key = f.execution.candidate.account.key
    const done = f.router.preflight(f.execution.id, f.model, accounts(), 1_000, 500)
    f.router.record(done.requestID, { inputTokens: 1_000, outputTokens: 500, status: "completed" })
    expect(f.ledger.pressure(key, "mistral-code", now - 1)).toBeCloseTo(0.004, 12)
    expect(f.ledger.pressure(key, "mistral-code", now + 1)).toBe(0)
    const uncertain = f.router.preflight(f.execution.id, f.model, accounts(), 1_000, 500)
    const reserved = row(f.ledger).estimate_pp
    f.router.record(uncertain.requestID, { inputTokens: null, outputTokens: null, status: "uncertain" })
    f.ledger.finish(f.execution.id, "uncertain", now)
    f.ledger.reconcile(f.execution.id, now + 1)
    expect(f.ledger.pressure(key, "mistral-code", now)).toBeCloseTo(reserved, 12)
    expect(f.ledger.pressure(key, "mistral-code", now + 2)).toBe(0)
  })

  test("an old outstanding request survives the additive database upgrade unrepriced", () => {
    const dir = mkdtempSync("/tmp/opencode/mistral-ledger-")
    let ledger: Ledger | null = null
    try {
      ledger = new Ledger(join(dir, "router.db"))
      const policy = defaultPolicy(), catalog = models(), router = new Router(policy, ledger, () => now)
      const e = router.reserve("old", task({ requestedModel: policy.aliases["deepseek-1017-high"] }), catalog, accounts())
      ledger.bind(e.id, "ses_old", now)
      router.preflight(e.id, catalog.find(m => m.providerID === "mistral" && m.id === e.candidate.ref.id)!, accounts(), 10_000, 500)
      const before = row(ledger).estimate_pp
      ledger.db.exec("ALTER TABLE requests DROP COLUMN cost_snapshot")
      ledger.close(); ledger = new Ledger(join(dir, "router.db"))
      expect(row(ledger).estimate_pp).toBe(before)
      expect(row(ledger).cost_snapshot).toBeNull()
      expect(ledger.pressure(e.candidate.account.key, "mistral-code", now + 1)).toBe(before)
    } finally { ledger?.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  test("non-Mistral estimates and completed settlement are unchanged", () => {
    const ledger = new Ledger(":memory:"); open.push(ledger)
    const policy = defaultPolicy(), catalog = models(), router = new Router(policy, ledger, () => now)
    const model = catalog.find(m => m.providerID === "openai")!
    model.cost = [{ input: 2, output: 8, cache: { read: 0.2, write: 2 } }]
    const e = router.reserve("openai", task({ requestedModel: policy.aliases["sol-high"] }), catalog, accounts())
    ledger.bind(e.id, "ses_openai", now)
    const req = router.preflight(e.id, model, accounts(), 10_000, 2_000)
    expect(row(ledger).estimate_pp).toBe(2)
    expect(row(ledger).cost_snapshot).toBeNull()
    router.record(req.requestID, { inputTokens: 100, outputTokens: 50, status: "completed" })
    expect(row(ledger).estimate_pp).toBe(2)
  })
})
