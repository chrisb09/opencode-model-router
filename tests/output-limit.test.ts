import { describe, expect, test } from "bun:test"
import { capOutput } from "../src/output-limit.ts"
describe("wire output limits", () => {
  for (const field of ["max_tokens", "max_completion_tokens"]) test(`caps chat ${field}`, () => {
    const body = { [field]: 100000 }; expect(capOutput(body, false, 1000)).toBe(1000); expect(body[field]).toBe(1000)
  })
  test("caps Responses max_output_tokens", () => { const b = { max_output_tokens: 100000 }; expect(capOutput(b, true, 1000)).toBe(1000) })
  test("conflicting output limits never reach upstream", () => expect(() => capOutput({ max_tokens: 1000, max_completion_tokens: 100000 }, false, 1000)).toThrow("Conflicting"))
  test("Responses cannot carry an uncapped chat completion limit", () => expect(() => capOutput({ max_completion_tokens: 100000 }, true, 1000)).toThrow("protocol"))
  test("invalid output limits fail closed", () => {
    for (const v of [0, -1, Infinity, "1000"]) expect(() => capOutput({ max_tokens: v }, false, 1000)).toThrow("Invalid")
  })
})
