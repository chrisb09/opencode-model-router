import { afterEach, describe, expect, test } from "bun:test"
import { Ledger } from "../src/ledger.ts"
import { RouterService } from "../src/service.ts"
import { RouterClient } from "../src/client.ts"
import { defaultPolicy } from "../src/config.ts"
import { models, bindings, snapshot, task, jwt } from "./fixtures.ts"

const open: Ledger[] = []
afterEach(() => open.splice(0).forEach(l => l.close()))
async function fixture() {
  const ledger = new Ledger(":memory:"); open.push(ledger)
  const seen: any[] = []
  const config = { url: "http://127.0.0.1:7695", collectorUrl: "https://quota.example.com", enabled: true }
  const service = new RouterService(config, defaultPolicy(), ledger, "secret-local-token", (async () => Response.json(snapshot())) as unknown as typeof fetch,
    (async (url: any, init: any) => { seen.push({ url, ...init }); return new Response('data: {"response":{"usage":{"input_tokens":100,"output_tokens":50}}}\n\ndata: [DONE]\n', { headers: { "content-type": "text/event-stream" } }) }) as typeof fetch)
  const client = new RouterClient(config, "secret-local-token", ((u: any, init: any) => service.fetch(new Request(u, init))) as typeof fetch)
  await client.call("/registry", { directory: "/test", models: models(), bindings: bindings("secret-local-token") })
  const e = await client.call("/reserve", { id: "native", task: task({ requestedModel: defaultPolicy().aliases["sol-high"] }) })
  await client.call("/bind", { id: e.id, childSessionID: "ses_native" })
  const send = (body: any, target = "https://chatgpt.com/backend-api/codex/responses", bearer = jwt()) => service.fetch(new Request(config.url + "/proxy", { method: "POST", headers: { "x-router-token": client.token, "x-router-execution": e.id, "x-router-target": target, "x-opencode-router-model": e.candidate.model, authorization: "Bearer " + bearer, "content-type": "application/json" }, body: JSON.stringify(body) }))
  return { ledger, service, client, seen, e, send }
}
describe("native physical-request boundary", () => {
  test("caps output and strips local authority before forwarding", async () => {
    const f = await fixture()
    const response = await f.send({ model: "gpt-6.1-sol", input: "test", max_output_tokens: 100000 })
    expect(response.status).toBe(200); await response.text()
    expect(f.seen).toHaveLength(1)
    expect(JSON.parse(f.seen[0].body).max_output_tokens).toBe(f.e.candidate.outputTokens)
    expect(f.seen[0].headers.get("authorization")).toBe("Bearer " + jwt())
    expect([...f.seen[0].headers.keys()].some((k: string) => k.startsWith("x-router-") || k.startsWith("x-opencode-router-"))).toBe(false)
    const row: any = f.ledger.db.query("SELECT * FROM requests").get()
    expect(JSON.parse(row.usage)).toMatchObject({ inputTokens: 100, outputTokens: 50, status: "completed" })
  })
  test("a different wire model is denied even on an allowed host", async () => {
    const f = await fixture(); const response = await f.send({ model: "gpt-paid-other", input: "test" })
    expect(response.status).toBe(409); expect(f.seen).toHaveLength(0)
  })
  test("an oversized request is denied before any upstream bytes are sent", async () => {
    const f = await fixture(); const response = await f.send({ model: "gpt-6.1-sol", input: "x".repeat(501000) })
    expect(response.status).toBe(409); expect(f.seen).toHaveLength(0)
  })
  test("quota exhaustion between dispatch and request is enforced", async () => {
    const f = await fixture(); f.service.source.snapshot!.accounts.forEach(a => a.quotas.forEach((q: any) => q.remaining = 0))
    expect((await f.send({ model: "gpt-6.1-sol", input: "test" })).status).toBe(409)
    expect(f.seen).toHaveLength(0)
  })
  test("cannot follow redirects to a different endpoint", async () => {
    const f = await fixture(); const response = await f.send({ model: "gpt-6.1-sol", input: "test" }); await response.text()
    expect(f.seen[0].redirect).toBe("error")
  })
  test("another valid-looking account token cannot consume the reserved quota", async () => {
    const f = await fixture(); const response = await f.send({ model: "gpt-6.1-sol", input: "test" }, undefined, jwt("other-account"))
    expect(response.status).toBe(409); expect(f.seen).toHaveLength(0)
    expect(await response.text()).toContain("credential does not match")
  })
  test("Mistral proxy settles a streamed request using actual cache and output usage", async () => {
    const ledger = new Ledger(":memory:"); open.push(ledger)
    const config = { url: "http://127.0.0.1:7695", collectorUrl: "https://quota.example.com", enabled: true }
    const policy = defaultPolicy(), catalog = models()
    const model = catalog.find(m => m.providerID === "mistral" && m.id === "deepseek-v4-1-flash-1017")!
    model.cost = [{ input: 0.3, output: 1.2, cache: { read: 0.007, write: 0 } }]
    const service = new RouterService(config, policy, ledger, "secret-local-token", (async () => Response.json(snapshot())) as unknown as typeof fetch,
      (async () => new Response('data: {"usage":{"prompt_tokens":1000,"prompt_tokens_details":{"cached_tokens":400},"completion_tokens":100}}\n\ndata: [DONE]\n', { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch)
    const client = new RouterClient(config, "secret-local-token", ((u: any, init: any) => service.fetch(new Request(u, init))) as typeof fetch)
    await client.call("/registry", { directory: "/test", models: catalog, bindings: bindings("secret-local-token") })
    const e = await client.call("/reserve", { id: "mistral-native", task: task({ requestedModel: policy.aliases["deepseek-1017-high"] }) })
    await client.call("/bind", { id: e.id, childSessionID: "ses_mistral_native" })
    const response = await service.fetch(new Request(config.url + "/proxy", { method: "POST", headers: { "x-router-token": client.token, "x-router-execution": e.id, "x-router-target": "https://api.mistral.ai/v1/chat/completions", authorization: "Bearer test-go-key", "content-type": "application/json" }, body: JSON.stringify({ model: model.id, messages: [], max_tokens: 1024 }) }))
    expect(response.status).toBe(200); await response.text()
    const row: any = ledger.db.query("SELECT estimate_pp,usage FROM requests").get()
    expect(row.estimate_pp).toBeCloseTo(((600 * 0.3 + 400 * 0.007 + 100 * 1.2) / 1_000_000) * 100 / 150, 12)
    expect(JSON.parse(row.usage)).toMatchObject({ inputTokens: 1000, cacheReadTokens: 400, outputTokens: 100, status: "completed" })
  })
})
