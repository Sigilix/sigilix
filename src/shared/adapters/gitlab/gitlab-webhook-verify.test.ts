// GitLab webhook verification — GitLab sends the shared secret VERBATIM in the
// plaintext `X-Gitlab-Token` header (no HMAC). The check is a constant-time
// string equality between the header value and the configured secret.

import { describe, expect, it } from "vitest"
import { verifyGitLabWebhook } from "@/src/shared/adapters/gitlab/gitlab-webhook-verify"

const SECRET = "gitlab-test-secret"

describe("verifyGitLabWebhook", () => {
  it("accepts a matching token", () => {
    expect(verifyGitLabWebhook(SECRET, SECRET)).toBe(true)
  })

  it("rejects a tampered token", () => {
    expect(verifyGitLabWebhook(`${SECRET}x`, SECRET)).toBe(false)
    expect(verifyGitLabWebhook("gitlab-test-secreT", SECRET)).toBe(false)
  })

  it("rejects a token of a different length (constant-time length guard)", () => {
    expect(verifyGitLabWebhook("short", SECRET)).toBe(false)
  })

  it("rejects empty inputs (fail closed)", () => {
    expect(verifyGitLabWebhook("", SECRET)).toBe(false)
    expect(verifyGitLabWebhook(SECRET, "")).toBe(false)
    expect(verifyGitLabWebhook("", "")).toBe(false)
  })
})
