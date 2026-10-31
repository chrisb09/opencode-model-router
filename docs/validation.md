# Validation and handoff

Validated locally on 2026-10-24 and updated on 2026-10-31 with OpenCode **2.2.1** and Bun **1.3.14**. The plugin/client dependencies are pinned to **2.2.5**; the V2 plugin API remained compatible.

## Final automated results

| Component | Validation | Result |
|---|---|---|
| Router | `bun test tests` | 205 passed, 0 failed |
| Router | `npm run typecheck` | Passed |
| Router | `npm audit --omit=dev` | 24 moderate transitive advisories; no high/critical; npm reports no fix |
| Antigravity adapter | `npm test` | 1,242 passed; 25 existing todo tests |
| Antigravity adapter | Typecheck and build | Passed |
| Existing quota service | `npm test` | 92 passed, 0 failed |
| Existing quota service | `npm run typecheck` | Passed, including web workspace |
| Observatory | Complete `bun test tests` suite | 55 passed, 0 failed |
| Observatory | All workspace typechecks | Passed |
| Observatory plugin | Workspace build | Passed |

`npm audit --omit=dev` reports 24 moderate transitive advisories in the OpenCode
plugin/client dependency tree (glob/minimatch and npm packaging tooling). There
are no high or critical advisories, and npm reports no fix available in the
current dependency graph. They are not router source findings.

Observatory tests used the existing **local `observatory_test` PostgreSQL
database** and isolated XDG config/data/state directories under `/tmp/opencode`.
They did not use production PostgreSQL, replace the live client configuration,
or clear the real telemetry queue. The two new attribution regressions are part
of that complete suite, covering concurrent pinned SDK sessions and Go's actual
Console integration. The installed V2 entrypoint loads the patched source;
the corresponding distribution output was rebuilt too.

The quota-service checkout contains concurrently edited widget code belonging
to the user. Those edits were preserved. Its full test count includes that code;
the router-specific changes there are limited to unknown-usage handling in the
Codex/Go parsers and their regressions.

## Verified live behavior

- Only **Plan** and **Build** are visible primaries; neither has a fixed model.
  The active primary remained `openai/gpt-6.1-sol#high` throughout validation.
- All seven role definitions are installed as subagents with distinct prompts
  and permissions. Plan cannot launch general; children cannot recurse.
- `ai-usage`, `model-router` and production `observatory` MCP servers connected.
- Gemini medium/high, DeepSeek max and Sol high completed subscription-only
  smoke tests. Concurrent different-model dispatch and native background
  completion worked. Background completion released its execution slot.
- The Go provider's integration is **`opencode`**, not `opencode-go`. A read-only
  comparison confirmed that the active Console OAuth workspace matches the
  production quota collector workspace. The corrected mapping passed a live
  Go call without changing provider credentials.
- Sol's zstd-compressed native request passed after bounded decoding was added.
  The earlier compression/identity failures remained recorded; tasks were not
  automatically replayed or erased to make the history appear clean.
- The independent DeepSeek critic completed a safety review. Regression-covered
  fixes include setup fail-closed behavior, future quota timestamps, alternate
  output limits, SDK model-object identity, actual native account identity,
  mixed-transport rejection and explicit uncertainty reconciliation.
- The 2026-10-24 inspection showed **no reserved, running or uncertain
  executions and no unsettled requests**. Historical failed executions remain in
  the ledger. Counts may continue changing as other live sessions use the
  installation. The 2026-10-31 follow-up found and cleared two stale running
  executions; after cleanup and the concurrency probes, `router status` reported
  no running executions. Probe tasks are counted separately and excluded from
  performance statistics.
- Observatory still targets `https://observatory.christian-f-brinkmann.de` with
  the original installation identity. Upload acknowledgments are advancing and
  the status tool reports no upload error. A transient pending queue is normal
  while sessions and historical recovery are active; it was not cleared.
- Native todos are enabled, populated in this session, and permitted for Plan.
- The global delegation preference was loaded into this running session after
  saving `~/.config/opencode/AGENTS.md`. Plan/Build coordinator guidance now calls
  for considering specialists for every nontrivial task, with explicit user
  opt-outs taking precedence. Three added hook tests verify both coordinators
  receive the guidance without replacing base instructions, changing primary
  models or unconditionally launching agents; children do not receive coordinator
  delegation encouragement. Typecheck and the current router suite passed.

## Native steps and concurrency validation (2026-10-31)

The router no longer applies tier-based 10/20/30 request caps. The seven visible
agents use native `steps: 30`; hidden `<role>-extended` variants use `steps: 60`.
`routing.steps` 1–60 selects the base or extended variant, and the native runner
retains its graceful final-step summary. `maxRequestsPerExecution: 100` is only a
runaway backstop. Live checks confirmed:

- `routing.steps: 45` created a child on `reviewer-extended` with native steps 60;
  the router recorded requested steps 45 and actual step budget 60.
- A default `explore` child stayed on the base variant with native steps 30.
- A forced DeepSeek child completed after the stale-slot cleanup, proving the
  OpenCode Go account was usable again.
- Two simultaneous Sol children completed under the new OpenAI cap of 4.

Two stale `general`/DeepSeek executions from 2026-10-24 were found still marked
`running` although their native children had been idle for 6.9 days. They held
both old `opencode-go` slots and caused immediate `Concurrent account capacity
reserved` denials. They were finished and reconciled through the operator path.
A new `router recover <executionID> --confirm-provider-idle` command verifies the
native child is idle before finishing/reconciling a running reservation; the
service now falls back to the newest registry for inactive project directories.

Temporary `testMode` disabled concurrency admission only; quota, cooldown,
identity, context and paid/Kimi gates remained active. Probe traffic was marked
`test` and excluded from ordinary performance statistics. Measurements:

| Provider | Clean levels | Notes |
|---|---|---|
| Antigravity | 1,2,3,4,6,8,10,12,16 per account | 16 concurrent completed on one account; 8 on two other accounts. An 8-child realistic read-only tool-loop pass completed with two requests per child. No 429s. |
| OpenCode Go / DeepSeek | 1,2,3,4,6,8,10,12,16 total | All completed; no 429s. |
| OpenAI Codex / Sol | 1,2,3,4,6 total | 6 concurrent completed. An 8-child attempt had 6 complete and 2 denied by the router's local `codex-weekly` quota-debt floor, not a provider 429. |

Installed caps: Antigravity 4 per account, OpenCode Go 4 total, OpenAI 4 total,
global 8. Concurrency-only denials wait up to `queueTimeoutMs: 20000` with
jitter, then fail; quota/identity/model/context denials do not wait. Test mode
was disabled afterward and the live service reports `concurrencyChecks: enabled`
and `accountPinning: disabled`. These are local burst limits, not
provider-published concurrency numbers; provider quotas and behavior can change.

The startup/5-minute maintenance loop was verified live: its first run found an
uncertain execution, confirmed the native child was idle, and automatically
reconciled it. The loop does not clear quota debt. Manual
`recover <executionID> --confirm-provider-idle` remains available for immediate
operator action before the idle threshold.

Antigravity's official documentation states that accessing it through
third-party software violates its Terms of Service. The provider remains an
optional/experimental route; this validation does not assert compliance with
that term.

## Rollback validation

### Local workflow v1 follow-up

The approved local workflow MVP adds separate additive `wf_*` tables, native
`workflow_annotate` / `workflow_read`, two additional read-only MCP tools, and
JSON/Mermaid CLI exports. A follow-up adds a static, self-contained HTML/SVG
lifeline timeline with lanes, wall-clock spans, request marks, model/status
styling, contribution badges, summary cards and a detail table. Local labels/notes
remain only in workflow task rows and are redacted from default reads/exports. No
Observatory workflow contract, remote export, hosted dashboard deployment or
prompt/response capture was added.

The router suite now has **205 passing tests**. New coverage includes annotation
ownership and acyclic session-scoped relations, null-vs-zero usage, redaction and
Mermaid/HTML injection, post-commit trace-failure isolation from quota gates,
additive SQLite reopen compatibility, deletion cascades, capacity markers,
out-of-order primary lifecycle reconstruction, timeline lane bounding and
null-vs-zero usage in lifelines. Independent review prompted the lifecycle
hardening and explicit foreign-key/deletion checks; trusted-local-API and best-effort
primary attribution limitations are documented instead of presented as stronger
security/measurement guarantees.

Live checks used the existing native tools to create/update the current session's
logical tasks, link a subscription-only background child, and inspect redacted
JSON/Mermaid. A separate subscription-only primary smoke session recorded a
completed Build/Gemini-medium primary span without changing the user's current
Build/Sol-high selection. Primary token counts/cost remain explicitly unavailable.
The current session's recorded spans were rendered to a private local timeline
(`~/.local/share/opencode-model-router/exports/`) and checked in headless Chromium:
the page loaded with no script/runtime errors, showed primary/reviewer/explore
lifelines and request/usage details, and had no remote resource dependencies.
Timeline rendering is client-side; only the earlier workflow service/MCP changes
needed a restart. A later external OpenCode server restart did not remove the
router ledger; the `ai-usage` MCP's Basic header was switched to its existing
private `collector-authorization` file after the restarted server no longer
inherited `AI_USAGE_BASIC`, and all three MCP servers reconnected successfully.

A private online SQLite backup and targeted configuration/manifest backups were
taken before installation. The existing installation manifest was extended only
for newly added workflow permissions, so targeted disabling can still remove
router-owned rules while retaining later user settings.

See [workflow.md](workflow.md) for exact commands, privacy controls, recording
limits, deletion semantics and what is intentionally not implemented.

### Router removal

Five unit tests cover targeted removal, unchanged restoration, preservation of
new plugins/settings, manually selected primary models, extra primary permissions
and edited subagents. A **read-only dry-run against the actual installed config**
confirmed that router plugin/MCP entries are removed, original plugins remain,
primary choices and native todos survive, and no merge warnings occur.

The live disable script was **not executed**: testing must not disable the user's
working router or discard historical state. The script retains credentials,
session history, the ledger and private backups. It warns instead of deleting
subsequently edited agent/MCP definitions. See the README for the command.

## Explicit limitations / unfinished capabilities

1. **Paid Opus/Kimi execution remains locked.** Trusted spending grants,
   per-physical-attempt monetary reservations and hard dollar-budget enforcement
   are not implemented. No paid test calls were made. Opus's configured model
   reference has **no reasoning variant**.
2. **Subscription units are estimates.** Reservations use conservative,
   context-scaled percentage points, not exact provider token capacity. Independent
   quota windows are checked separately, but external clients and primaries can
   still consume the same accounts outside this router's control.
3. **Ambiguous quota recovery remains conservative.** A startup/5-minute reaper
   can release an idle child's concurrency slot automatically, but uncertain quota
   debt remains until an authoritative observation. Reconciliation never invents
   measured token counts or silently repeats work. Manual `recover` remains for
   immediate operator action.
4. **No empirical quality optimizer.** Selection follows the agreed tier/role
   policy and eligibility constraints. Measured throughput/reliability is diagnostic;
   short smoke tests do not establish a meaningful performance ranking.
5. **Permissions are not an OS sandbox.** Read-only and approved diagnostic access
   use native OpenCode permissions. Routing protects managed local delegation,
   not arbitrary code, manual provider use, other machines or hostile plugins.
6. **Transport scope is deliberate.** Guarded native HTTP and Antigravity SDK
   requests are supported. Routed WebSocket and custom mixed native/SDK subscription
   transports are denied, not silently allowed around accounting.
7. **Remote collector parser deployment is separate.** Local parser fixes have
   not been deployed to the production quota service. The router independently
   rejects missing raw counters rather than trusting normalized 100% displays.
8. **Reload while idle where possible.** Successful captured native tool snapshots
   survive plugin reload as required by V2; initialization failures retain a deny
   gate. Native background events are durable. The idle reaper covers stale local
   executions, but it is not a distributed lease service and cannot coordinate
   other machines. `recover` verifies the native child idle before immediate
   finishing/reconciling.

## Source and version-control handoff

The new project is `/home/christian/git/opencode-model-router`, initialized on
`main` and pushed to the **private** repository
<https://github.com/chrisb09/opencode-model-router>. Its policy, implementation,
tests and docs are versioned; the local runtime database, credentials, backups
and timestamped HTML/PNG exports are not.

Related repository state at handoff:

- `/home/christian/git/opencode-model-router`: feature commit `47d3571`
  (native step budgets, measured concurrency caps, recovery command and probe),
  followed by documentation commits on `main`. The repository is private; the
  local SQLite ledger and credentials are not versioned.
- `/home/christian/git/opencode-observatory`: committed/pushed on `main` as
  `3a67905` (V2 transport/wrapper attribution, regression test and rebuilt
  tracked plugin distribution).
- `/home/christian/git/opencode-antigravity-auth`: committed/pushed on `main` as
  `320ddae` (request-local pins, cursor preservation, tests, V2 comments and
  rebuilt tracked output).
- `/home/christian/git/ai_usage`: clean and up to date on `main` at `8b4c573`;
  the unknown-usage parser work is already part of that state.
- `~/.config/opencode/opencode.jsonc`: local additive agents/plugin/MCP/todo
  settings; not a repository and not pushed.
- `~/.config/opencode/AGENTS.md`: the user's local global delegation preference;
  not a repository and retained independently of router disabling.

The router repository contains the **viewer generator**, not the recorded
workflow data. Pulling it on another machine neither transfers the local SQLite
ledger nor adds workflow storage/visualization to the Observatory. The local HTML
timeline remains the current visualization; Observatory export/dashboard work is
still stage 2/3 in the proposal. Private configuration, tokens, workspace
bindings and SQLite state must not be committed.

The original private installation backup is referenced by
`~/.local/share/opencode-model-router/installation-backup`. Prefer the targeted
disable helper over copying a stale whole-file backup onto newer user changes.
