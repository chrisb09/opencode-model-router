import { describe, expect, test } from "bun:test"
import { credentialFingerprint, goAuthorizationFingerprint, verifyNativeCredential } from "../src/identity.ts"
import { jwt } from "./fixtures.ts"
describe("native quota-account credential identity", () => {
  test("OAuth token rotation preserves the account identity", () => {
    const first = credentialFingerprint("openai", { type: "oauth", access: jwt("account-a") }, "secret")
    const rotated = jwt("account-a").replace("test-signature", "different-signature")
    expect(credentialFingerprint("openai", { type: "oauth", access: rotated }, "secret")).toBe(first)
    expect(() => verifyNativeCredential("openai", new Headers({ authorization: "Bearer " + rotated }), first, "secret")).not.toThrow()
  })
  test("different Codex accounts are not interchangeable", () => {
    const fp = credentialFingerprint("openai", { type: "oauth", access: jwt("account-a") }, "secret")
    expect(() => verifyNativeCredential("openai", new Headers({ authorization: "Bearer " + jwt("account-b") }), fp, "secret")).toThrow("does not match")
  })
  test("API-key billing cannot impersonate Codex allowance", () => expect(() => credentialFingerprint("openai", { type: "key", key: "api-key" }, "secret")).toThrow("never API-key"))
  test("Go keys are bound without storing or exposing the key", () => {
    const fp = credentialFingerprint("opencode-go", { type: "key", key: "go-secret" }, "secret")
    expect(fp).not.toContain("go-secret")
    expect(() => verifyNativeCredential("opencode-go", new Headers({ authorization: "Bearer go-secret" }), fp, "secret")).not.toThrow()
    expect(() => verifyNativeCredential("opencode-go", new Headers({ authorization: "Bearer other-key" }), fp, "secret")).toThrow()
  })
  test("missing identity metadata is not treated as any available account", () => {
    expect(() => verifyNativeCredential("openai", new Headers({ authorization: "Bearer " + jwt() }), undefined, "secret")).toThrow("not bound")
  })
  test("a mismatched Codex account header is refused", () => {
    const fp = credentialFingerprint("openai", { type: "oauth", access: jwt("account-a") }, "secret")
    expect(() => verifyNativeCredential("openai", new Headers({ authorization: "Bearer " + jwt("account-a"), "chatgpt-account-id": "account-b" }), fp, "secret")).toThrow("header")
  })
  test("Go Console OAuth is bound to its actual workspace, not a legacy Go key", () => {
    const value = { type: "oauth", access: "console-access", metadata: { orgID: "workspace-a" } }
    const fp = credentialFingerprint("opencode-go", value, "secret")
    const binding = { workspaceID: "workspace-a", fingerprints: [goAuthorizationFingerprint(value.access, "secret")] }
    expect(() => verifyNativeCredential("opencode-go", new Headers({ authorization: "Bearer console-access", "x-org-id": "workspace-a" }), fp, "secret", binding)).not.toThrow()
    expect(() => verifyNativeCredential("opencode-go", new Headers({ authorization: "Bearer legacy-go-key" }), fp, "secret", binding)).toThrow("workspace")
    expect(() => verifyNativeCredential("opencode-go", new Headers({ authorization: "Bearer console-access", "x-org-id": "workspace-b" }), fp, "secret", binding)).toThrow("header")
  })
  test("Console token rotation can retain a short verified overlap without changing workspace identity", () => {
    const fp = credentialFingerprint("opencode-go", { type: "oauth", access: "new-token", metadata: { orgID: "workspace-a" } }, "secret")
    const binding = { workspaceID: "workspace-a", fingerprints: [goAuthorizationFingerprint("new-token", "secret"), goAuthorizationFingerprint("old-token", "secret")] }
    expect(() => verifyNativeCredential("opencode-go", new Headers({ authorization: "Bearer old-token" }), fp, "secret", binding)).not.toThrow()
    expect(() => verifyNativeCredential("opencode-go", new Headers({ authorization: "Bearer other-token" }), fp, "secret", binding)).toThrow()
  })
})
