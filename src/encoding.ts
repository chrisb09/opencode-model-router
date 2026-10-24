import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib"

/** Native Codex uses zstd. Bound decompression before parsing or forwarding. */
export async function decodeBody(request: Request, maxBytes = 8_000_000): Promise<string> {
  const wire = Buffer.from(await request.arrayBuffer())
  if (wire.byteLength > maxBytes) throw new Error("Context body too large")
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase() ?? "identity"
  const options = { maxOutputLength: maxBytes }
  const plain = encoding === "identity" ? wire : encoding === "gzip" ? gunzipSync(wire, options)
    : encoding === "deflate" ? inflateSync(wire, options) : encoding === "zstd" ? zstdDecompressSync(wire, options)
    : null
  if (!plain) throw new Error("Unsupported native request content encoding")
  if (plain.byteLength > maxBytes) throw new Error("Decompressed context body too large")
  return plain.toString("utf8")
}
