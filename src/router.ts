import { randomUUID } from "node:crypto"
import type { Account, CatalogModel, Policy, Task, Usage } from "./types.ts"
import { recommend } from "./policy.ts"
import { Ledger } from "./ledger.ts"

export class Router {
  constructor(readonly policy: Policy, readonly ledger: Ledger, readonly clock = Date.now, readonly testMode = false) {}
  recommend(task: Task, models: CatalogModel[], accounts: Account[]) {
    return recommend(this.policy, task, models, accounts, this.clock(),
      (k, w, at) => this.ledger.pressure(k, w, at),
      this.testMode ? () => 0 : k => this.ledger.concurrency(k),
      (k, m) => this.ledger.cooldown(k, m),
      this.testMode ? () => 0 : () => this.ledger.totalConcurrency())
  }
  reserve(id: string, task: Task, models: CatalogModel[], accounts: Account[]) {
    return this.ledger.atomic(() => {
      if (this.ledger.get(id)) throw new Error("Dispatch ID already exists; do not repeat a possibly executed task")
      const result = this.recommend(task, models, accounts)
      const selected = result.candidates.find(c => !c.rejected.length)
      if (!selected) {
        this.ledger.log(id, "denied", { role: task.role, tier: task.tier, errors: result.errors, candidates: result.candidates.map(c => ({ model: c.model, account: c.account.key, reasons: c.rejected })) }, this.clock())
        throw new Error("No eligible model: " + [...result.errors, ...new Set(result.candidates.flatMap(c => c.rejected))].join("; "))
      }
      return this.ledger.create(id, task, selected, this.clock())
    })
  }
  preflight(executionID: string, model: CatalogModel, accounts: Account[], inputBound: number, outputBound: number) {
    return this.ledger.atomic(() => {
      const execution = this.ledger.get(executionID)
      if (!execution || execution.state !== "running") throw new Error("No active routed execution")
      if (model.providerID !== execution.candidate.ref.providerID || model.id !== execution.candidate.ref.id) throw new Error("Routed child model changed; create a new child for escalation")
      if (!Number.isSafeInteger(inputBound) || inputBound < 0 || !Number.isSafeInteger(outputBound) || outputBound < 1 || outputBound > execution.candidate.outputTokens || outputBound > model.limit.output || inputBound > Math.min(model.limit.input ?? Infinity, model.limit.context - outputBound)) throw new Error("Request exceeds context/output bounds; split the task instead of truncating")
      if (this.ledger.requestCount(executionID) >= this.policy.maxRequestsPerExecution) throw new Error(`Routed execution request backstop reached (${this.policy.maxRequestsPerExecution} requests); start a new child with a handoff`)
      const account = accounts.find(a => a.key === execution.candidate.account.key && a.credentialID === execution.candidate.account.credentialID)
      if (!account) throw new Error("Reserved credential is no longer available")
      // Existing task owns its concurrency slot. Exclude its unconsumed initial
      // hold so the first physical request replaces, rather than doubles, it.
      const first = this.ledger.requestCount(executionID) === 0
      const check = recommend(this.policy, { ...execution.task, requestedModel: execution.candidate.model, inputTokens: Math.max(0, inputBound - 8192), outputTokens: outputBound }, [model], [account], this.clock(),
        (k, w, at) => Math.max(0, this.ledger.pressure(k, w, at) - (first ? execution.candidate.estimatedRequestPp : 0)),
        this.testMode ? () => 0 : k => Math.max(0, this.ledger.concurrency(k) - 1),
        (k, m) => this.ledger.cooldown(k, m),
        this.testMode ? () => 0 : () => Math.max(0, this.ledger.totalConcurrency() - 1))
      const admissible = check.candidates.find(c => !c.rejected.length)
      if (!admissible) throw new Error("Reserved account no longer eligible: " + check.candidates.flatMap(c => c.rejected).join("; "))
      const id = randomUUID()
      this.ledger.reserveRequest(id, { ...execution, candidate: { ...execution.candidate, estimatedRequestPp: admissible.estimatedRequestPp } }, inputBound, outputBound, this.clock())
      return { requestID: id, accountKey: account.key, credentialID: account.credentialID, model: execution.candidate.ref }
    })
  }
  record(requestID: string, usage: Usage) { return this.ledger.atomic(() => this.ledger.settleRequest(requestID, usage, this.clock())) }
  failure(executionID: string, status: number, retryAfterMs = 0) {
    const e = this.ledger.get(executionID)
    if (!e) return
    const reason = status === 429 ? "rate-limit" : status === 401 || status === 403 ? "authentication" : "provider-failure"
    const delay = status === 429 ? Math.max(60_000, Math.min(retryAfterMs, 3_600_000)) : reason === "authentication" ? 3_600_000 : 30_000
    this.ledger.failure(e.candidate.account.key, `${e.candidate.ref.providerID}/${e.candidate.ref.id}`, this.clock() + delay, reason)
    this.ledger.log(executionID, "provider-failure", { status, reason, retryAfterMs: delay }, this.clock())
  }
}
