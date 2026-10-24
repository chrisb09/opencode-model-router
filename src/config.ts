import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import defaults from "../config/policy.json"
import type { Policy } from "./types.ts"

export const paths = (home = homedir()) => ({
  config: join(home, ".config/opencode-model-router/config.json"),
  token: join(home, ".config/opencode-model-router/service-token"),
  state: join(home, ".local/share/opencode-model-router"),
  database: join(home, ".local/share/opencode-model-router/router.db"),
})
const settingsSchema = z.object({
  url: z.string().url().default("http://127.0.0.1:7695"),
  collectorUrl: z.string().url().default("https://usage.christian-f-brinkmann.de"),
  collectorAuthorizationFile: z.string().optional(),
  policyFile: z.string().optional(),
  enabled: z.boolean().default(true),
  workflow: z.object({ enabled: z.boolean().default(true), captureLabels: z.boolean().default(true) }).strict().optional(),
  credentialBindings: z.array(z.object({ providerID: z.string(), credentialID: z.string(), accountKey: z.string(), credentialFingerprint: z.string().optional(), integrationID: z.string().optional(), workspaceID: z.string().optional() }).strict()).optional(),
}).strict()
export type Settings = z.infer<typeof settingsSchema>
export const defaultPolicy = (): Policy => structuredClone(defaults) as Policy
export async function settings(file = paths().config): Promise<Settings> {
  return settingsSchema.parse(JSON.parse(await readFile(file, "utf8")))
}
export async function loadPolicy(file?: string): Promise<Policy> {
  const p = file ? JSON.parse(await readFile(file, "utf8")) : defaultPolicy()
  // Validate the complete user policy rather than silently accepting misspelled
  // safeguards. Role/tier arrays are validated when expanding candidates too.
  const nonnegative = z.number().finite().nonnegative()
  const tierMap = <T extends z.ZodTypeAny>(v: T) => z.object({ LOW: v, DEFAULT: v, HARD: v, EXCEPTIONAL: v }).strict()
  const roleMap = Object.fromEntries(["explore", "research", "general", "debugger", "reviewer", "architect", "critic"].map(r => [r, tierMap(z.array(z.string().min(1)).min(1))]))
  return z.object({
    version: z.literal(1), aliases: z.record(z.string(), z.string().min(1)), roles: z.object(roleMap).strict(),
    fallbacks: tierMap(z.array(z.string())), criticPreferences: z.record(z.string(), z.enum(["gemini", "deepseek", "sol", "kimi", "opus", "unknown"])),
    outputTokens: tierMap(z.number().int().positive()), maxSteps: tierMap(z.number().int().positive().max(100)),
    quota: z.object({ maxAgeMs: z.number().int().positive(), hardReservePp: nonnegative.max(100),
      softReservePp: z.record(z.string(), nonnegative.max(100)), estimatedRequestPp: z.record(z.string(), nonnegative.positive().max(100)),
      maxConcurrentPerAccount: z.record(z.string(), z.number().int().positive().max(16)) }).strict(),
    allowPaid: z.boolean(), allowKimi: z.boolean(), maxTaskUsd: nonnegative, totalBudgetUsd: nonnegative,
  }).strict().parse(p) as Policy
}
export function assertLocalUrl(url: string): URL {
  const u = new URL(url)
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.username || u.password || u.pathname !== "/") throw new Error("Router URL must be http://127.0.0.1:<port>")
  return u
}
