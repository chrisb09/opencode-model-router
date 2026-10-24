import { workflowSummary } from "./workflow-export.ts"
import type { WorkflowSnapshot, WorkflowSpan, WorkflowTask } from "./workflow-types.ts"

const esc = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!))
const compact = (value: number | null): string => {
  if (value === null) return "unknown"
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}
const duration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "unknown"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60), rest = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m ${rest}s`
  const hours = Math.floor(minutes / 60), mins = minutes % 60
  return `${hours}h ${mins}m`
}
const utcTime = (value: number): string => Number.isFinite(value) ? `${new Date(value).toISOString().slice(11, 19)}Z` : "unknown"
const utcStamp = (value: number): string => Number.isFinite(value) ? new Date(value).toISOString() : "unknown"
const titleText = (parts: Array<string | null | undefined>, max = 220): string => {
  const text = parts.filter((part): part is string => Boolean(part)).join(" · ")
  const chars = Array.from(text.replace(/[\u0000-\u001f\u007f]+/g, " "))
  return esc(chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join(""))
}
const shortModel = (model: string | null): string => model ? model.replace(/^[^/]+\//, "") : "model not observed"
const clip = (value: string, max: number): string => {
  const chars = Array.from(value.replace(/[\u0000-\u001f\u007f]+/g, " "))
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("")
}
const stateClass = (state: string): string => ["completed", "running", "failed", "denied", "cancelled", "unknown"].includes(state) ? state : "unknown"
const contributionClass = (value: string): string => value === "partially_incorporated" ? "partial" : value
const contributionLabel = (value: string): string => value.replaceAll("_", " ")

const COLORS: Record<string, string> = {
  gemini: "#2d7f86", deepseek: "#6b5bd2", sol: "#b66a1e", opus: "#9b5d3e",
  kimi: "#327a45", unknown: "#626b7a",
}
const family = (model: string | null): string => {
  const lower = (model ?? "").toLowerCase()
  if (lower.includes("gemini")) return "gemini"
  if (lower.includes("deepseek")) return "deepseek"
  if (lower.includes("sol")) return "sol"
  if (lower.includes("opus")) return "opus"
  if (lower.includes("kimi")) return "kimi"
  return "unknown"
}
const modelColor = (model: string | null): string => COLORS[family(model)]!

type Lane = {
  key: string
  primary: boolean
  spans: WorkflowSpan[]
  task: WorkflowTask | undefined
}

const TICK_STEPS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000]
const tickStep = (range: number): number => TICK_STEPS.find(step => range / step <= 7) ?? TICK_STEPS.at(-1)!

function lanesOf(snapshot: WorkflowSnapshot, fallbackEnd: number) {
  const usable = (span: WorkflowSpan) => Number.isFinite(span.startedAt) && span.startedAt >= 0
  const safeEnd = (span: WorkflowSpan) => Number.isFinite(span.endedAt) && span.endedAt! >= span.startedAt ? span.endedAt! : Math.max(span.startedAt, fallbackEnd)
  const spans = snapshot.spans.filter(usable)
  const primary = spans.filter(span => span.kind === "primary").sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const delegated = spans.filter(span => span.kind !== "primary").sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const groups = new Map<string, WorkflowSpan[]>()
  for (const span of delegated) {
    const key = span.childSessionID ?? span.id
    groups.set(key, [...(groups.get(key) ?? []), span])
  }
  const taskByID = new Map(snapshot.tasks.map(task => [task.id, task]))
  const lanes: Lane[] = []
  if (primary.length) {
    const last = primary.at(-1)!
    lanes.push({ key: "primary", primary: true, spans: primary, task: taskByID.get(last.taskID) })
  }
  let omitted = 0, childLanes = 0
  for (const [key, group] of groups) {
    if (childLanes >= 40) { omitted += group.length; continue }
    childLanes++
    const last = group.at(-1)!
    lanes.push({ key, primary: false, spans: group, task: taskByID.get(last.taskID) })
  }
  return { lanes, spans, primary, omitted, safeEnd }
}

function usageText(span: WorkflowSpan): string {
  const seen = new Set<string>()
  const requests = span.requests.filter(request => {
    if (!request.id) return true
    if (seen.has(request.id)) return false
    seen.add(request.id)
    return true
  })
  if (!requests.length) return "no observed subagent usage"
  let input: number | null = null, output: number | null = null
  for (const request of requests) {
    if (request.inputTokens !== null && Number.isFinite(request.inputTokens) && request.inputTokens >= 0) input = (input ?? 0) + request.inputTokens
    if (request.outputTokens !== null && Number.isFinite(request.outputTokens) && request.outputTokens >= 0) output = (output ?? 0) + request.outputTokens
  }
  return `${requests.length} req · ${compact(input)} in / ${compact(output)} out`
}

const laneActor = (lane: Lane): string => {
  if (lane.primary) return "Primary · " + lane.spans.at(-1)!.agent
  const last = lane.spans.at(-1)!
  return `${last.agent} · ${last.kind === "denial" ? "denied" : last.purpose}`
}
const laneModel = (lane: Lane): string => {
  const models = [...new Set(lane.spans.map(span => span.model).filter((model): model is string => Boolean(model)))]
  return models.length ? models.map(shortModel).join(", ") : lane.primary ? "model not recorded" : "model not observed"
}
const laneTaskText = (snapshot: WorkflowSnapshot, lane: Lane): string => {
  const task = lane.task
  if (!task) return "task not recorded"
  if (snapshot.includesLocalText && task.label) return task.label
  return task.purpose + " · " + task.id.slice(-8)
}

const STYLE = `
:root{color-scheme:light;--ink:#1e2532;--muted:#657083;--line:#d8dee9;--bg:#f5f7fb;--card:#fff;--primary:#455b88;--danger:#b83a4b;--warn:#a76912;--ok:#28714b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1480px;margin:0 auto;padding:28px 30px 44px}header{display:flex;flex-wrap:wrap;gap:10px 24px;align-items:flex-end;justify-content:space-between;margin-bottom:18px}
h1{font-size:24px;line-height:1.15;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px}.meta{color:var(--muted);font-size:12.5px}.notice{border-left:3px solid #8294b8;background:#eef2f9;color:#45536a;padding:9px 12px;margin:12px 0 18px;font-size:12.5px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;margin:0 0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:11px 13px}.card .k{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}.card .v{font-size:19px;font-weight:650;margin-top:2px}.card .s{font-size:11px;color:var(--muted);margin-top:2px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:auto;box-shadow:0 1px 2px #19243b0b}.chart{display:block;min-width:1050px;width:100%;height:auto}
.axis{fill:var(--muted);font-size:11px}.grid{stroke:#e6ebf3;stroke-width:1}.lifeline{stroke:#cfd7e4;stroke-width:1;stroke-dasharray:3 4}.lane-title{fill:var(--ink);font-size:12.5px;font-weight:600}.lane-meta{fill:var(--muted);font-size:10.5px}.lane-task{fill:#778397;font-size:10px}
.bar{stroke-width:1.2}.bar.completed{opacity:.92}.bar.running{stroke-dasharray:4 2}.bar.failed,.bar.denied{stroke:var(--danger);stroke-width:1.8}.bar.cancelled,.bar.unknown{opacity:.45;stroke-dasharray:2 2}
.duration{fill:#263142;font-size:10px;font-weight:600}.request{fill:#fff;opacity:.7}.connector{fill:none;stroke:#7183a7;stroke-width:1.1;stroke-dasharray:4 3;opacity:.75}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin:10px 2px 0;color:var(--muted);font-size:11px}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle}
.table{width:100%;border-collapse:collapse;font-size:12px}.table th,.table td{padding:8px 10px;border-bottom:1px solid #e8edf4;text-align:left;vertical-align:top}.table th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:#fafbfd;position:sticky;top:0}.table tr:last-child td{border-bottom:0}.model{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.pill{display:inline-block;border-radius:99px;padding:1px 7px;font-size:10px;font-weight:650;border:1px solid #ccd5e2;background:#f6f8fb;white-space:nowrap}.pill.incorporated{color:#226443;background:#e9f5ee;border-color:#b8ddc8}.pill.partially_incorporated,.pill.partial{color:#87580b;background:#fff4df;border-color:#ecd39d}.pill.validation_only{color:#315b91;background:#edf4ff;border-color:#c4d7ef}.pill.rejected{color:#9c2c3d;background:#fff0f2;border-color:#efc1c8}.pill.superseded,.pill.unassessed{color:#596577}.foot{color:var(--muted);font-size:11.5px;margin-top:16px;max-width:980px}.truncated{background:#fff5df;border-color:#ead097}.empty{padding:38px;text-align:center;color:var(--muted)}
@media (prefers-reduced-motion:no-preference){.bar.running{animation:run 2.4s ease-in-out infinite}@keyframes run{50%{opacity:.55}}}
@media print{body{background:#fff}main{max-width:none;padding:0}.panel{box-shadow:none}.chart{min-width:0}.notice{break-inside:avoid}}
`

export function workflowTimelineSVG(snapshot: WorkflowSnapshot): string {
  const fallbackEnd = Math.max(snapshot.generatedAt, ...snapshot.spans.map(span => Number.isFinite(span.startedAt) ? span.startedAt : 0))
  const { lanes, spans, primary, omitted, safeEnd } = lanesOf(snapshot, fallbackEnd)
  if (!spans.length) return `<div class="empty">No workflow spans were recorded for this session.</div>`

  const start = Math.min(...spans.map(span => span.startedAt))
  const end = Math.max(fallbackEnd, ...spans.map(safeEnd))
  const range = Math.max(1000, end - start)
  const laneHeight = 66, top = 72, width = 1380, left = 318, right = 34
  const plotWidth = width - left - right
  const height = top + lanes.length * laneHeight + 30
  const x = (time: number) => left + ((Math.max(start, Math.min(end, time)) - start) / range) * plotWidth
  const ticks = (() => {
    const step = tickStep(range)
    const first = Math.ceil(start / step) * step
    const result: number[] = []
    for (let at = first; at <= end && result.length < 9; at += step) result.push(at)
    if (!result.length) result.push(start, end)
    return result
  })()
  const paths: string[] = []
  const blocks: string[] = []
  const rowY = new Map<string, number>()
  lanes.forEach((lane, index) => rowY.set(lane.key, top + index * laneHeight + laneHeight / 2))
  for (const tick of ticks) {
    const px = x(tick)
    blocks.push(`<line class="grid" x1="${px.toFixed(2)}" y1="${top - 10}" x2="${px.toFixed(2)}" y2="${height - 25}"/>`)
    blocks.push(`<text class="axis" x="${px.toFixed(2)}" y="${top - 20}" text-anchor="middle">${esc(utcTime(tick))}</text>`)
  }
  {
    const nowX = x(fallbackEnd)
    blocks.push(`<line x1="${nowX.toFixed(2)}" y1="${top - 10}" x2="${nowX.toFixed(2)}" y2="${height - 25}" stroke="#9eabc0" stroke-width="1" stroke-dasharray="2 4"/>`)
  }

  // Delegation connectors are time containment, not proof of causal contribution.
  for (const span of lanes.flatMap(lane => lane.spans).filter(span => span.kind !== "primary")) {
    const parent = primary.find(candidate => candidate.startedAt <= span.startedAt && safeEnd(candidate) >= span.startedAt)
    if (!parent) continue
    const childY = rowY.get(span.childSessionID ?? span.id)
    const parentY = rowY.get("primary")
    if (childY === undefined || parentY === undefined) continue
    const px = x(span.startedAt)
    paths.push(`<path class="connector" d="M ${px.toFixed(2)} ${(parentY + 13).toFixed(2)} C ${px.toFixed(2)} ${(parentY + 30).toFixed(2)}, ${px.toFixed(2)} ${(childY - 18).toFixed(2)}, ${px.toFixed(2)} ${(childY - 11).toFixed(2)}"/>`)
  }

  lanes.forEach((lane, index) => {
    const y = top + index * laneHeight
    const barY = y + 22
    const actor = laneActor(lane)
    const models = laneModel(lane)
    const state = lane.spans.at(-1)!.state
    const contribution = lane.task?.contribution ?? "unassessed"
    const usage = lane.primary ? "primary usage not collected" : lane.spans.at(-1) ? usageText(lane.spans.at(-1)!) : "usage unknown"
    blocks.push(`<line class="lifeline" x1="${left}" y1="${(y + laneHeight / 2).toFixed(2)}" x2="${width - right}" y2="${(y + laneHeight / 2).toFixed(2)}"/>`)
    blocks.push(`<text class="lane-title" x="22" y="${y + 20}">${esc(clip(actor, 44))}${lane.spans.length > 1 ? ` · ${lane.spans.length} spans` : ""}</text>`)
    blocks.push(`<text class="lane-meta" x="22" y="${y + 36}">${esc(clip(models, 42))}${lane.spans.at(-1)!.tier ? ` · ${esc(lane.spans.at(-1)!.tier!)}` : ""} · ${esc(state)}</text>`)
    blocks.push(`<text class="lane-task" x="22" y="${y + 58}">${esc(clip(laneTaskText(snapshot, lane), 31))} · ${esc(contributionLabel(contribution))} · ${esc(clip(usage, 34))}</text>`)
    for (const span of lane.spans) {
      const spanStart = span.startedAt
      const spanEnd = safeEnd(span)
      const bx = x(spanStart), bw = Math.max(4, x(spanEnd) - bx)
      const color = modelColor(span.model)
      const title = titleText([span.kind, span.agent, span.model ?? "model not observed", span.purpose, span.state, `started ${utcStamp(spanStart)}`, `duration ${duration(spanEnd - spanStart)}`, lane.task ? `contribution ${lane.task.contribution}` : null])
      blocks.push(`<rect class="bar ${esc(stateClass(span.state))}" x="${bx.toFixed(2)}" y="${barY}" width="${bw.toFixed(2)}" height="23" rx="4" fill="${color}"><title>${title}</title></rect>`)
      if (bw > 52) blocks.push(`<text class="duration" x="${(bx + 6).toFixed(2)}" y="${barY + 15}">${esc(duration(spanEnd - spanStart))}</text>`)
      for (const request of span.requests) {
        if (!Number.isFinite(request.startedAt)) continue
        const requestEnd = Number.isFinite(request.endedAt) && request.endedAt! >= request.startedAt ? request.endedAt! : spanEnd
        const rx = x(request.startedAt), rw = Math.max(2, x(requestEnd) - rx)
        blocks.push(`<rect class="request" x="${rx.toFixed(2)}" y="${(barY + 16).toFixed(2)}" width="${rw.toFixed(2)}" height="4" rx="1"><title>${titleText([`${request.state} request`, `in ${request.inputTokens ?? "unknown"}`, `out ${request.outputTokens ?? "unknown"}`, `quota estimate ${request.estimatedQuotaPp.toFixed(3)}pp`])}</title></rect>`)
      }
    }
  })

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Workflow lifeline timeline for session ${esc(snapshot.sessionID)}" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="${width}" height="${height}" fill="#fff"/>
<text class="axis" x="${left}" y="22" text-anchor="start">UTC time</text>
<text class="axis" x="${width - right}" y="22" text-anchor="end">${esc(utcStamp(start))} → ${esc(utcStamp(end))}</text>
${blocks.join("\n")}
${paths.join("\n")}
</svg>
${omitted ? `<p class="foot truncated">${omitted} older delegation span${omitted === 1 ? "" : "s"} not shown; this view is bounded to 40 child lanes.</p>` : ""}`
}

export function workflowTimelineHTML(snapshot: WorkflowSnapshot): string {
  const summary = workflowSummary(snapshot)
  const spans = snapshot.spans
  const start = spans.length ? Math.min(...spans.map(span => span.startedAt).filter(Number.isFinite)) : snapshot.generatedAt
  const end = spans.length ? Math.max(snapshot.generatedAt, ...spans.map(span => Number.isFinite(span.endedAt) && span.endedAt! >= span.startedAt ? span.endedAt! : span.startedAt)) : snapshot.generatedAt
  const contributionText = Object.entries(summary.tasks.byContribution).filter(([, count]) => count > 0).map(([name, count]) => `${contributionLabel(name)} ${count}`).join(" · ") || "none"
  const laneCount = (spans.some(span => span.kind === "primary") ? 1 : 0) + Math.min(40, new Set(spans.filter(span => span.kind !== "primary").map(span => span.childSessionID ?? span.id)).size)
  const rows = spans.slice().sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).map(span => {
    const task = snapshot.tasks.find(task => task.id === span.taskID)
    const endAt = Number.isFinite(span.endedAt) && span.endedAt! >= span.startedAt ? span.endedAt! : snapshot.generatedAt
    return `<tr><td>${esc(span.kind)}</td><td>${esc(span.agent)}</td><td class="model">${esc(span.model ?? "unknown")}</td><td>${esc(span.purpose)}</td><td>${esc(utcTime(span.startedAt))} – ${esc(utcTime(endAt))}</td><td>${esc(duration(endAt - span.startedAt))}</td><td>${span.kind === "primary" ? "not collected" : esc(usageText(span))}</td><td><span class="pill ${esc(contributionClass(task?.contribution ?? "unassessed"))}">${esc(contributionLabel(task?.contribution ?? "unassessed"))}</span></td></tr>`
  }).join("\n")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Workflow timeline · ${esc(snapshot.sessionID)}</title><style>${STYLE}</style></head>
<body><main>
<header><div><h1>Workflow timeline</h1><div class="meta">${esc(snapshot.schemaVersion ? `Schema v${snapshot.schemaVersion}` : "Schema unknown")} · session <code>${esc(snapshot.sessionID)}</code> · generated ${esc(utcStamp(snapshot.generatedAt))}</div></div>
<div class="meta">${snapshot.localOnly ? "Local-only export" : "Export scope unknown"}${snapshot.includesLocalText ? " · local task labels included" : " · labels redacted"}</div></header>
<div class="notice">Horizontal bars show observed execution spans; child requests are small lighter marks. Dashed connectors mean a delegation started while a primary span was active, not measured causality or contribution. Contribution is an explicit coordinator assessment, not a score.</div>
<section class="cards">
<div class="card"><div class="k">Observed timeline</div><div class="v">${esc(duration(end - start))}</div><div class="s">${spans.length} span${spans.length === 1 ? "" : "s"} across ${laneCount} lane${laneCount === 1 ? "" : "s"}</div></div>
<div class="card"><div class="k">Logical tasks</div><div class="v">${summary.counts.tasks}</div><div class="s">${summary.tasks.byState.completed ?? 0} completed · ${summary.tasks.byState.running ?? 0} running</div></div>
<div class="card"><div class="k">Delegations</div><div class="v">${summary.spans.byKind.delegation}</div><div class="s">${summary.spans.byKind.denial} denied · ${summary.spans.byKind.primary} primary spans</div></div>
<div class="card"><div class="k">Known subagent usage</div><div class="v">${compact(summary.usage.inputTokens)} / ${compact(summary.usage.outputTokens)}</div><div class="s">in / out · ${summary.usage.inputObservedRequests} of ${summary.usage.requests} requests observed</div></div>
<div class="card"><div class="k">Unassessed</div><div class="v">${summary.tasks.byContribution.unassessed}</div><div class="s">${esc(contributionText)}</div></div>
</section>
<section class="panel">${workflowTimelineSVG(snapshot)}</section>
<div class="legend"><span><i style="background:${COLORS.gemini}"></i>Gemini</span><span><i style="background:${COLORS.deepseek}"></i>DeepSeek</span><span><i style="background:${COLORS.sol}"></i>Sol</span><span><i style="background:${COLORS.opus}"></i>Opus</span><span><i style="background:${COLORS.kimi}"></i>Kimi</span><span><i style="background:${COLORS.unknown}"></i>Unknown</span><span>Dashed border = running / incomplete</span><span>Red border = failed / denied</span></div>
<h2>Span details</h2>
<section class="panel"><table class="table"><thead><tr><th>Kind</th><th>Agent</th><th>Model</th><th>Purpose</th><th>UTC range</th><th>Duration</th><th>Request usage</th><th>Contribution</th></tr></thead><tbody>${rows || `<tr><td colspan="8">No spans recorded.</td></tr>`}</tbody></table></section>
<p class="foot">Primary token usage and cost are not claimed. “Duration” measures observed elapsed time, not effort or value. Labels are omitted unless this export was explicitly requested with local text; notes are never rendered. This file loads no scripts, fonts or remote resources.</p>
</main></body></html>`
}
