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
  test("implementation default prefers the pace-ahead Mistral DeepSeek", () => {
    const selected = choose(task({ role: "general" }))!
    expect(selected.family).toBe("deepseek")
    expect(selected.model).toBe(defaultPolicy().aliases["deepseek-1017"])
    expect(selected.account.key).toBe("mistral-code:default")
  })
  test("quota pace prefers the account furthest ahead of its window progression", () => {
    // A fresh full Mistral window is behind pace; Go windows nearly expired
    // with quota to spare are ahead of it, so the shared rank picks Go.
    const a = accounts()
    a.find(x => x.providerID === "mistral")!.windows[0].resetAt = new Date(now + 2592000000).toISOString()
    const go = a.find(x => x.providerID === "opencode-go")!
    go.windows[0].resetAt = new Date(now + 1800000).toISOString()
    go.windows[1].resetAt = new Date(now + 60480000).toISOString()
    go.windows[2].resetAt = new Date(now + 259200000).toISOString()
    const selected = choose(task({ role: "general" }), a)!
    expect(selected.model).toBe(defaultPolicy().aliases.deepseek)
    expect(selected.account.key).toBe("opencode-go:default")
    expect(selected.reasons).toContain("Quota ahead of window progression")
  })
  test("a group member hitting its reserve falls through to the other DeepSeek", () => {
    const a = accounts(); a.find(x => x.providerID === "mistral")!.windows[0].remainingPct = 0
    const selected = choose(task({ role: "general" }), a)!
    expect(selected.family).toBe("deepseek")
    expect(selected.account.key).toBe("opencode-go:default")
  })
  test("exhausting both DeepSeek accounts fails closed", () => {
    const a = accounts()
    a.find(x => x.providerID === "mistral")!.windows[0].remainingPct = 0
    a.find(x => x.providerID === "opencode-go")!.windows[2].remainingPct = 0
    expect(choose(task({ role: "general" }), a)).toBeUndefined()
  })
  test("catalog-level rejection of both DeepSeeks fails closed for general", () => {
    const m = models().filter(m => !((m.providerID === "mistral" && m.id === "deepseek-v4-1-flash-1017") || (m.providerID === "opencode-go" && m.id === "deepseek-v4.1-flash")))
    expect(choose(task({ role: "general" }), accounts(), m)).toBeUndefined()
  })
  test("LOW uses DeepSeek Flash at low effort instead of GLM Flash", () => {
    const selected = choose(task({ tier: "LOW" }))!
    expect(selected.family).toBe("deepseek")
    expect(selected.ref.variant).toBe("low")
    expect(selected.model).toBe(defaultPolicy().aliases["deepseek-1017-low"])
  })
  test("critic LOW falls to GLM Flash when the origin is DeepSeek", () => {
    const selected = choose(task({ role: "critic", tier: "LOW", originModel: defaultPolicy().aliases["deepseek-1017-low"] }))!
    expect(selected.model).toBe(defaultPolicy().aliases["glm-flash"])
  })
  test("designer exceptional uses Opus when paid dispatch is enabled", () => {
    const p = defaultPolicy(); p.allowPaid = true; p.maxTaskUsd = 5; p.totalBudgetUsd = 10
    const selected = recommend(p, task({ role: "designer", tier: "EXCEPTIONAL" }), models(), accounts(), now).candidates.find(c => !c.rejected.length)!
    expect(selected.family).toBe("opus")
  })
  test("no specified Opus effort", () => expect(defaultPolicy().aliases.opus).toBe("oneprovider/claude-opus-5-5"))
  test("Plan cannot launch general", () => expect(choose(task({ role: "general", parentAgent: "plan" }))).toBeUndefined())
  test("children cannot recurse", () => expect(choose(task({ parentAgent: "research" }))).toBeUndefined())
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
  test("global concurrency cap blocks all candidates when saturated", () => {
    const p = defaultPolicy()
    const result = recommend(p, task(), models(), accounts(), now, () => 0, () => 0, () => 0, () => p.quota.maxConcurrentTotal!)
    expect(result.candidates.every(c => c.rejected.includes("Concurrent total capacity reached"))).toBe(true)
  })
  test("test account pin restricts candidates to the requested account", () => {
    const selected = choose(task({ requestedModel: defaultPolicy().aliases["glm-flash"], accountKey: "mistral-code:default" }))
    expect(selected?.account.key).toBe("mistral-code:default")
    expect(choose(task({ requestedModel: defaultPolicy().aliases["glm-flash"], accountKey: "mistral-code:missing" }))).toBeUndefined()
  })
  test("Sol input cap differs from total context", () => expect(choose(task({ requestedModel: defaultPolicy().aliases["sol-high"], inputTokens: 500001 }))).toBeUndefined())
  test("output budget and context are checked together", () => expect(choose(task({ inputTokens: 999000, outputTokens: 4096 }))).toBeUndefined())
  test("capabilities filter before selection", () => expect(choose(task({ modalities: ["audio"] }))).toBeUndefined())
  test("unknown provider and forbidden variants cannot bypass routing", () => {
    for (const model of ["openai/gpt-6.1-sol#xhigh", "openai/gpt-6.1-sol#max", "openrouter/anthropic/claude-opus-5.5", "opencode-go/deepseek-v4.1-pro#max"]) expect(choose(task({ requestedModel: model }))).toBeUndefined()
  })
  test("Opus and Kimi are locked by default policy and unlockable via policy booleans", () => {
    const def = defaultPolicy()
    for (const name of [def.aliases.opus, def.aliases.kimi]) expect(recommend(def, task({ requestedModel: name }), models(), accounts(), now).candidates.every(c => c.rejected.length)).toBe(true)
    const p = defaultPolicy(); p.allowPaid = true; p.allowKimi = true; p.totalBudgetUsd = 10; p.maxTaskUsd = 5
    for (const name of [p.aliases.opus, p.aliases.kimi]) expect(recommend(p, task({ requestedModel: name }), models(), accounts(), now).candidates.some(c => c.rejected.length === 0)).toBe(true)
  })
  for (const [origin, preferred] of [["gemini", "deepseek"], ["deepseek", "sol"], ["sol", "deepseek"], ["kimi", "sol"], ["opus", "sol"], ["glm", "deepseek"], ["mistral", "sol"]] as const) {
    test(`critic after ${origin} prefers ${preferred}`, () => {
      const names: Record<string, string> = { gemini: "antigravity/antigravity-gemini-3.8-flash#high", deepseek: defaultPolicy().aliases.deepseek, sol: defaultPolicy().aliases["sol-high"], kimi: defaultPolicy().aliases.kimi, opus: defaultPolicy().aliases.opus, glm: defaultPolicy().aliases.glm, mistral: "mistral/mistral-large-4#high" }
      expect(choose(task({ role: "critic", originModel: names[origin] }))!.family).toBe(preferred)
    })
  }
  test("critic requires recognized provenance", () => expect(choose(task({ role: "critic" }))).toBeUndefined())
  test("different provider alias is not family independence", () => {
    expect(familyOf("oneprovider/deepseek-v4.1-flash")).toBe(familyOf(defaultPolicy().aliases.deepseek))
    expect(familyOf(defaultPolicy().aliases["deepseek-1017"])).toBe("deepseek")
    expect(familyOf(defaultPolicy().aliases.glm)).toBe("glm")
    expect(familyOf("mistral/mistral-large-4#high")).toBe("mistral")
    expect(choose(task({ role: "critic", originModel: "oneprovider/deepseek-v4.1-flash", requestedModel: defaultPolicy().aliases.deepseek }))).toBeUndefined()
    expect(choose(task({ role: "critic", originModel: defaultPolicy().aliases.glm, requestedModel: defaultPolicy().aliases["deepseek-1017"] }))).toBeDefined()
  })
  test("image tasks fall through the DeepSeek group to the image-capable Go member", () => {
    const selected = choose(task({ modalities: ["text", "image"] }))!
    expect(selected.model).toBe(defaultPolicy().aliases.deepseek)
  })
  test("video and PDF tasks route to the media agent's GLM Flash", () => {
    expect(choose(task({ role: "media", modalities: ["text", "video"] }))!.model).toBe(defaultPolicy().aliases["glm-flash"])
    expect(choose(task({ role: "media", modalities: ["text", "pdf"] }))!.model).toBe(defaultPolicy().aliases["glm-flash"])
  })
  test("media HARD uses GLM Flash max", () => {
    expect(choose(task({ role: "media", tier: "HARD", modalities: ["text", "video"] }))!.model).toBe(defaultPolicy().aliases["glm-flash-max"])
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
    const m2 = models(); m2.find(m2 => m2.providerID === "mistral" && m2.id === "deepseek-v4-1-flash-1017")!.package = "aisdk:@ai-sdk/mistral"
    expect(choose(task({ requestedModel: defaultPolicy().aliases["deepseek-1017"] }), accounts(), m2)).toBeUndefined()
  })
})
