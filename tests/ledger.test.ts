import { afterEach, describe, expect, test } from "bun:test"
import { Ledger } from "../src/ledger.ts"
import { NoEligibleModelError, Router } from "../src/router.ts"
import { defaultPolicy } from "../src/config.ts"
import { task, models, accounts, now } from "./fixtures.ts"

const open: Ledger[] = []
afterEach(() => { for (const l of open.splice(0)) l.close() })
const fixture = () => { const l = new Ledger(":memory:"); open.push(l); const p = defaultPolicy(); return { l, p, r: new Router(p, l, () => now), a: accounts(), m: models() } }
describe("atomic reservation ledger", () => {
  test("select, bind and settle without duplicate usage", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a)
    expect(e.state).toBe("reserved")
    l.bind(e.id, "ses_child", now)
    const selected = m.find(m => m.providerID === e.candidate.ref.providerID && m.id === e.candidate.ref.id)!
    const req = r.preflight(e.id, selected, a, 1000, 4096)
    expect(r.record(req.requestID, { inputTokens: 10, outputTokens: 20, status: "completed" })).toBe(true)
    expect(r.record(req.requestID, { inputTokens: 10, outputTokens: 20, status: "completed" })).toBe(false)
    l.finish(e.id, "completed", now)
    expect(l.concurrency(e.candidate.account.key)).toBe(0)
  })
  test("parallel requests cannot reserve the same last slot", async () => {
    const { r, a, m, p } = fixture(); p.quota.maxConcurrentPerAccount.antigravity = 1
    const result = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => Promise.resolve().then(() => r.reserve("parallel-" + i, task({ requestedModel: p.aliases["gemini-high"] }), m, a))))
    expect(result.filter(x => x.status === "fulfilled")).toHaveLength(2)
    expect(result.filter(x => x.status === "rejected")).toHaveLength(3)
  })
  test("duplicate dispatch IDs cannot replay possibly written work", () => {
    const { r, m, a } = fixture(); r.reserve("one", task(), m, a)
    expect(() => r.reserve("one", task(), m, a)).toThrow("already exists")
  })
  test("unconsumed initial hold is replaced, not doubled", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a)
    const before = l.pressure(e.candidate.account.key, "gemini-5h", now - 1)
    l.bind(e.id, "ses_child", now)
    r.preflight(e.id, m.find(m => m.id === e.candidate.ref.id)!, a, 1000, 1000)
    expect(l.pressure(e.candidate.account.key, "gemini-5h", now - 1)).toBe(before)
  })
  test("completed but not reflected usage remains reserved", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_child", now)
    const req = r.preflight(e.id, m.find(m => m.id === e.candidate.ref.id)!, a, 1000, 1000)
    r.record(req.requestID, { inputTokens: null, outputTokens: null, status: "completed" }); l.finish(e.id, "completed", now)
    expect(l.pressure(e.candidate.account.key, "gemini-5h", now - 1)).toBeGreaterThan(0)
    expect(l.pressure(e.candidate.account.key, "gemini-5h", now + 1)).toBe(0)
  })
  test("unknown aborted consumption is not freed by a later snapshot", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_child", now)
    const req = r.preflight(e.id, m.find(m => m.id === e.candidate.ref.id)!, a, 1000, 1000)
    r.record(req.requestID, { inputTokens: null, outputTokens: null, status: "uncertain" }); l.finish(e.id, "uncertain", now)
    expect(l.pressure(e.candidate.account.key, "gemini-5h", now + 1)).toBeGreaterThan(0)
    expect(l.concurrency(e.candidate.account.key)).toBe(1)
  })
  test("background reservations stay held until execution termination", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("bg", task(), m, a); l.bind(e.id, "ses_background", now)
    expect(l.forChild("ses_background")!.state).toBe("running")
    expect(l.concurrency(e.candidate.account.key)).toBe(1)
  })
  test("global concurrency cap is enforced across accounts", () => {
    const { l, r, a, m, p } = fixture(); p.quota.maxConcurrentTotal = 1
    const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_child", now)
    expect(l.totalConcurrency()).toBe(1)
    try { r.reserve("two", task(), m, a) }
    catch (error) {
      expect(error).toBeInstanceOf(NoEligibleModelError)
      expect((error as NoEligibleModelError).concurrencyOnly).toBe(true)
    }
  })
  test("stale execution query excludes terminal work and respects the age threshold", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_child", now)
    expect(l.stale(now)).toHaveLength(0)
    expect(l.stale(now + 1).map(x => x.id)).toEqual([e.id])
    l.finish(e.id, "completed", now + 2)
    expect(l.stale(now + 3)).toHaveLength(0)
  })
  test("request backstop is enforced", () => {
    const { l, r, a, m, p } = fixture(); p.maxRequestsPerExecution = 1
    const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_child", now)
    r.preflight(e.id, m.find(m => m.id === e.candidate.ref.id)!, a, 1000, 1000)
    expect(() => r.preflight(e.id, m.find(m => m.id === e.candidate.ref.id)!, a, 1000, 1000)).toThrow("backstop")
  })
  test("later context growth fails before dispatch", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_child", now)
    expect(() => r.preflight(e.id, m.find(m => m.id === e.candidate.ref.id)!, a, 2000000, 1000)).toThrow("context/output")
  })
  test("rate limits create a bounded cooldown rather than provider loops", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a)
    r.failure(e.id, 429, Infinity)
    expect(l.cooldown(e.candidate.account.key, `${e.candidate.ref.providerID}/${e.candidate.ref.id}`)).toBe(now + 3600000)
  })
  test("reserved account cannot be rebound to a different child", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_one", now)
    expect(() => l.bind(e.id, "ses_two", now)).toThrow("already bound")
  })
  test("terminal execution with an unacknowledged request retains its slot", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_child", now)
    r.preflight(e.id, m.find(m => m.id === e.candidate.ref.id)!, a, 1000, 1000)
    l.finish(e.id, "failed", now)
    expect(l.get(e.id)!.state).toBe("uncertain")
    expect(l.concurrency(e.candidate.account.key)).toBe(1)
    expect((l.db.query("SELECT state FROM requests").get() as any).state).toBe("uncertain")
  })
  test("explicit reconciliation releases the slot without manufacturing measured usage", () => {
    const { l, r, a, m } = fixture(); const e = r.reserve("one", task(), m, a); l.bind(e.id, "ses_child", now)
    const request = r.preflight(e.id, m.find(m => m.id === e.candidate.ref.id)!, a, 1000, 1000)
    r.record(request.requestID, { inputTokens: null, outputTokens: null, status: "uncertain" }); l.finish(e.id, "uncertain", now)
    l.reconcile(e.id, now + 1)
    expect(l.concurrency(e.candidate.account.key)).toBe(0)
    expect(l.pressure(e.candidate.account.key, "gemini-5h", now)).toBeGreaterThan(0)
    expect(l.pressure(e.candidate.account.key, "gemini-5h", now + 2)).toBe(0)
    expect(JSON.parse((l.db.query("SELECT usage FROM requests").get() as any).usage).inputTokens).toBeNull()
  })
})
