import { contributions, purposes, type Contribution, type Purpose, type WorkflowSnapshot, type WorkflowSpan } from "./workflow-types.ts"

/** Aggregate, metadata-only summary. No contribution percentage, speedup or worker-time claims. */
export interface WorkflowSummary {
  schemaVersion: 1
  generatedAt: number
  sessionID: string
  truncated: boolean
  includesLocalText: boolean
  counts: { tasks: number; spans: number; events: number; requests: number; rootTasks: number }
  tasks: { byState: Record<string, number>; byPurpose: Record<Purpose, number>; byContribution: Record<Contribution, number> }
  spans: { byKind: Record<"primary" | "delegation" | "denial", number>; byState: Record<string, number>; byAgent: Record<string, number>; byModel: Record<string, number> }
  usage: {
    requests: number
    /** Known input tokens only; null when no request reported a value (a measured zero stays zero). */
    inputTokens: number | null
    outputTokens: number | null
    /** Number of distinct requests contributing to each sum (explicit observed coverage). */
    inputObservedRequests: number
    outputObservedRequests: number
    primaryUsage: "not_collected"
    cost: "unavailable"
  }
  coverage: WorkflowSnapshot["coverage"]
  usageByModel: Record<string, { requests: number; inputTokens: number | null; outputTokens: number | null; inputObservedRequests: number; outputObservedRequests: number }>
}

const increment = (record: Record<string, number>, key: string) => { record[key] = (record[key] ?? 0) + 1 }
const ordered = (record: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

export function workflowSummary(snapshot: WorkflowSnapshot): WorkflowSummary {
  const byState: Record<string, number> = Object.create(null)
  const byPurpose = Object.fromEntries(purposes.map(purpose => [purpose, 0])) as Record<Purpose, number>
  const byContribution = Object.fromEntries(contributions.map(contribution => [contribution, 0])) as Record<Contribution, number>
  for (const task of snapshot.tasks) {
    increment(byState, task.state)
    if (task.purpose in byPurpose) byPurpose[task.purpose]++
    if (task.contribution in byContribution) byContribution[task.contribution]++
  }

  const byKind = { primary: 0, delegation: 0, denial: 0 }
  const spanState: Record<string, number> = Object.create(null)
  const byAgent: Record<string, number> = Object.create(null)
  const byModel: Record<string, number> = Object.create(null)
  for (const span of snapshot.spans) {
    if (span.kind in byKind) byKind[span.kind]++
    increment(spanState, span.state)
    increment(byAgent, span.agent || "unknown")
    increment(byModel, span.model ?? "unknown")
  }

  // Deduplicate repeated request records by non-empty ID so retries/joins cannot double count.
  const seen = new Set<string>()
  let requests = 0
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  let inputObservedRequests = 0
  let outputObservedRequests = 0
  const usageByModel: WorkflowSummary["usageByModel"] = Object.create(null)
  for (const span of snapshot.spans) for (const request of span.requests) {
    if (request.id) {
      if (seen.has(request.id)) continue
      seen.add(request.id)
    }
    requests++
    const group = usageByModel[span.model ?? "unknown"] ??= { requests: 0, inputTokens: null, outputTokens: null, inputObservedRequests: 0, outputObservedRequests: 0 }
    group.requests++
    if (request.inputTokens !== null && Number.isFinite(request.inputTokens) && request.inputTokens >= 0) {
      inputTokens = (inputTokens ?? 0) + request.inputTokens
      inputObservedRequests++
      group.inputTokens = (group.inputTokens ?? 0) + request.inputTokens; group.inputObservedRequests++
    }
    if (request.outputTokens !== null && Number.isFinite(request.outputTokens) && request.outputTokens >= 0) {
      outputTokens = (outputTokens ?? 0) + request.outputTokens
      outputObservedRequests++
      group.outputTokens = (group.outputTokens ?? 0) + request.outputTokens; group.outputObservedRequests++
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    sessionID: snapshot.sessionID,
    truncated: snapshot.truncated,
    includesLocalText: snapshot.includesLocalText,
    counts: {
      tasks: snapshot.tasks.length,
      spans: snapshot.spans.length,
      events: snapshot.events.length,
      requests,
      rootTasks: snapshot.tasks.filter(task => task.parentTaskID === null).length,
    },
    tasks: { byState: ordered(byState), byPurpose, byContribution },
    spans: { byKind, byState: ordered(spanState), byAgent: ordered(byAgent), byModel: ordered(byModel) },
    usage: { requests, inputTokens, outputTokens, inputObservedRequests, outputObservedRequests, primaryUsage: "not_collected", cost: "unavailable" },
    coverage: { ...snapshot.coverage },
    usageByModel: Object.fromEntries(Object.entries(usageByModel).sort(([a], [b]) => a.localeCompare(b))),
  }
}

const ENTITIES: Record<string, string> = {
  "&": "#38;", "<": "#60;", ">": "#62;", '"': "#34;", "'": "#39;", "`": "#96;", "[": "#91;", "]": "#93;",
  "{": "#123;", "}": "#125;", "(": "#40;", ")": "#41;", "|": "#124;", "#": "#35;", "%": "#37;", ";": "#59;", "\\": "#92;",
}

/** Single-line, length-capped text that cannot close a quoted label or form directives, arrows or raw HTML. */
const label = (text: string, max = 90): string => {
  const chars = Array.from(text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim())
  const limited = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")
  return limited.replace(/[&<>"'`\[\]{}()|#%;\\]/g, char => ENTITIES[char]!).replace(/\bclick\b/gi, "cli#99;k")
}

const taskText = (snapshot: WorkflowSnapshot, task: WorkflowSnapshot["tasks"][number], nodeID: string): string => {
  const parts = snapshot.includesLocalText && task.label ? [task.label, task.purpose, task.state] : [task.purpose, task.state, nodeID]
  return label(parts.join(" · "))
}

const spanText = (span: WorkflowSpan): string => label([span.kind, span.agent || "agent unknown", span.model ?? "model unknown", span.state].join(" · "))

export function workflowMermaid(snapshot: WorkflowSnapshot): string {
  const lines = ["flowchart LR", "  classDef task fill:#eef2ff,stroke:#41538a,color:#111", "  classDef span fill:#fff7e6,stroke:#8a6d41,color:#111"]
  const taskIDs = new Set(snapshot.tasks.map(task => task.id))
  const spanBlocks = new Map<string, string[]>()
  const orphanBlocks: string[] = []
  snapshot.spans.forEach((span, index) => {
    const spanID = `span_${index + 1}`
    const block = [`    ${spanID}["${spanText(span)}"]`, `    class ${spanID} span`]
    const taskIndex = snapshot.tasks.findIndex(task => task.id === span.taskID)
    if (taskIndex >= 0) block.push(`    task_${taskIndex + 1} -.- ${spanID}`)
    if (taskIDs.has(span.taskID)) {
      if (!spanBlocks.has(span.taskID)) spanBlocks.set(span.taskID, [])
      spanBlocks.get(span.taskID)!.push(...block)
    } else orphanBlocks.push(...block)
  })

  const taskNode = new Map<string, string>()
  const attached = new Set<string>()
  snapshot.tasks.forEach((task, index) => {
    const nodeID = `task_${index + 1}`
    if (!taskNode.has(task.id)) taskNode.set(task.id, nodeID)
    const block = [`  subgraph task_group_${index + 1}["${taskText(snapshot, task, nodeID)}"]`, "    direction TB", `    ${nodeID}["${label(`${nodeID} · ${task.purpose} · ${task.state} · ${task.contribution}`)}"]`]
    if (!attached.has(task.id)) {
      attached.add(task.id)
      for (const spanLine of spanBlocks.get(task.id) ?? []) block.push(spanLine)
    }
    block.push(`  end`, `  class ${nodeID} task`)
    lines.push(...block)
  })

  const orphaned = snapshot.spans.some(span => !taskNode.has(span.taskID))
  if (orphaned) {
    lines.push('  subgraph orphaned_spans["unattached spans"]', "    direction TB")
    for (const line of orphanBlocks) lines.push(line)
    lines.push("  end")
  }

  const seenEdges = new Set<string>()
  snapshot.tasks.forEach(task => {
    const child = taskNode.get(task.id)
    if (!child) return
    const add = (edge: string | null) => {
      if (!edge || seenEdges.has(edge)) return
      seenEdges.add(edge)
      lines.push(`  ${edge}`)
    }
    if (task.parentTaskID && task.parentTaskID !== task.id) {
      const parent = taskNode.get(task.parentTaskID)
      add(parent ? `${parent} -->|parent| ${child}` : null)
    }
    for (const dependencyID of task.dependsOn) {
      const dependency = taskNode.get(dependencyID)
      add(dependency && dependency !== child ? `${child} -.->|depends| ${dependency}` : null)
    }
  })
  return lines.join("\n")
}
