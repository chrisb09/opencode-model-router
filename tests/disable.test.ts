import { describe, expect, test } from "bun:test"
import { removeInstallation } from "../src/disable.ts"
import { agentDefinitions } from "../src/agents.ts"
import { defaultPolicy } from "../src/config.ts"

const original = { $schema: "https://opencode.ai/config.json", plugins: ["existing-plugin"], providers: { custom: { settings: { custom: true } } }, mcp: { servers: { existing: { type: "remote", url: "https://example.com/mcp" } } } }
const manifest = { repo: "/router", agents: agentDefinitions(defaultPolicy()), mcp: { type: "local", command: ["bun", "/router/src/mcp.ts"] } }
const installed = (): any => ({ ...structuredClone(original), plugins: ["existing-plugin", { package: "/router/plugin", options: { enabled: true } }], agents: structuredClone(manifest.agents), experimental: { subagent_depth: 1 }, mcp: { servers: { ...structuredClone(original.mcp.servers), "model-router": manifest.mcp } } })
describe("non-destructive disable/rollback", () => {
  test("unchanged installation restores exactly the original config", () => {
    const result = removeInstallation(installed(), manifest, original)
    expect(result.config).toEqual(original); expect(result.warnings).toHaveLength(0)
  })
  test("subsequently selected primary model survives and owned permissions are removed", () => {
    const config = installed(); config.agents.build.model = "user/manually-selected"
    const result = removeInstallation(config, manifest, original)
    expect(result.config.agents.build).toEqual({ model: "user/manually-selected" })
  })
  test("new user plugins/settings are not discarded", () => {
    const config = installed(); config.plugins.push("new-user-plugin"); config.experimental.todo = true
    const result = removeInstallation(config, manifest, original)
    expect(result.config.plugins).toEqual(["existing-plugin", "new-user-plugin"])
    expect(result.config.experimental).toEqual({ todo: true })
    expect(result.config.providers).toEqual(original.providers)
  })
  test("an added primary permission survives without retaining owned routing restrictions", () => {
    const config = installed(); const added = { action: "user_tool", resource: "*", effect: "allow" }
    config.agents.plan.permissions.push(added)
    const result = removeInstallation(config, manifest, original)
    expect(result.config.agents.plan.permissions).toEqual([added])
  })
  test("edited subagent definitions are preserved instead of overwritten", () => {
    const config = installed(); config.agents.reviewer.system = "User review instructions"
    const result = removeInstallation(config, manifest, original)
    expect(result.config.agents.reviewer.system).toBe("User review instructions")
    expect(result.config.agents.reviewer.mode).toBe("subagent")
    expect(result.warnings).toContain("Kept subsequently edited agent: reviewer")
  })
})
