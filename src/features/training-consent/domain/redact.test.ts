// sig-training-data-consent — pre-store redaction seam.
import { describe, expect, it } from "vitest"
import { redactText, redactTrainingRecord } from "@/src/features/training-consent/domain/redact"
import type { TrainingRecord } from "@/src/features/training-consent/domain/types"

describe("redactText", () => {
  it("masks email addresses", () => {
    const out = redactText("contact alice@example.com for access")
    expect(out).not.toContain("alice@example.com")
    expect(out).toContain("[REDACTED]")
  })

  it("masks provider token prefixes", () => {
    for (const secret of ["sk-abcdefghijklmnop1234", "ghp_ABCDEFGHIJKLMNOP1234", "AKIAIOSFODNN7EXAMPLE"]) {
      const out = redactText(`token=${secret}`)
      expect(out).not.toContain(secret)
    }
  })

  it("masks bearer headers, JWTs and PEM private keys", () => {
    expect(redactText("Authorization: Bearer abcdef0123456789xyz")).toContain("[REDACTED]")
    expect(redactText("eyJhbGciOi.eyJzdWIiOi.SflKxwRJSMe")).not.toContain("eyJhbGciOi")
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----"
    expect(redactText(pem)).not.toContain("MIIabc")
  })

  it("leaves clean text unchanged", () => {
    expect(redactText("just a normal review comment about naming")).toBe("just a normal review comment about naming")
  })
})

describe("redactTrainingRecord", () => {
  it("redacts the payload AND every metadata value, returning a new object", () => {
    const record: TrainingRecord = {
      kind: "chat",
      id: "abc",
      payload: "email me at bob@corp.io",
      meta: { author: "carol@corp.io", repo: "acme/widgets" },
    }
    const out = redactTrainingRecord(record)
    expect(out.payload).not.toContain("bob@corp.io")
    expect(out.meta?.author).not.toContain("carol@corp.io")
    expect(out.meta?.repo).toBe("acme/widgets")
    // input untouched
    expect(record.payload).toContain("bob@corp.io")
  })

  it("redacts the id too (it lands in the R2 key/body/logs, so it must be masked)", () => {
    const record: TrainingRecord = {
      kind: "fix-diff",
      // a caller-controlled owner/repo could smuggle a secret into the id
      id: "sk-abcdefghijklmnop1234/repo:verify",
      payload: "clean",
    }
    const out = redactTrainingRecord(record)
    expect(out.id).not.toContain("sk-abcdefghijklmnop1234")
    expect(out.id).toContain("[REDACTED]")
    // input untouched
    expect(record.id).toContain("sk-abcdefghijklmnop1234")
  })
})
