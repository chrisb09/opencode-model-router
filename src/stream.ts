import type { Usage } from "./types.ts"

/** No prompt/output storage: retain only a bounded partial SSE line and counts. */
export class UsageParser {
  private buffer = ""
  terminal = false
  usage: Usage = { inputTokens: null, outputTokens: null, status: "completed" }
  push(text: string) {
    this.buffer += text
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop()!.slice(-262144)
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      if (line.slice(5).trim() === "[DONE]") { this.terminal = true; continue }
      try { this.observe(JSON.parse(line.slice(5))) } catch { /* empty or partial */ }
    }
  }
  observe(data: any) {
    if (["response.completed", "response.failed", "response.incomplete", "message_stop"].includes(data.type)) this.terminal = true
    if (data.error || data.type === "response.failed") this.usage.status = "failed"
    const u = data.usage ?? data.response?.usage ?? data.message?.usage ?? null
    if (!u) return
    const n = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
    this.usage.inputTokens = n(u.input_tokens ?? u.prompt_tokens) ?? this.usage.inputTokens
    this.usage.outputTokens = n(u.output_tokens ?? u.completion_tokens) ?? this.usage.outputTokens
    this.usage.reasoningTokens = n(u.output_tokens_details?.reasoning_tokens ?? u.completion_tokens_details?.reasoning_tokens) ?? this.usage.reasoningTokens
    this.usage.cacheReadTokens = n(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens) ?? this.usage.cacheReadTokens
  }
}
export function measuredStream(body: ReadableStream<Uint8Array>, done: (usage: Usage) => void, started: number): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new UsageParser()
  let ended = false
  const finish = (status: Usage["status"]) => { if (!ended) { ended = true; done({ ...parser.usage, status: parser.usage.status === "failed" ? "failed" : status, durationMs: performance.now() - started }) } }
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { parser.push(decoder.decode() + "\n"); finish("completed"); controller.close(); return }
        parser.push(decoder.decode(next.value, { stream: true }))
        controller.enqueue(next.value)
      } catch (error) { finish("uncertain"); controller.error(error) }
    },
    async cancel(reason) { finish(parser.terminal ? "completed" : "uncertain"); await reader.cancel(reason) },
  })
}
