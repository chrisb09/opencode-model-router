import { createHash } from "node:crypto"
import type { Database } from "bun:sqlite"
import { z } from "zod"
import type { Execution } from "./types.ts"
import { purposes, taskStates, contributions, type WorkflowTask, type WorkflowSpan, type WorkflowSnapshot, type Purpose } from "./workflow-types.ts"

export const workflowID = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const localText = (max: number) => z.string().max(max).refine(v => !/[\u0000-\u001f\u007f]/.test(v), "Local text cannot contain control characters")
export const annotationSchema = z.object({
  taskID: workflowID.optional(), parentTaskID: workflowID.nullable().optional(),
  dependsOn: z.array(workflowID).max(32).optional(), purpose: z.enum(purposes).optional(),
  state: z.enum(taskStates).optional(), label: localText(160).optional(),
  contribution: z.enum(contributions).optional(), note: localText(1000).optional(),
  evidenceIDs: z.array(workflowID).max(32).optional(),
}).strict()
export type Annotation = z.infer<typeof annotationSchema>
export const delegationTraceSchema = z.object({
  taskID: workflowID.optional(), purpose: z.enum(purposes).optional(), label: localText(160).optional(),
  background: z.boolean().default(false), previousExecutionID: z.string().max(500).optional(),
}).strict()
export type DelegationTrace = z.infer<typeof delegationTraceSchema>
export const primaryTraceSchema = z.object({
  sessionID: workflowID, eventID: workflowID, sequence: z.number().int().nonnegative(),
  at: z.number().int().nonnegative(), state: z.enum(["running", "completed", "failed", "cancelled"]),
  agent: z.enum(["plan", "build"]), model: z.string().max(300).nullable(),
}).strict()
type PrimaryTrace = z.infer<typeof primaryTraceSchema>
type SpanRow = { payload: string; sequence: number | null }
const stable = (kind: string, id: string) => `${kind}:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`
const purposeFor = (role: string): Purpose => ({ explore: "exploration", research: "research", general: "implementation", debugger: "debugging", reviewer: "review", architect: "planning", critic: "criticism", plan: "planning", build: "integration" } as Record<string, Purpose>)[role] ?? "unknown"
const maxTasks = 500, maxSpans = 2000, maxEvents = 5000
class WorkflowLimitError extends Error {}

/** Local-only structured facts. No prompts, request bodies, registry or credentials. */
export class WorkflowStore {
  constructor(readonly db: Database, readonly captureLabels = true, readonly clock = Date.now) {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS wf_sessions(session_id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,truncated INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS wf_tasks(session_id TEXT NOT NULL REFERENCES wf_sessions(session_id) ON DELETE CASCADE,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS wf_spans(session_id TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,execution_id TEXT,sequence INTEGER,payload TEXT NOT NULL,PRIMARY KEY(session_id,id),FOREIGN KEY(session_id,task_id) REFERENCES wf_tasks(session_id,id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS wf_execution ON wf_spans(execution_id);
      CREATE TABLE IF NOT EXISTS wf_events(session_id TEXT NOT NULL REFERENCES wf_sessions(session_id) ON DELETE CASCADE,id TEXT NOT NULL,at INTEGER NOT NULL,kind TEXT NOT NULL,task_id TEXT,span_id TEXT,PRIMARY KEY(session_id,id));
      CREATE INDEX IF NOT EXISTS wf_recent ON wf_sessions(updated_at);
      CREATE TABLE IF NOT EXISTS wf_context(session_id TEXT PRIMARY KEY REFERENCES wf_sessions(session_id) ON DELETE CASCADE,agent TEXT NOT NULL,model TEXT);
      CREATE TABLE IF NOT EXISTS wf_primary_events(session_id TEXT NOT NULL REFERENCES wf_sessions(session_id) ON DELETE CASCADE,id TEXT NOT NULL,sequence INTEGER NOT NULL,at INTEGER NOT NULL,state TEXT NOT NULL,agent TEXT NOT NULL,model TEXT,PRIMARY KEY(session_id,id),UNIQUE(session_id,sequence));`)
  }
  private atomic<T>(fn: () => T, session?: string): T {
    try { return this.db.transaction(fn).immediate() }
    catch (error) {
      if (session && error instanceof WorkflowLimitError) this.db.query("UPDATE wf_sessions SET truncated=1 WHERE session_id=?").run(session)
      throw error
    }
  }
  private touch(session: string, at = this.clock()) {
    if (!this.db.query("SELECT 1 FROM wf_sessions WHERE session_id=?").get(session)) {
      if ((this.db.query("SELECT count(*) AS n FROM wf_sessions").get() as any).n >= 1000) throw new WorkflowLimitError("Workflow session capacity reached; prune local traces")
      this.db.query("INSERT INTO wf_sessions VALUES(?,?,?,0)").run(session, at, at)
    }
    this.db.query("UPDATE wf_sessions SET updated_at=max(updated_at,?) WHERE session_id=?").run(at, session)
  }
  private count(table: "wf_tasks" | "wf_spans" | "wf_events", session: string): number { return (this.db.query(`SELECT count(*) AS n FROM ${table} WHERE session_id=?`).get(session) as any).n }
  private event(session: string, id: string, kind: string, task: string | null, span: string | null, at = this.clock()) {
    if (this.count("wf_events", session) >= maxEvents) { this.db.query("UPDATE wf_sessions SET truncated=1 WHERE session_id=?").run(session); return }
    this.db.query("INSERT OR IGNORE INTO wf_events VALUES(?,?,?,?,?,?)").run(session, id, at, kind, task, span)
  }
  private task(session: string, id: string): WorkflowTask | null {
    const row = this.db.query<{ payload: string }, [string, string]>("SELECT payload FROM wf_tasks WHERE session_id=? AND id=?").get(session, id)
    return row ? JSON.parse(row.payload) : null
  }
  hasTask(session: string, id: string) { return this.task(session, id) !== null }
  private saveTask(session: string, task: WorkflowTask) {
    if (!this.task(session, task.id) && this.count("wf_tasks", session) >= maxTasks) throw new WorkflowLimitError("Workflow task capacity reached")
    this.db.query("INSERT INTO wf_tasks VALUES(?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET payload=excluded.payload").run(session, task.id, JSON.stringify(task))
  }
  private newTask(session: string, id: string, purpose: Purpose, label?: string): WorkflowTask {
    const at = this.clock()
    const t: WorkflowTask = { id, source: "automatic", parentTaskID: null, dependsOn: [], purpose, state: "planned", contribution: "unassessed", assessmentSource: null, evidenceIDs: [], createdAt: at, updatedAt: at, ...(this.captureLabels && label ? { label } : {}) }
    this.saveTask(session, t); return t
  }
  annotate(session: string, eventID: string, input: Annotation) {
    return this.atomic(() => {
      this.touch(session)
      const id = input.taskID ?? stable("task", eventID)
      const duplicate = this.db.query<{ task_id: string }, [string, string]>("SELECT task_id FROM wf_events WHERE session_id=? AND id=?").get(session, eventID)
      if (duplicate) return { taskID: duplicate.task_id, duplicate: true }
      if (this.count("wf_events", session) >= maxEvents) throw new WorkflowLimitError("Workflow annotation capacity reached")
      const old = this.task(session, id)
      if (!old && input.taskID) throw new Error("Workflow task not found in this session; omit taskID to create one")
      const task = old ?? this.newTask(session, id, input.purpose ?? "unknown")
      const next = { ...task, ...input, id, source: "coordinator" as const, updatedAt: this.clock() }
      delete (next as any).taskID
      if (!this.captureLabels) { delete next.label; delete next.note }
      if (input.contribution !== undefined || input.note !== undefined || input.evidenceIDs !== undefined) next.assessmentSource = "coordinator"
      if (new Set(next.dependsOn).size !== next.dependsOn.length) throw new Error("Duplicate workflow dependency")
      const all = (this.db.query<{ payload: string }, [string]>("SELECT payload FROM wf_tasks WHERE session_id=?").all(session)).map(r => JSON.parse(r.payload) as WorkflowTask)
      const tasks = new Map(all.map(t => [t.id, t])); tasks.set(id, next)
      const edges = new Map<string, string[]>()
      for (const t of tasks.values()) {
        for (const from of [...t.dependsOn, ...(t.parentTaskID ? [t.parentTaskID] : [])]) {
          if (!tasks.has(from)) throw new Error("Workflow relation target not found in this session")
          edges.set(from, [...(edges.get(from) ?? []), t.id])
        }
      }
      const visiting = new Set<string>(), done = new Set<string>()
      const visit = (node: string) => {
        if (visiting.has(node)) throw new Error("Workflow relations must be acyclic")
        if (done.has(node)) return
        visiting.add(node); for (const child of edges.get(node) ?? []) visit(child)
        visiting.delete(node); done.add(node)
      }
      for (const key of tasks.keys()) visit(key)
      this.saveTask(session, next)
      this.event(session, eventID, "task.annotated", id, null)
      return { taskID: id, duplicate: false }
    }, session)
  }
  private span(session: string, id: string): WorkflowSpan | null {
    const row = this.db.query<SpanRow, [string, string]>("SELECT payload,sequence FROM wf_spans WHERE session_id=? AND id=?").get(session, id)
    return row ? JSON.parse(row.payload) : null
  }
  private saveSpan(session: string, span: WorkflowSpan, sequence: number | null = null) {
    if (!this.span(session, span.id) && this.count("wf_spans", session) >= maxSpans) throw new WorkflowLimitError("Workflow span capacity reached")
    this.db.query("INSERT INTO wf_spans VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,id) DO UPDATE SET payload=excluded.payload").run(session, span.id, span.taskID, span.executionID, sequence, JSON.stringify(span))
  }
  delegation(e: Execution, meta?: DelegationTrace) {
    this.atomic(() => {
      const session = e.task.parentSessionID
      this.touch(session)
      if (this.span(session, e.id)) return
      const previous = meta?.previousExecutionID ? this.span(session, meta.previousExecutionID) : null
      const taskID = meta?.taskID ?? previous?.taskID ?? stable("task", e.id)
      let task = this.task(session, taskID)
      if (!task && meta?.taskID) throw new Error("Workflow task not found in this session")
      const automatic = !meta?.taskID && !previous
      const purpose = meta?.purpose ?? task?.purpose ?? purposeFor(e.task.role)
      if (!task) task = this.newTask(session, taskID, purpose, meta?.label)
      if (automatic) { task.state = "running"; this.saveTask(session, task) }
      this.saveSpan(session, { id: e.id, taskID, kind: "delegation", executionID: e.id, childSessionID: e.childSessionID, agent: e.task.role, model: e.candidate.model, modelSource: "routing_selection", modelsObserved: [e.candidate.model], tier: e.task.tier, purpose, state: e.state, startedAt: e.createdAt, endedAt: null, background: meta?.background ?? false, continuationOf: previous?.id ?? null, requests: [], accountRef: stable("account", e.candidate.account.key), routingReasons: e.candidate.reasons.slice(0, 10) })
      this.event(session, stable("selected", e.id), "delegation.selected", taskID, e.id, e.createdAt)
    }, e.task.parentSessionID)
  }
  execution(e: Execution) {
    this.atomic(() => {
      const s = this.span(e.task.parentSessionID, e.id)
      if (!s) return
      const terminal = !["reserved", "running"].includes(e.state)
      if (s.state === e.state && s.childSessionID === e.childSessionID) return
      s.childSessionID = e.childSessionID; s.state = e.state
      s.endedAt = terminal ? e.updatedAt : null
      this.saveSpan(e.task.parentSessionID, s)
      // Only automatically generated delegation tasks follow execution status;
      // explicit logical tasks can have multiple executions and require assessment.
      const t = this.task(e.task.parentSessionID, s.taskID)
      const latest = this.db.query<{ id: string }, [string, string]>("SELECT id FROM wf_spans WHERE session_id=? AND task_id=? ORDER BY json_extract(payload,'$.startedAt') DESC,id DESC LIMIT 1").get(e.task.parentSessionID, s.taskID)
      if (t && t.source !== "coordinator" && latest?.id === s.id) {
        t.state = terminal ? e.state === "completed" ? "completed" : ["cancelled", "reconciled"].includes(e.state) ? "cancelled" : e.state === "uncertain" ? "blocked" : "failed" : "running"
        t.updatedAt = e.updatedAt; this.saveTask(e.task.parentSessionID, t)
      }
      this.touch(e.task.parentSessionID)
      this.event(e.task.parentSessionID, stable("execution", `${e.id}:${e.state}:${e.childSessionID}`), `delegation.${e.state}`, s.taskID, s.id, e.updatedAt)
    }, e.task.parentSessionID)
  }
  context(session: string, agent: string, model: string) {
    this.atomic(() => {
      this.touch(session)
      this.db.query("INSERT INTO wf_context VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET agent=excluded.agent,model=excluded.model").run(session, agent, model)
      const active = this.db.query<SpanRow, [string]>("SELECT payload,sequence FROM wf_spans WHERE session_id=? AND sequence IS NOT NULL ORDER BY sequence DESC LIMIT 1").get(session)
      if (active) {
        const span = JSON.parse(active.payload) as WorkflowSpan
        if (span.state === "running") {
          span.model = model; span.modelSource = "request_hook"
          span.modelsObserved = [...new Set([...(span.modelsObserved ?? []), model])].slice(-20)
          this.saveSpan(session, span, active.sequence)
        }
      }
    }, session)
  }
  denial(id: string, task: { parentSessionID: string; role: string; tier: string }) {
    this.atomic(() => {
      const session = task.parentSessionID
      this.touch(session)
      if (this.span(session, id)) return
      const t = this.newTask(session, stable("task", id), purposeFor(task.role))
      t.state = "blocked"; this.saveTask(session, t)
      this.saveSpan(session, { id, taskID: t.id, kind: "denial", executionID: null, childSessionID: null, agent: task.role, model: null, tier: task.tier, purpose: t.purpose, state: "denied", startedAt: this.clock(), endedAt: this.clock(), background: false, continuationOf: null, requests: [] })
      this.event(session, stable("denied", id), "delegation.denied", t.id, id)
    }, task.parentSessionID)
  }
  primary(input: PrimaryTrace) {
    this.atomic(() => {
      const session = input.sessionID
      this.touch(session, input.at)
      if (this.db.query("SELECT 1 FROM wf_primary_events WHERE session_id=? AND (id=? OR sequence=?)").get(session, input.eventID, input.sequence)) return
      if ((this.db.query("SELECT count(*) AS n FROM wf_primary_events WHERE session_id=?").get(session) as any).n >= maxEvents) throw new WorkflowLimitError("Workflow primary event capacity reached")
      this.db.query("INSERT INTO wf_primary_events VALUES(?,?,?,?,?,?,?)").run(session, input.eventID, input.sequence, input.at, input.state, input.agent, input.model)
      const context = this.db.query<{ agent: string; model: string | null }, [string]>("SELECT agent,model FROM wf_context WHERE session_id=?").get(session)
      let task = this.task(session, "primary")
      if (!task) task = this.newTask(session, "primary", purposeFor(input.agent))
      // Native execution is serialized per session. Reconstruct from authoritative
      // durable sequence, not delivery order. A terminal only belongs to the start
      // before it AND before the next start. Late starts repair previous gaps.
      const events = this.db.query<any, [string]>("SELECT * FROM wf_primary_events WHERE session_id=? ORDER BY sequence").all(session)
      const starts = events.filter(e => e.state === "running")
      let latest: WorkflowSpan | null = null
      const terminalOwners = new Map<string, string>()
      let eventIndex = 0
      for (let i = 0; i < starts.length; i++) {
        const start = starts[i], next = starts[i + 1]
        while (eventIndex < events.length && events[eventIndex].sequence <= start.sequence) eventIndex++
        const candidate = events[eventIndex]
        const end = candidate && candidate.state !== "running" && (!next || candidate.sequence < next.sequence) ? candidate : undefined
        const id = `primary:${start.sequence}`
        const old = this.span(session, id)
        const model = old?.modelSource === "request_hook" ? old.model : start.model ?? (starts.length === 1 ? context?.model : null) ?? null
        const span: WorkflowSpan = { id, taskID: task.id, kind: "primary", executionID: null, childSessionID: null, agent: start.agent, model, modelSource: old?.modelSource === "request_hook" ? "request_hook" : start.model ? "session_snapshot" : model ? "request_hook" : "unknown", modelsObserved: old?.modelsObserved ?? (model ? [model] : []), tier: null, purpose: purposeFor(start.agent), state: end?.state ?? (next ? "unknown" : "running"), startedAt: start.at, endedAt: end ? Math.max(start.at, end.at) : null, background: false, continuationOf: null, requests: [] }
        if (!old || JSON.stringify(old) !== JSON.stringify(span)) this.saveSpan(session, span, start.sequence)
        this.event(session, start.id, "primary.running", task.id, span.id, start.at)
        if (end) terminalOwners.set(end.id, span.id)
        latest = span
      }
      // Update initially unmatched terminal events once a late start supplies the
      // missing correlation, while retaining explicit unknown gaps otherwise.
      for (const e of events.filter(e => e.state !== "running")) {
        const spanID = terminalOwners.get(e.id) ?? null
        this.event(session, e.id, spanID ? `primary.${e.state}` : "primary.unmatched_terminal", task.id, spanID, e.at)
        this.db.query("UPDATE wf_events SET kind=?,span_id=? WHERE session_id=? AND id=?").run(spanID ? `primary.${e.state}` : "primary.unmatched_terminal", spanID, session, e.id)
      }
      if (task.source !== "coordinator") {
        task.state = latest && latest.state !== "unknown" ? latest.state as WorkflowTask["state"] : "blocked"
        task.updatedAt = this.clock(); this.saveTask(session, task)
      }
    }, input.sessionID)
  }
  read(session: string, includeLocalText = false): WorkflowSnapshot {
    const tasks = this.db.query<{ payload: string }, [string]>("SELECT payload FROM wf_tasks WHERE session_id=? ORDER BY id").all(session).map(r => {
      const t = JSON.parse(r.payload) as WorkflowTask
      if (!includeLocalText) { delete t.label; delete t.note }
      return t
    })
    const spans = this.db.query<{ payload: string }, [string]>("SELECT payload FROM wf_spans WHERE session_id=? ORDER BY id").all(session).map(r => {
      const s = JSON.parse(r.payload) as WorkflowSpan
      if (s.executionID) s.requests = (this.db.query<any, [string]>("SELECT id,state,started_at,ended_at,estimate_pp,usage FROM requests WHERE execution_id=? ORDER BY started_at,id").all(s.executionID)).map(r => {
        const u = r.usage ? JSON.parse(r.usage) : {}
        return { id: r.id, state: r.state, startedAt: r.started_at, endedAt: r.ended_at, estimatedQuotaPp: r.estimate_pp, inputTokens: u.inputTokens ?? null, outputTokens: u.outputTokens ?? null, reasoningTokens: u.reasoningTokens ?? null, cacheReadTokens: u.cacheReadTokens ?? null }
      })
      return s
    })
    const events = this.db.query<any, [string]>("SELECT id,at,kind,task_id,span_id FROM wf_events WHERE session_id=? ORDER BY at,id").all(session).map(r => ({ id: r.id, at: r.at, kind: r.kind, taskID: r.task_id, spanID: r.span_id }))
    return { schemaVersion: 1, sessionID: session, generatedAt: this.clock(), localOnly: true, includesLocalText: includeLocalText, tasks, spans, events, truncated: !!(this.db.query<any, [string]>("SELECT truncated FROM wf_sessions WHERE session_id=?").get(session)?.truncated), coverage: { primaryUsage: "not_collected", contribution: "explicit_coordinator_assessment", cost: "unavailable", history: "since_tracing_enabled" } }
  }
  list(limit = 20) { return this.db.query("SELECT session_id AS sessionID,created_at AS createdAt,updated_at AS updatedAt,truncated FROM wf_sessions ORDER BY updated_at DESC,session_id LIMIT ?").all(limit) }
  forget(session: string) { return this.db.query("DELETE FROM wf_sessions WHERE session_id=?").run(session).changes > 0 }
}
