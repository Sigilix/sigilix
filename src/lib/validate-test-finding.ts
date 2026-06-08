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
  | "unbacked-source-coverage-no-evidence" // sev>=4 source coverage claim when no testing evidence pack exists
  | "uncited-missing-coverage" // "source lacks tests" claim not backed by a real ->NONE mapping for finding.path
  | "vague-insufficient-test" // "tests inadequate" claim that names no concrete source/API/branch
  | "glue-covered-by-helper" // SIG-128 / SIG-166-1: missing-coverage (->NONE) OR insufficient-test finding on a file whose changed logic fully delegates to same-PR tested helpers
  | "glue-covered-by-structure" // SIG-128 PR 6 / SIG-166-1: missing-coverage (->NONE) OR insufficient-test finding on a file whose changed logic is structurally orchestrator glue (small + delegation-shaped), independent of whether the delegated-to helpers are same-PR tested
  | "cross-referenced-in-sibling-test" // SIG-347 / SIG-166-2: insufficient-test finding whose cited concrete identifier is already referenced by an in-diff sibling test we fetched (the PR #144 over-fire shape — `parsePrReviewResponse` cited while tests/triage-pr-review.test.ts covers it in the same PR)

/**
 * Parse a `siblingMapping:<source>-><test|NONE>` evidenceRef into its
 * source + arrow value. Mirrors the SIG-113 citation-gate ref parsing
 * (`evaluateTestingFindingCitation`) so the two gates agree on what a
 * mapping ref means. Returns null for any other ref shape.
 */
/**
 * SIG-118: parse a `coverageGap:<path>:<line>` evidenceRef. The line is
 * read from the LAST colon so paths that themselves contain colons
 * (e.g. a Windows drive or a URL-shaped path) don't break parsing.
 * Returns null for any non-coverageGap ref or a non-positive-integer
 * line. Shared by `evaluateTestFinding` (SIG-111) and
 * `evaluateTestingFindingCitation` (SIG-113) so the two gates agree on
 * the shape (defined here, the lower-level module, to avoid a circular
 * import with the orchestrator).
 */
export function parseCoverageGapRef(ref: string): { path: string; line: number } | null {
  if (typeof ref !== "string") return null
  const trimmed = ref.trim()
  if (!trimmed.startsWith("coverageGap:")) return null
  const i = trimmed.lastIndexOf(":")
  // A valid ref has a SECOND colon separating path from line, so the
  // last colon must be strictly after the prefix's own colon.
  if (i < "coverageGap:".length) return null
  const path = trimmed.slice("coverageGap:".length, i)
  const lineStr = trimmed.slice(i + 1)
  if (path.length === 0 || lineStr.length === 0) return null
  const line = Number(lineStr)
  if (!Number.isInteger(line) || line <= 0) return null
  return { path, line }
}

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
 * SIG-118: does the finding cite at least one REAL coverage gap for its
 * own path? A `coverageGap:<path>:<line>` ref is admissible only when
 * (a) `<path>` equals `finding.path` (relevance, mirroring the sibling-
 * mapping rule) AND (b) `"<path>:<line>"` is in the real gap set passed
 * to the gate (the LCOV-derived added-and-uncovered set). This is a
 * MISSING-COVERAGE-style claim backed by deterministic CI evidence.
 */
function citesRealCoverageGap(
  finding: PrReviewFinding,
  coverageGaps: ReadonlySet<string>,
): boolean {
  if (coverageGaps.size === 0) return false
  if (!Array.isArray(finding.evidenceRefs)) return false
  const findingPath = typeof finding.path === "string" ? finding.path.trim() : ""
  for (const ref of finding.evidenceRefs) {
    if (typeof ref !== "string") continue
    const parsed = parseCoverageGapRef(ref)
    if (parsed === null) continue
    if (parsed.path !== findingPath) continue
    if (coverageGaps.has(`${parsed.path}:${parsed.line}`)) return true
  }
  return false
}

/**
 * SIG-118: does the finding cite a `coverageGap:` ref AT ALL (resolved or
 * not)? A REAL coverageGap for the finding's path keeps earlier; this
 * detects an UNRESOLVED one. It only promotes the finding to the
 * missing-coverage class when there's no competing real insufficient-test
 * class (see `evaluateTestFinding`) — so it catches a fabricated
 * coverageGap-only claim WITHOUT letting one piggyback on a real
 * inspected-test citation to escape via ambiguous-keep (Codex HIGH).
 */
function citesCoverageGapClass(finding: PrReviewFinding): boolean {
  if (!Array.isArray(finding.evidenceRefs)) return false
  return finding.evidenceRefs.some((ref) => parseCoverageGapRef(ref) !== null)
}

/**
 * Does the finding cite at least one REAL inspected test file (via the
 * `inspectedTestFiles` array OR an `inspectedTestFile:<path>`
 * evidenceRef)? This is one insufficient-test admissibility signal: the
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

function citesRealCoveredSiblingMapping(finding: PrReviewFinding, pack: TestingEvidencePack): boolean {
  if (!Array.isArray(finding.evidenceRefs)) return false
  const realMappingBySource = new Map<string, string>()
  for (const m of pack.siblingMappings) {
    if (m.test !== null) realMappingBySource.set(m.source, m.test)
  }
  const findingPath = typeof finding.path === "string" ? finding.path.trim() : ""
  for (const ref of finding.evidenceRefs) {
    if (typeof ref !== "string") continue
    const parsed = parseSiblingMappingRef(ref)
    if (!parsed) continue
    if (parsed.source !== findingPath) continue
    const realTest = realMappingBySource.get(parsed.source)
    if (realTest !== undefined && parsed.arrowValue === realTest) return true
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

function isLikelyTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\/|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
}

/**
 * CLASS detection (vs admissibility): does the finding cite an
 * inspected-test signal AT ALL (a non-empty `inspectedTestFiles` array
 * OR an `inspectedTestFile:<path>` evidenceRef), regardless of whether
 * the cited path is real? A finding citing an inspected test is making
 * an INSUFFICIENT-TEST claim; `citesRealInspectedTest` then decides
 * whether that inspected-test citation is real, and `namesConcreteTarget`
 * the specificity.
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

function citesCoveredSiblingMappingClass(finding: PrReviewFinding): boolean {
  if (!Array.isArray(finding.evidenceRefs)) return false
  return finding.evidenceRefs.some((ref) => {
    if (typeof ref !== "string") return false
    const parsed = parseSiblingMappingRef(ref)
    return parsed !== null && parsed.arrowValue !== "NONE"
  })
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

function claimsSpeculativeConstantIntent(finding: PrReviewFinding): boolean {
  const text = `${finding.headline} ${finding.body} ${finding.testGap ?? ""}`
  return (
    /\b(?:signal(?:s|ing|ed)?|suggest(?:s|ing|ed)?|indicat(?:es|ing|ed)?|implies|intent|future|eventually|prepar(?:es|ing|ed)?)\b/i.test(text)
    && /\b(?:const(?:ant)?|default value|delayMs|timeoutMs|backoff delay|retry delay)\b/i.test(text)
  )
}

function namesConcreteBranchOrErrorPath(finding: PrReviewFinding): boolean {
  const text = `${finding.headline} ${finding.body} ${finding.testGap ?? ""}`
  return (
    /\b(?:branch|error path|failure path|failure case|rejection|throw|throws|thrown|catch|rejects?|exception|guard|negative case|null case|undefined case|boundary case|overflow case|race case|timeout branch)\b/i.test(text)
    || /`[^`]*(?:if\s*\(|throw|catch|reject|timeout|null|undefined)[^`]*`/i.test(text)
  )
}

function claimsRetryDelayWithoutConcreteExecutionPath(finding: PrReviewFinding): boolean {
  const text = `${finding.headline} ${finding.body} ${finding.testGap ?? ""}`
  return (
    /\b(?:backoff|delayMs|timeoutMs|delay|timeout)\b/i.test(text)
    && /\b(?:happy path|success(?:ful)? path|successful attempt|only asserts|only covers|only exercises|does not cover|doesn't cover|missing coverage|needs coverage)\b/i.test(text)
    && !namesConcreteBranchOrErrorPath(finding)
  )
}

function claimsAbsentRetryImplementationAsTestGap(finding: PrReviewFinding): boolean {
  const text = `${finding.headline} ${finding.body} ${finding.testGap ?? ""}`
  const retryConcept = /\b(?:retry|backoff|fallback)\b/i.test(text)
  if (!retryConcept) return false
  const nameImpliesBehavior = /\b(?:function|method|api)\s+name\s+(?:implies|suggests|signals)\b/i.test(text)
  const nameOrUtilityOnly =
    /\bnamed\s+`?retry/i.test(text) ||
    /\bexports?\s+(?:a\s+)?(?:promise-based\s+)?retry\s+(?:utility|function|helper)\b/i.test(text) ||
    /\bfunction\s+is\s+named\s+`?retry/i.test(text)
  const absentBehavior =
    /\bno\s+retry\s+attempts\b/i.test(text) ||
    /\bwithout\s+(?:any\s+)?(?:retry|failure|backoff|fallback)[^.]{0,80}\bbehavior\s+tested\b/i.test(text) ||
    /\bno\s+`?catch`?\/failure\s+or\s+backoff\s+behavior\b/i.test(text)
  if ((nameImpliesBehavior || nameOrUtilityOnly) && absentBehavior) return true
  return (
    nameImpliesBehavior ||
    /\b(?:no|without|lacks?)\s+(?:retry|backoff|fallback)\s+(?:loop|logic|behavior|behaviour|implementation)\b/i.test(text) ||
    /\bstill\s+(?:contains|has)\s+no\s+(?:retry|backoff|fallback)\b/i.test(text)
  )
}

/**
 * SIG-347 (AC #2): generic identifiers that would match almost any test
 * body — excluded from the sibling-test cross-check so a finding citing
 * only a token like `error` can't be falsely suppressed. The cross-check's
 * safety belt (a too-generic / too-short token never triggers a drop).
 */
const CROSS_CHECK_STOPLIST = new Set<string>([
  "null", "undefined", "true", "false", "error", "value", "result", "data",
  "function", "return", "async", "await", "const", "type", "test", "expect",
  "string", "number", "object", "array", "promise", "void",
])

/**
 * SIG-347 (AC #2): extract the concrete identifiers a finding names, for
 * the sibling-test cross-check. Reads the HEADLINE only — the finding's
 * primary subject (the prompt instructs the model to name the concrete
 * target there). Scoping to the headline (not headline+body) shrinks the
 * false-suppression surface: a finding that only mentions a symbol in
 * passing body prose is NOT cross-checked, so it keeps (recall-favoring).
 * Pulls backticked code spans and keeps the LEADING identifier token of
 * each — `parsePrReviewResponse(x)` → `parsePrReviewResponse`,
 * `parser.run` → `parser`. Keeps only identifier-shaped tokens of length
 * >= 4 that aren't in `CROSS_CHECK_STOPLIST`. The length + stoplist floor is
 * the safety belt: a too-generic / too-short token can't trigger a false drop.
 */
function extractCitedIdentifiers(finding: PrReviewFinding): string[] {
  const text = typeof finding.headline === "string" ? finding.headline : ""
  const out = new Set<string>()
  const backtick = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = backtick.exec(text)) !== null) {
    const span = m[1] ?? ""
    const idMatch = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(span)
    if (!idMatch) continue
    const id = idMatch[0]
    if (id.length < 4) continue
    if (CROSS_CHECK_STOPLIST.has(id.toLowerCase())) continue
    out.add(id)
  }
  return [...out]
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * SIG-347 (AC #2): is the finding's cited identifier already referenced by
 * the in-diff **sibling** test of the finding's own source path?
 *
 * Sibling-scoped (AC #2 is about the "corresponding source"): only the test
 * paired with `finding.path` in `pack.siblingMappings` is scanned — an
 * UNRELATED changed test that happens to mention the same token must not
 * suppress the finding. That sibling is scanned only when it is BOTH in the
 * PR's changed set (`testFilesChanged`) AND has fetched content
 * (`inspectedTestContentByPath`), so the check reflects the actual diff, not
 * the whole repo. A word-boundary identifier hit means the "existing tests
 * don't cover X" claim is an over-fire (PR #144: `parsePrReviewResponse`
 * cited while the same PR's `tests/triage-pr-review.test.ts` references it).
 * FP-safe: returns false when no identifier is extractable, the source has no
 * in-diff sibling test, or no sibling body is available — the gate then keeps
 * the finding via its normal path.
 */
function isCrossReferencedInSiblingTest(
  finding: PrReviewFinding,
  pack: TestingEvidencePack,
): boolean {
  const contentByPath = pack.inspectedTestContentByPath
  if (!contentByPath) return false
  const idents = extractCitedIdentifiers(finding)
  if (idents.length === 0) return false
  const findingPath = typeof finding.path === "string" ? finding.path.trim() : ""
  if (findingPath.length === 0) return false
  // The sibling test(s) of THIS finding's source path — not every changed test.
  const siblingTests = new Set<string>()
  for (const m of pack.siblingMappings) {
    if (m.source === findingPath && typeof m.test === "string") siblingTests.add(m.test)
  }
  if (siblingTests.size === 0) return false
  // Word-boundary match (no lookbehind) so `parse` doesn't hit inside
  // `parseFoo`; `$`/`_` count as identifier chars at the boundary. Compiled
  // once per identifier (not per identifier × test-body) — Sigilix #401 perf.
  const idRegexes = idents.map(
    (id) => new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeForRegExp(id)}(?:[^A-Za-z0-9_$]|$)`),
  )
  const changed = new Set(pack.testFilesChanged)
  for (const testPath of siblingTests) {
    if (!changed.has(testPath)) continue
    const body = contentByPath[testPath]
    if (typeof body !== "string" || body.length === 0) continue
    for (const re of idRegexes) {
      if (re.test(body)) return true
    }
  }
  return false
}

const ERROR_PATH_ASSERTION_RE = /\b(?:toThrow|toThrowError|rejects|toReject|catch|throws?)\b/
const ERROR_TOKEN_RE = /\b[A-Z][A-Za-z0-9_$]*(?:Error|Exception)\b/g
const QUOTED_ERROR_TOKEN_RE = /(["'`])([^"'`\n]{4,120})\1/g

function normalizeErrorPathToken(token: string): string | null {
  const t = token.trim().replace(/\s+/g, " ")
  if (t.length < 4) return null
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t) && !/(?:Error|Exception)$/i.test(t)) return null
  if (/^(?:error branch|error path|failure path|rejection path|exception branch)$/i.test(t)) return null
  return t.toLowerCase()
}

function extractConcreteErrorPathTokens(finding: PrReviewFinding): string[] {
  const text = `${finding.headline} ${finding.body} ${finding.testGap ?? ""}`
  const out = new Set<string>()
  for (const m of text.matchAll(ERROR_TOKEN_RE)) {
    const token = normalizeErrorPathToken(m[0] ?? "")
    if (token) out.add(token)
  }
  for (const m of text.matchAll(QUOTED_ERROR_TOKEN_RE)) {
    const token = normalizeErrorPathToken(m[2] ?? "")
    if (token) out.add(token)
  }
  return [...out]
}

function concreteBranchOrErrorPathAlreadyAssertedInSiblingTest(
  finding: PrReviewFinding,
  pack: TestingEvidencePack,
): boolean {
  const contentByPath = pack.inspectedTestContentByPath
  if (!contentByPath) return false
  const text = `${finding.headline} ${finding.body} ${finding.testGap ?? ""}`
  if (!/\b(?:error path|error branch|failure path|failure branch|failure case|rejection|rejection branch|throw|throws|thrown|throw branch|catch|rejects?|exception|exception branch)\b/i.test(text)) {
    return false
  }
  const tokens = extractConcreteErrorPathTokens(finding)
  if (tokens.length === 0) return false
  const findingPath = typeof finding.path === "string" ? finding.path.trim() : ""
  if (findingPath.length === 0) return false
  const changed = new Set(pack.testFilesChanged)
  for (const m of pack.siblingMappings) {
    if (m.source !== findingPath || typeof m.test !== "string" || !changed.has(m.test)) continue
    const body = contentByPath[m.test]
    if (typeof body !== "string" || body.length === 0) continue
    const normalizedBody = body.toLowerCase()
    if (ERROR_PATH_ASSERTION_RE.test(body) && tokens.some((token) => normalizedBody.includes(token))) return true
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
 *   - GLUE SUPPRESSION (hoisted, applies first): SIG-128 + SIG-166-1 —
 *     reject `glue-covered-by-helper` when the pack marks `finding.path`
 *     helper-covered with status "all"; reject `glue-covered-by-structure`
 *     when the pack marks it `structurallyGlue: true`. Fires for the
 *     MISSING-COVERAGE or INSUFFICIENT-TEST classes (and the ambiguous
 *     case where the finding cites both). Does NOT fire for a pure
 *     coverageGap-only class — that path is reserved for the
 *     uncited-missing-coverage reject (preserves the CodeRabbit-scoping
 *     test at tests/validate-test-finding.test.ts).
 *   - MISSING-COVERAGE class (cites a siblingMapping, not an inspected
 *     test): keep iff `citesRealMissingCoverage`; else reject
 *     `uncited-missing-coverage`. The finding must require a concrete
 *     `path`.
 *   - INSUFFICIENT-TEST class (cites an inspected test, not a sibling
 *     mapping): keep iff `namesConcreteTarget` AND not a bare
 *     "needs more tests"; else reject `vague-insufficient-test`. The
 *     finding must require a concrete `path`.
 *   - AMBIGUOUS (cites both, or neither): prefer KEEP unless the
 *     hoisted glue suppression fires above. The "neither" branch is the
 *     SIG-113 keep-by-default fallback (no class signal, no FP shape).
 */
export function evaluateTestFinding(
  finding: PrReviewFinding,
  pack: TestingEvidencePack | undefined,
  /**
   * SIG-118: the real coverage-gap set, keyed `"<path>:<line>"`. Defaults
   * to an empty set (back-compat for callers that don't ingest coverage).
   * A finding citing a real `coverageGap:<finding.path>:<line>` is making
   * an admissible MISSING-COVERAGE claim backed by deterministic CI
   * evidence — it ALWAYS keeps.
   */
  coverageGaps: ReadonlySet<string> = new Set<string>(),
): TestFindingDecision {
  // Scope: only sev>=4 testing findings are subject to the specificity
  // bar. Everything else passes untouched.
  if (finding.category !== "testing") return { keep: true }
  if (finding.score < 4) return { keep: true }

  // No pack to cross-check against (legacy caller hasn't threaded it) →
  // no evidence to gate on; keep for back-compat.
  if (!pack) {
    return { keep: true }
  }

  // SIG-113 deletion/rename exception: a real "PR removed test coverage"
  // finding citing a changed/deleted test file ALWAYS keeps. Checked
  // FIRST so it can never be reclassified into a reject path.
  if (citesChangedTestFile(finding, pack)) return { keep: true }

  // SIG-118: a real coverage-gap citation for the finding's own path is
  // a deterministic-CI-backed missing-coverage claim — it ALWAYS keeps.
  // Checked alongside the deletion/rename exception (before the path /
  // class machinery) so a legitimately-cited coverage gap can never be
  // reclassified into the uncited-missing-coverage reject path.
  if (citesRealCoverageGap(finding, coverageGaps)) return { keep: true }

  // A sev>=4 testing finding needs a concrete path to be actionable.
  // The SIG-113 gate doesn't require this; the missing-coverage check
  // below relies on it for the relevance cross-check. An empty path is
  // a clear FP shape (can't anchor, can't cross-check).
  if (typeof finding.path !== "string" || finding.path.trim().length === 0) {
    return { keep: false, reason: "missing-path" }
  }

  // SIG-349 / V4 Flash calibration: when the testing evidence pack is
  // empty, there is no authoritative source→test map or inspected test
  // content. A score>=4 source-coverage finding in that state is an
  // unbacked "no tests/no coverage" claim, often a duplicate security or
  // performance bug wearing a testing label. Changed test-file quality
  // findings remain admissible, but source coverage claims must wait for
  // real testing evidence.
  if (pack.sourceFilesChanged.length === 0 && pack.testFilesChanged.length === 0) {
    return isLikelyTestPath(finding.path.trim())
      ? { keep: true }
      : { keep: false, reason: "unbacked-source-coverage-no-evidence" }
  }

  // Classify by which citation KIND the finding leans on — independent
  // of whether that citation resolves. A `siblingMapping:` ref is a
  // MISSING-COVERAGE claim only when it points to `->NONE`; a covered
  // `siblingMapping:<source>-><test>` or inspected-test citation is an
  // INSUFFICIENT-TEST claim. The resolve / specificity checks below
  // decide admissibility WITHIN the chosen class.
  //
  const insufficientClass = citesInspectedClass(finding) || citesCoveredSiblingMappingClass(finding)
  const siblingMissingClass = citesSiblingMappingClass(finding)
  // Codex review (HIGH): an UNRESOLVED `coverageGap:` ref (a real one for
  // the finding's path already kept at :381) promotes to missing-class
  // ONLY when there's no competing real insufficient-test class. This
  // catches a fabricated coverageGap-only claim (→ uncited-missing-
  // coverage) while preventing a bogus coverageGap from piggybacking on a
  // real inspected-test citation to straddle both classes and escape via
  // ambiguous-keep (the bypass Codex flagged).
  const missingClass =
    siblingMissingClass || (citesCoverageGapClass(finding) && !insufficientClass)

  // SIG-166-1: structural orchestrator-glue suppression fires for EITHER
  // the ->NONE sibling-mapping missing class OR the insufficient-test
  // class on the SAME glue files (founder feedback on PR #144,
  // 2026-05-23). Originally (SIG-128 + PR 6) the suppression was hoisted
  // only inside the missing-class branch and scoped to siblingMissingClass,
  // but the testing specialist over-fires the SAME orchestrator-glue FP
  // shape via the insufficient-test class too — same helper-covered /
  // structurally-glue sources, different citation kind. Scoping to
  // `siblingMissingClass || insufficientClass` keeps the coverageGap-only
  // class routing through `uncited-missing-coverage`, preserving the
  // CodeRabbit-scoping invariant at
  // tests/validate-test-finding.test.ts:399.
  if (siblingMissingClass || insufficientClass) {
    const helperCov = pack.helperCoverageBySource?.[finding.path.trim()]
    if (helperCov?.status === "all") {
      return { keep: false, reason: "glue-covered-by-helper" }
    }
    if (helperCov?.structurallyGlue === true) {
      return { keep: false, reason: "glue-covered-by-structure" }
    }
  }

  if (claimsAbsentRetryImplementationAsTestGap(finding)) {
    return { keep: false, reason: "vague-insufficient-test" }
  }

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

  // Insufficient-test claim. Require (a) a real inspected test or covered
  // sibling mapping was cited AND (b) the body/headline names a concrete
  // source/API/branch — not a bare "needs more tests" nudge.
  // A finding that names a concrete target
  // keeps even if it ALSO uses vague phrasing (`namesConcreteTarget` is
  // the positive signal). When the inspected citation doesn't resolve OR
  // nothing concrete is named, it's the vague-insufficient-test FP shape.
  if (
    (citesRealInspectedTest(finding, pack) || citesRealCoveredSiblingMapping(finding, pack))
    && namesConcreteTarget(finding)
    && (!claimsSpeculativeConstantIntent(finding) || namesConcreteBranchOrErrorPath(finding))
    && !claimsRetryDelayWithoutConcreteExecutionPath(finding)
  ) {
    // SIG-347 (AC #2): the specialist read a real test AND named a concrete
    // target — but if that target is already referenced by an in-diff sibling
    // test, the "existing tests are insufficient" claim is the PR #144
    // over-fire shape. Cross-check the fetched test body before keeping.
    // A finding that names a concrete branch/error/rejection path is not
    // refuted merely because the test mentions the same exported function on
    // a happy path. It can only be demoted when the sibling test also shows an
    // error assertion and shares a specific error/path token from the finding.
    if (
      citesRealInspectedTest(finding, pack) &&
      (
        !namesConcreteBranchOrErrorPath(finding) ||
        concreteBranchOrErrorPathAlreadyAssertedInSiblingTest(finding, pack)
      ) &&
      isCrossReferencedInSiblingTest(finding, pack)
    ) {
      return { keep: false, reason: "cross-referenced-in-sibling-test" }
    }
    return { keep: true }
  }
  return { keep: false, reason: "vague-insufficient-test" }
}
