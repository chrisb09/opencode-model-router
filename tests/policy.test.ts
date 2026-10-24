import { describe, expect, test } from "bun:test"
import { defaultPolicy, loadPolicy, assertLocalUrl } from "../src/config.ts"
import { recommend, parseModel, familyOf } from "../src/policy.ts"
import { models, accounts, task, now } from "./fixtures.ts"
import { roles, tiers } from "../src/types.ts"

const choose = (t = task(), a = accounts(), m = models()) => recommend(defaultPolicy(), t, m, a, now).candidates.find(c => !c.rejected.length)
describe("agreed policy", () => {
  test("default policy validates", async () => { expect(await loadPolicy()).toEqual(defaultPolicy()) })
  for (const role of roles) for (const tier of tiers) {
    test(`${role}/${tier} has an eligible subscription route`, () => {
      const selected = choose(task({ role, tier, originModel: "antigravity/antigravity-gemini-3.8-flash#high" }))
      expect(selected).toBeDefined()
      expect(selected!.ref.variant).not.toBe("xhigh")
      expect(selected!.family).not.toBe("opus")
      expect(selected!.family).not.toBe("kimi")
    })
  }
  test("explore exceptional uses Sol medium", () => expect(choose(task({ tier: "EXCEPTIONAL" }))!.ref.variant).toBe("medium"))
  test("research exceptional uses Sol high", () => expect(choose(task({ role: "research", tier: "EXCEPTIONAL" }))!.ref.variant).toBe("high"))
  test("implementation default uses DeepSeek max", () => expect(choose(task({ role: "general" }))!.model).toBe(defaultPolicy().aliases.deepseek))
  test("no specified Opus effort", () => expect(defaultPolicy().aliases.opus).toBe("oneprovider/claude-opus-5-5"))
  test("Plan cannot launch general", () => expect(choose(task({ role: "general", parentAgent: "plan" }))).toBeUndefined())
  test("children cannot recurse", () => expect(choose(task({ parentAgent: "research" }))).toBeUndefined())
  test("weekly exhaustion blocks otherwise abundant account", () => {
    const a = accounts(); a.filter(a => a.providerID === "antigravity").forEach(a => a.windows[1].remainingPct = 0)
    expect(choose(task(), a)!.family).toBe("deepseek")
  })
  test("monthly exhaustion blocks Go", () => {
    const a = accounts(); a.find(a => a.providerID === "opencode-go")!.windows[2].remainingPct = 0
    expect(choose(task({ role: "general" }), a)!.family).toBe("gemini")
  })
  test("unknown allowance is not unlimited", () => {
    const a = accounts(); a.forEach(a => a.windows.forEach(w => w.remainingPct = null))
    expect(choose(task(), a)).toBeUndefined()
  })
  test("missing window is represented as unknown by normalization", () => {
    const a = accounts(); a.forEach(a => a.windows = [])
    expect(choose(task(), a)).toBeUndefined()
  })
  test("stale observations block dispatch", () => {
    const a = accounts(); a.forEach(a => a.windows.forEach(w => w.checkedAt = now - 3600000))
    expect(choose(task(), a)).toBeUndefined()
  })
  test("future-dated observations cannot release intervening request debt", () => {
    const a = accounts(); a.forEach(a => a.windows.forEach(w => w.checkedAt = now + 30000))
    expect(choose(task(), a)).toBeUndefined()
  })
  test("a passed reset does not manufacture replenishment", () => {
    const a = accounts(); a.forEach(a => a.windows[0].resetAt = new Date(now - 1).toISOString())
    expect(choose(task(), a)).toBeUndefined()
  })
  test("Sol input cap differs from total context", () => expect(choose(task({ requestedModel: defaultPolicy().aliases["sol-high"], inputTokens: 500001 }))).toBeUndefined())
  test("output budget and context are checked together", () => expect(choose(task({ inputTokens: 999000, outputTokens: 4096 }))).toBeUndefined())
  test("capabilities filter before selection", () => expect(choose(task({ modalities: ["audio"] }))).toBeUndefined())
  test("unknown provider and forbidden variants cannot bypass routing", () => {
    for (const model of ["openai/gpt-6.1-sol#xhigh", "openai/gpt-6.1-sol#max", "openrouter/anthropic/claude-opus-5.5", "opencode-go/deepseek-v4.1-pro#max"]) expect(choose(task({ requestedModel: model }))).toBeUndefined()
  })
  test("Opus and Kimi remain locked even if policy booleans alone are changed", () => {
    const p = defaultPolicy(); p.allowPaid = true; p.allowKimi = true; p.totalBudgetUsd = 10; p.maxTaskUsd = 5
    for (const name of [p.aliases.opus, p.aliases.kimi]) expect(recommend(p, task({ requestedModel: name }), models(), accounts(), now).candidates.every(c => c.rejected.length)).toBe(true)
  })
  for (const [origin, preferred] of [["gemini", "deepseek"], ["deepseek", "sol"], ["sol", "deepseek"], ["kimi", "sol"], ["opus", "sol"]] as const) {
    test(`critic after ${origin} prefers ${preferred}`, () => {
      const names: Record<string, string> = { gemini: defaultPolicy().aliases["gemini-high"], deepseek: defaultPolicy().aliases.deepseek, sol: defaultPolicy().aliases["sol-high"], kimi: defaultPolicy().aliases.kimi, opus: defaultPolicy().aliases.opus }
      expect(choose(task({ role: "critic", originModel: names[origin] }))!.family).toBe(preferred)
    })
  }
  test("critic requires recognized provenance", () => expect(choose(task({ role: "critic" }))).toBeUndefined())
  test("different provider alias is not family independence", () => {
    expect(familyOf("oneprovider/deepseek-v4.1-flash")).toBe(familyOf(defaultPolicy().aliases.deepseek))
    expect(choose(task({ role: "critic", originModel: "oneprovider/deepseek-v4.1-flash", requestedModel: defaultPolicy().aliases.deepseek }))).toBeUndefined()
  })
  test("hard reserve cannot be bypassed by critical importance", () => {
    const a = accounts(); a.forEach(a => a.windows.forEach(w => w.remainingPct = 2))
    expect(choose(task({ importance: "critical" }), a)).toBeUndefined()
  })
  test("remote or credential-bearing router URLs are refused", () => {
    for (const url of ["https://example.com", "http://localhost:7695", "http://a:b@127.0.0.1:7695", "http://127.0.0.1:7695/path"]) expect(() => assertLocalUrl(url)).toThrow()
  })
  test("parses model IDs containing slashes", () => expect(parseModel("p/a/b#high")).toEqual({ providerID: "p", id: "a/b", variant: "high" }))
  test("unsupported mixed native/AI SDK subscription transport is rejected before dispatch", () => {
    const m = models(); m.find(m => m.providerID === "openai")!.package = "aisdk:@ai-sdk/openai"
    expect(choose(task({ requestedModel: defaultPolicy().aliases["sol-high"] }), accounts(), m)).toBeUndefined()
  })
})
