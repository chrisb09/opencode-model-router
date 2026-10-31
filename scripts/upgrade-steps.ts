import { readFile, writeFile, mkdir, copyFile, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { paths, loadPolicy, settings } from "../src/config.ts"
import { agentDefinitions } from "../src/agents.ts"
import { roles, type Policy } from "../src/types.ts"

/**
 * One-shot upgrade for an existing installation:
 * - replace the router's tier request caps with native step budgets
 * - add hidden extended-step variants (30 default, 60 extended)
 * - add the parent subagent permissions needed to dispatch those variants
 *
 * It preserves user edits to model, color, system, description and permissions.
 */

const p = paths()
const config = await settings()
if (!config.policyFile) throw new Error("Router policyFile is not configured")
const configPath = join(homedir(), ".config/opencode/opencode.jsonc")
const manifestPath = join((await readFile(join(p.state, "installation-backup"), "utf8")).trim(), "installation.json")
const rawPolicy = JSON.parse(await readFile(config.policyFile, "utf8"))
const rawConfig = JSON.parse(await readFile(configPath, "utf8"))
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))

const backup = join(homedir(), ".local/state/opencode-model-router/backups", "steps-" + new Date().toISOString().replace(/[:.]/g, "-"))
await mkdir(backup, { recursive: true, mode: 0o700 })
for (const [from, name] of [[configPath, "opencode.jsonc"], [config.policyFile, "policy.json"], [manifestPath, "installation.json"]]) {
  await copyFile(from, join(backup, name)); await chmod(join(backup, name), 0o600)
}

rawPolicy.steps ??= { default: 30, extended: 60 }
rawPolicy.maxRequestsPerExecution ??= 100
rawPolicy.quota ??= {}
rawPolicy.quota.maxConcurrentTotal ??= 16
delete rawPolicy.maxSteps
await writeFile(config.policyFile, JSON.stringify(rawPolicy, null, 2) + "\n", { mode: 0o600 })
const policy = await loadPolicy(config.policyFile) as Policy
const definitions = agentDefinitions(policy)

const extended = (id: string) => `${id}-extended`
for (const role of roles) {
  const base = rawConfig.agents?.[role]
  if (!base) throw new Error(`Missing installed agent ${role}; run the installer or restore the backup first`)
  base.steps = policy.steps.default
  const id = extended(role)
  const description = String(base.description ?? "").replace(/ \(extended step budget\)$/, "") + " (extended step budget)"
  const variant = rawConfig.agents?.[id] ?? { ...structuredClone(base), steps: policy.steps.extended, hidden: true, description }
  variant.steps = policy.steps.extended
  variant.hidden = true
  variant.description = description
  rawConfig.agents[id] = variant
  manifest.agents[id] = structuredClone(variant)
}

for (const [id, includeGeneral] of [["plan", false], ["build", true]] as const) {
  const agent = rawConfig.agents?.[id]
  if (!agent) throw new Error(`Missing installed coordinator ${id}`)
  agent.permissions ??= []
  manifest.agents[id].permissions ??= []
  for (const role of roles) {
    if (role === "general" && !includeGeneral) continue
    const rule = { action: "subagent", resource: extended(role), effect: "allow" }
    if (!agent.permissions.some((existing: any) => JSON.stringify(existing) === JSON.stringify(rule))) agent.permissions.push(rule)
    if (!manifest.agents[id].permissions.some((existing: any) => JSON.stringify(existing) === JSON.stringify(rule))) manifest.agents[id].permissions.push(rule)
  }
}

// Keep the manifest's base definitions aligned with the installed default.
for (const role of roles) manifest.agents[role].steps = policy.steps.default

await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
await writeFile(configPath, JSON.stringify(rawConfig, null, 2) + "\n")
console.log(`Upgraded native step budgets. Private backup: ${backup}`)
console.log(`Default steps: ${policy.steps.default}; extended: ${policy.steps.extended}; request backstop: ${policy.maxRequestsPerExecution}`)
console.log("OpenCode will reload the agent catalog. Restart the router service to load the migrated policy:")
console.log("  systemctl --user restart opencode-model-router.service")
