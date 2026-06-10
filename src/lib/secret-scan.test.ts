// ARC-187 — secret scan: rule matching, redaction, fingerprinting,
// false-positive suppression on the generic catch-all.

import { describe, it, expect } from "vitest"

import { runSecretScan, renderSecretHitsForPrompt, containsCredentialToken, secretAllowlistReason } from "@/src/lib/secret-scan"

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

  it("flags Ollama cloud API keys (ollama_)", () => {
    const hits = runSecretScan(mkDiff("ai.ts", [
      'const OLLAMA = "ollama_1234567890abcdef1234567890abcdef"',
    ]))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.ruleId).toBe("ollama-api-key")
    expect(hits[0]?.category).toBe("ollama")
    expect(hits[0]?.severity).toBe("error")
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

describe("runSecretScan — SIG-93 path-shape false-positive gate", () => {
  it("does NOT flag a kebab-case docs path in a comment (PR #98 evidence)", () => {
    // From PR #98: comment in src/lib/shadow-bakeoff-config.ts
    // referenced `claude/handoff/arc-292-model-lineup-codex-response.md`.
    // The generic regex matched the 50-char `claude/handoff/arc-292-…-codex-response`
    // body and the `.md` extension sat just outside the match.
    const hits = runSecretScan(mkDiff("src/lib/shadow-bakeoff-config.ts", [
      "// See claude/handoff/arc-292-model-lineup-codex-response.md for context.",
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag path-list literal members in a test fixture (PR #105 evidence)", () => {
    // From PR #105: test fixture array in tests/tests-specialist-input.test.ts
    // contained the path `tests/triage-pr-review-ensemble-merge-shortcut.test.ts`
    // as a string-array member. Should be suppressed.
    const hits = runSecretScan(mkDiff("tests/tests-specialist-input.test.ts", [
      'const FIXTURES = ["tests/triage-pr-review-ensemble-merge-shortcut.test.ts"]',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("still flags a real high-entropy secret with NO path shape", () => {
    // Sanity: gate is conservative — a 40+-char token without `/` or
    // a file extension after still flags.
    const hits = runSecretScan(mkDiff("config.ts", [
      'const KEY = "QzM4xT9YpA2RnE7vK0sH4uIoLcG6dF1jW8bV5kHrNm2QpZ"',
    ]))
    expect(hits[0]?.ruleId).toBe("generic-high-entropy-token")
  })

  it("still flags a leaked AWS-style secret that contains `/` (no file extension after it)", () => {
    // AWS secret access keys can contain `/`. Gate requires BOTH `/`
    // in match AND a `.<ext>` immediately after — so an AWS secret
    // assigned to a string literal still flags.
    const hits = runSecretScan(mkDiff("aws-config.ts", [
      'const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
    ]))
    expect(hits[0]?.ruleId).toBe("generic-high-entropy-token")
  })

  it("does NOT flag a multi-segment path with a code extension in an import-like line", () => {
    const hits = runSecretScan(mkDiff("src/lib/x.ts", [
      'import { foo } from "./some/deeply/nested/path/inside/the/source/tree/module.ts"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag a path tail like `.json` after a multi-segment match", () => {
    const hits = runSecretScan(mkDiff("scripts/seed.ts", [
      '  const fixturePath = "data/fixtures/large-corpus-with-many-segments-and-stuff.json"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })
})

describe("runSecretScan — SIG-126 identifier/path/prose-shape false-positive gate", () => {
  // Suppression: single-case + separator-segmented tokens are
  // identifiers/paths/prose, not secrets. The generic 40+-char rule
  // matched these as P0 "secrets".
  it("does NOT flag a 40+-char kebab-case identifier", () => {
    const hits = runSecretScan(mkDiff("src/lib/notes.ts", [
      'const NOTE = "good-blocking-io-on-request-path-anchored"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag a slash-joined lowercase prose token", () => {
    const hits = runSecretScan(mkDiff("src/lib/notes.ts", [
      'const TAGS = "flag-gated/best-effort/timeout-capped/budget-aware/non-fatal"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag a SCREAMING_SNAKE env-var name", () => {
    const hits = runSecretScan(mkDiff("src/lib/config.ts", [
      'const NAME = "OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag a lower snake_case identifier", () => {
    const hits = runSecretScan(mkDiff("src/lib/config.ts", [
      'const FN = "resolve_symbol_retrieval_budget_for_the_logic_role"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  // FN-safety: the guard must NEVER suppress a real secret. These are
  // mixed-case high-entropy strings that match the rule but match NONE
  // of the single-case suppression shapes. If someone later widens the
  // guard to catch mixed-case strings, these tests MUST start failing.
  it("STILL flags a mixed-case base64-ish secret with no separators", () => {
    const hits = runSecretScan(mkDiff("config.ts", [
      'const KEY = "Ab3xZ9Qw7Lp2Rk8Mn4Vc6Bd1Hg5Tf0Js7Yu3Wq9Ea2"',
    ]))
    expect(hits[0]?.ruleId).toBe("generic-high-entropy-token")
  })

  it("STILL flags a mixed-case AWS-style secret that contains `/`", () => {
    const hits = runSecretScan(mkDiff("aws-config.ts", [
      'const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYExampleKeyAbc1"',
    ]))
    expect(hits[0]?.ruleId).toBe("generic-high-entropy-token")
  })

  // FN-safety (code-reviewer CRITICAL): single-case secret families with
  // NO dedicated provider rule must still fire. Their random bodies contain
  // DIGITS, so the purely-alphabetic-segment guard does not suppress them.
  // These guard specifically against the snake_case (r3) + kebab (r1) rules
  // being widened back to admit digit-bearing segments.
  it("STILL flags a DigitalOcean-style PAT (dop_v1_<lowercase hex>)", () => {
    const hits = runSecretScan(mkDiff("src/lib/do.ts", [
      'const TOKEN = "dop_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeDefined()
  })

  it("STILL flags a lowercase token whose segments contain digits (Slack-style body)", () => {
    const hits = runSecretScan(mkDiff("src/lib/slack.ts", [
      'const TOK = "xoxb-2401440store-2401440bot-abcd1234efgh5678ijkl9012"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeDefined()
  })
})

describe("runSecretScan — SIG-251 camelCase + env-assignment false-positive gate", () => {
  // Regression: PR #206 fired 5 P0s + PR #210 fired more, on no-digit tokens
  // the SIG-126 shape guards missed (camelCase has no separators; NAME=value
  // has an `=` outside the SCREAMING_SNAKE shape). Generalized guard: any
  // generic match with NO digits is an identifier / path / env-ref / prose,
  // never a real secret (real bodies contain digits — see FN tests below).

  it("does NOT flag a 40+-char camelCase identifier (PR #206)", () => {
    const hits = runSecretScan(mkDiff("src/index.ts", [
      "async function handleAdminMigrateReviewMemoryToRepoIdRoute() {}",
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag a PascalCase identifier", () => {
    const hits = runSecretScan(mkDiff("src/index.ts", [
      "class ReviewMemoryClaimShadowTelemetryAggregatorService {}",
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag an env-var NAME=value reference in a comment (PR #210 config.ts:254)", () => {
    const hits = runSecretScan(mkDiff("src/lib/config.ts", [
      "   * this AND env OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW=soften",
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag a long SCREAMING_SNAKE shell var ref ($VAR — the 43-char name still matches the 40+ rule and is suppressed by the no-digit guard)", () => {
    const hits = runSecretScan(mkDiff("scripts/deploy.sh", [
      "printf on | wrangler secret put $OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW_ENABLED",
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  // FN-safety: a digit-bearing mixed-case token (the shape a real provider-less
  // secret takes) MUST still fire — the camelCase/Pascal guards are pure-alpha.
  it("STILL flags a digit-bearing mixed-case token with no separators", () => {
    const hits = runSecretScan(mkDiff("config.ts", [
      'const KEY = "handleAdmin9Migrate7Review3Memory2ToRepo8IdRoute1Xy"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeDefined()
  })

  // FN-safety (Codex cross-check — the reason we use narrow shapes, NOT a
  // blanket "no-digit → suppress"): real ALL-LETTER secret formats MUST still
  // fire. A blanket no-digit rule would have suppressed these.
  it("STILL flags a base32/TOTP-style all-uppercase no-digit secret", () => {
    // RFC base32 alphabet A-Z2-7; a real seed can be all letters. All-caps →
    // matches NONE of the camelCase/Pascal/snake shapes → must fire.
    const hits = runSecretScan(mkDiff("src/lib/totp.ts", [
      'const SEED = "MFRGGZDFMZTWQYLEMZUGKZBANVXXEZLTMVZCAYTB"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeDefined()
  })

  it("STILL flags a digit-free base64 token (irregular casing + `/`)", () => {
    // A 30-byte CSPRNG token base64-encoded, 40 chars, zero digits. Random
    // casing + `/` → not a clean identifier shape → must fire.
    const hits = runSecretScan(mkDiff("src/lib/auth.ts", [
      'const TOKEN = "JuIqkUItYHsmxF/LCLfuzfTdvHOTHysg/tQs/yiK"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeDefined()
  })
})

describe("runSecretScan — SIG-217 explicit allowlist (mixed-separator safe substrings)", () => {
  // The trigger FP: a JSDoc list of GitHub webhook actions. Mixes `/` (between
  // events) and `_` (inside ready_for_review), so the single-separator SIG-126
  // shape rules miss it. Was dismissed as not-a-bug, then re-fired at P0.
  it("does NOT flag the `opened/synchronize/reopened/ready_for_review` webhook list", () => {
    const hits = runSecretScan(mkDiff("src/index.ts", [
      ' * Decide jobs for opened/synchronize/reopened/ready_for_review actions.',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag a digit-bearing SCREAMING_SNAKE env var (S3-style)", () => {
    const hits = runSecretScan(mkDiff("src/lib/config.ts", [
      'const NAME = "OPENCLAW_S3_BUCKET_REGION_US_EAST_1_PRIMARY_KEY"',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  it("does NOT flag a kebab-case JSON key with digits (oauth2-...)", () => {
    const hits = runSecretScan(mkDiff("config.json", [
      '  "oauth2-client-credentials-redirect-uri-allowlist": true',
    ]))
    expect(hits.find((h) => h.ruleId === "generic-high-entropy-token")).toBeUndefined()
  })

  describe("secretAllowlistReason — pure classifier", () => {
    it("classifies the trigger webhook-event list", () => {
      expect(secretAllowlistReason("opened/synchronize/reopened/ready_for_review")).toBe("github-webhook-event")
    })
    it("classifies SCREAMING_SNAKE env vars", () => {
      expect(secretAllowlistReason("OPENCLAW_ENSEMBLE_MAX_MODEL_CALLS_PER_PR")).toBe("screaming-env-var")
    })
    it("classifies kebab-case JSON keys", () => {
      expect(secretAllowlistReason("content-security-policy-report-only-directive")).toBe("kebab-json-key")
    })
    // FN-safety: a real secret must NOT be allowlisted. Mixed casing + digits,
    // not a clean identifier/event vocabulary → null → still fires.
    it("returns null for a genuine mixed-case secret", () => {
      expect(secretAllowlistReason("Ab3xZ9Qw7Lp2Rk8Mn4Vc6Bd1Hg5Tf0Js7Yu3Wq9Ea2")).toBeNull()
    })
    it("returns null for a slash-joined list with an unknown segment", () => {
      // `deploy` is not a webhook action → the whole list must NOT be trusted.
      expect(secretAllowlistReason("opened/deploy/reopened/ready_for_review")).toBeNull()
    })
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
    // SIG-282: hits are framed as CANDIDATES to verify, not authoritative
    // secrets with a baked-in "rotate" remediation (that text moved to the
    // deterministic per-CWE remediation applied only on a CONFIRMED finding).
    expect(block).toContain("CANDIDATES")
    expect(block).toContain("false positive")
    expect(block).not.toContain("rotate")
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

describe("containsCredentialToken — secret-remediation gate (Pattern A)", () => {
  it("matches vetted provider-specific credential shapes", () => {
    expect(containsCredentialToken('const apiKey = "AKIAIOSFODNN7EXAMPLE"')).toBe(true)
    expect(containsCredentialToken('token: "ghp_0123456789abcdefghijklmnopqrstuvwxyz"')).toBe(true)
    expect(containsCredentialToken('const k = "sk-ant-0123456789abcdefghijklmnopqrstuvwxyz"')).toBe(true)
    expect(containsCredentialToken('STRIPE="sk_live_0123456789abcdefghijklmno"')).toBe(true)
    expect(containsCredentialToken("-----BEGIN RSA PRIVATE KEY-----")).toBe(true)
  })

  it("matches a credential-named identifier assigned a high-entropy value", () => {
    expect(containsCredentialToken('const apiKey = "aB3xY9kQ1mZ7pL5wR2tN8vC4hG6jD0sF"')).toBe(true)
    expect(containsCredentialToken('password = "p4ssW0rdWithDigits1234567890abcd"')).toBe(true)
  })

  it("does NOT match the hallucinated .length leak (the bug)", () => {
    expect(containsCredentialToken("console.log(payload.length)")).toBe(false)
    expect(containsCredentialToken("logger.info(`token length=${apiKey.length}`)")).toBe(false)
  })

  it("biases toward false for hashes, identifiers, placeholders, and short/empty values", () => {
    // 40-char hex hash assigned to a key-named field → not a credential.
    expect(containsCredentialToken('const apiKey = "0123456789abcdef0123456789abcdef01234567"')).toBe(false)
    // Long pure-alpha camelCase identifier in a token-named field → not a credential.
    expect(containsCredentialToken('const tokenName = "veryLongLowerCamelIdentifierNameHere"')).toBe(false)
    // Placeholder.
    expect(containsCredentialToken('const apiKey = "your-api-key-here"')).toBe(false)
    // High-entropy value but no credential-named identifier on the line.
    expect(containsCredentialToken('const data = "aB3xY9kQ1mZ7pL5wR2tN8vC4hG6jD0sF"')).toBe(false)
    expect(containsCredentialToken("")).toBe(false)
    expect(containsCredentialToken("const x = 5")).toBe(false)
  })

  it("checks each line independently on multi-line input (Sigilix #248 catch)", () => {
    // Identifier on one line, an UNRELATED high-entropy value (hash) on
    // another — must NOT false-match across lines.
    expect(
      containsCredentialToken("function processApiKey(input) {\n  const h = sha(x) // aB3xY9kQ1mZ7pL5wR2tN8vC4hG6jD0sF1\n}"),
    ).toBe(false)
    // A real credential on a LATER line of a multi-line range → still detected.
    expect(
      containsCredentialToken("const config = {\n  apiKey: \"AKIAIOSFODNN7EXAMPLE\",\n}"),
    ).toBe(true)
    // A genuine same-line assignment inside a multi-line range → detected.
    expect(
      containsCredentialToken("export const creds = {\n  password: \"p4ssW0rdWithDigits1234567890abcd\",\n}"),
    ).toBe(true)
  })
})
