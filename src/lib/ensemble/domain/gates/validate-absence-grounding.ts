// SIG-290 v1: anti-hallucination absence-grounding gate.
//
// The companion to SIG-281's inline-grounding gate (where THAT gate asks
// "is this sub-4 nit grounded enough for an inline thread?"), this gate
// asks the soundness question: "did the bot actually SEE the evidence it
// would need to claim an absence?"
//
// An "absence-claim" finding asserts that something is NOT there — "lacks
// tests", "no null check", "missing validation", "error is never
// handled". Such a claim is only believable if the evidence that would
// confirm-or-refute it was inside the specialist's window. When it was
// NOT — the sibling test file was never inspected, or the cited source
// file was dropped from the diff entirely — the bot was GUESSING, and the
// finding is downgraded (DEMOTED to the review body, never hard-dropped).
//
// FALSE-POSITIVE SAFETY (biases HARD toward KEEP):
//   - A finding that doesn't match the absence-claim detector → KEEP.
//   - An EXCLUDED phrase ("PR adds the missing X", "was missing",
//     "missing from the allowlist", a conditional, a negation, a
//     positive-presence claim) → KEEP — these are not absence-claims.
//   - Performance findings are NEVER scanned → KEEP.
//   - When the evidence state is UNKNOWN (no sibling mapping, path not
//     provably dropped) → KEEP. We only suppress when the evidence was
//     PROVABLY outside the window (a mapping says the test wasn't
//     inspected, or the cited path was dropped). Zero false-negatives.
//   - No score floor: a P0/P1 ungrounded absence-claim is the WORST case
//     — the bot couldn't have seen the evidence, so it is demoted too.
//
// SHADOW-FIRST: the actual demotion is gated behind
//   `OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE` (off | shadow | enforce,
//   default off) at the call site. `off` ⇒ the gate never runs; `shadow`
//   ⇒ counts/telemeters but keeps every finding inline (zero behavior
//   change); only `enforce` demotes. This module is pure and mode-
//   agnostic.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { TestingEvidencePack } from "@/src/lib/testing-evidence-pack"

/**
 * Validator mode. `off` (default): the gate doesn't run. `shadow`:
 * telemeter what WOULD be demoted but keep every finding inline.
 * `enforce`: actually demote ungrounded absence-claims to the review
 * body. Three-state with `off` as the cautious default — matches the
 * off|shadow|enforce idiom of `parseLogicPromptBudgetMode` /
 * `GateMode` / `OPENCLAW_GRAPH_EXPANSION`.
 */
export type AbsenceClaimValidatorMode = "off" | "shadow" | "enforce"

/**
 * Parse `OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE`. Case-insensitive,
 * whitespace-tolerant; any unknown / missing value resolves to `off` —
 * the cautious default that disables the gate entirely.
 */
export function parseAbsenceClaimValidatorMode(
  raw: string | undefined,
): AbsenceClaimValidatorMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/** Single failure shape — an absence-claim the bot couldn't have grounded. */
export type AbsenceGroundingDropReason = "absence-claim-ungrounded-by-truncation"

export type AbsenceGroundingDecision =
  | { keep: true }
  | { keep: false; reason: AbsenceGroundingDropReason }

export interface AbsenceGroundingContext {
  /**
   * The testing-specialist evidence pack. Used to resolve a testing-
   * flavored absence-claim against the source→test sibling mappings +
   * the set of test files actually inspected. Undefined when the pack
   * isn't wired (back-compat / non-testing PRs) — then testing claims
   * fall to UNKNOWN → keep.
   */
  testingEvidence?: TestingEvidencePack | undefined
  /** Paths present in the PR's reviewable diff (reserved for future
   *  refinements; v1's grounding predicate keys off the mappings +
   *  `droppedPaths`, not this set, but the call site supplies it so the
   *  signature is stable). */
  reviewablePaths: ReadonlySet<string>
  /** Was the packed diff char-truncated before specialist dispatch? In
   *  v1 this is NOT used alone to suppress (we can't tell whether the
   *  cited region fell in the truncated tail — FP-safe), but it's part
   *  of the context the call site computes and may inform v2. */
  wasTruncated: boolean
  /** Paths the batcher dropped from the diff entirely (their content
   *  was PROVABLY not in any specialist's window). A non-testing
   *  absence-claim on a dropped path is ungrounded. */
  droppedPaths: readonly string[]
}

// --- Detector ---------------------------------------------------------
//
// Run EXCLUSIONS first — any match means the phrase is NOT an absence-
// claim (a positive "adds the missing X", a past-tense "was missing", a
// config-allowlist reference, a conditional, a negation, or a positive-
// presence claim). Only when zero exclusions match do we test the
// ABSENCE patterns; zero absence matches → not an absence-claim → keep.

const ABSENCE_EXCLUSION_PATTERNS: readonly RegExp[] = [
  // "PR adds the missing null check", "fixes the lacking validation"
  /(?:adds|fixes|implements|provides|includes|introduces)\s+(?:the\s+)?(?:missing|lacking|absent)/i,
  // "X was missing", "the guard had been absent" — past-tense report of a
  // now-resolved gap, not a current absence-claim.
  /(?:was|were|had\s+been)\s+(?:missing|lacking|absent)/i,
  // "missing from the allowlist/config/import/..." — a structural
  // reference, not a behavioral absence-claim.
  /missing\s+from\s+(?:the\s+)?(?:allowlist|config|import|export|type|interface)/i,
  // "if X is missing", "when the guard becomes absent" — a hypothetical /
  // conditional, not an asserted absence.
  /(?:if|when|should|could|would|might)\s+\w+\s+(?:is|are|be|becomes?)\s+(?:missing|lacking|absent)/i,
  // "not missing", "no longer lacking" — an explicit negation.
  /(?:not|no\s+longer)\s+(?:missing|lacking|absent)/i,
  // "has test coverage", "provides null handling" — a positive-presence
  // claim that happens to mention the noun.
  /(?:has|includes|contains|provides|offers)\s+(?:\w+\s+){0,2}(?:test|coverage|validation|guard|handling)/i,
]

// Testing/coverage-flavored absence patterns.
//
// `\s*(?:\w+\s+){0,3}` is the keyword→noun separator: an optional
// whitespace gap, then 0-3 intervening words, so "lacks tests" (no
// gap-word), "no null check" (direct), and "missing test coverage for
// the new branch" (one+ intervening) all match. (The spec's bare
// `(?:\w+\s+){0,3}` omitted the leading `\s*`, so the keyword could not
// connect to the noun across the required word boundary — it failed on
// every canonical example; the `\s*` is the minimal correct repair.)
const ABSENCE_TESTING_PATTERNS: readonly RegExp[] = [
  /(?:lacks|missing|no|without|absent|needs?\s+(?:a\s+)?)\s*(?:\w+\s+){0,3}(?:test|coverage|spec|assertion)/i,
]

// Guard/validation/error-handling-flavored absence patterns.
const ABSENCE_GUARD_PATTERNS: readonly RegExp[] = [
  /(?:lacks|missing|no|without|absent|needs?\s+(?:a\s+)?)\s*(?:\w+\s+){0,3}(?:null\s*check|validation|guard|sanitiz|error\s*handling)/i,
]

// General "is never handled / fails to validate / there is no check"
// absence patterns.
const ABSENCE_GENERAL_PATTERNS: readonly RegExp[] = [
  /(?:is|are)\s+(?:not|never)\s+(?:handled|checked|validated|tested|covered|guarded)/i,
  /(?:fails|doesn'?t|does\s+not)\s+(?:to\s+)?(?:handle|check|validate|test|cover|guard)/i,
  /(?:there\s+is|has)\s+(?:no|not)\s+(?:\w+\s+){0,2}(?:test|check|validation|handling|coverage)/i,
]

const ALL_ABSENCE_PATTERNS: readonly RegExp[] = [
  ...ABSENCE_TESTING_PATTERNS,
  ...ABSENCE_GUARD_PATTERNS,
  ...ABSENCE_GENERAL_PATTERNS,
]

function findingText(finding: PrReviewFinding): string {
  return `${finding.headline} ${finding.body}`
}

/**
 * Should this finding's absence-claim be graded against the sibling-TEST
 * predicate (vs the dropped-path predicate)? Route on the SPECIALIST
 * CATEGORY only — NOT on prose. A non-testing absence-claim (e.g. a
 * security "no null check") whose body merely MENTIONS "test" must not be
 * graded against an uninspected sibling test: its evidence is the SOURCE
 * file, which was in-window. (code-reviewer P1: prose-substring routing
 * suppressed grounded non-testing findings.)
 */
function isTestingFlavored(finding: PrReviewFinding): boolean {
  return finding.category === "testing"
}

/**
 * Detect an absence-claim. Returns true ONLY when the text looks like a
 * current assertion that something is NOT present. EXCLUSIONS are tested
 * first (any match → not an absence-claim). Category scoping:
 *   - testing / security / architecture (= "complexity"): always scanned.
 *   - logic: scanned ONLY if an absence pattern actually matches
 *     (logic findings are commonly NOT absence-claims; we don't want to
 *     widen the detector's surface on them beyond a literal pattern hit).
 *   - performance: NEVER scanned.
 *   - other categories (error-handling / style / syntax / docs): scanned
 *     like the always-set — an "error is never handled" claim is exactly
 *     this gate's domain.
 *
 * Exported for unit tests.
 */
export function isAbsenceClaim(finding: PrReviewFinding): boolean {
  // Performance findings are never absence-claims for this gate.
  if (finding.category === "performance") return false

  const text = findingText(finding)

  // Exclusions win — a positive / past-tense / conditional / negated /
  // structural phrase is not an asserted absence.
  for (const re of ABSENCE_EXCLUSION_PATTERNS) {
    if (re.test(text)) return false
  }

  const matchesAbsence = ALL_ABSENCE_PATTERNS.some((re) => re.test(text))

  // Logic findings only count as absence-claims on a literal pattern hit
  // (no category-implied widening). Every other scanned category uses the
  // same literal-pattern test, so this is effectively a uniform "did a
  // pattern match?" — the explicit branch documents the scoping contract
  // and leaves room to tighten logic independently later.
  if (finding.category === "logic") return matchesAbsence

  return matchesAbsence
}

// --- Grounding predicate ----------------------------------------------

/**
 * Was a TESTING-flavored absence-claim grounded? Resolves the finding's
 * `path` against the sibling mappings:
 *   - mapping `test === null` → GROUNDED → keep. `->NONE` means the source
 *     genuinely has NO sibling test, which the bot SAW (the source→NONE
 *     mapping is in the pack it received, and SIG-113 accepts `->NONE` as
 *     legitimate evidence) — so "lacks tests" is correct, not a guess.
 *   - mapping `test` exists AND was inspected → GROUNDED → keep (bot read it).
 *   - mapping `test` exists but was NOT inspected → UNGROUNDED → the bot
 *     claimed "no/insufficient tests" without ever opening the sibling test
 *     it points at → suppress (this is the ONLY suppress case).
 *   - NO mapping for this path → UNKNOWN → keep (FP-safe).
 *   - no testing evidence wired → UNKNOWN → keep.
 */
function evaluateTestingGrounding(
  finding: PrReviewFinding,
  pack: TestingEvidencePack | undefined,
): AbsenceGroundingDecision {
  if (!pack) return { keep: true }
  const mapping = pack.siblingMappings.find((m) => m.source === finding.path)
  if (!mapping) return { keep: true } // UNKNOWN → keep
  // `->NONE`: the source has no sibling test — a GROUNDED, true absence
  // (both reviewers + the SIG-113 `->NONE` evidence contract). Never suppress.
  if (mapping.test === null) return { keep: true }
  const inspected = new Set(pack.inspectedTestFiles)
  if (inspected.has(mapping.test)) return { keep: true } // bot read the test
  // A sibling test EXISTS but was NOT inspected — the bot couldn't have seen
  // what it would need to claim the absence. The one provable out-of-window case.
  return { keep: false, reason: "absence-claim-ungrounded-by-truncation" }
}

/**
 * Was a NON-testing absence-claim grounded? The only PROVABLE
 * out-of-window signal in v1 is a dropped path: if the cited path was
 * dropped from the diff entirely, the specialist never saw its content,
 * so a "no null check / missing validation" claim on it was a guess.
 * Otherwise UNKNOWN → keep. (We deliberately do NOT use `wasTruncated`
 * alone — a truncated tail might or might not contain the cited region,
 * and suppressing on that would risk false-negatives.)
 */
function evaluateNonTestingGrounding(
  finding: PrReviewFinding,
  droppedPaths: readonly string[],
): AbsenceGroundingDecision {
  if (droppedPaths.includes(finding.path)) {
    return { keep: false, reason: "absence-claim-ungrounded-by-truncation" }
  }
  return { keep: true } // UNKNOWN → keep
}

/**
 * Pure decision for ONE finding. Mode-agnostic — the orchestrator gates
 * the demotion behind off/shadow/enforce. Never throws, no I/O.
 *
 * Order: detect the absence-claim first (non-claims keep immediately),
 * then route to the testing vs non-testing grounding predicate. Every
 * UNKNOWN keeps; only a PROVABLY-out-of-window absence-claim is demoted.
 */
export function evaluateAbsenceGrounding(
  finding: PrReviewFinding,
  context: AbsenceGroundingContext,
): AbsenceGroundingDecision {
  if (!isAbsenceClaim(finding)) return { keep: true }

  if (isTestingFlavored(finding)) {
    return evaluateTestingGrounding(finding, context.testingEvidence)
  }
  return evaluateNonTestingGrounding(finding, context.droppedPaths)
}

// SIG-290 shadow-first; see PR #244.
