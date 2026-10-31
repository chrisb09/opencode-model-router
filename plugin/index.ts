import { Plugin } from "@opencode/plugin"
import * as Tool from "@opencode/plugin/promise/tool"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { connect } from "../src/client.ts"
import type { RouterClient } from "../src/client.ts"
import { coordinatorInstructions } from "../src/agents.ts"
import { loadPolicy, settings as readSettings } from "../src/config.ts"
import type { Binding } from "../src/collector.ts"
import { modelString } from "../src/policy.ts"
import { agentVariant, selectStepBudget } from "../src/steps.ts"
import { roles, type CatalogModel, type Execution, type Task, type Policy } from "../src/types.ts"
import { guardLanguage } from "./guard.ts"
import { credentialFingerprint, goAuthorizationFingerprint } from "../src/identity.ts"
import { workflowTools } from "./workflow.ts"
import { purposes } from "../src/workflow-types.ts"

export const routingSchema = {
  type: "object", properties: {
    tier: { type: "string", enum: ["LOW", "DEFAULT", "HARD", "EXCEPTIONAL"] },
    importance: { type: "string", enum: ["low", "normal", "high", "critical"] },
    inputTokens: { type: "integer", minimum: 0 }, outputTokens: { type: "integer", minimum: 1 },
    steps: { type: "integer", minimum: 1, maximum: 100, description: "Requested native OpenCode step budget; default 30, extended variant up to the configured maximum" },
    originSessionID: { type: "string", description: "Original child session to independently review; omit when reviewing the primary session's work" },
    modalities: { type: "array", items: { type: "string", enum: ["text", "image", "pdf", "audio", "video"] } },
    taskID: { type: "string", description: "Logical task ID returned by workflow_annotate; optional" },
    purpose: { type: "string", enum: purposes },
  }, additionalProperties: false,
} as const
export const subagentInput = {
  type: "object", properties: {
    agent: { type: "string" }, description: { type: "string" }, prompt: { type: "string" }, model: { type: "string", description: "Only set for an explicit user model preference; routing safeguards still apply" },
    sessionID: { type: "string" }, background: { type: "boolean" }, routing: routingSchema,
  }, required: ["agent", "description", "prompt"], additionalProperties: false,
} as const
const hints = z.object({ tier: z.enum(["LOW", "DEFAULT", "HARD", "EXCEPTIONAL"]).default("DEFAULT"), importance: z.enum(["low", "normal", "high", "critical"]).default("normal"), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().positive().optional(), steps: z.number().int().positive().max(100).optional(), originSessionID: z.string().startsWith("ses").optional(), modalities: z.array(z.string()).optional(), taskID: z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(200).optional(), purpose: z.enum(purposes).optional() }).strict()

export default Plugin.define({ id: "quota-model-router", async setup(ctx) { return setupRouter(ctx) } })

export async function setupRouter(ctx: Context, suppliedClient?: RouterClient, suppliedPolicy?: Policy) {
  let initialized = false
  let initializationStatus = "starting"
  const cleanupOnFailure: Array<() => void> = []
  // Install the gate before any filesystem/network/configuration operation. Do
  // not throw from setup on initialization failure: the host would dispose the
  // failed plugin's registrations and reveal the unrestricted native executor.
  await ctx.tool.transform(editor => {
    editor.update("subagent", tool => {
      const native = tool.execute
      tool.execute = async (input, context) => {
        if (!initialized) throw new Tool.Error({ message: `Quota router unavailable or paused (${initializationStatus}); inspect its service/configuration and reload. Delegation is blocked, not bypassed.` })
        return native(input, context)
      }
    })
  })
  try {
  if (ctx.options.enabled === false) { initializationStatus = "paused by plugin options"; return () => {} }
  const client = suppliedClient ?? await connect(typeof ctx.options.config === "string" ? ctx.options.config : undefined)
  if (!client.config.enabled) { initializationStatus = "paused by configuration"; return }
  const policy = suppliedPolicy ?? await loadPolicy(client.config.policyFile)
  let disposed = false
  const localChildren = new Map<string, string>()
  const registration = async () => {
    const all = await ctx.model.list()
    const models = all.data.filter(m => Object.values(policy.aliases).some(ref => ref.split("#")[0] === `${m.providerID}/${m.id}`)).map(m => ({
      providerID: m.providerID, id: m.id, modelID: m.modelID, package: m.package, enabled: m.enabled, limit: { ...m.limit }, variants: m.variants.map(v => ({ id: v.id })),
      capabilities: { tools: m.capabilities.tools, input: [...m.capabilities.input], output: [...m.capabilities.output] }, cost: m.cost.map(c => ({ ...c, cache: { ...c.cache } })),
    })) as CatalogModel[]
    const integrations = (await ctx.integration.list()).data
    const bindings: Binding[] = []
    for (const providerID of ["antigravity", "openai", "opencode-go", "oneprovider"]) {
      try {
      // Console can supply Go through integration "opencode". Provider names
      // are not credential identities; follow the actual provider metadata.
      const integrationID = (await ctx.provider.get({ providerID: providerID as any })).data.integrationID ?? providerID
      const integration = integrations.find(i => i.id === integrationID)
      const active = await ctx.integration.connection.active(integrationID as any)
      for (const c of integration?.connections ?? []) {
        if (c.type !== "credential" || (providerID === "antigravity" && c.method !== "oauth") || (providerID !== "antigravity" && (active?.type !== "credential" || c.id !== active.id))) continue
        let fingerprint: string | undefined
        let workspaceID: string | undefined
        let authorizationFingerprint: string | undefined
        if (["openai", "opencode-go"].includes(providerID)) {
          const credential = await ctx.integration.connection.resolve(c)
          if (!credential) continue
          try { fingerprint = credentialFingerprint(providerID, credential, client.token) } catch { continue }
          if (providerID === "opencode-go" && credential.type === "oauth" && typeof credential.metadata?.orgID === "string") {
            workspaceID = credential.metadata.orgID
            authorizationFingerprint = goAuthorizationFingerprint(credential.access, client.token)
          }
        }
        bindings.push({ providerID, integrationID, credentialID: c.id, label: c.label, method: c.method, credentialFingerprint: fingerprint, workspaceID, authorizationFingerprint,
          accountKey: providerID === "antigravity" ? `google:${c.label.toLowerCase()}` : providerID === "openai" ? "codex:default" : providerID === "oneprovider" ? "oneprovider:default" : "opencode-go:default" })
      }
      } catch { /* An unavailable integration must not disable other eligible providers. */ }
    }
    const approved = suppliedClient ? client.config.credentialBindings : (await readSettings(typeof ctx.options.config === "string" ? ctx.options.config : undefined)).credentialBindings
    await client.call("/registry", { directory: ctx.location.directory, models, bindings: approved ? bindings.filter(b => approved.some(a => a.providerID === b.providerID && a.credentialID === b.credentialID && a.accountKey === b.accountKey && a.credentialFingerprint === b.credentialFingerprint && a.workspaceID === b.workspaceID)) : bindings })
  }
  // Fail plugin setup if the guard service is unavailable rather than leaving a
  // partially registered routing tool behind. Installation starts it first.
  await registration()
  const interval = setInterval(() => { if (!disposed) void registration().catch(() => {}) }, 60_000)
  interval.unref?.()
  cleanupOnFailure.push(() => clearInterval(interval))
  await ctx.tool.transform(editor => {
    editor.update("subagent", tool => {
      const native = tool.execute
      tool.input = subagentInput
      tool.description += "\nQuota-aware routing is enforced automatically. Optional routing metadata: tier, importance, inputTokens, outputTokens, steps, originSessionID and modalities. Native steps default to 30; steps >30 use an internal extended variant up to the configured maximum. Paid Opus and Kimi are locked. Use a new child for escalation."
      tool.execute = async (value, context) => {
        if (!initialized) throw new Tool.Error({ message: "Quota router is not initialized; delegation blocked" })
        const input = value as any
        const routing = hints.parse(input.routing ?? {})
        if (!roles.includes(input.agent)) throw new Tool.Error({ message: "Unknown routed subagent role" })
        if (context.agent === "plan" && input.agent === "general") throw new Tool.Error({ message: "Plan cannot delegate implementation" })
        await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool", messageID: context.messageID, id: context.id }, action: "subagent", resources: [input.agent], save: [input.agent] })
        await registration()
        const parent = await ctx.session.get({ sessionID: context.sessionID })
        if (parent.parentID) throw new Tool.Error({ message: "Subagent recursion is disabled" })
        let origin = parent
        if (routing.originSessionID) {
          origin = await ctx.session.get({ sessionID: routing.originSessionID as any })
          if (origin.parentID !== parent.id && origin.id !== parent.id) throw new Tool.Error({ message: "Original session is not in the current delegation tree" })
        }
        const old = input.sessionID ? await client.call<Execution | null>("/execution", { childSessionID: input.sessionID }) : null
        if (input.sessionID && (!old || old.task.parentSessionID !== context.sessionID || old.task.role !== input.agent)) throw new Tool.Error({ message: "Only a matching routed child can be continued" })
        if (old && input.model && input.model !== old.candidate.model) throw new Tool.Error({ message: "Use a new child session for a model change" })
        const oldRequestedSteps = old?.task.steps ?? old?.task.stepBudget ?? policy.steps.default
        if (old && routing.steps !== undefined && routing.steps !== oldRequestedSteps) throw new Tool.Error({ message: "Use a new child session for a native step budget change" })
        let steps: ReturnType<typeof selectStepBudget>
        try { steps = selectStepBudget(policy, routing.steps ?? oldRequestedSteps) }
        catch (error) { throw new Tool.Error({ message: error instanceof Error ? error.message : "Invalid native step budget" }) }
        const stepBudget = old?.task.stepBudget ?? steps.budget
        const task: Task = { role: input.agent, tier: routing.tier, importance: routing.importance, parentAgent: context.agent, parentSessionID: context.sessionID,
          directory: ctx.location.directory, inputTokens: Math.max(routing.inputTokens ?? 0, Buffer.byteLength(input.prompt)), outputTokens: routing.outputTokens,
          modalities: routing.modalities ?? ["text"], originModel: origin.model ? modelString(origin.model) : undefined, requestedModel: old?.candidate.model ?? (input.model || undefined),
          steps: steps.requested, stepBudget }
        const id = `${context.sessionID}:${context.messageID}:${context.id}`
        let execution: Execution
        try { execution = old && ["reserved", "running"].includes(old.state) ? old : await client.call<Execution>("/reserve", { id, task, workflow: { taskID: routing.taskID, purpose: routing.purpose, label: String(input.description).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160), background: input.background ?? false, previousExecutionID: old?.id } }) }
        catch (error) { throw new Tool.Error({ message: error instanceof Error ? error.message : "Routing denied" }) }
        let child: string | null = execution.childSessionID
        let completed = false
        const nativeInput = { ...input, agent: agentVariant(input.agent, policy, execution.task.stepBudget ?? policy.steps.default), model: execution.candidate.model }
        delete nativeInput.routing
        if (task.role === "critic") nativeInput.prompt = `Original model: ${task.originModel}. Original session: ${origin.id}. Independently verify the evidence; do not claim a different provider alone makes this independent.\n\n${input.prompt}`
        try {
          const result = await native(nativeInput, { ...context, progress: async update => {
            if (typeof update.sessionID === "string") {
              child = update.sessionID
              await client.call("/bind", { id: execution.id, childSessionID: child })
              localChildren.set(child, execution.id)
            }
            await context.progress(update)
          } } as ToolContext)
          const state = (result.metadata as any)?.status
          if (state !== "running") { await client.call("/finish", { id: execution.id, state: "completed" }); completed = true }
          return { ...result, metadata: { ...result.metadata, routing: { executionID: execution.id, model: execution.candidate.model, account: execution.candidate.account.key, tier: task.tier, importance: task.importance, steps: execution.task.stepBudget, requestedSteps: execution.task.steps } } }
        } catch (error) {
          // Do not automatically retry another implementation agent after it may
          // have performed writes. Preserve its child for an explicit handoff.
          await client.call("/finish", { id: execution.id, state: child ? "failed" : "cancelled" }).catch(() => {})
          throw error
        } finally { if (completed && child) localChildren.delete(child) }
      }
    })
  })
  const executionFor = async (sessionID: string): Promise<Execution | null> => {
    const session = await ctx.session.get({ sessionID: sessionID as any })
    if (!session.parentID) return null // Router outages must not break primary work.
    return client.call("/execution", { childSessionID: sessionID })
  }
  await ctx.session.hook("context", async event => {
    if (["plan", "build"].includes(event.agent)) event.system.push({ type: "text", text: coordinatorInstructions })
    const execution = await executionFor(event.sessionID)
    if (execution && execution.state === "running") event.options.maxTokens = execution.candidate.outputTokens
  })
  await ctx.session.hook("model.request", async event => {
    const execution = await executionFor(event.sessionID)
    if (execution?.state === "running") {
      event.headers["x-opencode-router-execution"] = execution.id
      event.headers["x-opencode-router-model"] = modelString(event.model)
    }
  })
  await ctx.aisdk.hook("language", async event => {
    if (!Object.values(policy.aliases).some(ref => ref.split("#")[0] === `${event.model.providerID}/${event.model.id}`)) return
    if (!event.language && typeof event.sdk === "function") event.language = event.sdk(event.model.modelID ?? event.model.id, event.options)
    if (event.language) event.language = guardLanguage(event.language, client, { providerID: event.model.providerID, id: event.model.id, modelID: event.model.modelID ?? event.model.id })
  })
  await ctx.session.hook("http.request", async event => {
    const execution = await executionFor(event.sessionID)
    if (!execution || execution.state !== "running" || !["openai", "opencode-go"].includes(event.model.providerID)) return
    const headers = new Headers(event.request.headers)
    headers.set("x-router-token", client.token); headers.set("x-router-target", event.request.url)
    headers.set("x-router-execution", modelString(event.model) === execution.candidate.model ? execution.id : "model-change-denied")
    event.request = new Request(client.config.url + "/proxy", { method: event.request.method, headers, body: event.request.body, duplex: "half", signal: event.request.signal } as RequestInit)
  })
  await ctx.session.hook("experimental.ws.handshake", async event => {
    const execution = await executionFor(event.sessionID)
    if (execution?.state === "running") {
      // This release guards native HTTP. Never let WebSocket bypass accounting.
      event.url = client.config.url.replace("http:", "ws:") + "/websocket-disabled"
      event.headers = {}
    }
  })
  await ctx.session.hook("retry", async event => {
    const execution = await executionFor(event.sessionID)
    if (execution?.state === "running" && event.attempt >= 2) event.decision = { retry: false }
  })
  // Optional tracing must not remove the already-installed quota guards on failure.
  let workflowEvent: ((event: any) => Promise<void>) | undefined
  try { workflowEvent = await workflowTools(ctx, client) } catch { /* native routing remains guarded */ }
  const events = new AbortController()
  cleanupOnFailure.push(() => events.abort())
  void (async () => {
    while (!events.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (workflowEvent) await workflowEvent(event)
          if (!["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) continue
          const sessionID = (event.data as any).sessionID
          if (!sessionID) continue
          const execution = await executionFor(sessionID)
          if (!execution || execution.state !== "running" || execution.task.directory !== ctx.location.directory) continue
          // A delayed terminal event from an earlier run of the same child must
          // not release a newer continuation's reservation.
          if (!("created" in event) || event.created < execution.createdAt) continue
          const sequence = (event as any).durable?.seq
          if (event.type === "session.execution.started") {
            await ctx.storage.set(`native-start:${execution.id}`, sequence)
            continue
          }
          const started = await ctx.storage.get(`native-start:${execution.id}`)
          if (typeof started !== "number" || typeof sequence !== "number" || sequence <= started) continue
          await client.call("/finish", { id: execution.id, state: event.type.endsWith("succeeded") ? "completed" : event.type.endsWith("interrupted") ? "uncertain" : "failed" })
          localChildren.delete(sessionID)
        }
      } catch { if (!events.signal.aborted) await new Promise(r => setTimeout(r, 1000)) }
    }
  })()
  initialized = true
  initializationStatus = "ready"
  // V2 retains executable tool snapshots already captured by a model request.
  // Disposal removes future registrations, but must not invalidate an already
  // admitted snapshot merely because an unrelated config/source reload occurred.
  return () => { disposed = true; clearInterval(interval); events.abort() }
  } catch (error) {
    initializationStatus = `setup failed: ${error instanceof Error ? error.name : "unknown error"}`
    for (const cleanup of cleanupOnFailure) cleanup()
    return () => { initialized = false }
  }
}
