import { afterEach, describe, expect, test } from "bun:test"
import { Ledger } from "../src/ledger.ts"
import { RouterService } from "../src/service.ts"
import { RouterClient } from "../src/client.ts"
import { defaultPolicy } from "../src/config.ts"
import { models, bindings, snapshot, task, now } from "./fixtures.ts"
import { guardLanguage } from "../plugin/guard.ts"

const open: Ledger[] = []
afterEach(() => open.splice(0).forEach(l => l.close()))
async function fixture() {
  const ledger = new Ledger(":memory:"); open.push(ledger)
  const config = { url: "http://127.0.0.1:7695", collectorUrl: "https://quota.example.com", enabled: true }
  const service = new RouterService(config, defaultPolicy(), ledger, "test-token", (async () => Response.json(snapshot())) as unknown as typeof fetch)
  const client = new RouterClient(config, "test-token", ((url: any, init: any) => service.fetch(new Request(url, init))) as typeof fetch)
  await client.call("/registry", { directory: "/test", models: models(), bindings: bindings() })
  const e = await client.call("/reserve", { id: "guard-test", task: task() }); ledger.bind(e.id, "ses_child", now)
  return { ledger, service, client, e }
}
const usage = { inputTokens: { total: 30, noCache: 20, cacheRead: 10 }, outputTokens: { total: 20, text: 15, reasoning: 5 } }
const options = (id: string, model: string): any => ({ prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }], headers: { "x-opencode-router-execution": id, "x-opencode-router-model": model }, maxOutputTokens: 100000 })
const selected = { providerID: "antigravity", id: "antigravity-gemini-3.8-flash", modelID: "antigravity-gemini-3.8-flash" }
const wrap = (inner: any, client: RouterClient) => guardLanguage(inner, client, selected)
const inner = (generate: (options: any) => any, stream?: (options: any) => any): any => ({ specificationVersion: "v3", provider: "test", modelId: selected.modelID, supportedUrls: {}, doGenerate: generate, doStream: stream })
describe("request-scoped AI SDK guard", () => {
  test("caps output, pins the reserved account and records measured usage", async () => {
    const { client, e, ledger } = await fixture()
    let seen: any
    const guarded = wrap(inner(async o => { seen = o; return { usage } }), client)
    await guarded.doGenerate(options(e.id, e.candidate.model))
    expect(seen.maxOutputTokens).toBe(e.candidate.outputTokens)
    expect(seen.headers["x-opencode-router-account"]).toBe(e.candidate.account.label)
    const row: any = ledger.db.query("SELECT * FROM requests").get()
    expect(JSON.parse(row.usage)).toMatchObject({ inputTokens: 30, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 10 })
  })
  test("primary calls are untouched", async () => {
    const { client, ledger } = await fixture()
    const original: any = { prompt: [], maxOutputTokens: 111 }
    let seen: any
    await wrap(inner(async o => { seen = o; return { usage } }), client).doGenerate(original)
    expect(seen).toBe(original)
    expect(ledger.db.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 0 })
  })
  test("denies a changed model/variant before calling the provider", async () => {
    const { client, e } = await fixture(); let calls = 0
    const guarded = wrap(inner(async () => { calls++; return { usage } }), client)
    await expect(guarded.doGenerate(options(e.id, "openai/gpt-6.1-sol#max"))).rejects.toThrow("changed")
    expect(calls).toBe(0)
  })
  test("quota exhaustion after dispatch prevents further calls", async () => {
    const { client, service, e } = await fixture(); let calls = 0
    service.source.snapshot!.accounts.forEach(a => a.quotas.forEach((q: any) => q.remaining = 0))
    const guarded = wrap(inner(async () => { calls++; return { usage } }), client)
    await expect(guarded.doGenerate(options(e.id, e.candidate.model))).rejects.toThrow("eligible")
    expect(calls).toBe(0)
  })
  test("cancellation preserves uncertain debt", async () => {
    const { client, e, ledger } = await fixture()
    const guarded = wrap(inner(async () => ({ usage }), async () => ({ stream: new ReadableStream({ pull() {} }) })), client)
    const response = await guarded.doStream(options(e.id, e.candidate.model))
    await response.stream.cancel()
    expect((ledger.db.query("SELECT state FROM requests").get() as any).state).toBe("uncertain")
  })
  test("stream errors cannot be relabeled completed", async () => {
    const { client, e, ledger } = await fixture()
    const guarded = wrap(inner(async () => ({ usage }), async () => ({ stream: new ReadableStream({ start(c) { c.enqueue({ type: "error", error: "failure" }); c.close() } }) })), client)
    for await (const _ of (await guarded.doStream(options(e.id, e.candidate.model))).stream) {}
    expect((ledger.db.query("SELECT state FROM requests").get() as any).state).toBe("uncertain")
  })
  test("native/non-native context is not shared between concurrent requests", async () => {
    const { client, e, ledger } = await fixture()
    const second = await client.call("/reserve", { id: "second", task: task() }); ledger.bind(second.id, "ses_second", now)
    const seen: any[] = []
    const guarded = wrap(inner(async o => { await Bun.sleep(1); seen.push(o.headers); return { usage } }), client)
    await Promise.all([guarded.doGenerate(options(e.id, e.candidate.model)), guarded.doGenerate(options(second.id, second.candidate.model))])
    expect(new Set(seen.map(s => s["x-opencode-router-execution"])).size).toBe(2)
    expect(ledger.db.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 2 })
  })
  test("forged headers cannot authorize a different model object", async () => {
    const { client, e } = await fixture(); let calls = 0
    const wrong = { ...inner(async () => { calls++; return { usage } }), modelId: "different-model" }
    await expect(wrap(wrong, client).doGenerate(options(e.id, e.candidate.model))).rejects.toThrow("model object")
    expect(calls).toBe(0)
  })
})
