import { createHmac, timingSafeEqual } from "node:crypto"

function oauthAccount(access: string): string {
  let claims: any
  try { claims = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8")) } catch { throw new Error("Cannot identify Codex OAuth account") }
  const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id
  if (typeof id !== "string" || !id) throw new Error("Codex OAuth account claim is unavailable")
  return id
}
const digest = (provider: string, identity: string, secret: string) => createHmac("sha256", secret).update(provider + ":" + identity).digest("hex")
export function credentialFingerprint(provider: string, value: { type: string; access?: string; key?: string; metadata?: Record<string, unknown> }, secret: string): string | undefined {
  if (provider === "openai") {
    if (value.type !== "oauth" || !value.access) throw new Error("Codex routing requires identified OAuth, never API-key billing")
    return digest(provider, oauthAccount(value.access), secret)
  }
  if (provider === "opencode-go") {
    if (value.type === "oauth" && typeof value.metadata?.orgID === "string") return digest(provider, "workspace:" + value.metadata.orgID, secret)
    if (value.type !== "key" || !value.key) throw new Error("Go routing requires its bound inference credential")
    return digest(provider, value.key, secret)
  }
  return undefined
}
export function goAuthorizationFingerprint(access: string, secret: string) { return digest("opencode-go", "authorization:" + access, secret) }
export function verifyNativeCredential(provider: string, headers: Headers, expected: string | undefined, secret: string, consoleBinding?: { fingerprints: string[]; workspaceID?: string }) {
  if (!expected) throw new Error("Native credential identity is not bound; approve the existing credential mapping first")
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1]
  if (!bearer) throw new Error("Native provider authorization is missing")
  if (provider === "opencode-go" && consoleBinding?.fingerprints.length) {
    const actual = goAuthorizationFingerprint(bearer, secret)
    if (!consoleBinding.workspaceID || digest(provider, "workspace:" + consoleBinding.workspaceID, secret) !== expected || !consoleBinding.fingerprints.includes(actual)) throw new Error("Go Console credential does not match the reserved workspace")
    if (headers.has("x-org-id") && headers.get("x-org-id") !== consoleBinding.workspaceID) throw new Error("Go Console workspace header does not match its reservation")
    return
  }
  const account = provider === "openai" ? oauthAccount(bearer) : bearer
  if (provider === "openai" && headers.has("chatgpt-account-id") && headers.get("chatgpt-account-id") !== account) throw new Error("Codex account header does not match its OAuth identity")
  const actual = digest(provider, account, secret)
  const a = Buffer.from(actual), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Native credential does not match the reserved quota account")
}
