import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { Settings } from "./config.ts"
import { assertLocalUrl } from "./config.ts"
import { normalize, QuotaSource, type Binding } from "./collector.ts"
import { catalogSchema, taskSchema, bindingSchema, usageSchema } from "./schemas.ts"
import { Ledger } from "./ledger.ts"
import { Router } from "./router.ts"
import { measuredStream, UsageParser } from "./stream.ts"
import { decodeBody } from "./encoding.ts"
import { capOutput } from "./output-limit.ts"
import { verifyNativeCredential } from "./identity.ts"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import type { Account, CatalogModel, Policy } from "./types.ts"
import { WorkflowStore, annotationSchema, delegationTraceSchema, primaryTraceSchema, workflowID } from "./workflow.ts"
import { workflowMermaid, workflowSummary } from "./workflow-export.ts"

type Registry = { models: CatalogModel[]; bindings: Binding[]; updatedAt: number }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
const idSchema = z.string().min(1).max(250)
export function secureEqual(actual: string, expected: string) { const a = Buffer.from(actual), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b) }

export class RouterService {
  readonly router: Router
  readonly source: QuotaSource
  readonly workflow: WorkflowStore | null
  private workflowFailures = 0
  constructor(readonly config: Settings, readonly policy: Policy, readonly ledger: Ledger, readonly token: string, fetcher: typeof fetch = fetch, readonly upstreamFetch: typeof fetch = fetch) {
    this.router = new Router(policy, ledger); this.source = new QuotaSource(config, fetcher)
    try { this.workflow = new WorkflowStore(ledger.db, config.workflow?.captureLabels !== false) }
    catch { this.workflow = null; this.workflowFailures++ }
  }
  private trace(fn: (store: WorkflowStore) => void) {
    if (this.config.workflow?.enabled === false) return
    try { if (!this.workflow) throw new Error("Unavailable"); fn(this.workflow) } catch { this.workflowFailures++ }
  }
  registry(directory: string): Registry {
    const r = this.ledger.load<Registry>(`registry:${directory}`)
    if (!r || Date.now() - r.updatedAt > 180_000) throw new Error("OpenCode model/credential registry is stale or unavailable")
    return r
  }
  async accounts(bindings: Binding[], refresh = false): Promise<Account[]> {
    let snapshot = await this.source.get(refresh)
    let accounts = normalize(snapshot, bindings)
    const needsRefresh = accounts.some(a => a.windows.some(w => Date.now() - w.checkedAt > this.policy.quota.maxAgeMs || (w.resetAt && Date.parse(w.resetAt) <= Date.now())))
    if (needsRefresh && !refresh) { snapshot = await this.source.get(true); accounts = normalize(snapshot, bindings) }
    return accounts
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (!secureEqual(request.headers.get("x-router-token") ?? "", this.token)) return json({ error: "Unauthorized" }, 401)
    // Never expose local authority to cross-origin browser requests.
    if (request.headers.has("origin")) return json({ error: "Browser origins are not allowed" }, 403)
    try {
      if (path === "/health") return json({ ok: true, enabled: this.config.enabled, version: "0.1.0" })
      if (path === "/status" && request.method === "GET") {
        const registries = this.ledger.db.query<{ key: string; value: string }, []>("SELECT key,value FROM registry WHERE key LIKE 'registry:%'").all().map(r => ({ directory: r.key.slice(9), ...JSON.parse(r.value) as Registry }))
        const uniqueBindings = [...new Map(registries.flatMap(r => r.bindings).map(b => [b.credentialID, b])).values()]
        let accounts: Account[] = []
        try { accounts = await this.accounts(uniqueBindings) } catch {}
        return json({ enabled: this.config.enabled, quotaSource: this.config.collectorUrl, quotaError: this.source.lastError,
          policy: { aliases: this.policy.aliases, roles: this.policy.roles, quota: this.policy.quota },
          accounts: accounts.map(a => ({ ...a, windows: a.windows.map(w => ({ ...w, ageMs: Date.now() - w.checkedAt, stale: Date.now() - w.checkedAt > this.policy.quota.maxAgeMs, locallyReservedPp: this.ledger.pressure(a.key, w.key, w.checkedAt) })) })),
          models: [...new Map(registries.flatMap(r => r.models).map(m => [`${m.providerID}/${m.id}`, m])).values()],
          locations: registries.map(r => ({ directory: r.directory, updatedAt: r.updatedAt, models: r.models.map(m => `${m.providerID}/${m.id}`) })),
          workflow: { enabled: this.config.workflow?.enabled !== false, available: this.workflow !== null, localOnly: true, defaultExportIncludesText: false, captureFailures: this.workflowFailures },
          safeguards: { paidDispatch: "locked", kimiDispatch: "locked", quotaAccounting: "estimated percentage reservations", scope: "managed local subagents only", primaryModelSelection: "unchanged" }, ...this.ledger.status() })
      }
      if (path === "/proxy" && request.method === "POST") return await this.proxy(request)
      if (request.method !== "POST") return json({ error: "Not found" }, 404)
      const text = await request.text()
      if (text.length > 8_000_000) return json({ error: "Request too large" }, 413)
      const body = JSON.parse(text)
      if (path.startsWith("/workflow/")) {
        const store = this.workflow
        if (!store) throw new Error("Local workflow recorder unavailable; quota routing is unchanged")
        if (path === "/workflow/read") {
          const input = z.object({ sessionID: workflowID, format: z.enum(["json", "mermaid"]).default("json"), includeLocalText: z.boolean().default(false) }).strict().parse(body)
          const workflow = store.read(input.sessionID, input.includeLocalText)
          return json(input.format === "mermaid" ? { mermaid: workflowMermaid(workflow) } : { workflow, summary: workflowSummary(workflow), captureFailures: this.workflowFailures })
        }
        if (path === "/workflow/list") {
          const input = z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict().parse(body)
          return json({ workflows: store.list(input.limit) })
        }
        if (path === "/workflow/forget") {
          const input = z.object({ sessionID: workflowID, confirmation: z.literal("delete-local-workflow-only") }).strict().parse(body)
          return json({ deleted: store.forget(input.sessionID), quotaLedgerUntouched: true })
        }
        if (this.config.workflow?.enabled === false) throw new Error("Local workflow recording is disabled")
        if (path === "/workflow/annotate") {
          const input = z.object({ sessionID: workflowID, actorSessionID: workflowID, actorAgent: z.enum(["plan", "build"]), eventID: workflowID, annotation: annotationSchema }).strict().parse(body)
          if (input.sessionID !== input.actorSessionID) throw new Error("Workflow annotation belongs to another session")
          return json(store.annotate(input.sessionID, input.eventID, input.annotation))
        }
        if (path === "/workflow/context") {
          const input = z.object({ sessionID: workflowID, agent: z.enum(["plan", "build"]), model: z.string().max(300) }).strict().parse(body)
          this.trace(s => s.context(input.sessionID, input.agent, input.model)); return json({ ok: true })
        }
        if (path === "/workflow/primary") {
          const input = primaryTraceSchema.parse(body)
          this.trace(s => s.primary(input)); return json({ ok: true })
        }
        return json({ error: "Not found" }, 404)
      }
      if (path === "/registry") {
        const input = z.object({ directory: z.string().min(1), models: z.array(catalogSchema).max(10000), bindings: z.array(bindingSchema).max(100) }).strict().parse(body)
        const previous = this.ledger.load<Registry>(`registry:${input.directory}`)
        const bindings: Binding[] = input.bindings.map(b => {
          const old = previous?.bindings.find(p => p.credentialID === b.credentialID && p.credentialFingerprint === b.credentialFingerprint && p.workspaceID === b.workspaceID)
          const history = [...(b.authorizationFingerprint ? [{ fingerprint: b.authorizationFingerprint, until: Date.now() + 300_000 }] : []), ...(old?.authorizationHistory ?? [])].filter(h => h.until > Date.now())
          const unique = new Map<string, { fingerprint: string; until: number }>()
          for (const h of history) if ((unique.get(h.fingerprint)?.until ?? 0) < h.until) unique.set(h.fingerprint, h)
          return { ...b, authorizationHistory: [...unique.values()].sort((a, b) => b.until - a.until).slice(0, 3) }
        })
        this.ledger.save(`registry:${input.directory}`, { ...input, bindings, updatedAt: Date.now() })
        return json({ ok: true })
      }
      if (path === "/recommend" || path === "/reserve") {
        if (!this.config.enabled) return json({ error: "Router disabled" }, 409)
        const input = z.object({ id: idSchema.optional(), task: taskSchema, workflow: delegationTraceSchema.optional() }).strict().parse(body)
        const registry = this.registry(input.task.directory)
        let accounts = await this.accounts(registry.bindings)
        // Large conservative debt can exhaust a soft floor before the collector's
        // adaptive poll is due. Reconcile once, respecting its refresh cooldown;
        // never loop or lower the floor simply to get a request through.
        const recommendation = this.router.recommend(input.task, registry.models, accounts)
        if (!recommendation.candidates.some(c => !c.rejected.length) && recommendation.candidates.some(c => c.rejected.some(r => r.startsWith("Quota reserve reached")))) accounts = await this.accounts(registry.bindings, true)
        if (path === "/recommend") return json(this.router.recommend(input.task, registry.models, accounts))
        if (!input.id) throw new Error("Dispatch ID required")
        try {
          const execution = this.router.reserve(input.id, input.task, registry.models, accounts)
          this.trace(s => s.delegation(execution, input.workflow))
          return json(execution)
        } catch (error) {
          if (!this.ledger.get(input.id)) this.trace(s => s.denial(input.id!, input.task))
          throw error
        }
      }
      if (path === "/bind") {
        const { id, childSessionID } = z.object({ id: idSchema, childSessionID: z.string().startsWith("ses") }).strict().parse(body)
        const execution = this.ledger.bind(id, childSessionID, Date.now())
        this.trace(s => s.execution(execution)); return json(execution)
      }
      if (path === "/execution") {
        const { id, childSessionID } = z.object({ id: idSchema.optional(), childSessionID: z.string().optional() }).strict().parse(body)
        return json(id ? this.ledger.get(id) : childSessionID ? this.ledger.forChild(childSessionID) : null)
      }
      if (path === "/finish") {
        const input = z.object({ id: idSchema, state: z.enum(["completed", "failed", "uncertain", "cancelled"]) }).strict().parse(body)
        const execution = this.ledger.finish(input.id, input.state, Date.now())
        this.trace(s => s.execution(execution)); return json(execution)
      }
      if (path === "/reconcile") {
        const input = z.object({ id: idSchema, confirmation: z.literal("provider-idle-confirmed") }).strict().parse(body)
        const execution = this.ledger.get(input.id)
        if (!execution || !execution.childSessionID) throw new Error("Unknown child execution")
        const endpoint = await Service.discover()
        if (!endpoint) throw new Error("Cannot verify the native child is idle")
        const opencode = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
        if ((await opencode.session.active())[execution.childSessionID]) throw new Error("Native child is still running; reconciliation refused")
        const registry = this.registry(execution.task.directory)
        const account = (await this.accounts(registry.bindings, true)).find(a => a.key === execution.candidate.account.key)
        if (!account || account.windows.some(w => w.source !== "provider" || !Number.isFinite(w.checkedAt) || w.checkedAt <= execution.updatedAt || w.checkedAt > Date.now())) throw new Error("A fresh authoritative quota observation after termination is required")
        const reconciled = this.ledger.reconcile(execution.id, Date.now())
        this.trace(s => s.execution(reconciled)); return json(reconciled)
      }
      if (path === "/preflight") {
        const input = z.object({ id: idSchema, inputBound: z.number().int().nonnegative(), outputBound: z.number().int().positive() }).strict().parse(body)
        return json(await this.preflight(input.id, input.inputBound, input.outputBound))
      }
      if (path === "/usage") {
        const input = z.object({ requestID: idSchema, usage: usageSchema }).strict().parse(body)
        return json({ recorded: this.router.record(input.requestID, input.usage) })
      }
      if (path === "/failure") {
        const input = z.object({ id: idSchema, status: z.number().int().min(100).max(599), retryAfterMs: z.number().nonnegative().optional() }).strict().parse(body)
        this.router.failure(input.id, input.status, input.retryAfterMs); return json({ ok: true })
      }
      return json({ error: "Not found" }, 404)
    } catch (error) {
      // Only errors generated locally by our validation/routing code are exposed.
      return json({ error: error instanceof z.ZodError ? "Invalid router request" : error instanceof Error ? error.message.slice(0, 1500) : "Router request failed" }, 409)
    }
  }
  async preflight(id: string, inputBound: number, outputBound: number) {
    if (!this.config.enabled) throw new Error("Router disabled")
    const e = this.ledger.get(id)
    if (!e) throw new Error("Unknown execution")
    const registry = this.registry(e.task.directory)
    const model = registry.models.find(m => m.providerID === e.candidate.ref.providerID && m.id === e.candidate.ref.id)
    if (!model) throw new Error("Model no longer available")
    return this.router.preflight(id, model, await this.accounts(registry.bindings), inputBound, outputBound)
  }
  /** Guard native HTTP requests at the actual transport boundary. No secrets persist. */
  private async proxy(request: Request): Promise<Response> {
    const id = request.headers.get("x-router-execution") ?? ""
    const e = this.ledger.get(id)
    if (!e) throw new Error("Unknown routed execution")
    const target = new URL(request.headers.get("x-router-target") ?? "invalid:")
    const allowed = e.candidate.ref.providerID === "openai" ? ["api.openai.com", "chatgpt.com"] : e.candidate.ref.providerID === "opencode-go" ? ["opencode.ai"] : []
    if (target.protocol !== "https:" || !allowed.includes(target.hostname) || target.port || target.username || target.password) throw new Error("Unsupported native transport target")
    const binding = this.registry(e.task.directory).bindings.find(b => b.credentialID === e.candidate.account.credentialID && b.accountKey === e.candidate.account.key)
    verifyNativeCredential(e.candidate.ref.providerID, request.headers, binding?.credentialFingerprint, this.token,
      binding?.workspaceID ? { workspaceID: binding.workspaceID, fingerprints: (binding.authorizationHistory ?? []).filter(h => h.until > Date.now()).map(h => h.fingerprint) } : undefined)
    const raw = await decodeBody(request)
    if (raw.length > 8_000_000) throw new Error("Context body too large")
    const data = JSON.parse(raw)
    const selected = this.registry(e.task.directory).models.find(m => m.providerID === e.candidate.ref.providerID && m.id === e.candidate.ref.id)
    if (!selected || data.model !== (selected.modelID ?? selected.id)) throw new Error("Native request model does not match the reserved catalog model")
    const outputBound = capOutput(data, target.pathname.includes("responses"), e.candidate.outputTokens)
    const body = JSON.stringify(data)
    const bound = Buffer.byteLength(body) + 8192
    const reserved = await this.preflight(id, bound, outputBound)
    const headers = new Headers(request.headers)
    for (const name of [...headers.keys()]) if (name.startsWith("x-router-") || name.startsWith("x-opencode-router-") || ["host", "connection", "content-length", "content-encoding", "accept-encoding"].includes(name)) headers.delete(name)
    const started = performance.now()
    try {
      const upstream = await this.upstreamFetch(target, { method: "POST", headers, body, redirect: "error", signal: request.signal })
      if (!upstream.ok) {
        this.router.failure(id, upstream.status, Number(upstream.headers.get("retry-after") ?? 0) * 1000)
        this.router.record(reserved.requestID, { inputTokens: null, outputTokens: null, status: "failed", durationMs: performance.now() - started })
      }
      const replyHeaders = new Headers(upstream.headers)
      for (const h of ["content-encoding", "content-length", "transfer-encoding", "connection"]) replyHeaders.delete(h)
      if (!upstream.ok || !upstream.body) return new Response(upstream.body, { status: upstream.status, headers: replyHeaders })
      if (upstream.headers.get("content-type")?.includes("text/event-stream")) return new Response(measuredStream(upstream.body, usage => this.router.record(reserved.requestID, usage), started), { status: upstream.status, headers: replyHeaders })
      const result = await upstream.text(); const p = new UsageParser()
      try { p.observe(JSON.parse(result)) } catch {}
      this.router.record(reserved.requestID, { ...p.usage, durationMs: performance.now() - started })
      return new Response(result, { status: upstream.status, headers: replyHeaders })
    } catch {
      this.router.record(reserved.requestID, { inputTokens: null, outputTokens: null, status: "uncertain", durationMs: performance.now() - started })
      throw new Error("Native provider transport failed; reservation retained")
    }
  }
}

export function serve(service: RouterService) {
  const url = assertLocalUrl(service.config.url)
  return Bun.serve({ hostname: "127.0.0.1", port: Number(url.port || 80), idleTimeout: 255, maxRequestBodySize: 8_000_000, fetch: req => service.fetch(req) })
}
