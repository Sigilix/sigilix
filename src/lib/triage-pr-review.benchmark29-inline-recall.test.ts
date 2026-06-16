// In-repo replication of sigilix-monitor#29's INLINE-RECALL measurement — a deterministic regression
// guard against the recurring "found-but-bodied" leak (SIG-451).
//
// #29 (Greptile-style) planted 20 bugs across 5 fixture PRs and scored a bug as "caught" ONLY when
// Sigilix posts a line-level INLINE comment. Pre-SIG-451 inline recall was 45% — real findings were
// buried in the review body because they anchored to a CONTEXT (unchanged) line with no nearby `+`
// line. This test isolates the ANCHORING behavior from model recall: for each planted bug it
// SYNTHESIZES a finding at the bug's documented start line (i.e. assumes the model found it there) and
// runs it through the REAL render pipeline (`buildReviewSubmission`, the same path prod uses, with the
// parsed fixture diff as `reviewable` + `addedLineTextByLine` and `anchorPrecision` on). It then
// asserts the finding renders INLINE rather than in the body.
//
// Guarantee under test (SIG-451): a finding whose own line is RIGHT-reviewable (added OR context) must
// anchor INLINE. Bugs whose documented start line is a deleted (LEFT) / off-diff line are the known
// residual (absence-anchoring, a separate follow-up) and are reported but not asserted inline.
//
// Fixtures: `__fixtures__/bench29.json` (regenerated from the benchmark PR; do not hand-edit).

import { describe, expect, it } from "vitest"
import bench29 from "./__fixtures__/bench29.json"
import { buildReviewSubmission, type PrReviewFinding, type PrReviewVerdict } from "@/src/lib/triage-pr-review"
import { parseDiffToReviewablePositions, deriveSide } from "@/src/shared/util/diff-positions"
import { buildAddedLineTextByLine } from "@/src/features/ast-rules"

interface Bug {
  id: string
  pr: number
  file: string
  lineRange: number[] // [start, end] as stored in the fixture JSON
  category: string
  severity: string
  title: string
}

const SEV_TO_SCORE: Record<string, number> = { P0: 5, P1: 4, P2: 3, P3: 2 }

// Map the benchmark's taxonomy onto Sigilix finding categories. None map to "testing" (so the SIG-451
// context-line fallback applies, as it would for these real logic/security defects).
function mapCategory(c: string): "logic" | "security" {
  return c === "security" || c === "privacy" ? "security" : "logic"
}

function renderBug(
  bug: Bug,
  diffs: Record<string, string>,
): {
  inline: boolean
  line: number | undefined
  side: "LEFT" | "RIGHT" | null
} {
  const diff = diffs[String(bug.pr)] ?? ""
  const reviewable = parseDiffToReviewablePositions(diff)
  const addedLineTextByLine = buildAddedLineTextByLine(diff)
  const [lo = 1] = bug.lineRange
  const finding: PrReviewFinding = {
    path: bug.file,
    line: lo,
    score: SEV_TO_SCORE[bug.severity] ?? 3,
    category: mapCategory(bug.category),
    headline: `[${bug.id}] ${bug.title}`,
    body: `Planted benchmark bug ${bug.id}.`,
  }
  const verdict: PrReviewVerdict = {
    summary: `Bug ${bug.id}.`,
    confidence: 4,
    confidenceReason: "Benchmark fixture.",
    findings: [finding],
  }
  const out = buildReviewSubmission({
    verdict,
    prAuthor: "alice",
    headSha: "abc",
    reviewable,
    addedLineTextByLine,
    anchorPrecision: true,
  })
  const inline = (out.comments ?? []).some((c) => c.path === bug.file)
  return { inline, line: out.comments?.[0]?.line, side: deriveSide(reviewable, bug.file, lo) }
}

describe("benchmark #29 inline-recall replication (SIG-451 found-but-bodied regression guard)", () => {
  const bugs = bench29.bugs as Bug[]
  const diffs = bench29.diffs as Record<string, string>

  it("anchors every diff-reviewable planted bug INLINE (recovers the body-routing leak)", () => {
    const results = bugs.map((b) => ({ id: b.id, sev: b.severity, ...renderBug(b, diffs) }))
    const inlineCount = results.filter((r) => r.inline).length
    const rightBugs = results.filter((r) => r.side === "RIGHT")

    // CORE SIG-451 GUARANTEE: a planted bug whose documented start line is RIGHT-reviewable (added OR
    // context) MUST render inline. This is exactly the class that was being body-routed pre-SIG-451.
    // The per-bug id in the assertion message is the diagnostic on failure (which bug regressed).
    const bodied = rightBugs.filter((r) => !r.inline).map((r) => r.id)
    expect(
      bodied,
      `RIGHT-reviewable bugs must render INLINE (SIG-451 found-but-bodied guard); bodied: ${bodied.join(", ")}`,
    ).toEqual([])

    // Overall guard: inline recall must stay well above the 45% pre-SIG-451 baseline. (Deletion/off-diff
    // anchored bugs are the known residual — absence-anchoring is a separate follow-up.)
    expect(inlineCount).toBeGreaterThanOrEqual(Math.ceil(bugs.length * 0.8))
  })
})
