// SIG-462: line-precision snap — re-point a finding whose cited line is wrong onto
// the unique substantive added line that contains a code span it quotes.
//
// The specialist reads a raw git diff and MISCOUNTS line numbers, but reproduces
// the buggy code verbatim in its body (probe sigilix-monitor#39: 5 P0/P1 findings,
// 0 inline — each quoted its bug's exact code yet cited a blank/declaration line
// nearby; the SIG-285 verification gate then refuted the mis-anchored citation and
// body-demoted every one). `snapFindingLineToQuotedCode` (run in the validation
// pass right after `normalizeFindingScopeForAnchorability` / `anchorNoLineDeletionFinding`)
// trusts the quoted code over the model's count: it moves `line` to the unique
// substantive added line containing a backticked code span — so the citation is
// correct BEFORE verification (which then CONFIRMS, no body-demote).
//
// The unit tests pin the can't-mis-anchor contract clause-by-clause. The
// integration test drives the REAL path (validateForSubmission → the snap runs in
// the walk) on a new-file diff and asserts the corrected line + that `verifyFinding`
// flips refuted→confirmed at the snapped line (the load-bearing reason it stays
// inline in prod). Expected line numbers are derived from the added-line map, not
// hand-counted, so the test asserts the real invariant and fails on any revert.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { validateForSubmission, type SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import { type PrReviewVerdict, type PrReviewFinding } from "@/src/lib/triage-pr-review"
import { parseDiffToReviewablePositions, deriveSide, type ReviewableMap } from "@/src/shared/util/diff-positions"
import { buildAddedLineTextByLine } from "@/src/features/ast-rules"
import { snapFindingLineToQuotedCode, extractBacktickedCodeSpans } from "@/src/lib/ensemble/domain/validation-internals"
import { verifyFinding } from "@/src/lib/verification/verify-finding"
import { baseFinding, baseVerdict } from "@/src/lib/triage-pr-review-ensemble.test-helpers"

const PATH = "src/auth/session-refresh.ts"

// A real "new file" PR (every line added → every line a RIGHT diff position). The
// bug lines reproduce probe #39: the inverted expiry guard and the SQL-injected
// admin query. `WHERE user_id = '${userId}'` is UNIQUE to the listUserSessions
// query (the refreshSession query above binds `refresh_token = ?`), and the inverted
// guard `if (row.expiresAt > Date.now()) return null;` is unique too. Built as an
// array of plain strings (NOT a template literal) so `${userId}` stays literal.
const NEW_FILE_LINES = [
  "// Session refresh: validate the refresh cookie, mint a new access token.",
  "export interface Session {",
  "  id: string;",
  "  userId: string;",
  "  expiresAt: number;",
  "  revoked: number;",
  "}",
  "",
  "export async function refreshSession(db: D1Database, refreshToken: string): Promise<Session | null> {",
  "  if (!refreshToken) return null;",
  "  const row = await db",
  '    .prepare("SELECT id, expires_at AS expiresAt, revoked FROM sessions WHERE refresh_token = ?")',
  "    .bind(refreshToken)",
  "    .first<Session>();",
  "  if (!row) return null;",
  "",
  "  // Reject expired sessions.",
  "  if (row.expiresAt > Date.now()) return null;",
  "",
  "  return row;",
  "}",
  "",
  "export async function listUserSessions(db: D1Database, userId: string): Promise<Session[]> {",
  "  const rows = await db",
  "    .prepare(",
  "      `SELECT id FROM sessions WHERE user_id = '${userId}' ORDER BY created_at DESC`,",
  "    )",
  "    .all<Session>();",
  "  return rows.results;",
  "}",
]

function newFileDiff(lines: readonly string[]): string {
  const header = [
    `diff --git a/${PATH} b/${PATH}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${PATH}`,
    `@@ -0,0 +1,${lines.length} @@`,
  ]
  return [...header, ...lines.map((l) => `+${l}`)].join("\n")
}

const DIFF = newFileDiff(NEW_FILE_LINES)
const REVIEWABLE: ReviewableMap = parseDiffToReviewablePositions(DIFF)
const ADDED = buildAddedLineTextByLine(DIFF)

// Derive expected anchor lines from the added-line map (never hand-counted).
function addedLineContaining(needle: string): number {
  const byPath = ADDED.get(PATH)
  if (!byPath) throw new Error(`no added lines for ${PATH}`)
  let found: number | undefined
  for (const [line, text] of byPath) {
    if (text.includes(needle)) {
      if (found !== undefined) throw new Error(`"${needle}" is not unique (lines ${found}, ${line})`)
      found = line
    }
  }
  if (found === undefined) throw new Error(`no added line containing "${needle}"`)
  return found
}

const EXPIRY_LINE = addedLineContaining("if (row.expiresAt > Date.now()) return null;")
const SQLI_LINE = addedLineContaining("WHERE user_id = '${userId}'")
const FUNC_SIG_LINE = addedLineContaining("export async function refreshSession")

function snapFinding(overrides: Partial<PrReviewFinding>): PrReviewFinding {
  return {
    ...baseFinding,
    path: PATH,
    scope: "line",
    score: 5,
    category: "logic",
    line: 1,
    headline: "finding",
    body: "finding body",
    ...overrides,
  }
}

describe("SIG-462: snapFindingLineToQuotedCode — unit contract", () => {
  it("snaps a miscited finding to the unique line containing its quoted buggy code", () => {
    const f = snapFinding({
      line: FUNC_SIG_LINE, // model cited the function declaration, not the bug
      headline: "Inverted expiration check rejects valid sessions and accepts expired ones",
      body: "The guard `if (row.expiresAt > Date.now()) return null;` uses `>` not `<`, so `expiresAt` in the future is rejected.",
    })
    const out = snapFindingLineToQuotedCode(f, REVIEWABLE, ADDED)
    expect(out).not.toBe(f)
    expect(out.line).toBe(EXPIRY_LINE)
    expect(out.scope).toBe("line")
  })

  it("snaps a range finding to a single line and STRIPS the stale startLine", () => {
    const f = snapFinding({
      category: "security",
      startLine: FUNC_SIG_LINE,
      line: FUNC_SIG_LINE + 1,
      headline: "SQL injection in listUserSessions via string interpolation of userId",
      body: "The query `WHERE user_id = '${userId}'` interpolates `userId` directly — use a bound `?` parameter.",
    })
    const out = snapFindingLineToQuotedCode(f, REVIEWABLE, ADDED)
    expect(out.line).toBe(SQLI_LINE)
    expect("startLine" in out).toBe(false)
    expect(out.startLine).toBeUndefined()
  })

  it("PROTECTS a correct single-line citation (its line already holds the quoted span)", () => {
    const f = snapFinding({
      line: EXPIRY_LINE,
      body: "The guard `if (row.expiresAt > Date.now()) return null;` is inverted.",
    })
    expect(snapFindingLineToQuotedCode(f, REVIEWABLE, ADDED)).toBe(f)
  })

  it("PROTECTS a correct range citation when the span sits on its start/middle line (DeepSeek/Codex blocker)", () => {
    // Span on EXPIRY_LINE; finding cites the range [EXPIRY_LINE, EXPIRY_LINE+2].
    // Step-3 protection must scan the WHOLE range, not just `line` — else a correct
    // range gets moved + collapsed.
    const f = snapFinding({
      startLine: EXPIRY_LINE,
      line: EXPIRY_LINE + 2,
      body: "The guard `if (row.expiresAt > Date.now()) return null;` is inverted.",
    })
    expect(snapFindingLineToQuotedCode(f, REVIEWABLE, ADDED)).toBe(f)
  })

  it("leaves the finding UNCHANGED when no quoted span appears in any added line", () => {
    const f = snapFinding({
      line: FUNC_SIG_LINE,
      body: "The handler `doSomethingEntirelyAbsent(x)` is wrong (code not present in this diff).",
    })
    expect(snapFindingLineToQuotedCode(f, REVIEWABLE, ADDED)).toBe(f)
  })

  it("leaves the finding UNCHANGED when a span confirms on more than one added line (ambiguous, never guess)", () => {
    const yPath = "src/y.ts"
    const yDiff = [
      `diff --git a/${yPath} b/${yPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${yPath}`,
      "@@ -0,0 +1,3 @@",
      "+function a() { return computeChecksum(payload); }",
      "+function b() { return computeChecksum(payload); }",
      "+const z = 0;",
    ].join("\n")
    const yReviewable = parseDiffToReviewablePositions(yDiff)
    const yAdded = buildAddedLineTextByLine(yDiff)
    // Cite the line WITHOUT the token so protection passes; the span then confirms
    // on TWO substantive lines → ambiguous → never guess.
    const zLine = [...(yAdded.get(yPath) ?? new Map<number, string>())].find(([, t]) =>
      t.includes("const z"),
    )?.[0] as number
    const f = snapFinding({
      path: yPath,
      line: zLine,
      body: "The integrity check is wrong: `computeChecksum(payload)` is invoked twice.",
    })
    expect(snapFindingLineToQuotedCode(f, yReviewable, yAdded)).toBe(f)
  })

  it("does NOT anchor where the span is only a SUBSTRING of a larger identifier (code-reviewer BLOCKER)", () => {
    // The model quotes `authorizeRequest` (the symbol it means); the only line that
    // CONTAINS that text is `authorizeRequestStrict` — a DIFFERENT symbol. Matching
    // by the gate's whole-token rule (not substring `includes`) must refuse to
    // anchor there; a substring match would mis-anchor and the gate would then
    // refute → a corrupted line, strictly worse than leaving it put.
    const aPath = "src/auth.ts"
    const aDiff = [
      `diff --git a/${aPath} b/${aPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${aPath}`,
      "@@ -0,0 +1,3 @@",
      "+export function gate(req) {",
      "+  return authorizeRequestStrict(req);",
      "+}",
    ].join("\n")
    const aReviewable = parseDiffToReviewablePositions(aDiff)
    const aAdded = buildAddedLineTextByLine(aDiff)
    const sigLine = [...(aAdded.get(aPath) ?? new Map<number, string>())].find(([, t]) =>
      t.includes("export function gate"),
    )?.[0] as number
    const f = snapFinding({
      path: aPath,
      line: sigLine,
      category: "security",
      body: "Missing guard: `authorizeRequest` is never called before the handler runs.",
    })
    expect(snapFindingLineToQuotedCode(f, aReviewable, aAdded)).toBe(f)
  })

  it("PROTECTS a citation grounded only by a SHORT token below the span floor (code-reviewer MAJOR)", () => {
    // The finding correctly cites `log(userId)`, grounded by the short token
    // `userId` (6 chars, below the 10-char span floor). A longer span elsewhere
    // (`validateUserIdFormat(userId)`) must NOT drag it off — protection keys on the
    // verification gate's tokens, not the span-length floor.
    const lPath = "src/log.ts"
    const lDiff = [
      `diff --git a/${lPath} b/${lPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${lPath}`,
      "@@ -0,0 +1,4 @@",
      "+function f(userId) {",
      "+  log(userId);",
      "+  return validateUserIdFormat(userId);",
      "+}",
    ].join("\n")
    const lReviewable = parseDiffToReviewablePositions(lDiff)
    const lAdded = buildAddedLineTextByLine(lDiff)
    const logLine = [...(lAdded.get(lPath) ?? new Map<number, string>())].find(([, t]) =>
      t.includes("log(userId)"),
    )?.[0] as number
    const f = snapFinding({
      path: lPath,
      line: logLine,
      body: "Sensitive `userId` is logged; `validateUserIdFormat(userId)` does not redact it.",
    })
    expect(snapFindingLineToQuotedCode(f, lReviewable, lAdded)).toBe(f)
  })

  it("does NOT snap onto a comment line (substantive-code gate)", () => {
    // The span matches ONLY the deleted-test-style comment line "// Reject expired
    // sessions." — isSubstantiveCodeAnchorLine rejects whole-line comments, so no snap.
    const f = snapFinding({
      line: 1,
      body: "The comment `// Reject expired sessions.` documents an inverted guard.",
    })
    expect(snapFindingLineToQuotedCode(f, REVIEWABLE, ADDED)).toBe(f)
  })

  it("ignores a quoted span shorter than the minimum (10 chars)", () => {
    expect("revoked".length).toBeLessThan(10)
    const f = snapFinding({ line: 1, body: "The `revoked` column is never checked." })
    expect(snapFindingLineToQuotedCode(f, REVIEWABLE, ADDED)).toBe(f)
  })

  it("only uses BACKTICKED code spans, never single/double-quoted prose (Codex blocker)", () => {
    // The identifier in BACKTICKS would snap to its declaration line; in single
    // quotes (prose) it must NOT drive a snap — prose can mis-anchor.
    const backtick = snapFinding({ line: 1, body: "The function `listUserSessions` lacks an auth check." })
    expect(snapFindingLineToQuotedCode(backtick, REVIEWABLE, ADDED).line).toBe(addedLineContaining("listUserSessions"))
    const prose = snapFinding({ line: 1, body: "The function 'listUserSessions' lacks an auth check." })
    expect(snapFindingLineToQuotedCode(prose, REVIEWABLE, ADDED)).toBe(prose)
  })

  it("PROTECTS a correct CONTEXT-line anchor even when the same span is on an added line elsewhere (Codex blocker)", () => {
    // A modified-file hunk: the bug `normalize(user.id)` sits on a RIGHT CONTEXT
    // line (the finding's correct anchor, which SIG-451 keeps inline), and an
    // unrelated ADDED line elsewhere carries the SAME span. The added-line map
    // excludes context lines, so without the deriveSide guard the protect pass
    // would miss the correct anchor and the snap would move it onto the added
    // decoy — a mis-anchor. The guard must leave the finding UNCHANGED.
    const xPath = "src/x.ts"
    const xDiff = [
      `diff --git a/${xPath} b/${xPath}`,
      `--- a/${xPath}`,
      `+++ b/${xPath}`,
      "@@ -38,4 +38,5 @@ function f() {",
      "   const a = 1;",
      "   return normalize(user.id);",
      "+  const dup = normalize(user.id);",
      "   const b = 2;",
      " }",
    ].join("\n")
    const xReviewable = parseDiffToReviewablePositions(xDiff)
    const xAdded = buildAddedLineTextByLine(xDiff)
    const addedDup = [...(xAdded.get(xPath) ?? new Map<number, string>())].find(([, t]) =>
      t.includes("const dup"),
    )?.[0] as number
    const contextLine = addedDup - 1 // the `return normalize(user.id);` context line above the decoy
    // Structural preconditions (derived, not hand-counted): the context line is a
    // RIGHT anchor but is NOT in the added-line map; the decoy added line carries
    // the same span.
    expect(deriveSide(xReviewable, xPath, contextLine)).toBe("RIGHT")
    expect(xAdded.get(xPath)?.has(contextLine)).toBe(false)
    expect(xAdded.get(xPath)?.get(addedDup)).toContain("normalize(user.id)")
    const f = snapFinding({
      path: xPath,
      line: contextLine,
      body: "The id is not normalized before use: `normalize(user.id)` is bypassed on this path.",
    })
    expect(snapFindingLineToQuotedCode(f, xReviewable, xAdded)).toBe(f)
  })

  it("handles a malformed huge range without burning CPU (Codex MAJOR: scan anchors, not the interval)", () => {
    // startLine:1 + line:50_000_000 is schema-legal (no max). The old numeric-interval
    // walk would iterate 50M times here and time out; scanning the small added/anchor
    // sets must return promptly. Body quotes code absent from the diff → unchanged.
    const f = snapFinding({
      startLine: 1,
      line: 50_000_000,
      body: "The handler `doSomethingEntirelyAbsent(x)` is wrong (code not in this diff).",
    })
    expect(snapFindingLineToQuotedCode(f, REVIEWABLE, ADDED)).toBe(f)
  })

  it("leaves non-line scopes and scopeLocked findings untouched", () => {
    const body = "The guard `if (row.expiresAt > Date.now()) return null;` is inverted."
    expect(snapFindingLineToQuotedCode(snapFinding({ scope: "file", body }), REVIEWABLE, ADDED).scope).toBe("file")
    expect(snapFindingLineToQuotedCode(snapFinding({ scope: "pr", body }), REVIEWABLE, ADDED).scope).toBe("pr")
    const locked = snapFinding({ scopeLocked: true, line: FUNC_SIG_LINE, body })
    expect(snapFindingLineToQuotedCode(locked, REVIEWABLE, ADDED)).toBe(locked)
  })

  it("extractBacktickedCodeSpans: backticks only, len>=10, longest-first, de-duped", () => {
    const spans = extractBacktickedCodeSpans(
      "wrong `if (row.expiresAt > Date.now()) return null;` and `userId` and 'prose here long' and `dup` `dup`",
    )
    expect(spans).toEqual(["if (row.expiresAt > Date.now()) return null;"])
  })
})

describe("SIG-462: snap runs in the real validateForSubmission walk", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    logSpy.mockRestore()
  })

  function packSynth(finding: PrReviewFinding): { verdict: PrReviewVerdict; provenance: SynthesizerProvenance } {
    return {
      verdict: { ...baseVerdict, findings: [finding] },
      provenance: {
        findings: [
          { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
        ],
        dropped: [],
      },
    }
  }
  function logicSpecialist(finding: PrReviewFinding) {
    return [
      {
        role: "logic" as const,
        verdict: { ...baseVerdict, findings: [{ ...finding, id: "logic-0" }] },
        elapsedMs: 100,
      },
    ]
  }

  it("re-points a miscited inline finding to the buggy line; verifyFinding flips refuted→confirmed", () => {
    const finding = snapFinding({
      line: FUNC_SIG_LINE, // miscited at the function declaration
      headline: "Inverted expiration check rejects valid sessions and accepts expired ones",
      body: "The guard `if (row.expiresAt > Date.now()) return null;` uses `>` not `<`, so a future `expiresAt` is rejected.",
    })

    // Documents the bug: at the model's cited line the citation is REFUTED (no token
    // there) — which is what body-demotes it in prod under verification=enforce.
    expect(verifyFinding(finding, ADDED).verdict).toBe("refuted")

    const validated = validateForSubmission({
      synthOutput: packSynth(finding),
      reviewable: REVIEWABLE,
      specialistVerdicts: logicSpecialist(finding),
      addedLineTextByLine: ADDED,
      // isolate the snap/anchoring from the evidence gates (tested elsewhere):
      // "shadow" counts but never drops; "off" disables the demote-only gates.
      logicValidatorMode: "shadow",
      logicRefutationMode: "off",
      logicClaimRefutationMode: "off",
      inlineGroundingValidatorMode: "shadow",
      absenceClaimValidatorMode: "off",
      windowBlindnessValidatorMode: "off",
    })

    const out = validated.verdict.findings[0] ?? validated.unanchoredFindings[0]
    expect(out?.line).toBe(EXPIRY_LINE)
    expect(out?.scope).toBe("line")
    // The snapped finding is now an inline (clean) finding, not body/unanchored.
    expect(validated.verdict.findings).toHaveLength(1)
    expect(validated.unanchoredFindings).toHaveLength(0)

    // The load-bearing consequence: at the snapped line the citation CONFIRMS, so the
    // SIG-285 verification gate will NOT refute → no body-demote in prod.
    expect(verifyFinding({ ...finding, line: EXPIRY_LINE }, ADDED).verdict).toBe("confirmed")

    const snapEvents = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-finding-line-snapped"))
    expect(snapEvents).toHaveLength(1)
    expect(JSON.parse(snapEvents[0]!) as Record<string, unknown>).toMatchObject({
      event: "pr-review-finding-line-snapped",
      path: PATH,
      fromLine: FUNC_SIG_LINE,
      toLine: EXPIRY_LINE,
      category: "logic",
    })
  })
})
