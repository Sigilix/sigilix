// SIG-111: tests-finding specificity gate.
//
// The second post-LLM gate for `category: "testing"` findings, running
// immediately AFTER the SIG-113 citation gate
// (`evaluateTestingFindingCitation`). Where SIG-113 asks "did the
// specialist cite SOMETHING real?", this gate asks "is the cited
// finding SPECIFIC enough to be a true positive?" — the sibling-gap
// promotion (piece 1) widens what the tests specialist is allowed to
// flag, so this gate is the FP backstop that keeps the widened lens
// from re-introducing the PR #110 / PR #111 over-flagging class.
//
// FALSE-NEGATIVE SAFETY (the crux — the SIG-108 review caught real
// findings being dropped, so this gate biases hard toward KEEP):
//   - Applies ONLY to `category: "testing"` findings with `score >= 4`.
//     Lower-severity coverage nits pass untouched.
//   - A real "PR removed test coverage" finding citing a changed/
//     deleted test file (`testFileChanged:<path>`) ALWAYS keeps — the
//     SIG-113 deletion/rename exception is preserved verbatim.
//   - When the missing-vs-insufficient classification is ambiguous
//     (a finding cites BOTH or NEITHER a siblingMapping and an
//     inspectedTestFile), prefer KEEP. The gate only rejects when the
//     finding clearly falls into one class AND fails that class's
//     specificity bar.
//   - The two reject paths target the two concrete FP shapes:
//       * uncited-missing-coverage  — a "source X lacks tests" claim
//         whose `path` doesn't match a changed source with a real
//         `siblingMapping:<path>->NONE` in the pack.
//       * vague-insufficient-test   — a "tests are inadequate" claim
//         that reads a real inspected test file but names no concrete
//         source / API / branch (a generic "needs more tests" nudge).
//
// SHADOW-FIRST: the actual drop is gated behind
//   `OPENCLAW_TESTS_VALIDATOR_MODE` (shadow | enforce, default shadow)
//   at the call site. In shadow the verdict is only counted/telemetered
//   — never dropped. This module is pure and mode-agnostic; the
//   orchestrator decides what to do with the verdict. The SIG-86 shadow
//   aggregator instruments the would-drop rate; the bake-off harness is
//   NOT built here.

import type { PrReviewFinding } from "./triage-pr-review"
import type { TestingEvidencePack } from "./testing-evidence-pack"

/**
 * Validator mode. `shadow` (default): emit telemetry counting what
 * WOULD be dropped, but keep every finding. `enforce`: actually drop
 * rejected findings.
 */
export type TestsValidatorMode = "shadow" | "enforce"

/**
 * Parse `OPENCLAW_TESTS_VALIDATOR_MODE`. Anything other than the literal
 * "enforce" (case-insensitive, trimmed) resolves to "shadow" — the
 * cautious default for a false-negative-sensitive gate's staged
 * rollout. Mirrors `parseSecurityValidatorMode`.
 */
export function parseTestsValidatorMode(raw: string | undefined): TestsValidatorMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow"
}

/**
 * Result of evaluating one in-scope testing finding. `keep:false`
 * carries a structured reason for telemetry; `keep:true` is bare.
 */
export type TestFindingDecision =
  | { keep: true }
  | { keep: false; reason: TestDropReason }

export type TestDropReason =
  | "missing-path" // sev>=4 testing finding with no concrete path to anchor
  | "uncited-missing-coverage" // "source lacks tests" claim not backed by a real ->NONE mapping for finding.path
  | "vague-insufficient-test" // "tests inadequate" claim that names no concrete source/API/branch

/**
 * Parse a `siblingMapping:<source>-><test|NONE>` evidenceRef into its
 * source + arrow value. Mirrors the SIG-113 citation-gate ref parsing
 * (`evaluateTestingFindingCitation`) so the two gates agree on what a
 * mapping ref means. Returns null for any other ref shape.
 */
function parseSiblingMappingRef(ref: string): { source: string; arrowValue: string } | null {
  const trimmed = ref.trim()
  if (!trimmed.startsWith("siblingMapping:")) return null
  const payload = trimmed.slice("siblingMapping:".length)
  const arrowIdx = payload.indexOf("->")
  if (arrowIdx < 0) return null
  return {
    source: payload.slice(0, arrowIdx).trim(),
    arrowValue: payload.slice(arrowIdx + 2).trim(),
  }
}

/**
 * Does the finding cite a `testFileChanged:<path>` ref naming a test
 * file in the PR's changed set? This is the SIG-113 deletion/rename
 * exception — a real "PR removed test coverage" finding whose deleted
 * test can't be embedded. Such a finding ALWAYS keeps.
 */
function citesChangedTestFile(finding: PrReviewFinding, pack: TestingEvidencePack): boolean {
  if (!Array.isArray(finding.evidenceRefs)) return false
  const changed = new Set(pack.testFilesChanged)
  for (const ref of finding.evidenceRefs) {
    if (typeof ref !== "string") continue
    const trimmed = ref.trim()
    if (!trimmed.startsWith("testFileChanged:")) continue
    if (changed.has(trimmed.slice("testFileChanged:".length).trim())) return true
  }
  return false
}

/**
 * Does the finding cite a `siblingMapping:<finding.path>->NONE` that
 * REALLY exists in the pack (the source is a changed source whose
 * sibling is null)? This is the missing-coverage admissibility signal:
 * the cited mapping's source must equal the finding's path AND the
 * pack must actually carry that source as untested.
 */
function citesRealMissingCoverage(finding: PrReviewFinding, pack: TestingEvidencePack): boolean {
  if (!Array.isArray(finding.evidenceRefs)) return false
  // Real `<source>-><test|NONE>` map from the pack, mirroring the
  // SIG-113 gate's cross-check. A `->NONE` claim is only valid when the
  // pack agrees the source has no sibling.
  const realMappingBySource = new Map<string, string>()
  for (const m of pack.siblingMappings) {
    realMappingBySource.set(m.source, m.test ?? "NONE")
  }
  const findingPath = typeof finding.path === "string" ? finding.path.trim() : ""
  for (const ref of finding.evidenceRefs) {
    if (typeof ref !== "string") continue
    const parsed = parseSiblingMappingRef(ref)
    if (!parsed) continue
    // Relevance: the cited mapping must be ABOUT the file the finding
    // targets (mirrors SIG-113 — citing an unrelated file's mapping is
    // not a citation for THIS finding). Trim defensively so the helper
    // doesn't rely on the parser having trimmed `path`.
    if (parsed.source !== findingPath) continue
    // The pack must carry this source as genuinely untested (->NONE).
    if (realMappingBySource.get(parsed.source) === "NONE" && parsed.arrowValue === "NONE") {
      return true
    }
  }
  return false
}

/**
 * Does the finding cite at least one REAL inspected test file (via the
 * `inspectedTestFiles` array OR an `inspectedTestFile:<path>`
 * evidenceRef)? This is the insufficient-test admissibility signal: the
 * specialist actually read a test file before judging it inadequate.
 */
function citesRealInspectedTest(finding: PrReviewFinding, pack: TestingEvidencePack): boolean {
  const realInspected = new Set(pack.inspectedTestFiles)
  if (Array.isArray(finding.inspectedTestFiles)) {
    for (const p of finding.inspectedTestFiles) {
      if (typeof p === "string" && realInspected.has(p.trim())) return true
    }
  }
  if (Array.isArray(finding.evidenceRefs)) {
    for (const ref of finding.evidenceRefs) {
      if (typeof ref !== "string") continue
      const trimmed = ref.trim()
      if (!trimmed.startsWith("inspectedTestFile:")) continue
      if (realInspected.has(trimmed.slice("inspectedTestFile:".length).trim())) return true
    }
  }
  return false
}

/**
 * CLASS detection (vs admissibility): does the finding cite a
 * `siblingMapping:` evidenceRef AT ALL (regardless of whether it
 * resolves)? A finding that names a sibling mapping is making a
 * MISSING-COVERAGE claim — that's its class, even if the cited mapping
 * is for the wrong file or contradicts the pack. The resolve check
 * (`citesRealMissingCoverage`) then decides admissibility WITHIN the
 * class. Splitting class from admissibility is what lets the gate
 * REJECT a wrong-file / contradictory ->NONE claim instead of letting
 * it fall into the ambiguous-keep bucket.
 */
function citesSiblingMappingClass(finding: PrReviewFinding): boolean {
  if (!Array.isArray(finding.evidenceRefs)) return false
  // Codex review (HIGH): ONLY a `->NONE` mapping is a missing-coverage
  // claim. SIG-113 also accepts `siblingMapping:<source>-><test>` (a
  // COVERED mapping) — a concrete insufficient-test finding may cite that
  // to point at the existing test it read. Treating a `->test` ref as
  // missing-coverage would misclassify such a finding and drop it as
  // `uncited-missing-coverage`. A `->test` ref leaves the finding in the
  // ambiguous-keep bucket (unless it ALSO cites an inspected test).
  return finding.evidenceRefs.some((ref) => {
    if (typeof ref !== "string") return false
    const parsed = parseSiblingMappingRef(ref)
    return parsed !== null && parsed.arrowValue === "NONE"
  })
}

/**
 * CLASS detection (vs admissibility): does the finding cite an
 * inspected-test signal AT ALL (a non-empty `inspectedTestFiles` array
 * OR an `inspectedTestFile:<path>` evidenceRef), regardless of whether
 * the cited path is real? A finding citing an inspected test is making
 * an INSUFFICIENT-TEST claim; `citesRealInspectedTest` then decides
 * admissibility, and `namesConcreteTarget` the specificity.
 */
function citesInspectedClass(finding: PrReviewFinding): boolean {
  if (Array.isArray(finding.inspectedTestFiles)) {
    if (finding.inspectedTestFiles.some((p) => typeof p === "string" && p.trim().length > 0)) {
      return true
    }
  }
  if (Array.isArray(finding.evidenceRefs)) {
    return finding.evidenceRefs.some(
      (ref) => typeof ref === "string" && ref.trim().startsWith("inspectedTestFile:"),
    )
  }
  return false
}

/**
 * Does the finding's headline/body name something concrete — a code
 * identifier, a file path, or a branch/case keyword? FP-safe: ANY of the
 * specificity signals is enough to keep; we'd rather keep a borderline-
 * specific finding than drop a real one. Signal order is keep-biased and
 * length-independent (review fix): a backticked `parse` is concrete even
 * in a terse finding, so signals are checked with no length floor in
 * front of them.
 *
 * KNOWN GAP (code-review MEDIUM, accepted behind shadow): a finding
 * concrete only in PROSE — naming a behavior in plain English with no
 * backtick, no code-ish identifier, and no keyword from the list (e.g.
 * "the cancellation case is never exercised") — returns false and would
 * drop in enforce. The prompt instructs the model to backtick
 * identifiers, so most concrete findings hit signal 1; the shadow
 * telemetry quantifies this would-drop bucket before any enforce flip.
 */
function namesConcreteTarget(finding: PrReviewFinding): boolean {
  const text = `${finding.headline} ${finding.body}`
  // Signal 1: a backticked identifier / path (the prompt instructs the
  // model to backtick identifiers — a concrete finding names one).
  if (/`[^`]+`/.test(text)) return true
  // Signal 2: a code-ish identifier (camelCase / snake_case / dotted /
  // a path segment with an extension) appearing bare in the text.
  if (/[A-Za-z_$][A-Za-z0-9_$]*(?:[.(/][A-Za-z0-9_$./-]+)+/.test(text)) return true
  // Signal 3: names a specific branch/case/path class to test. A
  // branch/case keyword IS itself a concrete target (review fix: the old
  // "needs more tests" veto was demoting concretely-named branches like
  // "the timeout branch needs more tests" to a drop — a false negative
  // contradicting the keep-biased contract). So the keyword counts even
  // alongside vague call-to-action phrasing.
  if (
    /\b(branch|error path|edge case|null|undefined|throw|reject|exception|boundary|overflow|race|timeout|retry|fallback)\b/i.test(text)
  ) {
    return true
  }
  return false
}

/**
 * Pure decision for ONE testing-applicable finding. The caller has
 * already confirmed `finding.category === "testing"` upstream context
 * and run the SIG-113 citation gate; this helper applies the
 * specificity rule. Mode-agnostic — the orchestrator gates the drop
 * behind shadow/enforce.
 *
 * Contract:
 *   - score < 4 testing findings always pass (the specificity bar is
 *     sev>=4 only; lower-severity coverage nits don't need it).
 *   - non-testing findings always pass (defensive — the caller already
 *     scopes by category, but keep the helper self-contained).
 *   - a finding citing `testFileChanged:<path>` for a real changed test
 *     ALWAYS keeps (SIG-113 deletion/rename exception).
 *   - MISSING-COVERAGE class (cites a siblingMapping, not an inspected
 *     test): keep iff `citesRealMissingCoverage`; else reject
 *     `uncited-missing-coverage`. The finding must require a concrete
 *     `path`.
 *   - INSUFFICIENT-TEST class (cites an inspected test, not a sibling
 *     mapping): keep iff `namesConcreteTarget` AND not a bare
 *     "needs more tests"; else reject `vague-insufficient-test`. The
 *     finding must require a concrete `path`.
 *   - AMBIGUOUS (cites both, or neither): prefer KEEP (the SIG-113
 *     gate already required SOME real citation; an ambiguous shape is
 *     not a clear FP, so don't risk a false negative).
 */
export function evaluateTestFinding(
  finding: PrReviewFinding,
  pack: TestingEvidencePack | undefined,
): TestFindingDecision {
  // Scope: only sev>=4 testing findings are subject to the specificity
  // bar. Everything else passes untouched.
  if (finding.category !== "testing") return { keep: true }
  if (finding.score < 4) return { keep: true }

  // No pack to cross-check against (pure docs PR, or caller hasn't
  // threaded the pack) → no evidence to gate on; keep (mirrors the
  // SIG-113 "absent/empty pack" branch + back-compat for the staged
  // rollout).
  if (!pack || (pack.sourceFilesChanged.length === 0 && pack.testFilesChanged.length === 0)) {
    return { keep: true }
  }

  // SIG-113 deletion/rename exception: a real "PR removed test coverage"
  // finding citing a changed/deleted test file ALWAYS keeps. Checked
  // FIRST so it can never be reclassified into a reject path.
  if (citesChangedTestFile(finding, pack)) return { keep: true }

  // A sev>=4 testing finding needs a concrete path to be actionable.
  // The SIG-113 gate doesn't require this; the missing-coverage check
  // below relies on it for the relevance cross-check. An empty path is
  // a clear FP shape (can't anchor, can't cross-check).
  if (typeof finding.path !== "string" || finding.path.trim().length === 0) {
    return { keep: false, reason: "missing-path" }
  }

  // Classify by which citation KIND the finding leans on — independent
  // of whether that citation resolves. A finding citing a
  // `siblingMapping:` ref is making a MISSING-COVERAGE claim; one citing
  // an inspected test is making an INSUFFICIENT-TEST claim. The resolve
  // / specificity checks below decide admissibility WITHIN the chosen
  // class. Splitting class from admissibility is what lets the gate
  // reject a wrong-file / contradictory ->NONE claim rather than letting
  // it slip into the ambiguous-keep bucket.
  const missingClass = citesSiblingMappingClass(finding)
  const insufficientClass = citesInspectedClass(finding)

  // AMBIGUOUS: cites BOTH kinds, or NEITHER. Prefer keep (the FP-safe
  // crux) — the SIG-113 gate already required SOME real citation, and a
  // finding that straddles both classes (or fits neither cleanly) is not
  // a clear FP. Risking a false negative on an ambiguous shape is the
  // exact failure the SIG-108 review flagged.
  if (missingClass === insufficientClass) return { keep: true }

  if (missingClass) {
    // Missing-coverage claim. Admissible only when the cited mapping is
    // a real `siblingMapping:<finding.path>->NONE` in the pack (relevant
    // + the pack agrees the source is genuinely untested). A wrong-file
    // or contradictory ->NONE is the uncited-missing-coverage FP shape.
    return citesRealMissingCoverage(finding, pack)
      ? { keep: true }
      : { keep: false, reason: "uncited-missing-coverage" }
  }

  // Insufficient-test claim. Require (a) a real inspected test was read
  // AND (b) the body/headline names a concrete source/API/branch — not a
  // bare "needs more tests" nudge. A finding that names a concrete target
  // keeps even if it ALSO uses vague phrasing (`namesConcreteTarget` is
  // the positive signal). When the inspected citation doesn't resolve OR
  // nothing concrete is named, it's the vague-insufficient-test FP shape.
  if (citesRealInspectedTest(finding, pack) && namesConcreteTarget(finding)) {
    return { keep: true }
  }
  return { keep: false, reason: "vague-insufficient-test" }
}
