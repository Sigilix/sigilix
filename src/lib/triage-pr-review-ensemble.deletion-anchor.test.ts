// SIG-463: anchor a finding about DELETED code on the deleted (red/LEFT) line.
//
// A finding about removed code (founder Image #3: "verifySession returns a valid
// object for an expired token after the expiry check is removed") has no surviving
// RIGHT line that IS the bug, so the model anchors it to an adjacent structural
// line (`} catch {` — "a blank area"). The removed code lives on a LEFT diff line,
// but a mid-function deletion's old line-number collides with the context line that
// shifted into it, so `deriveSide` prefers RIGHT. `snapFindingLineToDeletedCode`
// (run in the validation walk after the SIG-462 RIGHT snap) re-points such a finding
// to the deleted line and stamps `anchorSide:"LEFT"`, which the renderer honors via
// `isPositionReviewable(...,"LEFT")` — so the comment posts on the line you removed.
//
// Tests drive the real path (validateForSubmission → buildReviewSubmissionWithMetadata),
// maps derived from one unified diff. Expected lines come from the deleted-line map,
// not hand-counted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { validateForSubmission, type SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import {
  buildReviewSubmissionWithMetadata,
  type PrReviewVerdict,
  type PrReviewFinding,
} from "@/src/lib/triage-pr-review"
import { parseDiffToReviewablePositions, type ReviewableMap } from "@/src/shared/util/diff-positions"
import { buildAddedLineTextByLine, buildDeletedLineTextByLine } from "@/src/features/ast-rules"
import { snapFindingLineToDeletedCode } from "@/src/lib/ensemble/domain/validation-internals"
import { selectRefutedInlineDemotions, applyReanchors } from "@/src/lib/verification/verify-finding"
import { isSubstantiveAnchorLine } from "@/src/shared/util/anchor-lines"
import { baseFinding, baseVerdict } from "@/src/lib/triage-pr-review-ensemble.test-helpers"

const PATH = "src/auth/session.ts"
const DELETED_GUARD = "if (typeof payload.exp !== 'number' || nowMs > payload.exp) return null;"

// A PURE deletion of the expiry guard. `} catch {` survives as a RIGHT context line
// (the model's bad anchor); the guard is a deleted LEFT line whose old number
// collides with the added `return {...}` (a mid-function deletion always collides).
const DIFF = [
  `diff --git a/${PATH} b/${PATH}`,
  `--- a/${PATH}`,
  `+++ b/${PATH}`,
  "@@ -62,8 +62,6 @@ export async function verifySession(token, secret, nowMs) {",
  "   try {",
  "     const payload = await decode(token, secret);",
  "     if (!payload) return null;",
  `-    ${DELETED_GUARD}`,
  "-    return { login: payload.login, email: payload.email, exp: payload.exp };",
  "+    return { login: payload.login, email: payload.email };",
  "   } catch {",
  "     return null;",
  "   }",
].join("\n")

const REVIEWABLE: ReviewableMap = parseDiffToReviewablePositions(DIFF)
const ADDED = buildAddedLineTextByLine(DIFF)
const DELETED = buildDeletedLineTextByLine(DIFF)

function deletedLineContaining(needle: string): number {
  const byPath = DELETED.get(PATH)
  if (!byPath) throw new Error(`no deleted lines for ${PATH}`)
  for (const [line, text] of byPath) if (text.includes(needle)) return line
  throw new Error(`no deleted line containing "${needle}"`)
}
const GUARD_OLD_LINE = deletedLineContaining(DELETED_GUARD)
// The surviving `} catch {` RIGHT context line the model anchors to (new-side number).
const CATCH_LINE = [...(REVIEWABLE.get(PATH) ?? [])]
  .filter((p) => p.side === "RIGHT")
  .map((p) => p.line)
  .find((n) => !ADDED.get(PATH)?.has(n) && n > GUARD_OLD_LINE) as number

function delFinding(overrides: Partial<PrReviewFinding>): PrReviewFinding {
  return {
    ...baseFinding,
    path: PATH,
    scope: "line",
    score: 5,
    category: "logic",
    line: CATCH_LINE,
    headline: "verifySession accepts an expired token after the expiry check was removed",
    body: `The deleted check \`${DELETED_GUARD}\` was the only guard rejecting an expired session.`,
    ...overrides,
  }
}

describe("SIG-463: snapFindingLineToDeletedCode — unit contract", () => {
  it("anchors a deleted-code finding to the deleted line with anchorSide:LEFT (founder Image #3)", () => {
    const f = delFinding({})
    const out = snapFindingLineToDeletedCode(f, REVIEWABLE, DELETED, ADDED)
    expect(out).not.toBe(f)
    expect(out.line).toBe(GUARD_OLD_LINE)
    expect(out.scope).toBe("line")
    expect(out.anchorSide).toBe("LEFT")
    expect("startLine" in out).toBe(false)
  })

  it("PROTECTS a present-code finding correctly anchored on an ADDED line (no LEFT pull, DeepSeek blocker)", () => {
    const addedLine = [...(ADDED.get(PATH) ?? new Map<number, string>())].find(([, t]) =>
      t.includes("return { login: payload.login, email: payload.email }"),
    )?.[0] as number
    const f = delFinding({
      line: addedLine,
      body: "The new return `return { login: payload.login, email: payload.email }` drops the `exp` field.",
    })
    expect(snapFindingLineToDeletedCode(f, REVIEWABLE, DELETED, ADDED)).toBe(f)
  })

  it("leaves UNCHANGED when the quoted code is in no deleted line", () => {
    const f = delFinding({ body: "The handler `doSomethingEntirelyAbsent(payload)` is wrong (not in this diff)." })
    expect(snapFindingLineToDeletedCode(f, REVIEWABLE, DELETED, ADDED)).toBe(f)
  })

  it("leaves UNCHANGED for non-line scope, scopeLocked, or an already-set anchorSide", () => {
    expect(snapFindingLineToDeletedCode(delFinding({ scope: "file" }), REVIEWABLE, DELETED, ADDED).scope).toBe("file")
    const locked = delFinding({ scopeLocked: true })
    expect(snapFindingLineToDeletedCode(locked, REVIEWABLE, DELETED, ADDED)).toBe(locked)
    const already = delFinding({ anchorSide: "LEFT" })
    expect(snapFindingLineToDeletedCode(already, REVIEWABLE, DELETED, ADDED)).toBe(already)
  })

  it("exempts a LEFT-anchored finding from the verification refute-demote (else it would body-demote)", () => {
    // Body carries a standalone token `nowMs` — present in the deleted guard, ABSENT
    // on the colliding added `return {...}` at GUARD_OLD_LINE — so verifyFinding (which
    // checks the ADDED index) REFUTES it. Without the anchorSide:LEFT exemption this
    // LEFT (deleted-line) finding would be wrongly body-demoted.
    const body = `The deleted guard compared \`nowMs\` against the token expiry; it is gone.`
    const left = delFinding({ line: GUARD_OLD_LINE, anchorSide: "LEFT", body })
    expect(selectRefutedInlineDemotions([left], ADDED)).toHaveLength(0)
    // Control: the same finding WITHOUT the LEFT flag IS refuted (proves the exemption matters).
    const right = delFinding({ line: GUARD_OLD_LINE, body })
    expect(selectRefutedInlineDemotions([right], ADDED)).toHaveLength(1)
  })

  it("exempts a LEFT-anchored finding from applyReanchors (never re-anchored onto a RIGHT added line)", () => {
    // A refuted single-line logic finding whose token (`validateExpiry`) is uniquely
    // present on a substantive ADDED line: WITHOUT the LEFT flag applyReanchors moves
    // it there; WITH anchorSide:"LEFT" it must be left untouched (it points at a
    // deleted line on purpose).
    const added = new Map([
      [
        "src/x.ts",
        new Map<number, string>([
          [5, "  // blank"],
          [9, "  const x = validateExpiry(token);"],
        ]),
      ],
    ])
    const make = (anchorSide?: "LEFT"): PrReviewFinding =>
      delFinding({
        path: "src/x.ts",
        line: 5, // refuted: token not on line 5
        body: "The guard `validateExpiry` was dropped from this path.",
        ...(anchorSide ? { anchorSide } : {}),
      })

    const left = make("LEFT")
    expect(applyReanchors([left], [{ line: 5 }], added, isSubstantiveAnchorLine)).toHaveLength(0)
    expect(left.line).toBe(5) // untouched

    const right = make() // control: same finding, no LEFT flag → re-anchors to line 9
    expect(applyReanchors([right], [{ line: 5 }], added, isSubstantiveAnchorLine)).toHaveLength(1)
    expect(right.line).toBe(9)
  })
})

describe("SIG-463: deletion anchor through the real validateForSubmission walk", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => logSpy.mockRestore())

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

  it("posts the deletion finding inline on side:LEFT at the deleted line (collision → explicit side wins)", () => {
    const finding = delFinding({})
    const validated = validateForSubmission({
      synthOutput: packSynth(finding),
      reviewable: REVIEWABLE,
      specialistVerdicts: [
        { role: "logic", verdict: { ...baseVerdict, findings: [{ ...finding, id: "logic-0" }] }, elapsedMs: 1 },
      ],
      addedLineTextByLine: ADDED,
      deletedLineTextByLine: DELETED,
      logicValidatorMode: "shadow",
      logicRefutationMode: "off",
      logicClaimRefutationMode: "off",
      inlineGroundingValidatorMode: "shadow",
      absenceClaimValidatorMode: "off",
      windowBlindnessValidatorMode: "off",
    })
    const out = validated.verdict.findings[0] ?? validated.unanchoredFindings[0]
    expect(out?.line).toBe(GUARD_OLD_LINE)
    expect(out?.anchorSide).toBe("LEFT")

    const built = buildReviewSubmissionWithMetadata({
      verdict: validated.verdict,
      prAuthor: null,
      headSha: "deadbeef",
      unanchored: validated.unanchoredFindings,
      reviewable: REVIEWABLE,
    })
    const comments = built.submission.comments ?? []
    expect(comments).toHaveLength(1)
    expect(comments[0]?.path).toBe(PATH)
    expect(comments[0]?.line).toBe(GUARD_OLD_LINE)
    expect(comments[0]?.side).toBe("LEFT")

    const anchored = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-finding-anchored-deleted-left"))
    expect(anchored).toHaveLength(1)
    expect(JSON.parse(anchored[0]!) as Record<string, unknown>).toMatchObject({
      event: "pr-review-finding-anchored-deleted-left",
      path: PATH,
      toLine: GUARD_OLD_LINE,
    })
  })

  it("does NOT run the added-line inline-grounding gate on a LEFT (deleted-line) anchor (SIG-466)", () => {
    // A sub-P1 (score 3) deletion finding snaps to the deleted line (anchorSide:"LEFT").
    // The inline-grounding gate checks the ADDED-line map, where a deleted-line anchor's
    // code never appears — so in `enforce` it would judge it "ungrounded" and demote a
    // real deletion finding to the body. The SIG-466 exemption must SKIP the gate for a
    // LEFT anchor (added-line grounding is structurally N/A here).
    const finding = delFinding({ score: 3 })
    const groundingDrops: Array<{ reason: string }> = []
    const validated = validateForSubmission({
      synthOutput: packSynth(finding),
      reviewable: REVIEWABLE,
      specialistVerdicts: [
        { role: "logic", verdict: { ...baseVerdict, findings: [{ ...finding, id: "logic-0" }] }, elapsedMs: 1 },
      ],
      addedLineTextByLine: ADDED,
      deletedLineTextByLine: DELETED,
      logicValidatorMode: "shadow",
      logicRefutationMode: "off",
      logicClaimRefutationMode: "off",
      inlineGroundingValidatorMode: "enforce", // would demote an ungrounded finding
      absenceClaimValidatorMode: "off",
      windowBlindnessValidatorMode: "off",
      onInlineGroundingFindingDropped: (_f, info) => groundingDrops.push({ reason: info.reason }),
    })
    const out = validated.verdict.findings[0] ?? validated.unanchoredFindings[0]
    expect(out?.anchorSide).toBe("LEFT")
    expect(out?.line).toBe(GUARD_OLD_LINE)
    // The gate was skipped — it never fired its drop callback on the LEFT anchor.
    expect(groundingDrops).toHaveLength(0)
  })
})
