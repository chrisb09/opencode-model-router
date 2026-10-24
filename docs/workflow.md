# Local workflow tracing (v1)

The router now records a local workflow alongside its quota ledger. It does not
export workflow data to Observatory or add a hosted dashboard. JSON, Mermaid and
a self-contained HTML lifeline timeline are available for local inspection.

## What is recorded

- Logical tasks: stable ID, optional parent/dependencies, structured purpose,
  state, explicit contribution assessment and evidence IDs.
- Delegation spans: actual selected model/variant, role, tier, routing reasons,
  pseudonymous account reference, native child session, foreground/background,
  timing and lifecycle outcome. Request usage is read from the existing ledger;
  private credential/account snapshots are not included in workflow exports.
- Separate executions for continuations, linked to the previous execution and
  logical task where known. A continuation of a still-running child keeps its
  existing execution. Explicit task links are preferable to inferred semantics.
- Primary Plan/Build execution spans from native lifecycle events. Primary models
  have provenance (`request_hook`, `session_snapshot`, or `unknown`) and observed
  model history. Primary usage is **not collected by this v1 workflow recorder**.
- Denied dispatches remain visible without inventing a selected model. Unknown
  or incomplete native lifecycle information remains a gap, not fabricated success.

This is metadata, not a conversation transcript. Prompts, responses, reasoning,
tool arguments/outputs, file contents and raw credentials are not recorded by the
workflow collector. Existing Observatory telemetry is unchanged.

Automatic tasks are created when a delegation has no explicit logical task ID.
An automatic task follows its latest known execution state; explicit logical
tasks can have several spans and their state remains coordinator-controlled.
The automatic `primary` task is a coordinator activity container, not an inferred
user requirement or proof that all work in the session was integrated.

## Use inside OpenCode

Ask:

> Show this session's workflow and model breakdown.

> Draw the workflow as Mermaid.

The coordinator uses `workflow_read` (`format: "json"` or `"mermaid"`). These reads
always redact task labels and contribution notes, even though they are local.
The read-only MCP also offers `model-router.get_workflow` with a session ID and
`model-router.list_workflows`. Mermaid is a dependency/structure view; for a
duration/overlap view, use the local HTML timeline below. There is no new slash
command or hosted dashboard.

For meaningful tasks, the coordinator can use `workflow_annotate`:

```json
{"purpose":"implementation","state":"running","label":"Implement the scoped change"}
```

The result returns a stable `taskID`. Link a delegation with:

```json
{"agent":"general","description":"Implement scoped change","prompt":"...","routing":{"taskID":"<returned-taskID>","purpose":"implementation","tier":"DEFAULT"}}
```

Then explicitly update the task, for example:

```json
{"taskID":"<returned-taskID>","state":"completed","contribution":"incorporated","evidenceIDs":["<child-session-ID>"]}
```

`parentTaskID` and `dependsOn` reference existing tasks in the same session.
Combined parent/dependency cycles, dangling/cross-session targets and duplicate
dependencies are rejected. Omit `taskID` when creating a task; do not invent IDs
or infer identity from a todo's position after renaming/reordering.

Only primary Plan/Build coordinators may use the native annotation tool; a child
cannot claim to be Build to escape this check. Read-only children may inspect
their parent workflow, but cannot annotate it. These are local tool boundaries:
the router's private token/API is trusted same-user authority, not a multi-tenant
security boundary against other processes or plugins holding that token.

## Contribution is an assessment, not a measurement

Values: `unassessed` (default), `incorporated`, `partially_incorporated`,
`validation_only`, `rejected`, `superseded`. Explicit annotations are labeled
`assessmentSource: "coordinator"`; automatic completion never implies usefulness.

Use them when you know how a result was used. Reviews may contribute validation
without changing code. Do not generate a percentage of "objective contribution",
silently classify missing assessments as rejection, or call a judge model just
to grade every action. Resource consumption is not value.

## Local CLI exports

```sh
bun /home/christian/git/opencode-model-router/src/cli.ts workflow list
bun /home/christian/git/opencode-model-router/src/cli.ts workflow <sessionID>
bun /home/christian/git/opencode-model-router/src/cli.ts workflow <sessionID> --mermaid
```

JSON includes a schema version, task/span/event graph, nullable observed usage,
request coverage, model/role counts, model token breakdown and assessment counts.
Requests are deduplicated by ID. Costs are explicitly unavailable; primary tokens
are not inferred from child usage. Timings are in spans. Summed nested span times
are not claimed as actual worker time, and no unobserved solo speedup is invented.
Mermaid uses generated node IDs and escaped labels/metadata rather than inserting
untrusted Mermaid syntax. It shows task containment, dependencies, model spans
and the task's assessment; the JSON carries fuller timing and provenance.

Labels and notes stay in local SQLite and are omitted by default. Only an explicit
local export opts them in:

```sh
bun /home/christian/git/opencode-model-router/src/cli.ts workflow <sessionID> --include-local-text
```

That flag can be combined with `--mermaid` or `--timeline`. Such an export contains
private text: do not attach it to a public issue or send it elsewhere without
reviewing it. No prompt/response capture or automatic Observatory export is enabled
by the flag. The authenticated loopback API also accepts the explicit flag;
CLI-only access is a convention, not a second OS security boundary against token
holders.

### Lifeline timeline (HTML/SVG)

Generate a self-contained local HTML file:

```sh
bun /home/christian/git/opencode-model-router/src/cli.ts workflow <sessionID> \
  --timeline --out ~/.local/share/opencode-model-router/exports/timeline.html
```

Open that file in a browser. `--out` is optional; without it the HTML is written
to stdout. `--include-local-text` adds local task labels to that local file. Notes
are never rendered. Default output contains redacted task IDs/purposes only.

The timeline has one lane per primary/child session, horizontal wall-clock spans
(left-to-right), lighter request marks inside delegated spans, status styling,
model colors, task/contribution labels, a summary card row and a span detail table.
Dashed connectors mark a delegation that **started while a primary span was active**;
they are time containment, not proof of causality or contribution. The file is
static: no JavaScript, remote fonts, images, analytics or network requests. It is
bounded to 40 child lanes, and an omission note is displayed when older spans are
not drawn. Duration is elapsed observed time, not effort or value.

The HTML viewer is generated on demand from the recorded snapshot. It is not a
live/auto-refreshing dashboard and does not add a cross-session visualization UI
or remote Observatory endpoint.

## Storage, disabling and deletion

Separate additive `wf_*` tables live in
`~/.local/share/opencode-model-router/router.db`. The quota tables/schema retain
their existing meaning. Private pre-upgrade configuration and online SQLite
backups were taken before installation; disabling does not erase history.

Optional private settings in `~/.config/opencode-model-router/config.json`:

```json
{"workflow":{"enabled":true,"captureLabels":true}}
```

- `enabled: false` stops new workflow capture/annotations, **not quota routing**.
  Existing workflow data remains readable/exportable/deletable.
- `captureLabels: false` discards new labels and notes at storage time. It does
  not retroactively erase previous local text.
- Restart the router service after changing these settings; `/reload` OpenCode
  to refresh captured plugin settings. Do so while delegated children are idle.

Explicit deletion:

```sh
bun /home/christian/git/opencode-model-router/src/cli.ts workflow forget <sessionID> --confirm
```

This deletes that session's workflow tables/relations, not sessions, provider
credentials, quota reservations, the router's original execution ledger or
Observatory data. Future observed work in the session can create a new trace;
disable recording first if that is unwanted. This is logical deletion, not
forensic secure erasure of SQLite pages/WALs or any independently retained backups.

There is no automatic retention deletion in v1. Recording is bounded to 1,000
sessions, 500 tasks/session, 2,000 spans/session and 5,000 events/session (including
a separate bounded native primary event log). Capacity gaps are marked truncated
where possible and counted as capture failures. Inspect/prune local traces when
needed. Exports are bounded by these recording limits, not unbounded history scans.

## Reliability and limits

- Workflow writes happen after authoritative reservation/state changes, outside
  their transactions. Trace failures are counted and cannot roll back quota
  reservations, release uncertainty or allow paid dispatch.
- Primary model capture is best-effort/non-blocking; primary lifecycle capture
  uses native durable sequence order, not network arrival order. Late starts can
  repair unmatched terminals. Missing lifecycle events remain unknown/unmatched.
- `captureFailures` in router status is since that service start; native reads
  also expose plugin-local capture failures. Failed observations are not retried
  indefinitely or hidden by deleting the workflow.
- Native primary execution is serialized per session; correlation relies on that
  invariant. Primary model snapshots/hook observations are not a billable request
  ledger and do not claim exact per-model primary resource attribution.
- Tracing starts when enabled. Historical purpose, dependencies, labels and
  contribution are not backfilled or guessed. Enabling halfway through a primary
  run may miss its start; the next full run provides a normal span.
- No automatic mapping from every native todo, no detailed per-tool span viewer,
  no live/cross-session visualization dashboard, no automatic task-quality scoring,
  and no remote workflow export are included yet. The local HTML timeline is a
  snapshot export, not a monitoring service. The existing Observatory remains
  responsible for its own detailed request/tool telemetry.

The first end-to-end checks covered native coordinator annotations, redacted in-chat/MCP
reads, explicit task-linked background delegation, primary lifecycle/model capture
in a separate subscription-only smoke session, JSON/Mermaid CLI output, and a
generated local lifeline timeline from this session's recorded spans.
