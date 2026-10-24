/** Normalize one supported wire output limit; reject conflicting protocol fields. */
export function capOutput(body: Record<string, any>, responses: boolean, cap: number): number {
  const keys = ["max_output_tokens", "max_tokens", "max_completion_tokens"]
  const present = keys.filter(k => body[k] !== undefined)
  if (present.length > 1) throw new Error("Conflicting native output-limit fields")
  const field = responses ? "max_output_tokens" : present[0] ?? "max_tokens"
  if (responses && present.some(k => k !== field) || !responses && field === "max_output_tokens") throw new Error("Output limit does not match the native protocol")
  const previous = body[field]
  if (previous !== undefined && (!Number.isSafeInteger(previous) || previous < 1)) throw new Error("Invalid native output limit")
  body[field] = Math.min(previous ?? cap, cap)
  return body[field]
}
