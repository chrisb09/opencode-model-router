import { readFile } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { Service } from "@opencode/client/service"
import { loadPolicy, paths, settings } from "../src/config.ts"
import type { Task } from "../src/types.ts"

/**
 * Local-only concurrency probe. It is intentionally not exposed through MCP or
 * the normal subagent tool. The router must be in testMode, which disables the
 * per-account admission check; quota, cooldown, identity and paid/Kimi gates
 * remain active.
 */

const args = process.argv.slice(2)
const arg = (name: string, fallback?: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const integer = (value: string, label: string) => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}
const provider = arg("--provider", "antigravity")!
const directory = arg("--directory", "/home/christian/git/opencode_migrate")!
const accountArg = arg("--account")
const parentArg = arg("--parent")
const timeoutMs = integer(arg("--timeout", "30000")!, "--timeout")
const outputTokens = integer(arg("--output-tokens", "1024")!, "--output-tokens")
const levels = (arg("--levels", "1,2,3,4")!).split(",").map(value => integer(value.trim(), "--levels"))
const prompt = arg("--prompt", "This is a read-only concurrency probe. Reply with exactly OK. Do not use tools and do not edit any file.")!
if (new Set(levels).size !== levels.length || levels.some((level, index) => index > 0 && level <= levels[index - 1])) throw new Error("--levels must be ascending and unique")
if (Math.max(...levels) > 16) throw new Error("--levels cannot exceed 16 in one run")
if (levels.reduce((sum, level) => sum + level, 0) > 40) throw new Error("Requested probe exceeds 40 child sessions; split the run")

const profiles: Record<string, { role: Task["role"]; tier: Task["tier"]; model: { providerID: string; id: string; variant: string }; account: string }> = {
  antigravity: { role: "explore", tier: "LOW", model: { providerID: "antigravity", id: "antigravity-gemini-3.8-flash", variant: "medium" }, account: "" },
  "opencode-go": { role: "reviewer", tier: "DEFAULT", model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "max" }, account: "opencode-go:default" },
  openai: { role: "reviewer", tier: "HARD", model: { providerID: "openai", id: "gpt-6.1-sol", variant: "high" }, account: "codex:default" },
}
const profile = profiles[provider]
if (!profile) throw new Error(`Unknown --provider; expected ${Object.keys(profiles).join(", ")}`)
const account = accountArg ?? profile.account
if (!account) throw new Error("Antigravity probes require --account <google:email> so the test can pin one account")

const p = paths()
const config = await settings()
const policy = await loadPolicy(config.policyFile)
const token = (await readFile(p.token, "utf8")).trim()
const routerUrl = config.url

async function router<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(routerUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-router-token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${path}: ${value.error ?? response.status}`)
  return value as T
}

const status = await router<any>("/status")
if (status.testMode !== true) throw new Error("Router testMode is off. Enable testMode in the private router config, restart the service, and rerun.")
let location = status.locations?.find((entry: any) => entry.directory === directory)
if (!location || Date.now() - location.updatedAt > 180_000) {
  // Test sessions may target an inactive project whose plugin registration has
  // aged out. Reuse the newest known catalog/bindings for the probe only.
  const db = new Database(p.database, { readonly: true })
  let latest: any = null
  try {
    const rows = db.query<{ value: string }, []>("SELECT value FROM registry WHERE key LIKE 'registry:%'").all()
    latest = rows.map(row => JSON.parse(row.value)).sort((a: any, b: any) => b.updatedAt - a.updatedAt)[0] ?? null
  } finally { db.close() }
  if (!latest) throw new Error(`No OpenCode model/credential registry is available for ${directory}`)
  await router("/registry", { directory, models: latest.models, bindings: latest.bindings })
  console.error(`Refreshed probe registry for ${directory} from the newest known catalog`)
  location = { directory, updatedAt: Date.now() }
}

const discovered = await Service.discover()
if (!discovered) throw new Error("OpenCode service is not available")
const endpoint = discovered
const auth = endpoint.auth ? "Basic " + btoa(`${endpoint.auth.username}:${endpoint.auth.password}`) : undefined
async function opencode<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint.url + path, {
    ...init,
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let value: any = {}
  try { value = text ? JSON.parse(text) : {} } catch { value = { raw: text.slice(0, 500) } }
  if (!response.ok) throw new Error(`${path}: ${value.error ?? value.message ?? response.status}`)
  return (value.data ?? value) as T
}

const quota = status.accounts?.find((entry: any) => entry.key === account)
if (!quota) throw new Error(`Account ${account} is not present in router status`)
const floor = (policy.quota.softReservePp[provider] ?? 0) + 2
for (const window of quota.windows ?? []) {
  if (window.remainingPct !== null && window.remainingPct <= floor) throw new Error(`Refusing to probe ${account}: ${window.key} is at ${window.remainingPct}% (floor ${floor}%)`)
}

const parent = parentArg ?? (await opencode<{ id: string }>("/api/session", { method: "POST", body: JSON.stringify({ agent: "plan", title: `Concurrency probe ${new Date().toISOString()}`, location: { directory } }) })).id
if (!parent?.startsWith("ses")) throw new Error("Could not create or identify the probe parent session")

interface Result {
  level: number
  child: string | null
  execution: string | null
  outcome: "completed" | "failed" | "timeout" | "denied" | "error"
  durationMs: number
  requests: number
  error: string | null
}

const createdExecutions: string[] = []
const allResults: Result[] = []
const requestedModel = `${profile.model.providerID}/${profile.model.id}#${profile.model.variant}`

async function sessionMessages(sessionID: string): Promise<any[]> {
  const data = await opencode<any>(`/api/session/${sessionID}/message?limit=100`)
  return Array.isArray(data) ? data : (data?.data ?? [])
}

async function cleanup(executionID: string, child: string | null) {
  try {
    const execution = await router<any>("/execution", { id: executionID })
    if (!execution || !["reserved", "running", "uncertain"].includes(execution.state)) return
    if (child) await opencode(`/api/session/${child}/interrupt`, { method: "POST", body: "{}" }).catch(() => {})
    await router("/finish", { id: executionID, state: "cancelled" })
    const after = await router<any>("/execution", { id: executionID }).catch(() => null)
    if (after?.state === "uncertain") {
      const reconciled = await router<any>("/reconcile", { id: executionID, confirmation: "provider-idle-confirmed" }).catch(error => ({ error: String(error) }))
      if (reconciled?.error) console.error(`Manual reconcile required for ${executionID}: ${reconciled.error}`)
    }
  } catch (error) {
    console.error(`Cleanup warning for ${executionID}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runLevel(level: number): Promise<Result[]> {
  const children = await Promise.all(Array.from({ length: level }, (_, index) => opencode<{ id: string }>("/api/session", {
    method: "POST",
    body: JSON.stringify({ parentID: parent, agent: profile.role, model: profile.model, title: `Probe ${level}.${index + 1} ${provider}` }),
  })))
  const started = performance.now()
  const results: Result[] = []
  const active: Array<{ child: string; execution: string; index: number }> = []
  for (const [index, child] of children.entries()) {
    const id = `probe:${Date.now()}:${level}:${index}:${crypto.randomUUID()}`
    const task: Task = {
      role: profile.role, tier: profile.tier, importance: "low", parentAgent: "plan", parentSessionID: parent, directory,
      inputTokens: 100, outputTokens, modalities: ["text"], requestedModel,
      steps: policy.steps.default, stepBudget: policy.steps.default, accountKey: account, test: true,
    }
    try {
      const execution = await router<any>("/reserve", { id, task, workflow: { purpose: "testing", label: `Concurrency probe ${provider} level ${level}`, background: false } })
      await router("/bind", { id: execution.id, childSessionID: child.id })
      createdExecutions.push(execution.id)
      active.push({ child: child.id, execution: execution.id, index })
    } catch (error) {
      results.push({ level, child: child.id, execution: null, outcome: "denied", durationMs: 0, requests: 0, error: error instanceof Error ? error.message : String(error) })
    }
  }
  await Promise.all(active.map(async entry => {
    const start = performance.now()
    let outcome: Result["outcome"] = "error"
    let error: string | null = null
    try {
      await opencode(`/api/session/${entry.child}/prompt`, { method: "POST", body: JSON.stringify({ text: prompt }) })
      const waited = await Promise.race([
        opencode(`/api/experimental/session/${entry.child}/wait`, { method: "POST", body: "{}" }).then(() => true),
        Bun.sleep(timeoutMs).then(() => false),
      ])
      if (!waited) {
        outcome = "timeout"
        error = `No completion within ${timeoutMs}ms`
        await opencode(`/api/session/${entry.child}/interrupt`, { method: "POST", body: "{}" }).catch(() => {})
      } else {
        const session = await opencode<any>(`/api/session/${entry.child}`)
        outcome = session.outcome === "succeeded" ? "completed" : session.outcome === "failed" ? "failed" : "error"
        const messages = await sessionMessages(entry.child).catch(() => [])
        const errors = messages.flatMap((message: any) => [
          ...(message.error?.message ? [message.error.message] : []),
          ...((message.content ?? []).filter((part: any) => part.type === "tool" && part.state?.status === "error").map((part: any) => part.state.error?.message).filter(Boolean)),
        ])
        error = errors[0] ?? null
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    await router("/finish", { id: entry.execution, state: outcome === "completed" ? "completed" : outcome === "timeout" ? "cancelled" : "failed" }).catch(() => {})
    results.push({ level, child: entry.child, execution: entry.execution, outcome, durationMs: performance.now() - start, requests: 0, error })
  }))
  const elapsed = performance.now() - started
  const db = new Database(p.database, { readonly: true })
  try {
    for (const result of results) {
      if (!result.execution) continue
      const row = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM requests WHERE execution_id=?").get(result.execution)
      result.requests = row?.n ?? result.requests
      const failure = db.query<{ data: string }, [string]>("SELECT data FROM decisions WHERE execution_id=? AND kind='provider-failure' ORDER BY id DESC LIMIT 1").get(result.execution)
      if (failure) {
        const data = JSON.parse(failure.data)
        result.error = result.error ?? `${data.reason ?? "provider failure"} (status ${data.status ?? "unknown"})`
      }
    }
  } finally { db.close() }
  console.log(`level ${level}: ${results.filter(r => r.outcome === "completed").length}/${level} completed in ${Math.round(elapsed)}ms`)
  return results
}

try {
  for (const level of levels) {
    const results = await runLevel(level)
    allResults.push(...results)
    const bad = results.filter(result => result.outcome !== "completed")
    if (bad.length) break
    const after = await router<any>("/status")
    const current = after.accounts?.find((entry: any) => entry.key === account)
    const low = (current?.windows ?? []).filter((window: any) => window.remainingPct !== null && window.remainingPct <= floor)
    if (low.length) throw new Error(`Stopping probe: ${low.map((w: any) => `${w.key}=${w.remainingPct}%`).join(", ")} reached the safety floor`)
  }
} finally {
  for (const execution of createdExecutions) {
    const entry = allResults.find(result => result.execution === execution)
    if (entry?.outcome === "completed") continue
    await cleanup(execution, entry?.child ?? null)
  }
}

const summary = {
  provider, account, model: requestedModel, directory, parent, testMode: true, levels,
  completed: allResults.filter(result => result.outcome === "completed").length,
  failed: allResults.filter(result => result.outcome === "failed").length,
  timeout: allResults.filter(result => result.outcome === "timeout").length,
  denied: allResults.filter(result => result.outcome === "denied").length,
  results: allResults,
}
console.log(JSON.stringify(summary, null, 2))
if (allResults.some(result => result.outcome !== "completed")) process.exitCode = 1
