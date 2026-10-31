import { describe, expect, test } from "bun:test"
import { defaultPolicy } from "../src/config.ts"
import { agentDefinitions } from "../src/agents.ts"
import { agentVariant, selectStepBudget } from "../src/steps.ts"

describe("native step budgets", () => {
  test("defaults to the base native budget", () => {
    const p = defaultPolicy()
    expect(selectStepBudget(p)).toEqual({ requested: p.steps.default, budget: p.steps.default, extended: false })
    expect(selectStepBudget(p, p.steps.default)).toEqual({ requested: p.steps.default, budget: p.steps.default, extended: false })
  })

  test("uses the extended bucket only above the default", () => {
    const p = defaultPolicy()
    expect(selectStepBudget(p, p.steps.default + 1)).toEqual({ requested: p.steps.default + 1, budget: p.steps.extended, extended: true })
    expect(selectStepBudget(p, p.steps.extended)).toEqual({ requested: p.steps.extended, budget: p.steps.extended, extended: true })
  })

  test("rejects values above the configured maximum", () => {
    const p = defaultPolicy()
    expect(() => selectStepBudget(p, p.steps.extended + 1)).toThrow("configured maximum")
    expect(() => selectStepBudget(p, 0)).toThrow("positive integer")
    expect(() => selectStepBudget(p, 1.5)).toThrow("positive integer")
  })

  test("maps a budget to the hidden native agent variant", () => {
    const p = defaultPolicy()
    expect(agentVariant("reviewer", p, p.steps.default)).toBe("reviewer")
    expect(agentVariant("reviewer", p, p.steps.extended)).toBe("reviewer-extended")
  })

  test("agent definitions expose hidden extended variants and preserve the 30-step default", () => {
    const p = defaultPolicy()
    const agents = agentDefinitions(p)
    for (const role of ["explore", "research", "general", "debugger", "reviewer", "architect", "critic"]) {
      expect(agents[role].steps).toBe(p.steps.default)
      expect(agents[role].hidden).toBeUndefined()
      expect(agents[`${role}-extended`]).toMatchObject({ steps: p.steps.extended, hidden: true, mode: "subagent" })
      expect(agents[`${role}-extended`].permissions).toEqual(agents[role].permissions)
      expect(agents[`${role}-extended`].system).toBe(agents[role].system)
    }
    expect(agents.plan.permissions).toContainEqual({ action: "subagent", resource: "reviewer-extended", effect: "allow" })
    expect(agents.plan.permissions).not.toContainEqual({ action: "subagent", resource: "general-extended", effect: "allow" })
    expect(agents.build.permissions).toContainEqual({ action: "subagent", resource: "general-extended", effect: "allow" })
  })
})
