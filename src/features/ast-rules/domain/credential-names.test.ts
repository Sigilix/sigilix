// credential-names — direct unit coverage for the shared `isCredentialName`
// matcher. It is the FP-safety gate for TWO security floors
// (no-insecure-random-token / CWE-338 and no-hardcoded-secret-fallback /
// CWE-798), so a silent regression here affects both rules — this file pins the
// boundary conditions documented in the source rather than only exercising them
// indirectly through the rule tests.

import { describe, it, expect } from "vitest"
import { isCredentialName } from "@/src/features/ast-rules/domain/credential-names"

describe("isCredentialName — credential-shaped names match", () => {
  const positives = [
    // strong suffixes, across camel / snake / SCREAMING normalization
    "apiKey",
    "api_key",
    "API_KEY",
    "clientSecret",
    "WEBHOOK_SECRET",
    "JWT_SECRET",
    "privateKey",
    "accessKey",
    "password",
    "passwd",
    "pwd",
    "csrf",
    "csrfNonce",
    "otp",
    "nonce",
    "verificationCode",
    "sessionId",
    "session_id",
    // token (ambiguous) — secret unless a non-secret prefix
    "token",
    "authToken",
    "resetToken",
    // salt (ambiguous) — bare word + the crypto sense
    "salt",
    "passwordSalt",
    "bcryptSalt",
  ]
  for (const name of positives) {
    it(`matches ${name}`, () => expect(isCredentialName(name)).toBe(true))
  }
})

describe("isCredentialName — non-secret names do NOT match", () => {
  const negatives = [
    // empties / nullish
    "",
    null,
    undefined,
    // generic identifiers
    "key",
    "id",
    "index",
    "name",
    "value",
    "count",
    // non-secret token cursors/streams (the NON_SECRET_TOKEN_PREFIX set)
    "nextToken",
    "cancelToken",
    "cancellationToken",
    "pageToken",
    "paginationToken",
    "continuationToken",
    "streamToken",
    "parseToken",
    // words that merely END in "salt" but aren't crypto salts
    "seaSalt",
    "basalt",
    "rockSalt",
  ]
  for (const name of negatives) {
    it(`does not match ${JSON.stringify(name)}`, () =>
      expect(isCredentialName(name as string | null | undefined)).toBe(false))
  }
})

describe("isCredentialName — normalization boundary", () => {
  it("strips non-alphanumerics before matching (`API-KEY!` → apikey)", () => {
    expect(isCredentialName("API-KEY!")).toBe(true)
  })
  it("is case-insensitive (`ResetToken`)", () => {
    expect(isCredentialName("ResetToken")).toBe(true)
  })
})
