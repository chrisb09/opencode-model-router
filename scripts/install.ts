import { mkdir, readFile, writeFile, chmod, copyFile, access } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, resolve, join } from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { paths, defaultPolicy } from "../src/config.ts"
import { agentDefinitions } from "../src/agents.ts"
import { credentialFingerprint } from "../src/identity.ts"

const home = homedir(), repo = resolve(import.meta.dir, ".."), p = paths()
const opencodeConfig = join(home, ".config/opencode/opencode.jsonc")
const unit = join(home, ".config/systemd/user/opencode-model-router.service")
const exists = async (path: string) => access(path).then(() => true, () => false)
const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const run = async (args: string[]) => { const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" }); const status = await proc.exited; if (status) throw new Error(`${args[0]} failed (${status})`); return new Response(proc.stdout).text() }

if (await exists(p.config)) throw new Error("Router already installed; edit its config instead of overwriting it")
if (await exists(unit)) throw new Error("A router service unit already exists; inspect it before installing")
const original = await readFile(opencodeConfig, "utf8")
// This installation's file is JSON despite the .jsonc suffix. Refuse to rewrite
// comments/trailing commas rather than silently stripping custom formatting.
const config = JSON.parse(original)
const additions = agentDefinitions(defaultPolicy())
for (const id of Object.keys(additions)) if (config.agents?.[id] || config.agent?.[id]) throw new Error(`Existing agent customization requires an explicit merge: ${id}`)

const backup = join(home, ".local/state/opencode-model-router/backups", new Date().toISOString().replace(/[:.]/g, "-"))
await mkdir(backup, { recursive: true, mode: 0o700 }); await chmod(backup, 0o700)
await writeFile(join(backup, "opencode.jsonc"), original, { mode: 0o600 })
for (const name of ["cli.json", "antigravity.json", "antigravity-accounts.json"]) {
  const source = join(home, ".config/opencode", name)
  if (await exists(source)) { await copyFile(source, join(backup, name)); await chmod(join(backup, name), 0o600) }
}
await mkdir(dirname(p.config), { recursive: true, mode: 0o700 }); await chmod(dirname(p.config), 0o700)
await mkdir(p.state, { recursive: true, mode: 0o700 }); await chmod(p.state, 0o700)
const token = randomBytes(32).toString("hex")
await writeFile(p.token, token, { mode: 0o600 })
const policyFile = join(dirname(p.config), "policy.json")
await writeFile(policyFile, JSON.stringify(defaultPolicy(), null, 2) + "\n", { mode: 0o600 })

// Reuse the existing usage service credential from the live OpenCode service's
// configured environment. Never print it or write it into OpenCode configuration.
const endpoint = await Service.discover()
if (!endpoint) throw new Error("Start OpenCode before installing so existing usage authorization can be reused")
const opencode = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
let basic = process.env.AI_USAGE_BASIC
if (!basic) {
  const info = await opencode.server.info()
  const env = await readFile(`/proc/${info.pid}/environ`)
  const entry = env.toString().split("\0").find(x => x.startsWith("AI_USAGE_BASIC="))
  basic = entry?.slice("AI_USAGE_BASIC=".length)
}
if (!basic) throw new Error("Existing AI_USAGE_BASIC credential is unavailable; no provider credentials were changed")
const auth = join(dirname(p.config), "collector-authorization")
await writeFile(auth, "Basic " + basic, { mode: 0o600 })
const connections = (await opencode.integration.list()).data
const savedCredentials = await opencode.credential.list()
const activeCredentialIDs = new Set(savedCredentials.filter(c => c.active).map(c => c.id))
const credentialBindings: Array<{ providerID: string; credentialID: string; accountKey: string; credentialFingerprint?: string; integrationID?: string; workspaceID?: string }> = []
for (const providerID of ["antigravity", "openai", "opencode-go", "oneprovider"]) {
  const integrationID = (await opencode.provider.get({ providerID })).data.integrationID ?? providerID
  const integration = connections.find(i => i.id === integrationID)
  for (const c of integration?.connections ?? []) if (c.type === "credential" && (providerID === "antigravity" ? c.method === "oauth" : activeCredentialIDs.has(c.id))) {
    const saved = savedCredentials.find(s => s.id === c.id)
    credentialBindings.push({ providerID, integrationID, credentialID: c.id, accountKey: providerID === "antigravity" ? `google:${c.label.toLowerCase()}` : providerID === "openai" ? "codex:default" : `${providerID}:default`, credentialFingerprint: saved ? credentialFingerprint(providerID, saved.value, token) : undefined,
      workspaceID: providerID === "opencode-go" && saved?.value.type === "oauth" && typeof saved.value.metadata?.orgID === "string" ? saved.value.metadata.orgID : undefined })
  }
}
const settings = { url: "http://127.0.0.1:7695", collectorUrl: "https://usage.christian-f-brinkmann.de", collectorAuthorizationFile: auth, policyFile, enabled: true, testMode: false, credentialBindings, workflow: { enabled: true, captureLabels: true } }
await writeFile(p.config, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 })
await mkdir(dirname(unit), { recursive: true })
await writeFile(unit, `[Unit]\nDescription=Quota-aware OpenCode subagent router\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${repo}\nExecStart=/usr/bin/bun ${repo}/src/cli.ts serve\nRestart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n`)
await run(["systemctl", "--user", "daemon-reload"])
await run(["systemctl", "--user", "enable", "--now", "opencode-model-router.service"])
const { RouterClient } = await import("../src/client.ts")
const client = new RouterClient(settings, token)
let healthy = false
for (let attempt = 0; attempt < 20; attempt++) {
  try { await client.call("/health"); healthy = true; break } catch { await Bun.sleep(250) }
}
if (!healthy) throw new Error("Router did not become healthy; OpenCode configuration has NOT been changed")
config.agents = { ...config.agents, ...additions }
config.plugins = [...(config.plugins ?? []), { package: join(repo, "plugin"), options: { config: p.config, enabled: true } }]
config.experimental = { ...config.experimental, subagent_depth: 1, todo: true }
config.mcp ??= {}; config.mcp.servers ??= {}
if (config.mcp.servers["model-router"]) throw new Error("An MCP server named model-router already exists")
config.mcp.servers["model-router"] = { type: "local", command: ["/usr/bin/bun", join(repo, "src/mcp.ts")] }
const updated = JSON.stringify(config, null, 2) + "\n"
await writeFile(join(backup, "installation.json"), JSON.stringify({ repo, installedAt: new Date().toISOString(), originalHash: hash(original), installedHash: hash(updated), agents: additions, mcp: config.mcp.servers["model-router"], originalExperimental: JSON.parse(original).experimental ?? null }, null, 2), { mode: 0o600 })
await writeFile(join(p.state, "installation-backup"), backup, { mode: 0o600 })
// Last operation: OpenCode watches this file and applies the additive changes.
await writeFile(opencodeConfig, updated)
console.log(`Installed model router. Private rollback backup: ${backup}`)
console.log("Plan/Build model selections and CLI keybindings were not changed. Paid/Kimi dispatch remains locked.")
