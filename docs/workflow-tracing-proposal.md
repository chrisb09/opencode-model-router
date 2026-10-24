# Proposed workflow tracing

Status: **local v1 implemented** on 2026-10-24 after approval. See
[workflow.md](workflow.md) for actual use, scope and limits. The sections below
retain the original design goals, including later Observatory/UI work.

## Goal

Explain which logical tasks were performed, their dependencies, which agents and
models handled them, and what their outputs contributed. Support later session
graphs, timelines and aggregate statistics without recording conversation content
or mistaking resource consumption for usefulness.

## Existing foundation

- Router `src/ledger.ts`: durable execution/request/decision records, parent and
  child session links, selected model/account, tier, role, timestamps and usage.
- Router `plugin/index.ts`: wraps native dispatch and observes foreground and
  background termination. It currently does **not** persist the tool description,
  logical task hierarchy, dependency links or assessments of usefulness.
- Observatory contracts: session/message/call relationships, agent/model/account,
  timings, usage, cost estimates and transport status. Existing `purpose` values
  distinguish chat/compaction/auxiliary, not logical engineering task categories.
- Observatory ingestion already handles durable, tenant-scoped event snapshots.
  Its current dashboard has aggregate charts and flat activity tables, not a
  workflow DAG or Gantt view.

Keep quota collection and provider credentials unchanged. Reuse Observatory's
delivery and analytics infrastructure rather than adding another hosted service.

## Model: logical work is not a model request

Use separate stable identities for:

1. Session: container, including direct Plan/Build work.
2. Workflow/task: logical user goal, with optional parent task and dependency IDs.
3. Execution/span: one attempt to perform work, assigned to a primary or child.
4. Provider request / tool invocation: existing low-level telemetry.

A child continuation or escalation creates another execution, not another claim
that the logical task contributed. Task nesting must work even though subagent
recursion remains prohibited. Dependencies and review relationships can cross
sibling tasks; the session tree alone cannot describe them.

Capture structured categories such as exploration, research, planning,
implementation, debugging, testing, review, criticism and integration separately
from transport `purpose`. Link native todos where an explicit mapping exists;
do not pretend a title/index heuristic proves task identity after a rename.

## Automatic facts versus assessed contribution

Record automatically where authoritative hooks provide evidence:

- Parent workflow/task, session, execution and tool-call IDs.
- Role, actual provider/model/variant and routing tier/reason.
- Planned/start/end/observation timestamps and lifecycle outcome.
- Requests, tool calls, observed tokens and estimated quota/cost, with units and
  measurement provenance. Unknown values remain null.
- Foreground/background, continuation/escalation, denial, retry and cancellation.

Record separate coordinator/user annotations for usefulness:

- `unassessed` by default, then `incorporated`, `partially_incorporated`,
  `validation_only`, `rejected`, or `superseded` when explicitly assessed.
- Annotation author/source, timestamp and references to supporting task/message/
  tool/report IDs. A bounded optional note is content and needs a privacy policy.
- A review can contribute by validating an approach or preventing a bad change;
  it need not produce code. A completed execution is not automatically useful.

Do **not** invent an objective percentage of contribution, saved time, quality
score or agent ranking from tokens, elapsed time, changed lines or self-ratings.
Allow later human ratings, clearly distinguished from automatic measurements.
No extra judge-model calls merely to grade every task by default.

## Collection and delivery

- Add structured lifecycle capture to the router's existing dispatch boundaries.
- Add a small coordinator annotation interface for task/dependency/outcome links;
  do not require the model to narrate every action. A future annotation tool must
  validate current-session ownership and obey Plan/Build and child permissions.
- Include direct primary work so a graph never implies agents did all the work.
- Store versioned events durably, with event IDs and idempotent updates. Treat
  late events, reloads, missed completion and uncertain termination explicitly.
- Add an explicit Observatory contract for workflow data and a durable bridge
  through its existing outbox. Do not silently send unsupported kinds or arbitrary
  metadata to the current server. Deploy contract compatibility before exporting.
- Keep telemetry delivery failure separate from quota enforcement: report trace
  gaps, never weaken a quota gate or repeat possibly completed implementation.

## Privacy and scope

- Start metadata-only: no prompts, responses, tool arguments, file contents,
  reasoning traces, raw credentials or full local paths in exported workflow data.
- Human-readable task labels and contribution notes may contain sensitive project
  details even when short. Make their storage/export an explicit choice; generic
  role/category labels work without them. Avoid arbitrary free-form metadata bags.
- Read APIs/exports must omit private router registry snapshots, authorization
  fingerprints and credential material. Scope server queries by user/installation.
- Provide retention/disable/export controls. Do not expand existing production
  telemetry content collection implicitly as part of this feature.
- Historical structure can be partially reconstructed from recorded IDs/times,
  but old semantic purpose/contribution must remain unknown, not fabricated.

## First statistics and views

- Workflow graph: tasks and dependencies; distinct edges for delegation, review,
  result incorporation and supersession. Color by model or role.
- Swimlane timeline: primary and children, parallel overlap, waiting/running spans,
  retries and failures. Show incomplete spans explicitly.
- Breakdown: requests/tokens/estimated cost by task, role and model; missing-value
  coverage shown. Do not double-count SDK steps and transport attempts.
- Outcome statistics: incorporation/validation rates with assessed/unassessed
  counts and source provenance. Do not call these causal model-quality scores.
- Distinguish workflow wall time from summed worker time. Overlap is measurable;
  time saved against an unobserved solo baseline is not.
- JSON export first; a derived Mermaid graph is a lightweight structural view.
  A static HTML/SVG lifeline timeline is the initial duration/overlap visual.
  Observatory DAG/timeline views can follow the same versioned data contract.

## Suggested delivery order

1. Agree metadata/label privacy, then implement local lifecycle recording,
   structured task/outcome annotations, read-only workflow inspection and JSON /
   Mermaid exports. Cover concurrency, continuation, cancellation, ownership,
   null metrics and idempotency in tests.
2. Add compatible Observatory contracts, durable export and tenant-safe workflow
   queries, keeping aggregate usage accounting unchanged.
3. Add graph/timeline views and cross-session statistics once the traces have
   sufficient coverage. Never hide unassessed outcomes or incomplete spans.

Delivery stage 1 is installed: local recording, native annotation/read tools,
read-only MCP inspection, JSON/Mermaid exports and a static HTML/SVG lifeline
timeline. Stages 2 and 3 (Observatory workflow export and hosted dashboard views)
remain unimplemented. Labels/notes stay local and default exports redact them;
no remote content-export approval was given.
