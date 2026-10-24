import { afterEach, describe, expect, test } from "bun:test"
import { Ledger } from "../src/ledger.ts"
import { RouterService } from "../src/service.ts"
import { RouterClient } from "../src/client.ts"
import { defaultPolicy } from "../src/config.ts"
import { parseModel } from "../src/policy.ts"
import { setupRouter } from "../plugin/index.ts"
import { coordinatorInstructions } from "../src/agents.ts"
import { models, bindings, snapshot, jwt } from "./fixtures.ts"

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))
async function fixture(consoleGo = false) {
  const ledger = new Ledger(":memory:")
  const config = { url: "http://127.0.0.1:7695", collectorUrl: "https://quota.example.com", enabled: true }
  const service = new RouterService(config, defaultPolicy(), ledger, "token", (async () => Response.json(snapshot())) as unknown as typeof fetch)
  const client = new RouterClient(config, "token", ((u: any, init: any) => service.fetch(new Request(u, init))) as typeof fetch)
  const parent = { id: "ses_parent", model: parseModel(defaultPolicy().aliases["sol-high"]), agent: "build" }
  const sessions = new Map<string, any>([[parent.id, parent]])
  const calls: any[] = []
  const hooks = new Map<string, any>()
  const tools = new Map<string, any>()
  let count = 0
  const tool: any = { name: "subagent", input: {}, description: "Native subagent", execute: async (input: any, context: any) => {
    const id = input.sessionID || `ses_child_${++count}`
    sessions.set(id, { id, parentID: context.sessionID, model: parseModel(input.model), agent: input.agent })
    await context.progress({ sessionID: id, status: "running" })
    calls.push({ ...input, sessionID: id })
    // Bind happens before the native prompt can dispatch a model request.
    expect(ledger.forChild(id)!.state).toBe("running")
    await Bun.sleep(1)
    return { content: "done", metadata: { sessionID: id, status: input.background ? "running" : "completed" } }
  } }
  const store = new Map<string, any>()
  const connections = bindings().map(b => b.providerID === "opencode-go" && consoleGo ? { ...b, credentialID: "cred_console", method: "device" } : b)
  const integrationFor = (b: any) => b.providerID === "opencode-go" && consoleGo ? "opencode" : b.providerID
  const queue: any[] = []; let wake: (() => void) | null = null
  const push = (event: any) => { queue.push(event); wake?.(); wake = null }
  const ctx: any = {
    app: { version: "2.1.4" }, options: {}, location: { directory: "/test" },
    model: { list: async () => ({ data: models() }) },
    provider: { get: async ({ providerID }: any) => ({ data: { id: providerID, integrationID: providerID === "opencode-go" && consoleGo ? "opencode" : providerID } }) },
    integration: { list: async () => ({ data: [...new Set(connections.map(integrationFor))].map(id => ({ id, connections: connections.filter(b => integrationFor(b) === id).map(b => ({ type: "credential", id: b.credentialID, label: b.label, method: b.method })) })) }), connection: { active: async (id: string) => ({ type: "credential", id: connections.find(b => integrationFor(b) === id)?.credentialID }), resolve: async (c: any) => c.id === "cred_sol" ? { type: "oauth", access: jwt() } : c.id === "cred_console" ? { type: "oauth", access: "console-token", metadata: { orgID: "test-workspace" } } : { type: "key", key: "test-go-key" } } },
    permission: { assert: async () => {} },
    tool: { transform: async (fn: any) => fn({ update: (id: string, update: any) => { if (id === "subagent") update(tool) }, add: (tool: any) => tools.set(tool.name, tool) }) },
    session: { get: async ({ sessionID }: any) => sessions.get(sessionID), hook: async (name: string, fn: any) => { const previous = hooks.get(name); hooks.set(name, previous ? async (event: any) => { await previous(event); await fn(event) } : fn) } },
    aisdk: { hook: async () => {} },
    storage: { set: async (k: string, v: any) => store.set(k, v), get: async (k: string) => store.get(k) },
    event: { subscribe: async function* ({ signal }: any) {
      signal.addEventListener("abort", () => wake?.(), { once: true })
      while (!signal.aborted) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve })
        if (signal.aborted) return
        while (queue.length) yield queue.shift()
      }
    } },
  }
  const stop = await setupRouter(ctx, client, defaultPolicy())
  cleanups.push(() => { stop?.(); ledger.close() })
  let invocation = 0
  const invoke = (input: any, agent = "build") => tool.execute({ agent: "explore", description: "Inspect test code", prompt: "Read the relevant code", ...input }, { sessionID: parent.id, agent, messageID: `msg_${++invocation}`, id: `call_${invocation}`, signal: new AbortController().signal, progress: async () => {} })
  return { client, ledger, service, tool, calls, parent, invoke, hooks, push, tools, sessions }
}
describe("native subagent dispatch integration", () => {
  test("primary workflow tools create/link logical work and keep labels/notes out of in-chat reads", async () => {
    const f = await fixture()
    const context: any = { sessionID: f.parent.id, agent: "plan", messageID: "msg_annotation", id: "call_annotation", signal: new AbortController().signal, progress: async () => {} }
    const result = await f.tools.get("workflow_annotate").execute({ purpose: "testing", label: "LOCAL_LABEL_CANARY", note: "LOCAL_NOTE_CANARY" }, context)
    const { taskID } = JSON.parse(result.content)
    const child = await f.invoke({ prompt: "PROMPT_PRIVATE_CANARY", routing: { taskID, purpose: "testing" } })
    const read = await f.tools.get("workflow_read").execute({}, context)
    const data = JSON.parse(read.content)
    expect(data.workflow.spans.find((s: any) => s.childSessionID === child.metadata.sessionID)).toMatchObject({ taskID, purpose: "testing" })
    expect(read.content).not.toContain("CANARY")
    const records = JSON.stringify(f.ledger.db.query("SELECT payload FROM wf_tasks UNION ALL SELECT payload FROM wf_spans").all())
    expect(records).toContain("LOCAL_LABEL_CANARY")
    expect(records).not.toContain("PROMPT_PRIVATE_CANARY")
  })
  test("a child cannot annotate another workflow even if it claims coordinator agent identity", async () => {
    const f = await fixture()
    const child = await f.invoke({})
    await expect(f.tools.get("workflow_annotate").execute({ purpose: "implementation" }, { sessionID: child.metadata.sessionID, agent: "build" })).rejects.toThrow("Only the primary")
    const read = await f.tools.get("workflow_read").execute({}, { sessionID: child.metadata.sessionID, agent: "explore" })
    expect(JSON.parse(read.content).workflow.sessionID).toBe(f.parent.id)
  })
  test("primary lifecycle events are observed without changing session models or quota reservations", async () => {
    const f = await fixture(); const before = structuredClone(f.parent.model)
    f.push({ id: "evt_start", type: "session.execution.started", created: Date.now(), durable: { seq: 1 }, data: { sessionID: f.parent.id } })
    f.push({ id: "evt_end", type: "session.execution.succeeded", created: Date.now(), durable: { seq: 2 }, data: { sessionID: f.parent.id } })
    await Bun.sleep(10)
    const data = await f.client.call("/workflow/read", { sessionID: f.parent.id })
    expect(data.workflow.spans[0]).toMatchObject({ kind: "primary", state: "completed", model: defaultPolicy().aliases["sol-high"] })
    expect(f.parent.model).toEqual(before)
    expect(f.ledger.status().executions).toEqual([])
  })
  for (const agent of ["plan", "build"]) test(`${agent} receives specialist consideration by default without replacing its base instructions`, async () => {
    const f = await fixture()
    const base = { type: "text", text: "Existing provider instructions" }
    const before = structuredClone(f.parent.model)
    const event = { sessionID: f.parent.id, agent, system: [base], options: {} }
    await f.hooks.get("context")(event)
    expect(event.system).toEqual([base, { type: "text", text: coordinatorInstructions }])
    expect(coordinatorInstructions).toContain("Consider specialist subagents for every task")
    expect(coordinatorInstructions).toContain("unless the user specifies otherwise or the task is trivial")
    expect(coordinatorInstructions).toContain('"work solo", "no subagents", or "do this directly" take precedence')
    expect(f.parent.model).toEqual(before)
    expect(f.calls).toHaveLength(0) // Guidance is not an unconditional fan-out scheduler.
  })
  test("specialist children do not receive coordinator delegation encouragement", async () => {
    const f = await fixture()
    const result = await f.invoke({})
    const event = { sessionID: result.metadata.sessionID, agent: "explore", system: [], options: {} }
    await f.hooks.get("context")(event)
    expect(event.system).toEqual([])
  })
  test("Go uses its actual Console integration instead of assuming the provider ID is the credential integration", async () => {
    const f = await fixture(true)
    const result = await f.invoke({ agent: "general" })
    const execution = f.ledger.forChild(result.metadata.sessionID)!
    expect(execution.candidate.ref.providerID).toBe("opencode-go")
    expect(execution.candidate.account.credentialID).toBe("cred_console")
  })
  test("failed setup retains a deny gate instead of exposing native dispatch", async () => {
    let calls = 0
    const tool: any = { execute: async () => { calls++; return { content: "unsafe" } } }
    const ctx: any = { options: {}, tool: { transform: async (fn: any) => fn({ update: (_id: string, mutate: any) => mutate(tool) }) } }
    const client: any = { config: { enabled: true } }
    await setupRouter(ctx, client, defaultPolicy()) // registration fails: no model API
    await expect(tool.execute({ model: "oneprovider/claude-opus-5-5" }, {})).rejects.toThrow("Delegation is blocked")
    expect(calls).toBe(0)
  })
  test("paused routing is not an unrestricted fallback", async () => {
    let calls = 0
    const tool: any = { execute: async () => { calls++; return { content: "unsafe" } } }
    const ctx: any = { options: {}, tool: { transform: async (fn: any) => fn({ update: (_id: string, mutate: any) => mutate(tool) }) } }
    await setupRouter(ctx, { config: { enabled: false } } as any, defaultPolicy())
    await expect(tool.execute({}, {})).rejects.toThrow("blocked")
    expect(calls).toBe(0)
  })
  test("concurrent tasks choose different models without changing the primary", async () => {
    const f = await fixture(); const before = structuredClone(f.parent.model)
    await Promise.all([f.invoke({ routing: { tier: "LOW" } }), f.invoke({ routing: { tier: "HARD" } })])
    expect(new Set(f.calls.map(c => c.model))).toEqual(new Set([defaultPolicy().aliases["gemini-medium"], defaultPolicy().aliases.deepseek]))
    expect(f.parent.model).toEqual(before)
  })
  test("Plan cannot dispatch the implementation role", async () => {
    const f = await fixture()
    await expect(f.invoke({ agent: "general" }, "plan")).rejects.toThrow("Plan cannot")
    expect(f.calls).toHaveLength(0)
  })
  test("paid or forbidden explicit models never reach native dispatch", async () => {
    const f = await fixture()
    for (const model of [defaultPolicy().aliases.opus, defaultPolicy().aliases.kimi, "openai/gpt-6.1-sol#max"]) await expect(f.invoke({ model })).rejects.toThrow("No eligible")
    expect(f.calls).toHaveLength(0)
  })
  test("foreground completion releases only the execution slot", async () => {
    const f = await fixture(); const result = await f.invoke({})
    const e = f.ledger.forChild(result.metadata.sessionID)!
    expect(e.state).toBe("completed"); expect(f.ledger.concurrency(e.candidate.account.key)).toBe(0)
    expect(result.metadata.routing.model).toBe(defaultPolicy().aliases["gemini-high"])
  })
  test("background dispatch retains capacity and uses durable run sequence for completion", async () => {
    const f = await fixture(); const result = await f.invoke({ background: true })
    const e = f.ledger.forChild(result.metadata.sessionID)!
    expect(e.state).toBe("running")
    f.push({ type: "session.execution.succeeded", created: Date.now(), durable: { seq: 1 }, data: { sessionID: e.childSessionID } })
    await Bun.sleep(5)
    expect(f.ledger.get(e.id)!.state).toBe("running") // no observed start: fail closed
    f.push({ type: "session.execution.started", created: Date.now(), durable: { seq: 2 }, data: { sessionID: e.childSessionID } })
    f.push({ type: "session.execution.succeeded", created: Date.now(), durable: { seq: 3 }, data: { sessionID: e.childSessionID } })
    await Bun.sleep(5)
    expect(f.ledger.get(e.id)!.state).toBe("completed")
  })
  test("continuation keeps the child's model and rejects model switching", async () => {
    const f = await fixture(); const first = await f.invoke({ routing: { tier: "LOW" } })
    await f.invoke({ sessionID: first.metadata.sessionID, routing: { tier: "HARD" } })
    expect(f.calls[1].model).toBe(f.calls[0].model)
    await expect(f.invoke({ sessionID: first.metadata.sessionID, model: defaultPolicy().aliases["sol-high"] })).rejects.toThrow("new child")
  })
  test("critic gets actual original session provenance", async () => {
    const f = await fixture(); const original = await f.invoke({ routing: { tier: "LOW" } })
    await f.invoke({ agent: "critic", routing: { originSessionID: original.metadata.sessionID } })
    expect(f.calls[1].model).toBe(defaultPolicy().aliases.deepseek)
    expect(f.calls[1].prompt).toContain(defaultPolicy().aliases["gemini-medium"])
  })
  test("primary request hooks do not consult a down router", async () => {
    const f = await fixture()
    f.client.call = async () => { throw new Error("Router down") }
    const event = { sessionID: f.parent.id, agent: "build", system: [], options: {}, headers: {} }
    await f.hooks.get("context")(event)
    await f.hooks.get("model.request")(event)
    expect(event.headers).toEqual({})
  })
})
