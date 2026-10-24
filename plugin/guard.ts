import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider"
import type { RouterClient } from "../src/client.ts"
import type { Execution, Usage } from "../src/types.ts"

const tokenUsage = (usage: any): Pick<Usage, "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens"> => ({
  inputTokens: typeof usage?.inputTokens?.total === "number" ? usage.inputTokens.total : null,
  outputTokens: typeof usage?.outputTokens?.total === "number" ? usage.outputTokens.total : null,
  reasoningTokens: typeof usage?.outputTokens?.reasoning === "number" ? usage.outputTokens.reasoning : null,
  cacheReadTokens: typeof usage?.inputTokens?.cacheRead === "number" ? usage.inputTokens.cacheRead : null,
})

/** Correlation comes from THIS call's headers, never a last-model/last-session map. */
export function guardLanguage(inner: LanguageModelV3, client: RouterClient, selected: { providerID: string; id: string; modelID: string }): LanguageModelV3 {
  async function prepare(options: LanguageModelV3CallOptions) {
    const id = options.headers?.["x-opencode-router-execution"]
    if (!id) return null // Explicitly selected primary models are never rerouted.
    // Native subscription providers use the HTTP proxy, never both guards. A
    // custom AISDK override fails closed rather than double-reserving or escaping
    // the transport boundary; ordinary explicit primary calls remain untouched.
    if (selected.providerID !== "antigravity") throw new Error("Routed custom AI SDK transport for a native provider is unsupported")
    const execution = await client.call<Execution>("/execution", { id })
    if (!execution || execution.state !== "running") throw new Error("Routed execution is not active")
    if (execution.candidate.ref.providerID !== selected.providerID || execution.candidate.ref.id !== selected.id || inner.modelId !== selected.modelID) throw new Error("AI SDK model object does not match the reserved model")
    if (options.headers?.["x-opencode-router-model"] !== execution.candidate.model) throw new Error("Routed model/variant changed; use a new child for escalation")
    const output = Math.min(options.maxOutputTokens ?? execution.candidate.outputTokens, execution.candidate.outputTokens)
    const bound = Buffer.byteLength(JSON.stringify({ prompt: options.prompt, tools: options.tools, providerOptions: options.providerOptions })) + 8192
    const reserved = await client.call<{ requestID: string }>("/preflight", { id, inputBound: bound, outputBound: output })
    const headers = { ...options.headers }
    // Internal account pin is consumed by the Antigravity adapter, never sent upstream.
    headers["x-opencode-router-account"] = execution.candidate.account.label
    headers["x-opencode-router-agent"] = execution.task.role
    return { id, requestID: reserved.requestID, options: { ...options, maxOutputTokens: output, headers }, started: performance.now() }
  }
  const finish = async (p: NonNullable<Awaited<ReturnType<typeof prepare>>>, usage: Usage) => {
    // A missing acknowledgment leaves conservative debt; never silently release it.
    await client.call("/usage", { requestID: p.requestID, usage: { ...usage, durationMs: performance.now() - p.started } })
  }
  return {
    specificationVersion: inner.specificationVersion, provider: inner.provider, modelId: inner.modelId, supportedUrls: inner.supportedUrls,
    async doGenerate(options) {
      const p = await prepare(options)
      if (!p) return inner.doGenerate(options)
      try {
        const value = await inner.doGenerate(p.options)
        await finish(p, { ...tokenUsage(value.usage), status: "completed" }); return value
      } catch (error) {
        await finish(p, { inputTokens: null, outputTokens: null, status: "uncertain" }).catch(() => {})
        const status = (error as any)?.statusCode
        if (typeof status === "number") await client.call("/failure", { id: p.id, status }).catch(() => {})
        throw error
      }
    },
    async doStream(options) {
      const p = await prepare(options)
      if (!p) return inner.doStream(options)
      try {
        const value = await inner.doStream(p.options)
        const reader = value.stream.getReader()
        let usage: Usage = { inputTokens: null, outputTokens: null, status: "completed" }
        let ended = false
        const end = async (status: Usage["status"]) => { if (!ended) { ended = true; await finish(p, { ...usage, status: usage.status === "uncertain" ? "uncertain" : status }) } }
        return { ...value, stream: new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read()
              if (next.done) { await end("completed"); controller.close(); return }
              if (next.value.type === "finish") usage = { ...tokenUsage(next.value.usage), status: "completed" }
              if (next.value.type === "error") usage.status = "uncertain"
              controller.enqueue(next.value)
            } catch (error) { await end("uncertain").catch(() => {}); controller.error(error) }
          },
          async cancel(reason) { await end("uncertain").catch(() => {}); await reader.cancel(reason) },
        }) }
      } catch (error) {
        await finish(p, { inputTokens: null, outputTokens: null, status: "uncertain" }).catch(() => {})
        const status = (error as any)?.statusCode
        if (typeof status === "number") await client.call("/failure", { id: p.id, status }).catch(() => {})
        throw error
      }
    },
  }
}
