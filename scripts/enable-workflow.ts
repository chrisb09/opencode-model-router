import { readFile, writeFile, mkdir, copyFile, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { paths } from "../src/config.ts"

// Add only workflow settings/permissions; do not reinstall or replace agent models.
const p = paths(), configPath = join(homedir(), ".config/opencode/opencode.jsonc")
const config = JSON.parse(await readFile(configPath, "utf8"))
const settings = JSON.parse(await readFile(p.config, "utf8"))
const installBackup = (await readFile(join(p.state, "installation-backup"), "utf8")).trim()
const manifestPath = join(installBackup, "installation.json")
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
const backup = join(homedir(), ".local/state/opencode-model-router/backups", "workflow-" + new Date().toISOString().replace(/[:.]/g, "-"))
await mkdir(backup, { recursive: true, mode: 0o700 })
for (const [from, name] of [[configPath, "opencode.jsonc"], [p.config, "router-config.json"], [manifestPath, "installation.json"]]) {
  await copyFile(from, join(backup, name)); await chmod(join(backup, name), 0o600)
}
for (const id of ["plan", "build", "explore", "research", "general", "debugger", "reviewer", "architect", "critic", "explore-extended", "research-extended", "general-extended", "debugger-extended", "reviewer-extended", "architect-extended", "critic-extended"]) {
  const agent = config.agents?.[id]
  if (!agent) continue
  const actions = ["workflow_read", "model-router_get_workflow", "model-router_list_workflows", ...(["plan", "build"].includes(id) ? ["workflow_annotate"] : [])]
  for (const action of actions) {
    agent.permissions ??= []
    if (agent.permissions.some((r: any) => r.action === action)) continue // Preserve explicit user rules.
    const rule = { action, resource: "*", effect: "allow" }
    agent.permissions.push(rule)
    const owned = manifest.agents?.[id]?.permissions
    if (owned && !owned.some((r: any) => r.action === action)) owned.push(rule)
  }
}
settings.workflow = { ...settings.workflow, enabled: true, captureLabels: settings.workflow?.captureLabels ?? true }
await writeFile(p.config, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 })
await writeFile(configPath, JSON.stringify(config, null, 2) + "\n")
console.log("Enabled local-only workflow recording and additive tool permissions. Existing models, credentials and spending gates are unchanged.")
console.log(`Private pre-upgrade config backup: ${backup}`)
