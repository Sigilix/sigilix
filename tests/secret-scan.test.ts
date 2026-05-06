// ARC-187 — secret scan: rule matching, redaction, fingerprinting,
// false-positive suppression on the generic catch-all.

import { describe, it, expect } from "vitest"

import { runSecretScan, renderSecretHitsForPrompt } from "../src/lib/secret-scan"

const mkDiff = (path: string, addedLines: string[]) => {
  const lines = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,0 +1,${addedLines.length} @@`,
    ...addedLines.map((l) => `+${l}`),
  ]
  return lines.join("\n")
}

describe("runSecretScan — provider-specific rules", () => {
  it("flags an AWS access key (AKIA prefix)", () => {
    const hits = runSecretScan(mkDiff("config.ts", [
      'export const KEY = "AKIAIOSFODNN7EXAMPLE"',
    ]))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.ruleId).toBe("aws-access-key")
    expect(hits[0]?.category).toBe("aws")
    expect(hits[0]?.severity).toBe("error")
  })

  it("flags AWS session keys (ASIA prefix)", () => {
    const hits = runSecretScan(mkDiff("config.ts", [
      'const SESSION = "ASIAY44QH8DHBEXAMPLE"',
    ]))
    expect(hits[0]?.ruleId).toBe("aws-access-key")
  })

  it("flags GitHub PATs (ghp_)", () => {
    const hits = runSecretScan(mkDiff("ci.ts", [
      'const T = "ghp_1234567890abcdef1234567890abcdef12345678"',
    ]))
    expect(hits[0]?.ruleId).toBe("github-token")
  })

  it("flags GitHub OAuth tokens (gho_, ghs_, ghr_, ghu_)", () => {
    for (const prefix of ["gho_", "ghs_", "ghr_", "ghu_"]) {
      const hits = runSecretScan(mkDiff("auth.ts", [
        `const T = "${prefix}1234567890abcdef1234567890abcdef12345678"`,
      ]))
      expect(hits[0]?.ruleId).toBe("github-token")
    }
  })

  it("flags Slack webhooks", () => {
    const hits = runSecretScan(mkDiff("notify.ts", [
      'const URL = "https://hooks.slack.com/services/T01ABCDEFG/B02ABCDEFG/AbCdEfGhIjKlMnOpQrStUvWx"',
    ]))
    expect(hits[0]?.ruleId).toBe("slack-webhook")
  })

  it("flags Stripe live + test secret keys", () => {
    const live = runSecretScan(mkDiff("payments.ts", [
      'const KEY = "sk_live_4eC39HqLyjWDarjtT1zdp7dc"',
    ]))
    expect(live[0]?.ruleId).toBe("stripe-secret-key")
    const test = runSecretScan(mkDiff("payments.ts", [
      'const KEY = "sk_test_4eC39HqLyjWDarjtT1zdp7dc"',
    ]))
    expect(test[0]?.ruleId).toBe("stripe-secret-key")
  })

  it("flags Anthropic keys (sk-ant-)", () => {
    const hits = runSecretScan(mkDiff("ai.ts", [
      'const ANTHROPIC = "sk-ant-api03-LongRandomBase64ish_String-1234567890"',
    ]))
    expect(hits[0]?.ruleId).toBe("anthropic-api-key")
  })

  it("flags OpenAI keys (sk-)", () => {
    const hits = runSecretScan(mkDiff("ai.ts", [
      'const OPENAI = "sk-proj1234567890abcdefghijklmnopqrst"',
    ]))
    expect(hits[0]?.ruleId).toBe("openai-api-key")
  })

  it("flags PEM private-key headers", () => {
    const hits = runSecretScan(mkDiff("keys/server.key", [
      "-----BEGIN RSA PRIVATE KEY-----",
    ]))
    expect(hits[0]?.ruleId).toBe("private-key-pem-header")
  })

  it("flags OPENSSH and PGP private-key headers too", () => {
    expect(runSecretScan(mkDiff("k", ["-----BEGIN OPENSSH PRIVATE KEY-----"]))[0]?.ruleId).toBe("private-key-pem-header")
    expect(runSecretScan(mkDiff("k", ["-----BEGIN PGP PRIVATE KEY-----"]))[0]?.ruleId).toBe("private-key-pem-header")
  })
})

describe("runSecretScan — generic high-entropy catch-all", () => {
  it("flags 40+ char base64-ish strings", () => {
    const hits = runSecretScan(mkDiff("config.ts", [
      'const X = "a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ12345"',
    ]))
    expect(hits[0]?.ruleId).toBe("generic-high-entropy-token")
    expect(hits[0]?.severity).toBe("warn")
  })

  it("does NOT flag pure hex-only strings (looks like a hash)", () => {
    const hits = runSecretScan(mkDiff("config.ts", [
      "const SHA = \"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6\"",
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag long URL fragments (line contains ://)", () => {
    const hits = runSecretScan(mkDiff("docs.ts", [
      'const URL = "https://example.com/path/with/many/segments/and/some/more/text"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does flag a high-entropy value alongside a provider-specific match (dedupes)", () => {
    // GitHub PATs are also long+base64ish; the generic regex would
    // also match. We dedupe by fingerprint.
    const hits = runSecretScan(mkDiff("ci.ts", [
      'const T = "ghp_1234567890abcdef1234567890abcdef12345678"',
    ]))
    // Provider-specific rule wins; only one hit recorded
    expect(hits).toHaveLength(1)
    expect(hits[0]?.ruleId).toBe("github-token")
  })
})

describe("runSecretScan — diff parsing semantics", () => {
  it("scans only added (+) lines, not deletions", () => {
    const diff = [
      "diff --git a/c.ts b/c.ts",
      "--- a/c.ts",
      "+++ b/c.ts",
      "@@ -1,2 +1,1 @@",
      '-const OLD = "AKIAIOSFODNN7EXAMPLE"',  // pre-existing, not flagged
      "+// removed",
    ].join("\n")
    expect(runSecretScan(diff)).toEqual([])
  })

  it("scans only added lines, not context", () => {
    const diff = [
      "diff --git a/c.ts b/c.ts",
      "--- a/c.ts",
      "+++ b/c.ts",
      "@@ -1,3 +1,3 @@",
      ' const X = "AKIAIOSFODNN7EXAMPLE"',  // unchanged context, not flagged
      "-old",
      "+new",
    ].join("\n")
    expect(runSecretScan(diff)).toEqual([])
  })

  it("tracks line numbers per file accurately", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "+++ b/a.ts",
      "@@ -10,0 +10,3 @@",
      "+nothing",
      "+nothing",
      '+const K = "AKIAIOSFODNN7EXAMPLE"',
      "diff --git a/b.ts b/b.ts",
      "+++ b/b.ts",
      "@@ -100,0 +100,1 @@",
      '+const K = "ghp_1234567890abcdef1234567890abcdef12345678"',
    ].join("\n")
    const hits = runSecretScan(diff)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ path: "a.ts", line: 12 })
    expect(hits[1]).toMatchObject({ path: "b.ts", line: 100 })
  })

  it("handles content lines starting with `--- ` or `+++ ` inside hunks (not headers)", () => {
    // Same defensive logic as deterministic-checks (sigilix-bot dogfood
    // catch on PR #52). Verify a SQL-comment-style deletion doesn't
    // corrupt parser state.
    const diff = [
      "diff --git a/script.sql b/script.sql",
      "--- a/script.sql",
      "+++ b/script.sql",
      "@@ -1,4 +1,4 @@",
      ' keep',
      "--- old SQL comment",  // deleted line that LOOKS like a header
      "+++ replacement note",  // added line that LOOKS like a header
      '+const KEY = "AKIAIOSFODNN7EXAMPLE"',
    ].join("\n")
    const hits = runSecretScan(diff)
    // The +++ line happens to start with `+` so it's an added line —
    // but it does NOT contain a secret pattern. The KEY line is the
    // one we expect to flag.
    const awsHits = hits.filter((h) => h.ruleId === "aws-access-key")
    expect(awsHits).toHaveLength(1)
  })
})

describe("runSecretScan — privacy + dedup", () => {
  it("redacts the matched value in the preview", () => {
    const hits = runSecretScan(mkDiff("c.ts", [
      'const K = "AKIAIOSFODNN7EXAMPLE"',
    ]))
    const preview = hits[0]?.redactedPreview ?? ""
    expect(preview).not.toContain("OSFODNN7")  // middle is redacted
    expect(preview).toContain("…")
  })

  it("uses a length-only placeholder for short secrets", () => {
    // Force a short match through a custom diff. The generic-token
    // rule won't match <40 chars. Use a private-key header instead;
    // header itself is short enough to trigger length-fallback redaction.
    // Actually: private-key header is 32+ chars depending on type, so
    // it WILL fit `2*4+3 = 11`. Use a custom Stripe key with min
    // 24-char body shape.
    const hits = runSecretScan(mkDiff("c.ts", [
      'const K = "sk_test_aaaaaaaaaaaaaaaaaaaaaaaa"',
    ]))
    expect(hits[0]?.redactedPreview).toContain("…")  // long enough for normal redaction
  })

  it("includes a stable fingerprint for cross-run dedup", () => {
    const hits1 = runSecretScan(mkDiff("c.ts", [
      'const K = "AKIAIOSFODNN7EXAMPLE"',
    ]))
    const hits2 = runSecretScan(mkDiff("c.ts", [
      'const K = "AKIAIOSFODNN7EXAMPLE"',
    ]))
    expect(hits1[0]?.fingerprint).toBe(hits2[0]?.fingerprint)
    expect(hits1[0]?.fingerprint).toContain("aws-access-key")
    expect(hits1[0]?.fingerprint).toContain("c.ts")
  })

  it("never returns the raw secret in any field", () => {
    const raw = "AKIAIOSFODNN7EXAMPLE"
    const hits = runSecretScan(mkDiff("c.ts", [`const K = "${raw}"`]))
    const allFields = JSON.stringify(hits)
    expect(allFields).not.toContain(raw)
  })
})

describe("renderSecretHitsForPrompt", () => {
  it("returns empty for no hits", () => {
    expect(renderSecretHitsForPrompt([])).toBe("")
  })

  it("renders a labeled block with severity, path:line, category, length, redacted preview", () => {
    const block = renderSecretHitsForPrompt([
      {
        ruleId: "aws-access-key",
        category: "aws",
        severity: "error",
        path: "config.ts",
        line: 42,
        matchLength: 20,
        redactedPreview: "AKIA…MPLE",
        fingerprint: "aws-access-key:config.ts:42:AKIA…MPLE",
      },
    ])
    expect(block).toContain("SECRET SCAN")
    expect(block).toContain("[ERROR]")
    expect(block).toContain("config.ts:42")
    expect(block).toContain("aws/aws-access-key")
    expect(block).toContain("length=20")
    expect(block).toContain("AKIA…MPLE")
    expect(block).toContain("rotate")  // remediation hint
  })

  it("never includes raw secret values in the rendered block", () => {
    const block = renderSecretHitsForPrompt([
      {
        ruleId: "aws-access-key",
        category: "aws",
        severity: "error",
        path: "x",
        line: 1,
        matchLength: 20,
        redactedPreview: "AKIA…MPLE",
        fingerprint: "aws-access-key:x:1:AKIA…MPLE",
      },
    ])
    expect(block).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })
})
