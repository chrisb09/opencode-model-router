import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"
import { paths } from "../src/config.ts"
import { removeInstallation } from "../src/disable.ts"

const backup = (await readFile(join(paths().state, "installation-backup"), "utf8")).trim()
const manifest = JSON.parse(await readFile(join(backup, "installation.json"), "utf8"))
const path = join(homedir(), ".config/opencode/opencode.jsonc")
const current = JSON.parse(await readFile(path, "utf8"))
const original = JSON.parse(await readFile(join(backup, "opencode.jsonc"), "utf8"))
const { config, warnings } = removeInstallation(current, manifest, original)
await writeFile(path, JSON.stringify(config, null, 2) + "\n")
// Let OpenCode unload the plugin before stopping its backing service.
await Bun.sleep(1000)
const proc = Bun.spawn(["systemctl", "--user", "disable", "--now", "opencode-model-router.service"], { stdout: "inherit", stderr: "inherit" })
await proc.exited
console.log("Routing disabled. Historical state, credentials and backups retained.")
for (const warning of warnings) console.log(warning)
