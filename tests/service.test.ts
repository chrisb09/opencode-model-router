import { afterEach, describe, expect, test } from "bun:test"
import { Ledger } from "../src/ledger.ts"
import { RouterService } from "../src/service.ts"
import { RouterClient } from "../src/client.ts"
import { defaultPolicy } from "../src/config.ts"
import { normalize, QuotaSource } from "../src/collector.ts"
import { UsageParser, measuredStream } from "../src/stream.ts"
import { models, bindings, snapshot, task, now } from "./fixtures.ts"
import { agentDefinitions } from "../src/agents.ts"
import { roles } from "../src/types.ts"

const open: Ledger[] = []
afterEach(() => open.splice(0).forEach(l => l.close()))
export function serviceFixture(overrides: Record<string, unknown> = {}) {
  const ledger = new Ledger(":memory:"); open.push(ledger)
  const config = { url: "http://127.0.0.1:7695", collectorUrl: "https://quota.example.com", enabled: true, ...overrides } as any
  const service = new RouterService(config, defaultPolicy(), ledger, "test-token", (async () => Response.json(snapshot())) as unknown as typeof fetch)
  const client = new RouterClient(config, "test-token", ((url: any, init: any) => service.fetch(new Request(url, init))) as typeof fetch)
  return { ledger, service, client }
}
describe("private service API", () => {
  test("requires authentication and rejects browser origins", async () => {
    const { service } = serviceFixture()
    expect((await service.fetch(new Request("http://127.0.0.1:7695/status"))).status).toBe(401)
    expect((await service.fetch(new Request("http://127.0.0.1:7695/status", { headers: { "x-router-token": "test-token", origin: "https://evil.example.com" } }))).status).toBe(403)
  })
  test("unregistered locations fail closed", async () => {
    const { client } = serviceFixture()
    await expect(client.call("/recommend", { task: task() })).rejects.toThrow("registry")
  })
  test("registered model metadata enables recommendation and reservation", async () => {
    const { client } = serviceFixture()
    await client.call("/registry", { directory: "/test", models: models(), bindings: bindings() })
    const recommended = await client.call("/recommend", { task: task() })
    expect(recommended.candidates[0].rejected).toHaveLength(0)
    const e = await client.call("/reserve", { id: "test", task: task() })
    expect(e.candidate.family).toBe("gemini")
    expect((await client.call("/status")).safeguards.paidDispatch).toBe("locked")
  })
  test("test account pins and test tasks are rejected outside test mode", async () => {
    const { client } = serviceFixture()
    await client.call("/registry", { directory: "/test", models: models(), bindings: bindings() })
    await expect(client.call("/reserve", { id: "pin", task: task({ accountKey: "google:a@example.com" }) })).rejects.toThrow("test mode")
    await expect(client.call("/reserve", { id: "test", task: task({ test: true }) })).rejects.toThrow("test mode")
  })
  test("test mode disables concurrency admission and exposes its status", async () => {
    const { client, service, ledger } = serviceFixture({ testMode: true })
    await client.call("/registry", { directory: "/test", models: models(), bindings: bindings() })
    for (let i = 0; i < 5; i++) {
      const e = await client.call("/reserve", { id: `pin_${i}`, task: task({ requestedModel: defaultPolicy().aliases["gemini-high"], accountKey: "google:a@example.com", test: true }) })
      expect(e.candidate.account.key).toBe("google:a@example.com")
      ledger.bind(e.id, `ses_pin_${i}`, now)
    }
    const status = await client.call("/status")
    expect(status.testMode).toBe(true)
    expect(status.safeguards.concurrencyChecks).toBe("disabled (test mode)")
    expect(status.safeguards.accountPinning).toBe("test-only")
    expect(service.router.testMode).toBe(true)
  })
  test("invalid schemas cannot authorize paid spending", async () => {
    const { client } = serviceFixture()
    await expect(client.call("/reserve", { id: "test", task: { ...task(), authorizePaid: true } })).rejects.toThrow("Invalid")
  })
  test("native proxy refuses arbitrary destinations before making an upstream call", async () => {
    const { client, service, ledger } = serviceFixture()
    await client.call("/registry", { directory: "/test", models: models(), bindings: bindings() })
    const e = await client.call("/reserve", { id: "native", task: task({ requestedModel: defaultPolicy().aliases["sol-high"] }) })
    ledger.bind(e.id, "ses_child", now)
    const response = await service.fetch(new Request("http://127.0.0.1:7695/proxy", { method: "POST", headers: { "x-router-token": "test-token", "x-router-execution": e.id, "x-router-target": "http://169.254.169.254/latest/meta-data" }, body: "{}" }))
    expect(response.status).toBe(409)
    expect(await response.text()).toContain("Unsupported native transport")
  })
  test("new policy never logs prompts or provider credentials", async () => {
    const { client } = serviceFixture()
    await client.call("/registry", { directory: "/test", models: models(), bindings: bindings() })
    await client.call("/reserve", { id: "test", task: task() })
    const output = JSON.stringify(await client.call("/status"))
    expect(output).not.toContain("authorization")
    expect(output).not.toContain("prompt")
  })
})
describe("quota source normalization", () => {
  test("all independent windows survive normalization", () => {
    const a = normalize(snapshot(), bindings())
    expect(a.find(a => a.providerID === "opencode-go")!.windows).toHaveLength(3)
    expect(a.find(a => a.providerID === "antigravity")!.windows).toHaveLength(2)
  })
  test("missing short window remains unknown", () => {
    const s = snapshot(); s.accounts[0].quotas = []
    expect(normalize(s, bindings())[0].windows.every(w => w.remainingPct === null && w.source === "unknown")).toBe(true)
  })
  test("OpenAI API-key auth is not Codex OAuth allowance", () => {
    const b = bindings(); b.find(b => b.providerID === "openai")!.method = "key"
    expect(normalize(snapshot(), b).find(a => a.providerID === "openai")!.active).toBe(false)
  })
  test("unknown raw Go units do not become 100% allowance", () => {
    const s = snapshot(); const a = s.accounts.find(a => a.accountKey === "opencode-go:default")
    a.quotas[0].remaining = 1; a.quotas[0].raw = {}
    expect(normalize(s, bindings()).find(a => a.providerID === "opencode-go")!.windows[0].remainingPct).toBeNull()
  })
  test("concurrent refresh requests share one collector request and cooldown", async () => {
    let refreshes = 0, reads = 0
    const source = new QuotaSource({ url: "http://127.0.0.1:7695", collectorUrl: "https://quota.example.com", enabled: true }, (async (url: string) => {
      await Bun.sleep(1); if (url.endsWith("refresh")) refreshes++; else reads++
      return Response.json(url.endsWith("refresh") ? {} : snapshot())
    }) as typeof fetch)
    await Promise.all([source.get(true), source.get(true), source.get(true)])
    await source.get(true)
    expect(refreshes).toBe(1); expect(reads).toBe(2)
  })
  test("provider fetch errors are sanitized", async () => {
    const source = new QuotaSource({ url: "http://127.0.0.1:7695", collectorUrl: "https://quota.example.com", enabled: true }, (async () => { throw new Error("Bearer secret-value") }) as unknown as typeof fetch)
    await expect(source.get()).rejects.toThrow("unavailable")
    expect(source.lastError).not.toContain("secret-value")
  })
})
describe("stream usage correlation", () => {
  test("parses chunked Responses and chat usage without retaining output", () => {
    const p = new UsageParser()
    p.push('data: {"response":{"usage":{"input_tokens":12,"output_tokens":8,"output_tokens_details":{"reasoning_tokens":3}}')
    p.push('}}\n\n')
    expect(p.usage).toMatchObject({ inputTokens: 12, outputTokens: 8, reasoningTokens: 3 })
    p.push('data: {"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\ndata: [DONE]\n')
    expect(p.usage.inputTokens).toBe(20)
  })
  test("stream cancellation retains uncertain usage", async () => {
    const usages: any[] = []
    const source = new ReadableStream<Uint8Array>({ pull() {} })
    const guarded = measuredStream(source, u => usages.push(u), performance.now())
    await guarded.cancel()
    expect(usages).toHaveLength(1); expect(usages[0].status).toBe("uncertain")
  })
})
describe("agent permissions and primary modes", () => {
  const rules = agentDefinitions(defaultPolicy())
  const effect = (id: string, action: string, resource = "*") => rules[id].permissions.filter((r: any) => (r.action === "*" || r.action === action) && (r.resource === "*" || r.resource === resource)).at(-1)?.effect
  test("no extra primary agents or pinned primary models", () => {
    for (const id of ["plan", "build"]) expect(rules[id].model).toBeUndefined()
    for (const id of roles) expect(rules[id].mode).toBe("subagent")
  })
  test("Plan cannot use general or mutate through MCP", () => {
    expect(effect("plan", "todowrite")).toBe("allow")
    expect(effect("plan", "workflow_annotate")).toBe("allow")
    expect(effect("build", "workflow_annotate")).toBe("allow")
    expect(effect("plan", "subagent", "general")).toBe("deny")
    expect(effect("plan", "subagent", "reviewer")).toBe("allow")
    expect(effect("plan", "observatory_setup")).toBe("deny")
    expect(effect("plan", "shell")).toBe("deny")
  })
  test("read-only agents cannot write, use arbitrary shell, or recurse", () => {
    for (const id of ["explore", "research", "reviewer", "architect", "critic"]) {
      expect(effect(id, "edit")).toBe("deny"); expect(effect(id, "shell")).toBe("deny"); expect(effect(id, "subagent")).toBe("deny")
    }
  })
  test("local explore and external research have different tools", () => {
    expect(effect("explore", "webfetch")).toBe("deny")
    expect(effect("research", "webfetch")).toBe("allow")
    expect(effect("debugger", "shell")).toBe("ask")
    expect(effect("general", "shell")).toBe("ask")
  })
})
