// SIG-285 PR 1 — worker-native line-anchored verification. Covers the four
// verdict states + the load-bearing line-anchoring guard (a token present
// elsewhere in the file must NOT confirm a finding anchored to a different line).

import { describe, expect, it } from "vitest"
import {
  deriveTokens,
  verifyFinding,
  findingKey,
  selectRefutedInlineDemotions,
  applyRefutedDemotion,
  planReanchor,
  applyReanchors,
} from "@/src/lib/verification/verify-finding"
// Use the SAME parser the ensemble feeds into verifyFinding in prod, so the
// line-anchoring tests exercise the real index, not a duplicate.
import { buildAddedLineTextByLine } from "@/src/features/ast-rules/domain/diff-filter"
import { readVerificationMode, readReanchorEnabled } from "@/src/lib/verification/mode"
import type { Env } from "@/src/shared/types/env"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

type DemotableFinding = Pick<
  PrReviewFinding,
  "path" | "line" | "headline" | "body" | "score" | "category" | "startLine"
>

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
  path: "src/db.ts",
  line: 10,
  headline: "",
  body: "",
  ...over,
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
    expect(deriveTokens({ headline: "SQL injection via `userId`", body: "see `db.query`" })).toEqual([
      "userId",
      "db.query",
    ])
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

  it("token-boundary: cited token `id` must NOT substring-confirm inside `isValid` (CR)", () => {
    const d = buildAddedLineTextByLine(
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n+const isValid = check()\n+const id = 5\n",
    )
    // line 1 contains "id" only as a substring of `isValid` → REFUTED (a bare
    // includes() would have falsely CONFIRMED).
    expect(verifyFinding({ path: "x.ts", line: 1, headline: "bug in `id`", body: "" }, d).verdict).toBe("refuted")
    // line 2 has `id` as a whole token → CONFIRMED.
    expect(verifyFinding({ path: "x.ts", line: 2, headline: "bug in `id`", body: "" }, d).verdict).toBe("confirmed")
  })

  it("token-boundary: a symbolic/dotted token (`db.query`) still matches via substring", () => {
    const d = buildAddedLineTextByLine(
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n+const r = db.query(userId)\n",
    )
    expect(verifyFinding({ path: "x.ts", line: 1, headline: "injection via `db.query`", body: "" }, d).verdict).toBe(
      "confirmed",
    )
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

describe("selectRefutedInlineDemotions (SIG-285 PR 4 — the demote subset)", () => {
  // Reuse the DIFF index: line 10 holds `userId`, line 11 does not.
  const fd = (over: Partial<DemotableFinding>): DemotableFinding => ({
    path: "src/db.ts",
    line: 11,
    headline: "",
    body: "",
    score: 4,
    category: "logic",
    ...over,
  })

  it("selects ONLY score>=4 logic/security findings whose cited token is REFUTED", () => {
    const refutedLogic = fd({
      line: 11,
      headline: "stale guard `userId`",
      category: "logic",
      score: 4,
    }) // userId not on line 11 → refuted
    const refutedSec = fd({
      line: 11,
      headline: "leak via `userId`",
      category: "security",
      score: 5,
    }) // refuted, security
    const confirmed = fd({
      line: 10,
      headline: "SQLi via `userId`",
      category: "security",
      score: 5,
    }) // userId IS on line 10 → confirmed
    const lowScore = fd({ line: 11, headline: "nit `userId`", category: "logic", score: 3 }) // refuted but score<4
    const wrongCat = fd({ line: 11, headline: "slow `userId`", category: "performance", score: 4 }) // refuted but not logic/security
    const inconclusive = fd({
      line: 99,
      headline: "off-diff `userId`",
      category: "logic",
      score: 4,
    }) // line not added → inconclusive
    const noCheck = fd({
      line: 11,
      headline: "no backticked token here",
      category: "security",
      score: 4,
    }) // no token → no-check

    const out = selectRefutedInlineDemotions(
      [refutedLogic, refutedSec, confirmed, lowScore, wrongCat, inconclusive, noCheck],
      index,
    )
    // Only the two refuted score>=4 logic/security findings, identity preserved.
    expect(out).toEqual([refutedLogic, refutedSec])
    expect(out[0]).toBe(refutedLogic) // same object ref → the ensemble's Set move works
    expect(out[1]).toBe(refutedSec)
  })

  it("returns [] when nothing is refuted-eligible (empty, all-confirmed, all-ineligible)", () => {
    expect(selectRefutedInlineDemotions([], index)).toEqual([])
    expect(
      selectRefutedInlineDemotions([fd({ line: 10, headline: "`userId`", category: "security", score: 4 })], index),
    ).toEqual([]) // confirmed
    expect(
      selectRefutedInlineDemotions([fd({ line: 11, headline: "`userId`", category: "testing", score: 5 })], index),
    ).toEqual([]) // wrong category
  })

  it("FAILS OPEN on a RANGE finding — never demotes a multi-line finding (Codex #257)", () => {
    // line 11 doesn't contain `userId` → verifyFinding(line 11) is REFUTED, but
    // verifyFinding only checks the END line; the token may be on an earlier line
    // of [startLine, line]. A range finding must NOT be demoted.
    const range = fd({
      startLine: 10,
      line: 11,
      headline: "leak via `userId`",
      category: "security",
      score: 5,
    })
    expect(selectRefutedInlineDemotions([range], index)).toEqual([])
    // A single-line finding (startLine === line, or undefined) IS still eligible.
    const single = fd({
      startLine: 11,
      line: 11,
      headline: "leak via `userId`",
      category: "security",
      score: 5,
    })
    expect(selectRefutedInlineDemotions([single], index)).toEqual([single])
  })
})

describe("applyRefutedDemotion (SIG-285 PR 4 — marker<->finding alignment)", () => {
  // The builder indexes findingMarkers by the inline finding's verdict.findings
  // position (SIG-127). Removing a finding without removing its marker in
  // lockstep attaches the WRONG finding's dismissal marker to later inline
  // comments, corrupting the cross-PR review-memory corpus (the P1 this fixes).
  it("keeps markers aligned to the kept findings after a MID-list demote", () => {
    const A = { id: "A" },
      B = { id: "B" },
      C = { id: "C" }
    const out = applyRefutedDemotion([A, B, C], ["mA", "mB", "mC"], new Set([B]))
    expect(out.keptFindings).toEqual([A, C])
    expect(out.keptMarkers).toEqual(["mA", "mC"]) // NOT ["mA","mB"] — the bug
    expect(out.demoted).toEqual([B])
    expect(out.keptFindings[0]).toBe(A) // identity preserved
    expect(out.keptFindings[1]).toBe(C)
  })

  it("demoting the FIRST finding shifts the kept markers correctly", () => {
    const A = { id: "A" },
      B = { id: "B" },
      C = { id: "C" }
    const out = applyRefutedDemotion([A, B, C], ["mA", "mB", "mC"], new Set([A]))
    expect(out.keptFindings).toEqual([B, C])
    expect(out.keptMarkers).toEqual(["mB", "mC"])
  })

  it("no demotions leaves both arrays unchanged; all-demoted empties them", () => {
    const A = { id: "A" },
      B = { id: "B" }
    expect(applyRefutedDemotion([A, B], ["mA", "mB"], new Set())).toEqual({
      keptFindings: [A, B],
      keptMarkers: ["mA", "mB"],
      demoted: [],
    })
    expect(applyRefutedDemotion([A, B], ["mA", "mB"], new Set([A, B]))).toEqual({
      keptFindings: [],
      keptMarkers: [],
      demoted: [A, B],
    })
  })

  it("tolerates a sparse (null) marker without misaligning the rest", () => {
    const A = { id: "A" },
      B = { id: "B" },
      C = { id: "C" }
    expect(applyRefutedDemotion([A, B, C], ["mA", null, "mC"], new Set([A])).keptMarkers).toEqual([null, "mC"])
  })
})

describe("planReanchor (SIG-285 inline-first — the re-anchor decision)", () => {
  // index: line 10 holds `userId`; line 11 holds `escape` + `input`.
  it("REANCHOR: exactly one same-file added line holds the cited token → move there", () => {
    // A finding citing `userId` anchored at line 11 (refuted — userId isn't there)
    // re-anchors to line 10 (the inline-first fix instead of a body-demote).
    const r = planReanchor(f({ line: 11, headline: "leak via `userId`" }), index)
    expect(r.kind).toBe("reanchor")
    if (r.kind === "reanchor") expect(r.toLine).toBe(10)
  })

  it("NO-MATCH: no added line holds the cited token → caller keeps the body-demote", () => {
    expect(planReanchor(f({ line: 11, headline: "bug in `nonexistentSymbol`" }), index).kind).toBe("no-match")
  })

  it("requires ALL cited tokens on ONE line (stricter than verifyFinding's any-token rule)", () => {
    // `userId` is on line 10, `escape` on line 11 — no single line has BOTH → no-match.
    expect(planReanchor(f({ line: 99, headline: "uses `userId` and `escape`" }), index).kind).toBe("no-match")
  })

  it("AMBIGUOUS: >1 added line holds all tokens → don't guess, body-demote", () => {
    const d = buildAddedLineTextByLine(
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,3 @@\n+const a = doThing()\n+const b = doThing()\n+const c = other()\n",
    )
    // `doThing` is a whole token on lines 1 AND 2; a finding citing it at line 3 → ambiguous.
    const r = planReanchor({ path: "x.ts", line: 3, headline: "bug in `doThing`", body: "" }, d)
    expect(r.kind).toBe("ambiguous")
    if (r.kind === "ambiguous") expect(r.candidateLines).toEqual([1, 2])
  })
})

describe("applyReanchors (SIG-285 enforce — the in-place mutation)", () => {
  const always = () => true // substantive
  const fd = (over: Partial<DemotableFinding>): DemotableFinding => ({
    path: "src/db.ts",
    line: 11,
    headline: "",
    body: "",
    score: 5,
    category: "security",
    ...over,
  })

  it("moves a refuted finding to the correct line in BOTH the finding AND the marker source (lockstep)", () => {
    // `userId` is on line 10, not line 11 — a finding citing it at line 11 is refuted + re-anchors to 10.
    const inline = [fd({ line: 11, headline: "leak via `userId`" })]
    const markerSrc = [{ line: 11 }] // index-aligned marker source (filteredConsensusFindings stand-in)
    const applied = applyReanchors(inline, markerSrc, index, always)
    expect(applied).toEqual([{ index: 0, path: "src/db.ts", fromLine: 11, toLine: 10 }])
    expect(inline[0]!.line).toBe(10) // render source moved
    expect(markerSrc[0]!.line).toBe(10) // marker source moved IN LOCKSTEP — the fid stays consistent
  })

  it("moves startLine in lockstep with line (no bogus range) when startLine was explicit", () => {
    const inline = [fd({ line: 11, startLine: 11, headline: "leak via `userId`" })]
    const markerSrc = [{ line: 11 }]
    applyReanchors(inline, markerSrc, index, always)
    expect(inline[0]!.line).toBe(10)
    expect((inline[0] as { startLine?: number }).startLine).toBe(10) // moved too — NOT left at 11 (Codex #260: would render a spurious range)
  })

  it("does NOT move onto a non-substantive target line (SIG-127 guard)", () => {
    const inline = [fd({ line: 11, headline: "leak via `userId`" })]
    const markerSrc = [{ line: 11 }]
    expect(applyReanchors(inline, markerSrc, index, () => false)).toEqual([])
    expect(inline[0]!.line).toBe(11) // unchanged
    expect(markerSrc[0]!.line).toBe(11)
  })

  it("leaves confirmed / score<4 / non-logic-security findings untouched", () => {
    const inline = [
      fd({ line: 10, headline: "`userId`", category: "security", score: 5 }), // confirmed (userId IS on 10)
      fd({ line: 11, headline: "`userId`", category: "logic", score: 3 }), // score < 4
      fd({ line: 11, headline: "`userId`", category: "performance", score: 5 }), // wrong category
    ]
    const markerSrc = [{ line: 10 }, { line: 11 }, { line: 11 }]
    expect(applyReanchors(inline, markerSrc, index, always)).toEqual([])
    expect(inline.map((x) => x.line)).toEqual([10, 11, 11]) // all unchanged
  })

  it("tolerates an undefined marker-source entry (moves the finding, skips the absent marker)", () => {
    const inline = [fd({ line: 11, headline: "leak via `userId`" })]
    const markerSrc: Array<{ line: number } | undefined> = [undefined]
    expect(applyReanchors(inline, markerSrc, index, always).length).toBe(1)
    expect(inline[0]!.line).toBe(10) // render source still moved; no throw on the absent marker
  })
})

describe("readVerificationMode", () => {
  const mk = (v?: string) => ({ OPENCLAW_VERIFICATION_MODE: v }) as unknown as Env
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

describe("readReanchorEnabled (SIG-285 re-anchor flip)", () => {
  const mk = (v?: string) => ({ OPENCLAW_VERIFICATION_REANCHOR: v }) as unknown as Env
  it("defaults to OFF (unset / blank / garbage / not 'on')", () => {
    expect(readReanchorEnabled(mk(undefined))).toBe(false)
    expect(readReanchorEnabled(mk(""))).toBe(false)
    expect(readReanchorEnabled(mk("  "))).toBe(false)
    expect(readReanchorEnabled(mk("enforce"))).toBe(false)
    expect(readReanchorEnabled(mk("true"))).toBe(false)
  })
  it("is ON only for the literal 'on' (case-insensitive, trimmed)", () => {
    expect(readReanchorEnabled(mk("on"))).toBe(true)
    expect(readReanchorEnabled(mk(" ON "))).toBe(true)
  })
})
