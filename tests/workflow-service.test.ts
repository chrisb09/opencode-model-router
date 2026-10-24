import { afterEach, describe, expect, test } from "bun:test"
import { Ledger } from "../src/ledger.ts"
import { RouterService } from "../src/service.ts"
import { RouterClient } from "../src/client.ts"
import { defaultPolicy, type Settings } from "../src/config.ts"
import { models, bindings, snapshot, task } from "./fixtures.ts"

const open: Ledger[] = []
afterEach(() => open.splice(0).forEach(l => l.close()))
async function fixture(workflow?: Settings["workflow"]) {
  const ledger = new Ledger(":memory:"); open.push(ledger)
  const config: Settings = { url: "http://127.0.0.1:7695", collectorUrl: "https://quota.example.com", enabled: true, workflow }
  const service = new RouterService(config, defaultPolicy(), ledger, "private-token", (async () => Response.json(snapshot())) as unknown as typeof fetch)
  const client = new RouterClient(config, "private-token", ((url: any, init: any) => service.fetch(new Request(url, init))) as typeof fetch)
  await client.call("/registry", { directory: "/test", models: models(), bindings: bindings() })
  const annotate = (eventID: string, annotation: any, sessionID = "ses_parent", actorSessionID = sessionID, actorAgent = "build") => client.call("/workflow/annotate", { sessionID, actorSessionID, actorAgent, eventID, annotation })
  return { ledger, config, service, client, annotate }
}
describe("workflow API privacy and isolation", () => {
  test("annotations and task-linked delegation read safely, with explicit local text opt-in", async () => {
    const f = await fixture()
    const { taskID } = await f.annotate("a", { purpose: "implementation", label: "LOCAL_LABEL_CANARY", note: "LOCAL_NOTE_CANARY", contribution: "incorporated" })
    const e = await f.client.call("/reserve", { id: "one", task: task(), workflow: { taskID, purpose: "testing", label: "IGNORED_DESCRIPTION", background: true } })
    await f.client.call("/bind", { id: e.id, childSessionID: "ses_child" })
    await f.client.call("/finish", { id: e.id, state: "completed" })
    const data = await f.client.call("/workflow/read", { sessionID: "ses_parent" })
    expect(data.workflow.spans[0]).toMatchObject({ taskID, purpose: "testing", state: "completed", background: true })
    expect(data.summary.tasks.byContribution.incorporated).toBe(1)
    for (const value of ["LOCAL_LABEL_CANARY", "LOCAL_NOTE_CANARY", "credential", '"windows":', "/test", "authorizationFingerprint"]) expect(JSON.stringify(data)).not.toContain(value)
    expect(JSON.stringify(await f.client.call("/workflow/read", { sessionID: "ses_parent", includeLocalText: true }))).toContain("LOCAL_NOTE_CANARY")
    expect(JSON.stringify(await f.client.call("/workflow/read", { sessionID: "ses_parent", format: "mermaid" }))).not.toContain("CANARY")
  })
  test("read-only workflow endpoints require the private router token", async () => {
    const f = await fixture()
    const r = await f.service.fetch(new Request("http://127.0.0.1:7695/workflow/read", { method: "POST", body: JSON.stringify({ sessionID: "ses_parent" }) }))
    expect(r.status).toBe(401)
  })
  test("annotation actors and graphs cannot cross session scopes or claim child mutation", async () => {
    const f = await fixture()
    await expect(f.annotate("a", {}, "ses_other", "ses_parent")).rejects.toThrow("another session")
    await expect(f.annotate("b", {}, "ses_parent", "ses_parent", "explore")).rejects.toThrow("Invalid")
    await expect(f.annotate("c", { label: "LOCAL_SECRET", prompt: "PROMPT_CANARY" })).rejects.toThrow("Invalid")
    expect(JSON.stringify(await f.client.call("/workflow/list", {}))).not.toContain("CANARY")
  })
  test("workflow write failure cannot roll back reservations, bind or terminalization", async () => {
    const f = await fixture()
    f.ledger.db.exec("CREATE TRIGGER block_trace BEFORE INSERT ON wf_sessions BEGIN SELECT RAISE(ABORT,'TRACE_CANARY'); END;")
    const e = await f.client.call("/reserve", { id: "one", task: task() })
    expect(f.ledger.get(e.id)!.state).toBe("reserved")
    await f.client.call("/bind", { id: e.id, childSessionID: "ses_child" })
    await f.client.call("/finish", { id: e.id, state: "completed" })
    expect(f.ledger.get(e.id)!.state).toBe("completed")
    const status = await f.client.call("/status")
    expect(status.workflow.captureFailures).toBeGreaterThan(0)
    expect(JSON.stringify(status)).not.toContain("TRACE_CANARY")
    await expect(f.client.call("/reserve", { id: "paid", task: task({ requestedModel: defaultPolicy().aliases.opus }) })).rejects.toThrow("No eligible")
  })
  test("workflow failure does not weaken preflight quota checks", async () => {
    const f = await fixture()
    const e = await f.client.call("/reserve", { id: "one", task: task() })
    await f.client.call("/bind", { id: e.id, childSessionID: "ses_child" })
    f.ledger.db.exec("DROP TABLE wf_events")
    f.service.source.snapshot!.accounts.forEach(a => a.quotas.forEach((q: any) => q.remaining = 0))
    await expect(f.client.call("/preflight", { id: e.id, inputBound: 1000, outputBound: 512 })).rejects.toThrow("no longer eligible")
    expect((await f.client.call("/health")).ok).toBe(true)
    expect((await f.client.call("/status")).safeguards.paidDispatch).toBe("locked")
  })
  test("disabled recording keeps existing read/export access and leaves quota enforcement active", async () => {
    const f = await fixture({ enabled: false, captureLabels: false })
    await f.client.call("/reserve", { id: "one", task: task() })
    expect((await f.client.call("/workflow/read", { sessionID: "ses_parent" })).workflow.tasks).toEqual([])
    await expect(f.annotate("a", {})).rejects.toThrow("disabled")
    await expect(f.client.call("/reserve", { id: "paid", task: task({ requestedModel: defaultPolicy().aliases.opus }) })).rejects.toThrow("No eligible")
  })
  test("late primary/model observations and recording failures are not quota/model mutations", async () => {
    const f = await fixture()
    await f.client.call("/workflow/context", { sessionID: "ses_parent", agent: "plan", model: "openai/model#high" })
    await f.client.call("/workflow/primary", { sessionID: "ses_parent", eventID: "evt_1", sequence: 1, at: 100, state: "running", agent: "plan", model: null })
    await f.client.call("/workflow/primary", { sessionID: "ses_parent", eventID: "evt_2", sequence: 2, at: 110, state: "completed", agent: "plan", model: null })
    const data = await f.client.call("/workflow/read", { sessionID: "ses_parent" })
    expect(data.workflow.spans[0]).toMatchObject({ kind: "primary", model: "openai/model#high", state: "completed", requests: [] })
    expect(data.summary.usage.inputTokens).toBeNull()
    expect(f.ledger.status().executions).toEqual([])
  })
})
