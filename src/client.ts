import { readFile } from "node:fs/promises"
import { settings, paths, assertLocalUrl, type Settings } from "./config.ts"

export class RouterClient {
  constructor(readonly config: Settings, readonly token: string, readonly fetcher: typeof fetch = fetch) { assertLocalUrl(config.url) }
  async call<T = any>(path: string, input?: unknown, timeoutMs = 45_000): Promise<T> {
    const response = await this.fetcher(this.config.url + path, { method: input === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-router-token": this.token }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(timeoutMs) })
    const result = await response.json() as any
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Router unavailable")
    return result as T
  }
}
export async function connect(file?: string) { return new RouterClient(await settings(file), (await readFile(paths().token, "utf8")).trim()) }
