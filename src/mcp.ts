import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { connect } from "./client.ts"
import { roles, tiers } from "./types.ts"

const client = await connect()
const server = new McpServer({ name: "model-router", version: "0.1.0" }, { instructions: "Read-only quota-aware subagent routing status and recommendations. Native subagent dispatch automatically enforces routing; recommendations do not reserve capacity or grant spending authority." })
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] })
server.registerTool("get_workflow", {
  description: "Read a local session workflow with logical tasks, actual model spans, nullable usage and explicit contribution assessments, or export Mermaid. Labels/notes and credentials are never included. No contribution percentage or remote export.",
  inputSchema: { sessionID: z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(200), format: z.enum(["json", "mermaid"]).default("json") }, annotations: { readOnlyHint: true },
}, async ({ sessionID, format }) => result(await client.call("/workflow/read", { sessionID, format })))
server.registerTool("list_workflows", { description: "List recent local workflow session IDs and timestamps, without labels, notes, paths or credentials.", inputSchema: { limit: z.number().int().min(1).max(100).default(20) }, annotations: { readOnlyHint: true } }, async ({ limit }) => result(await client.call("/workflow/list", { limit })))
server.registerTool("get_model_status", { description: "Inspect router health, safeguards, reservations and recent routing decisions. Read-only.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => result(await client.call("/status")))
server.registerTool("recommend_model", {
  description: "Rank model/account candidates without reserving or dispatching. Quotas may be refreshed through the existing collector's cooldown-controlled API.",
  inputSchema: { role: z.enum(roles), tier: z.enum(tiers).default("DEFAULT"), importance: z.enum(["low", "normal", "high", "critical"]).default("normal"), directory: z.string(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().positive().optional(), originModel: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ directory, role, tier, importance, inputTokens, outputTokens, originModel }) => result(await client.call("/recommend", { task: { directory, role, tier, importance, inputTokens, outputTokens, originModel, parentAgent: "build", parentSessionID: "ses_recommendation", modalities: ["text"] } })))
await server.connect(new StdioServerTransport())
