import { createHash } from "node:crypto"
import { z } from "zod"
import type { Context } from "@opencode/plugin/promise/plugin"
import * as Tool from "@opencode/plugin/promise/tool"
import type { RouterClient } from "../src/client.ts"
import { annotationSchema } from "../src/workflow.ts"
import { modelString } from "../src/policy.ts"

/** Only annotation labels/notes are text; reads always request redacted output. */
export async function workflowTools(ctx: Context, client: RouterClient) {
  let captureFailures = 0
  let pending = 0
  const send = async (path: string, body: unknown) => {
    if (client.config.workflow?.enabled === false) return
    if (pending >= 100) { captureFailures++; return }
    pending++
    try { await client.call(path, body, 1500) } catch { captureFailures++ } finally { pending-- }
  }
  await ctx.tool.transform(editor => {
    editor.add({
      name: "workflow_annotate",
      description: "Create/update a logical task in this session's LOCAL workflow. Omit taskID to create; use returned taskID to update or link routing.taskID. Explicit contribution assessments are coordinator opinions, not measured value. Labels/notes remain local and are omitted from default reads/exports. Never put prompts, secrets or file content in annotations. No quota/model changes.",
      input: z.toJSONSchema(annotationSchema) as any,
      options: { codemode: false },
      async execute(value, context) {
        const session = await ctx.session.get({ sessionID: context.sessionID })
        if (session.parentID || !["plan", "build"].includes(context.agent)) throw new Tool.Error({ message: "Only the primary Plan/Build coordinator can annotate its workflow" })
        await ctx.permission.assert({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool", messageID: context.messageID, id: context.id }, action: "workflow_annotate", resources: ["*"], save: ["*"] })
        const eventID = "annotation:" + createHash("sha256").update(`${context.sessionID}:${context.messageID}:${context.id}`).digest("hex")
        try {
          const result = await client.call("/workflow/annotate", { sessionID: session.id, actorSessionID: context.sessionID, actorAgent: context.agent, eventID, annotation: annotationSchema.parse(value) })
          return { content: JSON.stringify(result) }
        } catch { throw new Tool.Error({ message: "Workflow annotation failed; check task/dependency IDs, local recording settings or router health. Quota routing is unchanged." }) }
      },
    })
    editor.add({
      name: "workflow_read",
      description: "Read this session's local workflow graph and statistics, or export Mermaid. Labels/notes are always redacted. Includes primary/delegation coverage and explicit contribution assessments; does not estimate an objective contribution percentage.",
      input: { type: "object", properties: { format: { type: "string", enum: ["json", "mermaid"] } }, additionalProperties: false },
      options: { codemode: false },
      async execute(value, context) {
        const input = z.object({ format: z.enum(["json", "mermaid"]).default("json") }).strict().parse(value)
        const session = await ctx.session.get({ sessionID: context.sessionID })
        try {
          const result = await client.call("/workflow/read", { sessionID: session.parentID ?? session.id, format: input.format })
          return { content: JSON.stringify({ ...result, localCaptureFailures: captureFailures }) }
        } catch { throw new Tool.Error({ message: "Local workflow read unavailable; quota routing is unchanged" }) }
      },
    })
  })
  await ctx.session.hook("model.request", async event => {
    // Never let best-effort telemetry add router I/O latency to primary dispatch.
    if (!event.agent || !["plan", "build"].includes(event.agent) || event.kind !== "primary") return
    const agent = event.agent
    void (async () => {
      try {
        const session = await ctx.session.get({ sessionID: event.sessionID })
        if (!session.parentID) await send("/workflow/context", { sessionID: session.id, agent, model: modelString(event.model) })
      } catch { captureFailures++ }
    })()
  })
  return async (event: any) => {
    if (!["session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) return
    const sessionID = event.data?.sessionID
    if (!sessionID || typeof event.durable?.seq !== "number" || typeof event.created !== "number" || typeof event.id !== "string") return
    try {
      const session = await ctx.session.get({ sessionID })
      if (session.parentID || !session.agent || !["plan", "build"].includes(session.agent) || session.location?.directory && session.location.directory !== ctx.location.directory) return
      await send("/workflow/primary", { sessionID, eventID: event.id, sequence: event.durable.seq, at: event.created, agent: session.agent, model: session.model ? modelString(session.model) : null,
        state: event.type.endsWith("started") ? "running" : event.type.endsWith("succeeded") ? "completed" : event.type.endsWith("interrupted") ? "cancelled" : "failed" })
    } catch { captureFailures++ }
  }
}
