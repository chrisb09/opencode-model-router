import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Ledger } from "../src/ledger.ts"
import { Router } from "../src/router.ts"
import { WorkflowStore, annotationSchema } from "../src/workflow.ts"
import { defaultPolicy } from "../src/config.ts"
import { task, accounts, models, now } from "./fixtures.ts"

const ledgers: Ledger[] = []
afterEach(() => ledgers.splice(0).forEach(l => l.close()))
function fixture(captureLabels = true) {
  const ledger = new Ledger(":memory:"); ledgers.push(ledger)
  let time = now
  const store = new WorkflowStore(ledger.db, captureLabels, () => time)
  const router = new Router(defaultPolicy(), ledger, () => time)
  const reserve = (id: string, session = "ses_parent") => router.reserve(id, task({ parentSessionID: session }), models(), accounts())
  return { ledger, store, router, reserve, tick: () => time++ }
}
describe("local workflow task graph", () => {
  test("additive tables survive reopen without changing the preexisting quota ledger", () => {
    const dir = mkdtempSync("/tmp/opencode/workflow-migration-")
    let ledger: Ledger | null = new Ledger(join(dir, "router.db"))
    try {
      const router = new Router(defaultPolicy(), ledger)
      const e = router.reserve("old-execution", task(), models(), accounts())
      const original = ledger.get(e.id)
      const store = new WorkflowStore(ledger.db)
      store.annotate("ses_parent", "persisted", { label: "LOCAL_PERSISTENCE_CANARY" })
      expect(ledger.get(e.id)).toEqual(original)
      ledger.close(); ledger = new Ledger(join(dir, "router.db"))
      const restored = new WorkflowStore(ledger.db)
      expect(restored.read("ses_parent", true).tasks[0].label).toBe("LOCAL_PERSISTENCE_CANARY")
      expect(ledger.get(e.id)).toEqual(original)
      expect(restored.read("ses_parent").spans).toEqual([]) // No fabricated legacy backfill.
    } finally { ledger?.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  test("empty reads neither invent history nor create a session", () => {
    const { store } = fixture()
    expect(store.read("ses_empty").tasks).toEqual([])
    expect(store.list()).toEqual([])
  })
  test("annotations create stable IDs, replay idempotently and default to unassessed", () => {
    const { store } = fixture()
    const a = store.annotate("ses_parent", "event_a", { purpose: "planning", label: "LOCAL-LABEL" })
    expect(store.annotate("ses_parent", "event_a", { label: "IGNORED-REPLAY" })).toEqual({ taskID: a.taskID, duplicate: true })
    expect(store.read("ses_parent").tasks).toHaveLength(1)
    expect(store.read("ses_parent").tasks[0]).toMatchObject({ contribution: "unassessed", assessmentSource: null })
    expect(JSON.stringify(store.read("ses_parent"))).not.toContain("LOCAL-LABEL")
    expect(store.read("ses_parent", true).tasks[0].label).toBe("LOCAL-LABEL")
  })
  test("explicit outcomes carry provenance and evidence but not automatic value scores", () => {
    const { store } = fixture()
    const { taskID } = store.annotate("ses_parent", "a", { purpose: "review" })
    store.annotate("ses_parent", "b", { taskID, contribution: "validation_only", note: "LOCAL-NOTE", evidenceIDs: ["call_test"] })
    expect(store.read("ses_parent").tasks[0]).toMatchObject({ contribution: "validation_only", assessmentSource: "coordinator", evidenceIDs: ["call_test"] })
    expect(JSON.stringify(store.read("ses_parent"))).not.toContain("LOCAL-NOTE")
    expect(store.read("ses_parent", true).tasks[0].note).toBe("LOCAL-NOTE")
  })
  test("tasks and dependencies are scoped to their session", () => {
    const { store } = fixture()
    const { taskID } = store.annotate("ses_other", "a", {})
    expect(() => store.annotate("ses_parent", "b", { taskID })).toThrow("not found")
    expect(() => store.annotate("ses_parent", "c", { dependsOn: [taskID] })).toThrow("not found")
    expect(store.read("ses_parent").tasks).toHaveLength(0) // atomic rollback
  })
  test("self, duplicate and combined parent/dependency cycles are rejected atomically", () => {
    const { store } = fixture()
    const a = store.annotate("ses_parent", "a", {}).taskID
    const b = store.annotate("ses_parent", "b", { parentTaskID: a }).taskID
    expect(() => store.annotate("ses_parent", "c", { taskID: a, dependsOn: [b] })).toThrow("acyclic")
    expect(() => store.annotate("ses_parent", "d", { taskID: a, parentTaskID: a })).toThrow("acyclic")
    expect(() => store.annotate("ses_parent", "e", { taskID: b, dependsOn: [a, a] })).toThrow("Duplicate")
    expect(store.read("ses_parent").tasks.find(t => t.id === a)!.dependsOn).toEqual([])
  })
  test("strict bounded annotations reject control text, extra payloads and path-like evidence", () => {
    for (const input of [{ label: "x\nsecret" }, { note: "x".repeat(1001) }, { prompt: "SECRET" }, { evidenceIDs: ["/private/file"] }, { dependsOn: Array(33).fill("a") }]) expect(annotationSchema.safeParse(input).success).toBe(false)
  })
  test("captureLabels=false discards labels AND contribution notes at storage time", () => {
    const { store } = fixture(false)
    store.annotate("ses_parent", "a", { label: "LABEL_CANARY", note: "NOTE_CANARY" })
    expect(JSON.stringify(store.read("ses_parent", true))).not.toContain("CANARY")
  })
})
describe("automatic workflow spans", () => {
  test("automatic delegated facts and usage do not expose private candidate/registry data", () => {
    const { store, ledger, reserve, router } = fixture()
    let e = reserve("one")
    e.candidate.account.label = "PRIVATE_EMAIL_CANARY"; e.candidate.account.credentialID = "PRIVATE_CREDENTIAL_CANARY"
    store.delegation(e, { background: true, label: "LOCAL-DESCRIPTION" })
    e = ledger.bind(e.id, "ses_child", now); store.execution(e)
    const req = router.preflight(e.id, models().find(m => m.id === e.candidate.ref.id)!, accounts(), 1000, 1000)
    router.record(req.requestID, { inputTokens: null, outputTokens: 0, status: "completed" })
    e = ledger.finish(e.id, "completed", now); store.execution(e)
    const view = store.read("ses_parent")
    expect(view.spans[0]).toMatchObject({ kind: "delegation", childSessionID: "ses_child", state: "completed", background: true, model: e.candidate.model })
    expect(view.spans[0].requests[0]).toMatchObject({ inputTokens: null, outputTokens: 0 })
    expect(view.tasks[0].contribution).toBe("unassessed")
    for (const value of ["PRIVATE_EMAIL_CANARY", "PRIVATE_CREDENTIAL_CANARY", "LOCAL-DESCRIPTION", "authorization", "directory"]) expect(JSON.stringify(view)).not.toContain(value)
  })
  test("continuations keep logical identity but use separate execution spans", () => {
    const { store, ledger, reserve, tick } = fixture()
    const a = reserve("a"); store.delegation(a)
    store.execution(ledger.finish(a.id, "failed", now)); tick()
    const b = reserve("b"); store.delegation(b, { background: false, previousExecutionID: a.id })
    store.execution(ledger.finish(b.id, "completed", now + 1))
    const view = store.read("ses_parent")
    expect(view.tasks).toHaveLength(1)
    expect(view.spans).toHaveLength(2)
    expect(view.spans.find(s => s.id === "b")!.continuationOf).toBe("a")
    expect(view.tasks[0].state).toBe("completed")
    expect(view.tasks[0].contribution).toBe("unassessed")
  })
  test("explicit tasks are not automatically completed or assessed by one span", () => {
    const { store, ledger, reserve } = fixture()
    const { taskID } = store.annotate("ses_parent", "a", { purpose: "testing", state: "running" })
    const e = reserve("one"); store.delegation(e, { taskID, background: false })
    store.execution(ledger.finish(e.id, "completed", now))
    expect(store.read("ses_parent").tasks[0]).toMatchObject({ state: "running", contribution: "unassessed" })
  })
  test("repeated capture/bind/finish is idempotent", () => {
    const { store, ledger, reserve } = fixture()
    const e = reserve("one"); store.delegation(e); store.delegation(e)
    const finished = ledger.finish(e.id, "cancelled", now)
    store.execution(finished); store.execution(finished)
    const view = store.read("ses_parent")
    expect(view.spans).toHaveLength(1); expect(view.events).toHaveLength(2)
  })
  test("denied work stays visible with no invented selected model", () => {
    const { store } = fixture()
    store.denial("nope", { parentSessionID: "ses_parent", role: "reviewer", tier: "HARD" })
    expect(store.read("ses_parent").spans[0]).toMatchObject({ kind: "denial", model: null, state: "denied", requests: [] })
  })
  test("primary lifecycle is distinct, idempotent, and does not manufacture usage", () => {
    const { store } = fixture()
    const event = { sessionID: "ses_parent", agent: "build" as const, model: "openai/model#high", at: now, eventID: "start", sequence: 10, state: "running" as const }
    store.primary(event); store.primary(event)
    store.primary({ ...event, eventID: "end", sequence: 20, state: "completed", at: now + 10 })
    store.primary({ ...event, eventID: "next", sequence: 30, state: "running", at: now + 20 })
    store.primary({ ...event, eventID: "late-old-end", sequence: 21, state: "failed", at: now + 15 })
    const view = store.read("ses_parent")
    expect(view.spans).toHaveLength(2)
    expect(view.spans.find(s => s.id === "primary:10")!.state).toBe("completed")
    expect(view.spans.find(s => s.id === "primary:30")!.state).toBe("running")
    expect(view.spans.every(s => s.requests.length === 0)).toBe(true)
    expect(view.coverage.primaryUsage).toBe("not_collected")
  })
  test("an unmatched primary terminal is a gap, not fabricated start/completion", () => {
    const { store } = fixture()
    store.primary({ sessionID: "ses_parent", agent: "plan", model: null, at: now, eventID: "end", sequence: 2, state: "completed" })
    expect(store.read("ses_parent").spans).toEqual([])
    expect(store.read("ses_parent").events[0].kind).toBe("primary.unmatched_terminal")
  })
  test("late starts and terminals repair correlation without closing the wrong execution", () => {
    const orders = [[40, 30, 20, 10], [30, 10, 40, 20], [20, 40, 10, 30], [10, 40, 30, 20]]
    for (const order of orders) {
      const { store } = fixture()
      for (const sequence of order) store.primary({ sessionID: "ses_parent", eventID: `evt_${sequence}`, sequence, at: now + sequence, agent: "build", model: sequence <= 20 ? "model_a" : "model_b", state: [10, 30].includes(sequence) ? "running" : sequence === 20 ? "failed" : "completed" })
      const view = store.read("ses_parent")
      expect(view.spans.find(s => s.id === "primary:10")).toMatchObject({ state: "failed", model: "model_a", endedAt: now + 20 })
      expect(view.spans.find(s => s.id === "primary:30")).toMatchObject({ state: "completed", model: "model_b", endedAt: now + 40 })
      expect(view.events.find(e => e.id === "evt_20")!.spanID).toBe("primary:10")
      expect(view.events.find(e => e.id === "evt_40")!.spanID).toBe("primary:30")
    }
  })
  test("forget cascades all local text and primary events even if the caller previously disabled foreign keys", () => {
    const { ledger } = fixture()
    ledger.db.exec("PRAGMA foreign_keys=OFF")
    const store = new WorkflowStore(ledger.db)
    expect((ledger.db.query("PRAGMA foreign_keys").get() as any).foreign_keys).toBe(1)
    store.annotate("ses_parent", "note", { label: "DELETE_LABEL_CANARY", note: "DELETE_NOTE_CANARY" })
    store.primary({ sessionID: "ses_parent", eventID: "start", sequence: 1, at: now, agent: "build", model: null, state: "running" })
    store.context("ses_parent", "build", "model")
    store.forget("ses_parent")
    for (const table of ["wf_sessions", "wf_tasks", "wf_spans", "wf_events", "wf_context", "wf_primary_events"]) expect(ledger.db.query(`SELECT * FROM ${table}`).all()).toEqual([])
  })
  test("capacity failures set a persistent truncated marker without changing existing tasks", () => {
    const { store, ledger } = fixture()
    store.annotate("ses_parent", "first", {})
    const sample = (ledger.db.query("SELECT payload FROM wf_tasks LIMIT 1").get() as any).payload
    ledger.db.transaction(() => {
      for (let i = 0; i < 499; i++) ledger.db.query("INSERT INTO wf_tasks VALUES(?,?,?)").run("ses_parent", `capacity_${i}`, JSON.stringify({ ...JSON.parse(sample), id: `capacity_${i}` }))
    })()
    expect(() => store.annotate("ses_parent", "overflow", {})).toThrow("capacity")
    expect(store.read("ses_parent").truncated).toBe(true)
    expect(store.read("ses_parent").tasks).toHaveLength(500)
  })
  test("forget removes only workflow tables, not quota ledger or existing sessions", () => {
    const { store, ledger, reserve } = fixture()
    const e = reserve("one"); store.delegation(e)
    expect(store.forget("ses_parent")).toBe(true)
    expect(store.read("ses_parent").spans).toEqual([])
    expect(ledger.get(e.id)!.state).toBe("reserved")
    expect(ledger.concurrency(e.candidate.account.key)).toBe(1)
  })
})
