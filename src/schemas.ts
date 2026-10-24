import { z } from "zod"
import { roles, tiers } from "./types.ts"

const tokens = z.number().int().nonnegative().max(10_000_000)
export const taskSchema = z.object({
  role: z.enum(roles), tier: z.enum(tiers).default("DEFAULT"), importance: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  parentAgent: z.string().min(1), parentSessionID: z.string().startsWith("ses"), directory: z.string().min(1),
  inputTokens: tokens, outputTokens: tokens.positive().optional(), modalities: z.array(z.enum(["text", "image", "pdf", "audio", "video"])).min(1).default(["text"]),
  originModel: z.string().max(300).optional(), requestedModel: z.string().max(300).optional(),
}).strict()
export const catalogSchema = z.object({
  providerID: z.string(), id: z.string(), modelID: z.string().optional(), package: z.string().optional(), enabled: z.boolean(),
  limit: z.object({ context: tokens.positive(), input: tokens.positive().optional(), output: tokens.positive() }),
  variants: z.array(z.object({ id: z.string() })), capabilities: z.object({ tools: z.boolean(), input: z.array(z.string()), output: z.array(z.string()) }),
  cost: z.array(z.object({ input: z.number().nonnegative(), output: z.number().nonnegative(), cache: z.object({ read: z.number().nonnegative(), write: z.number().nonnegative() }), tier: z.object({ type: z.string(), size: z.number() }).optional() })),
}).strict()
export const bindingSchema = z.object({ providerID: z.string(), credentialID: z.string().min(1), label: z.string(), accountKey: z.string(), method: z.string(), credentialFingerprint: z.string().optional(), integrationID: z.string().optional(), workspaceID: z.string().optional(), authorizationFingerprint: z.string().optional() }).strict()
export const usageSchema = z.object({ inputTokens: tokens.nullable(), outputTokens: tokens.nullable(), reasoningTokens: tokens.nullable().optional(), cacheReadTokens: tokens.nullable().optional(), durationMs: z.number().finite().nonnegative().optional(), status: z.enum(["completed", "failed", "uncertain"]) }).strict()
