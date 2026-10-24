import { readFile, writeFile, copyFile, chmod } from "node:fs/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { paths, settings } from "../src/config.ts"
import { credentialFingerprint } from "../src/identity.ts"

if (!process.argv.includes("--approve-current")) throw new Error("Review existing credential mappings, then explicitly pass --approve-current. This does not authorize paid models.")
const p = paths(), config = await settings(), secret = (await readFile(p.token, "utf8")).trim()
const endpoint = await Service.discover()
if (!endpoint) throw new Error("OpenCode service unavailable")
const opencode = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const saved = await opencode.credential.list()
for (const binding of config.credentialBindings ?? []) {
  const integrationID = (await opencode.provider.get({ providerID: binding.providerID })).data.integrationID ?? binding.providerID
  const credential = binding.providerID === "antigravity" ? saved.find(c => c.id === binding.credentialID) : saved.find(c => c.integrationID === integrationID && c.active)
  if (!credential) throw new Error("An approved credential is no longer present")
  binding.integrationID = integrationID
  binding.credentialID = credential.id
  binding.workspaceID = binding.providerID === "opencode-go" && credential.value.type === "oauth" && typeof credential.value.metadata?.orgID === "string" ? credential.value.metadata.orgID : undefined
  binding.credentialFingerprint = credentialFingerprint(binding.providerID, credential.value, secret)
}
const backup = p.config + ".before-binding-" + Date.now()
await copyFile(p.config, backup); await chmod(backup, 0o600)
await writeFile(p.config, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
console.log("Bound the already approved credential identities. No provider credentials were changed; no spending was authorized. Restart the router and reload OpenCode plugins.")
