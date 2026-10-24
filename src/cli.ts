import { mkdir, chmod, writeFile } from "node:fs/promises"
import { dirname, resolve, join } from "node:path"
import { homedir } from "node:os"
import { connect } from "./client.ts"
import { settings, paths, loadPolicy } from "./config.ts"
import { Ledger } from "./ledger.ts"
import { RouterService, serve } from "./service.ts"
import { workflowTimelineHTML } from "./workflow-timeline.ts"

const command = process.argv[2] ?? "status"
try {
  const client = await connect()
  if (command === "serve") {
    const config = await settings()
    await mkdir(paths().state, { recursive: true, mode: 0o700 }); await chmod(paths().state, 0o700)
    const ledger = new Ledger(paths().database); await chmod(paths().database, 0o600)
    const server = serve(new RouterService(config, await loadPolicy(config.policyFile), ledger, client.token))
    console.log(`OpenCode model router listening at ${server.url.origin}; paid and Kimi dispatch locked`)
    const close = () => { server.stop(true); ledger.close(); process.exit(0) }
    process.on("SIGTERM", close); process.on("SIGINT", close)
  } else if (command === "status") console.log(JSON.stringify(await client.call("/status"), null, 2))
  else if (command === "workflow") {
    const sessionID = process.argv[3]
    if (!sessionID || sessionID === "list") console.log(JSON.stringify(await client.call("/workflow/list", {}), null, 2))
    else if (sessionID === "forget") {
      const id = process.argv[4]
      if (!id || !process.argv.includes("--confirm")) throw new Error("Usage: workflow forget <sessionID> --confirm (deletes workflow metadata only)")
      console.log(JSON.stringify(await client.call("/workflow/forget", { sessionID: id, confirmation: "delete-local-workflow-only" }), null, 2))
    } else {
      const timeline = process.argv.includes("--timeline")
      const format = timeline ? "json" : process.argv.includes("--mermaid") ? "mermaid" : "json"
      const result = await client.call("/workflow/read", { sessionID, format, includeLocalText: process.argv.includes("--include-local-text") })
      if (timeline) {
        const html = workflowTimelineHTML(result.workflow)
        if (process.argv.includes("--out")) {
          const raw = process.argv[process.argv.indexOf("--out") + 1]
          if (!raw || raw === "--out") throw new Error("Usage: workflow <sessionID> --timeline --out <file.html>")
          const target = resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, html, { mode: 0o600 }); await chmod(target, 0o600)
          console.log(target)
        } else console.log(html)
      } else console.log(format === "mermaid" ? result.mermaid : JSON.stringify(result, null, 2))
    }
  }
  else if (command === "reconcile") {
    const id = process.argv[3]
    if (!id || !process.argv.includes("--confirm-provider-idle")) throw new Error("Usage: reconcile <executionID> --confirm-provider-idle. Only confirm after verifying no provider request remains active; this is not spending authorization.")
    console.log(JSON.stringify(await client.call("/reconcile", { id, confirmation: "provider-idle-confirmed" }), null, 2))
  } else if (command === "recommend") {
    const raw = process.argv[3]
    if (!raw) throw new Error("Usage: bun src/cli.ts recommend '<task JSON>'")
    console.log(JSON.stringify(await client.call("/recommend", { task: JSON.parse(raw) }), null, 2))
   } else throw new Error("Commands: serve, status, recommend, reconcile, workflow")
} catch (error) { console.error(error instanceof Error ? error.message : "Router command failed"); process.exitCode = 1 }
