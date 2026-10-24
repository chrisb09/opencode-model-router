import { describe, expect, test } from "bun:test"
import { gzipSync, deflateSync } from "node:zlib"
import { decodeBody } from "../src/encoding.ts"
const text = JSON.stringify({ model: "gpt-6.1-sol", input: "test" })
describe("native request content encoding", () => {
  for (const [encoding, encode] of [["identity", (s: string) => Buffer.from(s)], ["gzip", gzipSync], ["deflate", deflateSync], ["zstd", Bun.zstdCompressSync]] as const) {
    test(`decodes ${encoding}`, async () => {
      const r = new Request("http://127.0.0.1/proxy", { method: "POST", headers: { "content-encoding": encoding }, body: new Uint8Array(encode(text)).buffer })
      expect(await decodeBody(r)).toBe(text)
    })
  }
  test("compressed input is bounded after decompression", async () => {
    const r = new Request("http://127.0.0.1/proxy", { method: "POST", headers: { "content-encoding": "zstd" }, body: new Uint8Array(Bun.zstdCompressSync("x".repeat(1000))).buffer })
    await expect(decodeBody(r, 100)).rejects.toThrow()
  })
  test("unsupported encodings fail closed", async () => {
    const r = new Request("http://127.0.0.1/proxy", { method: "POST", headers: { "content-encoding": "made-up" }, body: text })
    await expect(decodeBody(r)).rejects.toThrow("Unsupported")
  })
})
