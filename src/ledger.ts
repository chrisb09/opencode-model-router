import { Database } from "bun:sqlite"
import type { Candidate, Execution, Task, Usage } from "./types.ts"

type Row = { id: string; child_session_id: string | null; state: Execution["state"]; task: string; candidate: string; created_at: number; updated_at: number }
export class Ledger {
  readonly db: Database
  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, child_session_id TEXT, state TEXT NOT NULL,
        account_key TEXT NOT NULL, model TEXT NOT NULL, task TEXT NOT NULL,
        candidate TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS execution_child ON executions(child_session_id);
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
        account_key TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL,
        estimate_pp REAL NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
        usage TEXT, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS request_account ON requests(account_key,started_at);
      CREATE TABLE IF NOT EXISTS failures (
        account_key TEXT NOT NULL, model TEXT NOT NULL, until_at INTEGER NOT NULL,
        reason TEXT NOT NULL, PRIMARY KEY(account_key,model));
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT, at INTEGER NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registry (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
  }
  close() { this.db.close() }
  atomic<T>(fn: () => T): T { return this.db.transaction(fn).immediate() }
  get(id: string): Execution | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM executions WHERE id=?").get(id)
    return row ? this.decode(row) : null
  }
  forChild(id: string): Execution | null {
    const row = this.db.query<Row, [string]>("SELECT * FROM executions WHERE child_session_id=? ORDER BY created_at DESC LIMIT 1").get(id)
    return row ? this.decode(row) : null
  }
  /** Active executions whose last local state change predates the idle threshold. */
  stale(olderThan: number, limit = 50): Execution[] {
    return this.db.query<Row, [number, number]>(`SELECT * FROM executions
      WHERE state IN ('reserved','running','uncertain') AND updated_at < ?
      ORDER BY updated_at ASC LIMIT ?`).all(olderThan, limit).map(row => this.decode(row))
  }
  private decode(r: Row): Execution {
    return { id: r.id, childSessionID: r.child_session_id, state: r.state, task: JSON.parse(r.task), candidate: JSON.parse(r.candidate), createdAt: r.created_at, updatedAt: r.updated_at }
  }
  create(id: string, task: Task, candidate: Candidate, now: number) {
    this.db.query("INSERT INTO executions VALUES(?,NULL,'reserved',?,?,?,?,?,?)").run(id, candidate.account.key, candidate.model, JSON.stringify(task), JSON.stringify(candidate), now, now)
    this.log(id, "selected", { model: candidate.model, account: candidate.account.key, tier: task.tier, role: task.role, importance: task.importance, reasons: candidate.reasons }, now)
    return this.get(id)!
  }
  bind(id: string, child: string, now: number) {
    const e = this.get(id)
    if (!e || !["reserved", "running"].includes(e.state)) throw new Error("Execution is not dispatchable")
    if (e.childSessionID && e.childSessionID !== child) throw new Error("Execution already bound to another child")
    this.db.query("UPDATE executions SET child_session_id=?,state='running',updated_at=? WHERE id=?").run(child, now, id)
    return this.get(id)!
  }
  finish(id: string, state: Execution["state"], now: number) {
    const e = this.get(id)
    if (!e) throw new Error("Execution not found")
    if (["completed", "failed", "cancelled"].includes(e.state)) return e
    // If native execution terminated without a transport acknowledgment, preserve
    // uncertainty instead of leaving a fictitious live request or freeing a slot.
    this.db.query("UPDATE requests SET state='uncertain',ended_at=? WHERE execution_id=? AND state='reserved'").run(now, id)
    const uncertain = this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM requests WHERE execution_id=? AND state='uncertain'").get(id)!.n
    if (uncertain) state = "uncertain"
    // An uncertain physical request keeps debt even when the child terminates.
    this.db.query("UPDATE executions SET state=?,updated_at=? WHERE id=?").run(state, now, id)
    this.log(id, "finished", { state }, now)
    return this.get(id)!
  }
  concurrency(key: string): number {
    return this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM executions e WHERE account_key=? AND (state IN ('reserved','running','uncertain') OR EXISTS(SELECT 1 FROM requests r WHERE r.execution_id=e.id AND r.state IN ('reserved','uncertain')))").get(key)!.n
  }
  totalConcurrency(): number {
    return this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM executions e WHERE state IN ('reserved','running','uncertain') OR EXISTS(SELECT 1 FROM requests r WHERE r.execution_id=e.id AND r.state IN ('reserved','uncertain'))").get()!.n
  }
  pressure(key: string, _window: string, checkedAt: number): number {
    const active = this.db.query<{ n: number }, [string]>("SELECT coalesce(sum(json_extract(candidate,'$.estimatedRequestPp')),0) AS n FROM executions e WHERE account_key=? AND state IN ('reserved','running','uncertain') AND NOT EXISTS(SELECT 1 FROM requests r WHERE r.execution_id=e.id)").get(key)!.n
    // Completed requests are not freed against a snapshot predating completion.
    // Unknown/aborted usage never becomes spendable merely because time passes.
    const debt = this.db.query<{ n: number }, [string, number]>("SELECT coalesce(sum(estimate_pp),0) AS n FROM requests WHERE account_key=? AND (state IN ('reserved','uncertain') OR ended_at>?)").get(key, checkedAt)!.n
    return active + debt
  }
  requestCount(id: string): number { return this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM requests WHERE execution_id=?").get(id)!.n }
  reserveRequest(id: string, execution: Execution, inputBound: number, outputBound: number, now: number) {
    this.db.query("INSERT INTO requests VALUES(?,?,?,?,'reserved',?,?,NULL,NULL,?,?)").run(id, execution.id, execution.candidate.account.key, execution.candidate.model, execution.candidate.estimatedRequestPp, now, inputBound, outputBound)
  }
  settleRequest(id: string, usage: Usage, now: number) {
    const changed = this.db.query("UPDATE requests SET state=?,ended_at=?,usage=? WHERE id=? AND state='reserved'").run(usage.status, now, JSON.stringify(usage), id).changes
    return changed > 0
  }
  reconcile(id: string, now: number, automatic = false) {
    return this.atomic(() => {
      const e = this.get(id)
      if (!e || !["uncertain", "failed", "cancelled"].includes(e.state)) throw new Error("Only a terminal/uncertain execution can be reconciled")
      this.db.query("UPDATE requests SET state='reconciled',ended_at=? WHERE execution_id=? AND state IN ('reserved','uncertain')").run(now, id)
      this.db.query("UPDATE executions SET state='reconciled',updated_at=? WHERE id=?").run(now, id)
      this.log(id, automatic ? "automatic-reconciliation" : "explicit-reconciliation", { confirmation: automatic ? "automatic-idle-timeout" : "provider-idle-confirmed", actualUsage: "not invented; existing measured/null values retained", note: "Estimated debt remains until a newer quota observation" }, now)
      return this.get(id)!
    })
  }
  cooldown(key: string, model: string): number {
    return this.db.query<{ until_at: number }, [string, string]>("SELECT until_at FROM failures WHERE account_key=? AND model=?").get(key, model)?.until_at ?? 0
  }
  failure(key: string, model: string, until: number, reason: string) {
    this.db.query("INSERT INTO failures VALUES(?,?,?,?) ON CONFLICT(account_key,model) DO UPDATE SET until_at=max(until_at,excluded.until_at),reason=excluded.reason").run(key, model, until, reason)
  }
  save(key: string, value: unknown) { this.db.query("INSERT INTO registry VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)) }
  load<T>(key: string): T | null { const r = this.db.query<{ value: string }, [string]>("SELECT value FROM registry WHERE key=?").get(key); return r ? JSON.parse(r.value) : null }
  log(id: string | null, kind: string, data: unknown, now: number) { this.db.query("INSERT INTO decisions(execution_id,at,kind,data) VALUES(?,?,?,?)").run(id, now, kind, JSON.stringify(data)) }
  recent(limit = 20) { return this.db.query("SELECT execution_id,at,kind,data FROM decisions ORDER BY id DESC LIMIT ?").all(limit).map((r: any) => ({ ...r, data: JSON.parse(r.data) })) }
  status() {
    return {
      executions: this.db.query("SELECT state,count(*) AS count FROM executions WHERE coalesce(json_extract(task,'$.test'),0)=0 GROUP BY state").all(),
      requests: this.db.query(`SELECT r.state,count(*) AS count FROM requests r JOIN executions e ON e.id=r.execution_id
        WHERE coalesce(json_extract(e.task,'$.test'),0)=0 GROUP BY r.state`).all(),
      testExecutions: this.db.query("SELECT state,count(*) AS count FROM executions WHERE coalesce(json_extract(task,'$.test'),0)=1 GROUP BY state").all(),
      testRequests: this.db.query(`SELECT r.state,count(*) AS count FROM requests r JOIN executions e ON e.id=r.execution_id
        WHERE coalesce(json_extract(e.task,'$.test'),0)=1 GROUP BY r.state`).all(),
      performance: this.db.query(`SELECT r.model,count(*) AS samples,
        sum(r.state='completed') AS completed,sum(r.state='failed') AS failed,sum(r.state='uncertain') AS uncertain,
        avg(json_extract(r.usage,'$.durationMs')) AS averageDurationMs,
        1000.0*sum(json_extract(r.usage,'$.outputTokens'))/nullif(sum(CASE WHEN json_extract(r.usage,'$.outputTokens') IS NOT NULL THEN json_extract(r.usage,'$.durationMs') END),0) AS measuredOutputTokensPerSecond
        FROM requests r JOIN executions e ON e.id=r.execution_id
        WHERE r.state<>'reserved' AND coalesce(json_extract(e.task,'$.test'),0)=0 GROUP BY r.model`).all(), recent: this.recent(10) }
  }
}
