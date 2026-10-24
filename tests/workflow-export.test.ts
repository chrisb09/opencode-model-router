import { describe, expect, test } from "bun:test"
import { workflowMermaid, workflowSummary } from "../src/workflow-export.ts"
import { workflowTimelineHTML, workflowTimelineSVG } from "../src/workflow-timeline.ts"
import type { WorkflowRequest, WorkflowSnapshot, WorkflowSpan, WorkflowTask } from "../src/workflow-types.ts"

const task = (id: string, patch: Partial<WorkflowTask> = {}): WorkflowTask => ({
  id, parentTaskID: null, dependsOn: [], purpose: "implementation", state: "completed", contribution: "unassessed",
  assessmentSource: null, evidenceIDs: [], createdAt: 1, updatedAt: 2, ...patch,
})
const request = (id: string, patch: Partial<WorkflowRequest> = {}): WorkflowRequest => ({
  id, state: "completed", startedAt: 1, endedAt: 2, inputTokens: 10, outputTokens: 5,
  reasoningTokens: null, cacheReadTokens: null, estimatedQuotaPp: 0, ...patch,
})
const span = (id: string, taskID: string, patch: Partial<WorkflowSpan> = {}): WorkflowSpan => ({
  id, taskID, kind: "delegation", executionID: null, childSessionID: null, agent: "explore", model: "openai/gpt-5",
  tier: "DEFAULT", purpose: "exploration", state: "completed", startedAt: 0, endedAt: 10, background: false,
  continuationOf: null, requests: [], ...patch,
})
const snapshot = (patch: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot => ({
  schemaVersion: 1, sessionID: "ses_test", generatedAt: 123, localOnly: true, includesLocalText: false,
  tasks: [], spans: [], events: [], truncated: false,
  coverage: { primaryUsage: "not_collected", contribution: "explicit_coordinator_assessment", cost: "unavailable", history: "since_tracing_enabled" },
  ...patch,
})

describe("workflowSummary", () => {
  test("handles an empty graph without inventing usage", () => {
    const summary = workflowSummary(snapshot())
    expect(summary.counts).toEqual({ tasks: 0, spans: 0, events: 0, requests: 0, rootTasks: 0 })
    expect(summary.tasks.byContribution).toEqual({ unassessed: 0, incorporated: 0, partially_incorporated: 0, validation_only: 0, rejected: 0, superseded: 0 })
    expect(summary.usage).toEqual({ requests: 0, inputTokens: null, outputTokens: null, inputObservedRequests: 0, outputObservedRequests: 0, primaryUsage: "not_collected", cost: "unavailable" })
    expect(summary.spans.byKind).toEqual({ primary: 0, delegation: 0, denial: 0 })
    expect(summary.coverage.cost).toBe("unavailable")
    expect(workflowSummary(snapshot())).toEqual(summary)
  })

  test("counts task outcomes including unassessed and groups spans by role and model", () => {
    const summary = workflowSummary(snapshot({
      tasks: [
        task("root", { purpose: "planning", state: "completed", contribution: "unassessed" }),
        task("impl", { parentTaskID: "root", dependsOn: ["root"], state: "running", contribution: "incorporated" }),
        task("check", { parentTaskID: "root", purpose: "review", state: "failed", contribution: "unassessed" }),
      ],
      spans: [
        span("s1", "root", { kind: "primary", agent: "build", model: "openai/gpt-5", state: "completed" }),
        span("s2", "impl", { agent: "explore", model: null, state: "running" }),
        span("s3", "check", { agent: "reviewer", model: "anthropic/claude", state: "failed" }),
      ],
      events: [{ id: "e1", at: 1, kind: "created", taskID: "root", spanID: null }],
    }))
    expect(summary.counts).toMatchObject({ tasks: 3, spans: 3, events: 1, rootTasks: 1 })
    expect(summary.tasks.byState).toEqual({ completed: 1, failed: 1, running: 1 })
    expect(summary.tasks.byPurpose).toMatchObject({ planning: 1, implementation: 1, review: 1, unknown: 0 })
    expect(summary.tasks.byContribution).toMatchObject({ unassessed: 2, incorporated: 1, rejected: 0 })
    expect(summary.spans.byKind).toEqual({ primary: 1, delegation: 2, denial: 0 })
    expect(summary.spans.byAgent).toEqual({ build: 1, explore: 1, reviewer: 1 })
    expect(summary.spans.byModel).toEqual({ "anthropic/claude": 1, "openai/gpt-5": 1, unknown: 1 })
    expect(summary.spans.byState).toEqual({ completed: 1, failed: 1, running: 1 })
  })

  test("distinguishes null usage from a measured zero and reports coverage", () => {
    const spanWith = (requests: WorkflowRequest[]) => snapshot({ tasks: [task("t")], spans: [span("s", "t", { requests })] })
    const nullSummary = workflowSummary(spanWith([request("r1", { inputTokens: null, outputTokens: null })]))
    expect(nullSummary.usage).toMatchObject({ requests: 1, inputTokens: null, outputTokens: null, inputObservedRequests: 0, outputObservedRequests: 0 })
    const zeroSummary = workflowSummary(spanWith([request("r1", { inputTokens: 0, outputTokens: 0 })]))
    expect(zeroSummary.usage).toMatchObject({ requests: 1, inputTokens: 0, outputTokens: 0, inputObservedRequests: 1, outputObservedRequests: 1 })
    const partial = workflowSummary(spanWith([
      request("r1", { inputTokens: 100, outputTokens: 10 }),
      request("r2", { inputTokens: null, outputTokens: 0 }),
    ]))
    expect(partial.usage).toMatchObject({ requests: 2, inputTokens: 100, outputTokens: 10, inputObservedRequests: 1, outputObservedRequests: 2 })
    expect(partial.usageByModel["openai/gpt-5"]).toMatchObject({ requests: 2, inputTokens: 100, outputTokens: 10, inputObservedRequests: 1, outputObservedRequests: 2 })
  })

  test("does not invent primary usage or double count repeated request IDs", () => {
    const shared = request("shared", { inputTokens: 100, outputTokens: 40 })
    const summary = workflowSummary(snapshot({
      tasks: [task("t")],
      spans: [
        span("primary", "t", { kind: "primary", requests: [] }),
        span("delegation", "t", { requests: [shared, request("null", { inputTokens: null, outputTokens: null })] }),
        span("continued", "t", { requests: [shared, request("", { inputTokens: 1, outputTokens: 2 }), request("", { inputTokens: 3, outputTokens: 4 })] }),
      ],
    }))
    expect(summary.counts.requests).toBe(4)
    expect(summary.usage).toMatchObject({ requests: 4, inputTokens: 104, outputTokens: 46, inputObservedRequests: 3, outputObservedRequests: 3 })
    const serialized = JSON.stringify(summary).toLowerCase()
    for (const claim of ["speedup", "saved", "worker_time", "worker-time", "percent", "efficiency", "duration"]) expect(serialized).not.toContain(claim)
  })
})

describe("workflowMermaid", () => {
  test("renders an empty graph deterministically", () => {
    const chart = workflowMermaid(snapshot())
    expect(chart.startsWith("flowchart LR\n")).toBe(true)
    expect(chart).not.toContain("subgraph")
    expect(chart).not.toContain("task_")
    expect(workflowMermaid(snapshot())).toBe(chart)
  })

  test("renders tasks, parent/dependency edges and attached execution spans", () => {
    const chart = workflowMermaid(snapshot({
      tasks: [
        task("root", { purpose: "planning", state: "completed" }),
        task("child", { parentTaskID: "root", dependsOn: ["root"], state: "running" }),
      ],
      spans: [
        span("s1", "child", { kind: "primary", agent: "build", model: null, state: "running" }),
        span("s2", "child", { kind: "delegation", agent: "explore", model: "openai/gpt-5", state: "completed" }),
      ],
    }))
    expect(chart).toContain('subgraph task_group_1["planning · completed · task_1"]')
    expect(chart).toContain('subgraph task_group_2["implementation · running · task_2"]')
    expect(chart).toContain('span_1["primary · build · model unknown · running"]')
    expect(chart).toContain('span_2["delegation · explore · openai/gpt-5 · completed"]')
    expect(chart).toContain("    task_2 -.- span_1")
    expect(chart).toContain("    task_2 -.- span_2")
    expect(chart).toContain("  task_1 -->|parent| task_2")
    expect(chart).toContain("  task_2 -.->|depends| task_1")
    expect(workflowMermaid(snapshot({
      tasks: [task("root", { purpose: "planning", state: "completed" }), task("child", { parentTaskID: "root", dependsOn: ["root"], state: "running" })],
      spans: [span("s1", "child", { kind: "primary", agent: "build", model: null, state: "running" }), span("s2", "child", { kind: "delegation", agent: "explore", model: "openai/gpt-5", state: "completed" })],
    }))).toBe(chart)
  })

  test("keeps unattached spans visible instead of losing them", () => {
    const chart = workflowMermaid(snapshot({
      tasks: [task("t")],
      spans: [span("known", "t"), span("orphan", "missing")],
    }))
    expect(chart).toContain('subgraph orphaned_spans["unattached spans"]')
    expect(chart).toContain('span_2["delegation · explore · openai/gpt-5 · completed"]')
    expect(chart).toContain("  class task_1 task")
  })

  test("never returns local labels when includesLocalText is false", () => {
    const chart = workflowMermaid(snapshot({
      includesLocalText: false,
      tasks: [task("external-id-SECRET", { label: "SECRET-LABEL", purpose: "review", state: "completed" })],
      spans: [span("s", "external-id-SECRET")],
    }))
    expect(chart).not.toContain("SECRET-LABEL")
    expect(chart).not.toContain("external-id-SECRET")
    expect(chart).toContain('subgraph task_group_1["review · completed · task_1"]')
    expect(chart).toContain('span_1["delegation · explore · openai/gpt-5 · completed"]')
  })

  test("uses an explicitly included local label and caps its length", () => {
    const chart = workflowMermaid(snapshot({
      includesLocalText: true,
      tasks: [task("t", { label: "Customer login" })],
    }))
    expect(chart).toContain("Customer login · implementation · completed")
    const long = workflowMermaid(snapshot({ includesLocalText: true, tasks: [task("t", { label: "A".repeat(500) })] }))
    expect(long).not.toContain("A".repeat(95))
    expect(long.split("\n").every(line => line.length < 500)).toBe(true)
  })

  test("escapes labels, IDs and span metadata so they cannot inject Mermaid syntax", () => {
    const evilID = 'evil-task-id"]\n%%{init: {"theme":"dark"}}%%\nclick task_1 "javascript:alert(1)"'
    const evilSpanID = 'evil-span"]\n%%{init: {"securityLevel":"loose"}}%%'
    const payload = '"breakout"] --> evil[<script>alert(1)</script>]\n%%{init: {"theme":"dark"}}%%\nclick task_1 "javascript:alert(1)"\n`tick` & #34;'
    const snap = snapshot({
      includesLocalText: true,
      tasks: [task(evilID, { label: payload })],
      spans: [span(evilSpanID, evilID, { agent: 'agent"]\nclick span_1 "x', model: "model`\n%%{init}%%", state: 'running"] --> X[<b>x</b>' })],
    })
    const allowed = /^(flowchart LR| {2}classDef (?:task|span) [^\n]+| {2}subgraph task_group_\d+\["[^"\n]*"\]| {4}direction TB| {4}task_\d+\["[^"\n]*"\]| {4}span_\d+\["[^"\n]*"\]| {4}class span_\d+ span| {4}task_\d+ -\.- span_\d+| {2}end| {2}class task_\d+ task| {2}task_\d+ -->\|parent\| task_\d+| {2}task_\d+ -\.->\|depends\| task_\d+)$/
    const chart = workflowMermaid(snap)
    for (const raw of ["%%{", "<script", "<b>", '"breakout"]', evilID, evilSpanID, "click task_1", "click span_1"]) expect(chart).not.toContain(raw)
    expect(chart).not.toMatch(/^\s*click\b/m)
    expect(chart).toContain("#37;#37;#123;init")
    for (const line of chart.split("\n")) expect(line).toMatch(allowed)
    const redacted = workflowMermaid({ ...snap, includesLocalText: false })
    expect(redacted).not.toContain("breakout")
    expect(redacted).not.toContain("%%{")
    for (const line of redacted.split("\n")) expect(line).toMatch(allowed)
    expect(workflowMermaid(snap)).toBe(chart)
  })
})

describe("workflowTimelineHTML", () => {
  const timeline = (patch: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot => snapshot({
    generatedAt: 1_010_000,
    tasks: [task("root", { purpose: "integration", contribution: "incorporated", label: "LOCAL_ROOT" }), task("child", { parentTaskID: "root", purpose: "review", contribution: "validation_only", label: "LOCAL_CHILD", note: "LOCAL_NOTE_SECRET" })],
    spans: [
      span("p1", "root", { kind: "primary", agent: "build", model: "opencode-go/deepseek-v4.1-flash#max", purpose: "integration", startedAt: 1_000_000, endedAt: 1_008_000, requests: [] }),
      span("d1", "child", { childSessionID: "ses_child", agent: "reviewer", model: "antigravity/antigravity-gemini-3.8-flash#medium", purpose: "review", startedAt: 1_002_000, endedAt: 1_007_000, requests: [request("r1", { startedAt: 1_003_000, endedAt: 1_004_000, inputTokens: 100, outputTokens: 5 })] }),
    ],
    ...patch,
  })

  test("renders an honest empty state", () => {
    const html = workflowTimelineHTML(snapshot())
    expect(html).toContain("No workflow spans were recorded")
    expect(html).toContain("Primary token usage and cost are not claimed")
    expect(html).not.toContain("<script")
  })

  test("renders primary and delegated lifelines, request marks and known usage", () => {
    const html = workflowTimelineHTML(timeline())
    expect(html).toContain("<svg")
    expect(html).toContain("Primary · build")
    expect(html).toContain("reviewer · review")
    expect(html).toContain("antigravity-gemini-3.8-flash#medium")
    expect(html).toContain("1 req · 100 in / 5 out")
    expect(html).toContain("primary usage not collected")
    expect(html).toContain("2 spans across 2 lanes")
    expect(html).toContain('class="connector"')
    expect(html).toContain("validation only")
    expect(html).toContain("Dashed border")
    expect(html).toContain("Content-Security-Policy")
    expect(html).not.toContain("LOCAL_ROOT")
    expect(html).not.toContain("LOCAL_CHILD")
    expect(html).not.toContain("LOCAL_NOTE_SECRET")
    expect(workflowTimelineHTML(timeline())).toBe(html)
  })

  test("shows labels only when explicitly included and never shows notes", () => {
    const html = workflowTimelineHTML(timeline({ includesLocalText: true }))
    expect(html).toContain("LOCAL_ROOT")
    expect(html).toContain("LOCAL_CHILD")
    expect(html).not.toContain("LOCAL_NOTE_SECRET")
    expect(html).toContain("local task labels included")
  })

  test("ends running spans at the snapshot time and marks them as incomplete", () => {
    const html = workflowTimelineHTML(timeline({ spans: [span("running", "root", { kind: "primary", agent: "build", state: "running", startedAt: 1_005_000, endedAt: null, requests: [] })] }))
    expect(html).toContain("5.0s")
    expect(html).toContain("running")
    expect(html).toContain("primary usage not collected")
  })

  test("bounds child lanes while keeping the omission visible", () => {
    const spans = Array.from({ length: 42 }, (_, i) => span(`d${i}`, "child", { childSessionID: `ses_child_${i}`, startedAt: 1_000_000 + i * 1000, endedAt: 1_000_500 + i * 1000 }))
    const html = workflowTimelineHTML(snapshot({ tasks: [task("child")], spans }))
    expect(html).toContain("2 older delegation spans not shown")
    expect(html).toContain("bounded to 40 child lanes")
    expect((html.match(/class="bar /g) ?? []).length).toBe(40)
  })

  test("escapes HTML and script payloads from labels, IDs and model metadata", () => {
    const payload = `</title><script>alert(1)</script><img src=x onerror=alert(2)>`
    const html = workflowTimelineHTML(timeline({
      includesLocalText: true,
      tasks: [task("root", { label: payload })],
      spans: [span("p1", "root", { kind: "primary", agent: payload, model: payload, startedAt: 1_000_000, endedAt: 1_008_000, requests: [] })],
    }))
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&lt;img src=x")
    expect(workflowTimelineSVG(timeline({ includesLocalText: true, tasks: [task("root", { label: payload })] }))).toContain("&lt;script&gt;")
  })

  test("does not count duplicate request IDs twice in a lifeline", () => {
    const shared = request("same", { inputTokens: 10, outputTokens: 2 })
    const html = workflowTimelineHTML(timeline({ spans: [span("d1", "child", { requests: [shared, shared] })] }))
    expect(html).toContain("1 req · 10 in / 2 out")
  })
})
