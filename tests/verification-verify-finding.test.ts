// SIG-285 PR 1 — worker-native line-anchored verification. Covers the four
// verdict states + the load-bearing line-anchoring guard (a token present
// elsewhere in the file must NOT confirm a finding anchored to a different line).

import { describe, expect, it } from "vitest"
import {
  deriveTokens,
  verifyFinding,
  findingKey,
} from "../src/lib/verification/verify-finding"
// Use the SAME parser the ensemble feeds into verifyFinding in prod, so the
// line-anchoring tests exercise the real index, not a duplicate.
import { buildAddedLineTextByLine } from "../src/lib/ast-rules/diff-filter"
import { readVerificationMode } from "../src/lib/verification/mode"
import type { Env } from "../src/index"

// New side: line 9 = context, line 10 = the injection, line 11 = a safe line.
const DIFF = `diff --git a/src/db.ts b/src/db.ts
--- a/src/db.ts
+++ b/src/db.ts
@@ -1,2 +9,3 @@
 const db = connect()
+const q = "SELECT * FROM users WHERE id=" + userId
+const safe = escape(input)
`

const index = buildAddedLineTextByLine(DIFF)
const f = (over: Partial<{ path: string; line: number; headline: string; body: string }>) => ({
  path: "src/db.ts", line: 10, headline: "", body: "", ...over,
})

describe("buildAddedLineTextByLine (the parser prod feeds verifyFinding)", () => {
  it("indexes only added lines with correct new-side line numbers", () => {
    const byLine = index.get("src/db.ts")!
    expect(byLine.get(9)).toBeUndefined() // context line, not added
    expect(byLine.get(10)).toContain("userId")
    expect(byLine.get(11)).toBe("const safe = escape(input)")
  })
})

describe("deriveTokens", () => {
  it("extracts backticked code tokens from headline + body", () => {
    expect(deriveTokens({ headline: "SQL injection via `userId`", body: "see `db.query`" })).toEqual(["userId", "db.query"])
  })
  it("drops prose-in-backticks and bare keywords (no phantom confirm token)", () => {
    expect(deriveTokens({ headline: "this is `really bad` and `if`", body: "" })).toEqual([])
  })
  it("drops ~1-char tokens (a 1-char includes() would confirm almost any line)", () => {
    expect(deriveTokens({ headline: "off-by-one at `i` and `x`", body: "" })).toEqual([])
    expect(deriveTokens({ headline: "loop var `id` is fine", body: "" })).toEqual(["id"])
  })
  it("returns [] when nothing is backticked", () => {
    expect(deriveTokens({ headline: "this looks risky", body: "no tokens here" })).toEqual([])
  })
})

describe("verifyFinding", () => {
  it("CONFIRMED: cited token is present at the cited line", () => {
    const r = verifyFinding(f({ line: 10, headline: "SQL injection via `userId`" }), index)
    expect(r.verdict).toBe("confirmed")
    expect(r.check?.status).toBe("pass")
    expect(r.check?.outputSnippet).toContain("userId")
  })

  it("REFUTED (line-anchored): token exists elsewhere (line 10) but the finding anchors to line 11 where it's absent", () => {
    const r = verifyFinding(f({ line: 11, headline: "SQL injection via `userId`" }), index)
    expect(r.verdict).toBe("refuted")
    expect(r.check?.status).toBe("fail")
    // proves anchoring: userId IS in the diff (line 10), just not at the cited line.
    expect(index.get("src/db.ts")!.get(10)).toContain("userId")
  })

  it("INCONCLUSIVE: the cited line is not an added line in this diff (fail-open)", () => {
    const r = verifyFinding(f({ line: 99, headline: "bug in `userId`" }), index)
    expect(r.verdict).toBe("inconclusive")
    expect(r.check?.status).toBe("skipped")
  })

  it("NO-CHECK: no checkable token could be derived", () => {
    const r = verifyFinding(f({ line: 10, headline: "this is generally risky" }), index)
    expect(r.verdict).toBe("no-check")
    expect(r.check).toBeUndefined()
  })

  it("INCONCLUSIVE on a path not in the diff", () => {
    expect(verifyFinding(f({ path: "other.ts", line: 10, headline: "x `userId`" }), index).verdict).toBe("inconclusive")
  })
})

describe("findingKey", () => {
  it("is stable + content-addressed (path:line:headline)", () => {
    const a = findingKey({ path: "src/db.ts", line: 10, headline: "SQL injection" })
    expect(a).toBe(findingKey({ path: "src/db.ts", line: 10, headline: "SQL injection" }))
    expect(a).not.toBe(findingKey({ path: "src/db.ts", line: 11, headline: "SQL injection" }))
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("readVerificationMode", () => {
  const mk = (v?: string) => ({ OPENCLAW_VERIFICATION_MODE: v } as unknown as Env)
  it("defaults to off (unset / unknown / blank)", () => {
    expect(readVerificationMode(mk(undefined))).toBe("off")
    expect(readVerificationMode(mk("nonsense"))).toBe("off")
    expect(readVerificationMode(mk("  "))).toBe("off")
  })
  it("parses shadow / enforce (case-insensitive, trimmed)", () => {
    expect(readVerificationMode(mk(" SHADOW "))).toBe("shadow")
    expect(readVerificationMode(mk("enforce"))).toBe("enforce")
  })
})
