// SIG-318 (PR 8) / SIG-360 — the PR-review post-synthesis VALIDATION domain.
//
// The believability core: the hallucination guard, the per-lens evidence gates,
// scope/anchor normalization, and `validateForSubmission`. Recall-safety is the
// load-bearing invariant — a real P0/P1 never disappears SILENTLY: it is conserved
// inline or demoted to the body, OR hard-dropped by one of the 5 positively-judging
// gates (logic-evidence / logic-refutation / logic-claim-refutation / perf-evidence /
// testing-citation) WITH a recorded drop counter; every gate fails CLOSED to KEEP
// when uncertain. Behavior is pinned by
// tests/validation-golden-matrix + tests/validation-never-drop; do not regenerate
// those fixtures. The `validate-*` / trust-ledger gate family now lives in-domain
// under `./gates/` (SIG-385); the only residual laterals are the pure lib helpers
// (secret-scan reached via the gates; the type-only evidence/config leaves), which
// are shared with the orchestrator and stay at the edge.

import type {
  PrReviewVerdict,
  PrReviewFinding,
  EvidenceRecord,
  ReviewFindingScope,
} from "@/shared/domain/pr-review-finding"
import { ALL_SPECIALISTS, type SpecialistRole } from "@/shared/domain/specialist-role"
import { deriveSide, type ReviewableMap } from "@/shared/util/diff-positions"
import type { PrReviewVerdictWithIds } from "./findings"
// SIG-386 (PR1): the private, pure helper clusters lifted out of this core to
// `./validation-internals.ts` (evidence-record builders, security/rationale
// backfill, scope normalization, anchor repair, guard predicates). Relocation
// only — byte-identical bodies, no behavior change. The leaf type-imports
// CollectedVerdict/SynthesizerProvenance back from here (type-only, erased), so
// there is no runtime cycle.
import {
  buildSourceFindingSecurityEvidenceById,
  backfillSecurityEvidenceFromSources,
  buildSourceFindingRationaleById,
  backfillIndependentAssessmentFromSources,
  buildFindingEvidenceRecord,
  normalizeFindingScopeForAnchorability,
  resolveLensRationale,
  findRangeAwareAnchor,
  findRepairableInlineAnchor,
} from "./validation-internals"
// SIG-385: the validation gate family now lives IN this domain layer, under
// `./gates/`. These are in-domain sibling imports — no longer laterals to the
// god-file. The remaining documented laterals are the pure lib helpers below
// (secret-scan via the gates, the type-only evidence/config leaves).
import {
  evaluateSecurityFinding,
  deriveSecurityBucket,
  factClassCompatible,
  AUTHZ_BUCKET,
  type SecurityValidatorMode,
  type SecurityDropReason,
} from "./gates/validate-security-finding"
import { findingClaimsIntraInstanceRace } from "./gates/validate-do-race-finding"
import {
  evaluateTestFinding,
  parseCoverageGapRef,
  type TestsValidatorMode,
  type TestDropReason,
} from "./gates/validate-test-finding"
import {
  evaluateLogicFinding,
  type LogicValidatorMode,
  type LogicDropReason,
  type LogicEvidence,
} from "./gates/validate-logic-finding"
import {
  evaluateLogicRefutation,
  type LogicRefutationMode,
  type LogicRefutationDropReason,
} from "./gates/validate-logic-refutation"
import {
  evaluateRefutationSurvival,
  type RefutationSurvivalMode,
  type RefutationSurvivalDropReason,
} from "./gates/validate-refutation-survival"
import {
  evaluateLogicClaimRefutation,
  type LogicClaimRefutationMode,
  type LogicClaimDropReason,
} from "./gates/validate-logic-claim-refutation"
import {
  evaluatePerfFinding,
  perfFindingIsSelfOriginated,
  type PerfValidatorMode,
  type PerfDropReason,
  type PerfEvidence,
} from "./gates/validate-perf-finding"
import {
  evaluateInlineGrounding,
  type InlineGroundingValidatorMode,
  type InlineGroundingDropReason,
} from "./gates/validate-inline-grounding"
import {
  evaluateAbsenceGrounding,
  type AbsenceClaimValidatorMode,
  type AbsenceGroundingDropReason,
} from "./gates/validate-absence-grounding"
import {
  evaluateWindowBlindness,
  type WindowBlindnessValidatorMode,
  type WindowBlindnessDropReason,
} from "./gates/validate-window-blindness"
import {
  evaluateSecurityGrounding,
  type SecurityGroundingValidatorMode,
  type SecurityGroundingDropReason,
} from "./gates/validate-security-grounding"
import {
  evaluateSecurityUsage,
  type SecurityUsageValidatorMode,
  type SecurityUsageDropReason,
} from "./gates/validate-security-usage"
import { annotateFindingTrust } from "./gates/trust-ledger-thread"
import {
  dampTestingScoreForRatio,
  TEST_RATIO_DAMPER_THRESHOLD,
} from "./gates/test-ratio-damper"
import type { TestingEvidencePack } from "../../testing-evidence-pack"
import type { SecurityFact } from "../../security-evidence-manifest"
import type { SigilixProfile } from "../../sigilix-config"
import { lineInDurableObjectClass, type LineSpan, type AstCache } from "@/features/ast-rules"

const MAX_ADVISORY_NITS = 5

export interface SynthesizerProvenance {
  findings: Array<{
    sourceSpecialists: SpecialistRole[]
    sourceFindingIds: string[]
    action: "kept" | "merged" | "rewritten"
    verifiedViaRetrieval: boolean
  }>
  dropped: Array<{
    specialist: SpecialistRole
    sourceFindingId: string
    headline: string
    reason: string
  }>
  /**
   * ARC-189: findings the synth softened in response to a [REVIEW
   * MEMORY] block (matched on category, optionally on pathSha12 for
   * path-scoped memories). Optional + sparse: synths emitting
   * pre-v2 outputs (no review memory) omit this field, which
   * `isValidProvenance` accepts. The renderer applies a one-tier
   * `score` decrement on the matched finding before posting.
   */
  softened?: Array<{
    specialist: SpecialistRole
    sourceFindingId: string
    headline: string
    reason: string
  }>
}

export interface CollectedVerdict {
  role: SpecialistRole
  verdict: PrReviewVerdictWithIds | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  /** ARC-284: per-specialist accounting threaded through for the
   *  `specialist-fanout-summary` telemetry event. Undefined when the
   *  Promise.allSettled wrapper rejected before runSpecialist could
   *  emit (e.g. orchestrator-signal abort BEFORE the first attempt). */
  attemptsUsed?: number
  modelUsed?: string
}

// ─── post-synthesis validation ────────────────────────────────────────

/**
 * ARC-156 (Greptile port A2): vague-prefix filter — drop any finding
 * whose `headline` or `body` starts with one of these words (case-
 * sensitive, word-boundary). The negative-constraint specialist
 * prompts (see `SHARED_NEGATIVE_CONSTRAINTS` in pr-review-specialists.ts)
 * tell the model not to emit these; this post-processing filter is
 * the backstop for findings that slip through.
 */
export const VAGUE_PREFIXES = [
  "Ensure",
  "Verify",
  "Validate",
  "Consider",
  "Review",
  "Confirm",
] as const

/**
 * Returns true when the finding's headline OR body begins with one
 * of the VAGUE_PREFIXES words (followed by end-of-string or a
 * non-letter character so we don't false-match e.g. "Ensures").
 *
 * Pure — exported for unit tests.
 */
export function hasVaguePrefix(finding: PrReviewFinding): boolean {
  return startsWithVagueWord(finding.headline) || startsWithVagueWord(finding.body)
}

/**
 * Word-boundary regex for the vague prefix check. Built once from
 * VAGUE_PREFIXES so the boundary semantics match the stated
 * "any non-letter character" contract — covers `-`, `/`, `"`, `'`,
 * `[`, `\\`, etc. (Sigilix + CodeRabbit catch on arc-156 PR: the
 * prior `/[\s.,!?:;()]/` check was too narrow.) The `\b` anchor
 * fires between any word and non-word character, which matches the
 * intent for headline/body prefix detection.
 */
const VAGUE_PREFIX_RE = new RegExp(`^(?:${VAGUE_PREFIXES.join("|")})\\b`)

function startsWithVagueWord(s: string): boolean {
  const trimmed = (s ?? "").trim()
  return trimmed.length > 0 && VAGUE_PREFIX_RE.test(trimmed)
}

export interface ValidatedOutput {
  verdict: PrReviewVerdict
  /**
   * Findings that passed the hallucination guard and the score-1 demotion
   * check but failed `deriveSide()` (line not in the PR diff). Empty in
   * the success path; the submit-review fallback uses this list to
   * recover findings whose value survives without an inline anchor.
   */
  unanchoredFindings: PrReviewFinding[]
  droppedForInvalidLine: number
  /**
   * Count of line-scoped findings whose model-chosen line was not
   * reviewable but was repaired to a nearby substantive added line.
   * These stay inline instead of falling into the body-only section.
   */
  remappedInvalidLineToInline: number
  droppedForHallucination: number
  demotedScore1: number
  /**
   * ARC-156: count of findings dropped because their headline or
   * body started with a vague prefix word (Ensure / Verify /
   * Validate / Consider / Review / Confirm). Surfaced to shadow
   * telemetry so the filter's real-world impact is measurable.
   */
  droppedForVaguePrefix: number
  /**
   * SIG-113: count of `category: "testing"` findings dropped because
   * the specialist failed to cite evidence via `inspectedTestFiles`
   * or `evidenceRefs`. Eliminates the PR #110 / PR #111 hallucination
   * class where the specialist asserted "missing tests" without
   * inspecting any test file. Surfaced to telemetry so the gate's
   * hit rate is observable in the SIG-86 aggregator.
   */
  droppedForUncitedTestingEvidence: number
  /**
   * SIG-108: count of security-applicable findings the security
   * evidence gate flagged for drop (sev>=4 security finding with
   * fabricated / non-linking / absent evidence that auto-enrich
   * couldn't rescue). In `shadow` mode this counts what WOULD be
   * dropped without actually dropping (the finding stays in
   * `verdict.findings`); in `enforce` mode the finding is dropped.
   * Surfaced to telemetry so the gate's would-drop rate is observable
   * before enforcement is enabled.
   */
  droppedForFailedValidation: number
  /**
   * SIG-111: count of sev>=4 `category: "testing"` findings the
   * specificity gate flagged for drop (uncited missing-coverage claim
   * or vague insufficient-test claim that named no concrete
   * source/API/branch). In `shadow` mode this counts what WOULD be
   * dropped without dropping; in `enforce` mode the finding is dropped.
   * Surfaced to telemetry so the gate's would-drop rate is observable
   * before enforcement is enabled.
   */
  droppedForFailedTestValidation: number
  /**
   * SIG-109: count of sev>=4 logic-sourced findings the evidence gate
   * flagged for drop (unanchored claim — not on a changed path, or
   * quoting no concrete code token on an added line and unbacked by any
   * co-located AST hit; or missing path). In `shadow` mode this counts
   * what WOULD be dropped without dropping; in `enforce` mode the finding
   * is dropped. Surfaced to telemetry so the gate's would-drop rate is
   * observable before enforcement is enabled.
   */
  droppedForFailedLogicValidation: number
  /**
   * SIG-308: count of sev>=4 logic findings the refutation backstop flagged
   * for missing a survival rationale (would-drop in shadow, actual-drop in
   * enforce). Surfaced so the would-flag rate is observable before enforce.
   */
  droppedForFailedLogicRefutation: number
  /** SIG-328: logic findings whose AST-provably-false claim the gate flagged. */
  droppedForFailedLogicClaimRefutation: number
  /**
   * SIG-325: count of sev>=4 self-originated findings (currently security with
   * no resolving manifest evidenceId) the refutation-survival gate flagged for
   * a missing mechanism rationale (would-demote shadow / actual-demote enforce).
   */
  droppedForFailedRefutationSurvival: number
  /**
   * SIG-110: count of sev>=4 perf findings the evidence gate flagged
   * (unanchored perf claim, perf finding on an unchanged path, or missing
   * path). Shadow counts the would-drop; enforce drops. Surfaced to
   * telemetry so the gate's would-drop rate is observable before enforce.
   */
  droppedForFailedPerfValidation: number
  /**
   * SIG-281 PR C: count of score 2-3 findings the inline-grounding gate
   * flagged as ungrounded (would-demote-to-body in shadow, actual-demote
   * in enforce). Surfaced to telemetry so the gate's would-demote rate is
   * observable before enforce.
   */
  droppedForFailedInlineGroundingValidation: number
  /**
   * SIG-290 v1: count of absence-claim findings the absence-grounding
   * gate flagged as ungrounded — the evidence that would confirm-or-
   * refute the absence was PROVABLY not in the specialist's window
   * (would-demote-to-body in shadow, actual-demote in enforce). 0 when
   * the gate is `off`. Surfaced to telemetry so the gate's would-demote
   * rate is observable before enforce.
   */
  droppedForFailedAbsenceGroundingValidation: number
  /**
   * Cross-cutting over-fire Option B: count of window-blindness gate hits
   * (would-demote-to-body in shadow, actual-demote in enforce). 0 when the gate
   * is `off`. Surfaced to telemetry so the would-demote rate is observable
   * before enforce.
   */
  droppedForFailedWindowBlindnessValidation: number
  /**
   * SIG-293 v1: count of secrets-exposure findings the security-grounding
   * gate flagged as ungrounded — the cited line held no credential token
   * and no scanner fact corroborated it (would-demote-to-body in shadow,
   * actual-demote in enforce). 0 when the gate is `off`. Surfaced to
   * telemetry so the gate's would-demote rate is observable before enforce.
   */
  droppedForFailedSecurityGroundingValidation: number
  droppedForFailedSecurityUsageValidation: number
  /**
   * ARC-189: per-clean-finding provenance, aligned by INDEX with
   * `verdict.findings`. Captured during the same walk that filters
   * findings so the ensemble caller can derive the source specialist
   * for each surviving finding without re-walking with the same
   * filter rules. Used by Task 2.5 marker emission to map each
   * finding to its `ReviewMemoryCategory`.
   */
  cleanFindingProvenance: SynthesizerProvenance["findings"]
  /**
   * Synth provenance plus validation-layer drops that are not safe to
   * send inline, such as score-1 advisories under the default profile.
   */
  provenance: SynthesizerProvenance
}

export function evidencePieceCountForTelemetry(record: EvidenceRecord | undefined): number {
  if (!record) return 0
  return (
    record.specialistsThatFlagged.length +
    record.deterministicFactIds.length +
    record.retrievalChunkIds.length +
    record.relatedPriorPRs.length
  )
}

/**
 * SIG-325: a security finding is SELF-ORIGINATED when no deterministic scanner
 * fact backs it — its `evidenceId` is empty/missing, "NONE" (the authz/IDOR
 * exemption no scanner detects), a non-empty id that does NOT resolve in the
 * manifest, OR a resolving id whose fact is a PROVABLY different CWE bucket than
 * the finding's claimed class. CodeRabbit (PR #364): the SIG-108 gate rejects a
 * bogus id as fabricated, but in `shadow` it falls through — so a bogus non-empty
 * id must not silently bypass this backstop. Sigilix (PR #364): the SIG-108 gate
 * also drops a cross-class citation (`factClassCompatible`), but again only in
 * `enforce`; in `shadow` a CWE-22 claim citing a resolving CWE-798 fact would
 * otherwise read as tool-backed here and skip the refutation-survival backstop.
 * Re-check class compatibility so that laundering hole is closed in the
 * orchestrator too. A finding carrying a REAL, class-compatible resolving id
 * (cited, or auto-enriched by `evaluateSecurityFinding`) is tool-backed and
 * covered by the SIG-108 gate, so it is NOT re-gated here. No manifest at all →
 * nothing to corroborate against → self-originated.
 */
function isSelfOriginatedSecurityFinding(
  finding: PrReviewFinding,
  manifest: ReadonlyMap<string, SecurityFact> | undefined,
): boolean {
  const eid = typeof finding.evidenceId === "string" ? finding.evidenceId.trim() : ""
  if (eid.length === 0 || eid === "NONE") return true
  if (!manifest) return true
  const fact = manifest.get(eid)
  if (!fact) return true
  return !factClassCompatible(fact, finding)
}

/**
 * SIG-113: gate per-finding evidence citation for `category: "testing"`
 * findings. Drops uncited findings to suppress the PR #110/#111
 * hallucination class (specialist asserts "missing tests" without
 * having inspected any test file).
 *
 * Contract:
 *   - Non-testing findings always pass (gate only applies to category="testing")
 *   - When pack is undefined (orchestrator skipped the build — e.g. pure
 *     docs PR with no source/test files in the diff), all findings pass
 *     (no evidence to gate on; the SIG-91 prompt rule already covers
 *     this case via "[TESTING EVIDENCE] block absent → no missing-tests
 *     finding applicable")
 *   - Finding cites an `inspectedTestFiles` path that EXISTS in the
 *     pack's inspected set → keep (specialist read a file we actually
 *     embedded in its prompt)
 *   - Finding cites an `evidenceRefs` `siblingMapping:<source>-><test>`
 *     that MATCHES a real mapping in the pack AND whose `<source>`
 *     equals `finding.path` → keep (relevant + accurate absence claim)
 *   - Finding cites `evidenceRefs` `inspectedTestFile:<path>` resolving
 *     to a real inspected path → keep
 *   - Finding cites `evidenceRefs` `testFileChanged:<path>` resolving
 *     to a test file in the PR's changed set → keep (covers the
 *     "removed/renamed test coverage" class where the deleted test
 *     can't be fetched at headSha)
 *   - Otherwise → drop
 *
 * CodeRabbit catch on PR #112 (Major): the citation MUST be validated
 * against the actual pack, not just shape-checked. Pre-fix, any
 * non-empty `inspectedTestFiles` array or any `evidenceRefs` string
 * with the right prefix passed — letting a hallucinating model bypass
 * the gate with an invented path (`tests/made-up.test.ts`) or a
 * fabricated mapping. That reopens the "structurally valid but
 * factually unsupported" hole the gate exists to close. Now every
 * citation is cross-checked against `pack.inspectedTestFiles` /
 * `pack.siblingMappings`.
 *
 * Pure — exported for tests.
 */
export function evaluateTestingFindingCitation(
  finding: PrReviewFinding,
  pack: TestingEvidencePack | undefined,
  /**
   * SIG-118: the real coverage-gap set, keyed `"<path>:<line>"` (path
   * resolved to a changed file, line in the PR's added set). Defaults to
   * an empty set (back-compat for callers that don't ingest coverage). A
   * `coverageGap:<path>:<line>` evidenceRef is a REAL citation (keep)
   * only when (path,line) is in this set AND `finding.path === path`.
   */
  coverageGaps: ReadonlySet<string> = new Set<string>(),
): { keep: true } | { keep: false; reason: "no-citation" } {
  if (finding.category !== "testing") return { keep: true }
  // `buildTestingEvidencePack` always returns a pack object — even for
  // a pure docs PR it returns one with empty source/test arrays. Treat
  // an empty pack the same as an absent one: no evidence to gate on,
  // so pass the finding through.
  if (!pack || (pack.sourceFilesChanged.length === 0 && pack.testFilesChanged.length === 0)) {
    return { keep: true }
  }

  // Build the sets of REAL evidence from the pack. A citation only
  // counts if it names something the pack actually contains.
  const realInspected = new Set(pack.inspectedTestFiles)
  const realTestFilesChanged = new Set(pack.testFilesChanged)
  // Real mapping source → arrow-value, so we can both (a) confirm the
  // mapping exists AND (b) enforce relevance to `finding.path`.
  const realMappingBySource = new Map<string, string>()
  for (const m of pack.siblingMappings) {
    realMappingBySource.set(m.source, m.test ?? "NONE")
  }

  // inspectedTestFiles: at least one cited path must be in the pack's
  // real inspected set. An invented path doesn't count. No relevance-
  // to-`finding.path` check here — a finding about a source file
  // legitimately cites the (differently-named) test file it read.
  if (Array.isArray(finding.inspectedTestFiles)) {
    for (const p of finding.inspectedTestFiles) {
      if (typeof p === "string" && realInspected.has(p.trim())) {
        return { keep: true }
      }
    }
  }

  // evidenceRefs: validate each ref against the pack.
  if (Array.isArray(finding.evidenceRefs)) {
    for (const ref of finding.evidenceRefs) {
      if (typeof ref !== "string") continue
      const trimmed = ref.trim()

      // `siblingMapping:<source>-><test|NONE>` — must match a REAL
      // mapping AND be RELEVANT to this finding. CodeRabbit PR #112
      // (Major): a finding about `foo.ts` could otherwise cite an
      // unrelated real mapping (`bar.ts->NONE`) and bypass the gate.
      // The mapping's source must equal the finding's target path.
      if (trimmed.startsWith("siblingMapping:")) {
        const payload = trimmed.slice("siblingMapping:".length)
        const arrowIdx = payload.indexOf("->")
        if (arrowIdx < 0) continue
        const source = payload.slice(0, arrowIdx).trim()
        const arrowValue = payload.slice(arrowIdx + 2).trim()
        // Relevance: the cited mapping must be ABOUT the file the
        // finding targets.
        if (source !== finding.path) continue
        // Existence + accuracy: the cited arrow value must match the
        // pack's real mapping for that source (a `->NONE` claim for a
        // source that actually has a sibling is rejected).
        if (realMappingBySource.get(source) === arrowValue) {
          return { keep: true }
        }
        continue
      }

      // `inspectedTestFile:<path>` — must be a real inspected path.
      if (trimmed.startsWith("inspectedTestFile:")) {
        const path = trimmed.slice("inspectedTestFile:".length).trim()
        if (realInspected.has(path)) {
          return { keep: true }
        }
        continue
      }

      // `testFileChanged:<path>` — CodeRabbit PR #112 (Major): a
      // legitimate "PR removed/renamed test coverage" finding can't
      // cite an inspected file (the deleted test fails to fetch at
      // headSha) or a sibling mapping (no source). Accept a citation
      // that names a test file present in the PR's CHANGED set, which
      // includes deletions/renames.
      if (trimmed.startsWith("testFileChanged:")) {
        const path = trimmed.slice("testFileChanged:".length).trim()
        if (realTestFilesChanged.has(path)) {
          return { keep: true }
        }
        continue
      }

      // SIG-118: `coverageGap:<path>:<line>` — an LCOV-derived coverage
      // gap. Parse the LINE from the LAST colon so paths containing
      // colons stay intact. A real citation (keep) only when (path,line)
      // is in the real coverage-gap set AND the cited path matches
      // `finding.path` (relevance, mirroring the sibling-mapping rule).
      if (trimmed.startsWith("coverageGap:")) {
        const parsed = parseCoverageGapRef(trimmed)
        if (parsed === null) continue
        // Compare against the TRIMMED finding path (code-review LOW): the
        // SIG-111 gate trims, so keep both gates consistent.
        if (parsed.path !== finding.path.trim()) continue
        if (coverageGaps.has(`${parsed.path}:${parsed.line}`)) {
          return { keep: true }
        }
        continue
      }
    }
  }

  return { keep: false, reason: "no-citation" }
}

export type ValidateForSubmissionArgs = {
  synthOutput: { verdict: PrReviewVerdict; provenance: SynthesizerProvenance }
  reviewable: ReviewableMap
  specialistVerdicts: CollectedVerdict[]
  /**
   * SIG-113: testing-evidence pack built by the orchestrator from
   * the FULL diff inventory. Used by `evaluateTestingFindingCitation`
   * to drop `category: "testing"` findings that don't cite evidence
   * (the PR #110 / PR #111 hallucination class). Absent for callers
   * that haven't wired the pack through — the gate then no-ops
   * (back-compat for the staged rollout).
   */
  testingEvidence?: TestingEvidencePack
  /**
   * SIG-113: optional telemetry-emit callback fired once per dropped
   * testing finding. Lets the orchestrator log
   * `pr-review-testing-finding-dropped` with the full correlation
   * fields (owner/repo/prNumber/headSha) without coupling the pure
   * validator to a logger. Absent → silent drop (counter still
   * increments and surfaces via `droppedForUncitedTestingEvidence`).
   */
  onTestingFindingDropped?: (finding: PrReviewFinding, reason: "no-citation") => void
  /**
   * SIG-108: security fact manifest (evidenceId → fact) built by the
   * orchestrator via `buildSecurityFactManifest`. Used by
   * `evaluateSecurityFinding` to cross-check sev>=4 security findings'
   * evidence + auto-enrich corroborated findings. Absent → the gate
   * no-ops (back-compat for callers not yet threading the manifest).
   */
  securityManifest?: Map<string, SecurityFact>
  /**
   * SIG-141: per-file line spans of `class … extends DurableObject`
   * declarations in the changed files (AST-derived, see
   * `durableObjectClassSpans`). An authz-bucket security finding whose line
   * lands INSIDE one of these spans is suppressed unconditionally — a DO method
   * is only invokable by the Worker holding the binding, so the binding IS the
   * trust boundary (per-tenant isolation is via the DO id, not per-method
   * authz). Scoped to the class body so a real access-control bug in a
   * co-located top-level helper or other class is still surfaced. Absent → no
   * suppression (back-compat).
   */
  durableObjectClassSpans?: ReadonlyMap<string, readonly LineSpan[]>
  /**
   * SIG-108: gate mode. `shadow` (default): the gate's verdict is
   * counted + telemetered but the finding is NOT dropped. `enforce`:
   * rejected findings are dropped. Read from
   * `OPENCLAW_SECURITY_VALIDATOR_MODE` at the call site; defaults to
   * `shadow` for the cautious staged rollout.
   */
  securityValidatorMode?: SecurityValidatorMode
  /**
   * SIG-108: optional telemetry callback fired once per security
   * finding the gate flagged (whether or not it was actually dropped —
   * the `dropped` arg distinguishes enforce from shadow). Lets the
   * orchestrator log `pr-review-finding-rejected-validation` with full
   * correlation fields without coupling the pure validator to a logger.
   */
  onSecurityFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: SecurityDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-111: tests-finding specificity gate mode. `shadow` (default):
   * the gate's verdict is counted + telemetered but the finding is NOT
   * dropped. `enforce`: rejected findings are dropped. Read from
   * `OPENCLAW_TESTS_VALIDATOR_MODE` at the call site; defaults to
   * `shadow`. This gate is false-negative-sensitive (the SIG-108 review
   * caught real findings being dropped) so it ships dark and biases
   * toward keep.
   */
  testsValidatorMode?: TestsValidatorMode
  /**
   * SIG-111: optional telemetry callback fired once per testing finding
   * the specificity gate flagged (whether or not it was actually
   * dropped — the `dropped` arg distinguishes enforce from shadow).
   * Lets the orchestrator log `pr-review-finding-rejected-validation`
   * (the SIG-108 event, reused with a `gate: "tests"` discriminator)
   * without coupling the pure validator to a logger.
   */
  onTestFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: TestDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-118: the real coverage-gap set, keyed `"<path>:<line>"`, built
   * by the orchestrator from `ingestCoverage`. Threaded into BOTH the
   * SIG-113 citation gate and the SIG-111 specificity gate so a finding
   * citing a real `coverageGap:<path>:<line>` is treated as a genuine
   * missing-coverage citation. Absent / empty → both gates ignore
   * coverageGap refs (back-compat; default off).
   */
  coverageGaps?: ReadonlySet<string>
  /**
   * SIG-347 (AC #3 of SIG-166): diff-wide test-to-source added-line ratio,
   * computed by the orchestrator via `computeTestToSourceAddedRatio` from the
   * FULL PR diff. When > TEST_RATIO_DAMPER_THRESHOLD the loop damps each KEPT
   * `category: "testing"` finding's confidence by one point — de-emphasis on a
   * visibly test-heavy PR, never a drop. Default 0 → no damping (back-compat
   * for callers not threading it).
   */
  testToSourceRatio?: number
  /**
   * SIG-109: logic-finding evidence (added-line text per path + the
   * roleHint:logic AST findings). Threaded so `evaluateLogicFinding` can
   * anchor sev>=4 logic findings to the diff. Absent → the gate no-ops
   * (back-compat for callers not yet threading the evidence).
   */
  logicEvidence?: LogicEvidence
  /**
   * SIG-109: logic-finding evidence gate mode. `shadow` (default): the
   * gate's verdict is counted + telemetered but the finding is NOT
   * dropped. `enforce`: rejected findings are dropped. Read from
   * `OPENCLAW_LOGIC_VALIDATOR_MODE` at the call site; defaults to
   * `shadow`. This gate is false-negative-sensitive (logic bugs are
   * LLM-found with no deterministic backing) so it ships dark and biases
   * hard toward keep.
   */
  logicValidatorMode?: LogicValidatorMode
  /**
   * SIG-109: optional telemetry callback fired once per logic finding the
   * evidence gate flagged (whether or not it was actually dropped — the
   * `dropped` arg distinguishes enforce from shadow). Lets the
   * orchestrator log `pr-review-finding-rejected-validation` (the SIG-108
   * event, reused with a `gate: "logic"` discriminator) without coupling
   * the pure validator to a logger.
   */
  onLogicFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: LogicDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-308: logic-refutation backstop mode. `off` (default): the gate
   * doesn't run. `shadow`: the verdict is counted + telemetered but the
   * finding is NOT dropped. `enforce`: flagged findings are dropped. Read
   * from `OPENCLAW_LOGIC_REFUTATION_MODE` at the call site. Scoped to logic-
   * sourced findings; catches a sev>=4 logic finding that never showed it
   * survives refutation (no `independentAssessment`). Ships dark.
   */
  logicRefutationMode?: LogicRefutationMode
  /**
   * SIG-308: optional telemetry callback fired once per logic finding the
   * refutation backstop flagged (whether or not it was dropped — `dropped`
   * distinguishes enforce from shadow). Lets the orchestrator log
   * `pr-review-finding-rejected-validation` (gate:"logic-refutation")
   * without coupling the pure validator to a logger.
   */
  onLogicRefutationFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: LogicRefutationDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-325: generalized refutation-survival gate mode. `off` (default): the
   * gate doesn't run. `shadow`: count + telemeter the would-demote, keep inline.
   * `enforce`: demote flagged findings to the body. Read from
   * `OPENCLAW_REFUTATION_SURVIVAL_MODE` at the call site. Scoped to SELF-
   * originated findings (security findings with no resolving manifest
   * `evidenceId`, and performance findings with no co-located AST hit); a sev>=4
   * such finding lacking an `independentAssessment` mechanism rationale is
   * flagged. Logic is covered by its own SIG-308 gate. Ships dark.
   */
  refutationSurvivalMode?: RefutationSurvivalMode
  /**
   * SIG-325: telemetry callback fired once per finding the refutation-survival
   * gate flagged (`dropped` distinguishes enforce from shadow; `lens` names the
   * lens that triggered it). Lets the orchestrator log
   * `pr-review-finding-rejected-validation` (gate:"refutation-survival") without
   * coupling the pure validator to a logger.
   */
  onRefutationSurvivalFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: RefutationSurvivalDropReason; dropped: boolean; lens: string },
  ) => void
  /**
   * SIG-328: logic-claim refutation gate mode. `off` (default): the gate
   * doesn't run. `shadow`: would-drops are counted + telemetered, finding kept.
   * `enforce`: a logic finding whose supported claim shape is PROVABLY false
   * against the cited AST is dropped. Read from
   * `OPENCLAW_LOGIC_CLAIM_REFUTATION_MODE`. Scoped to sev>=4 logic findings;
   * needs `fullFileByPath` for the AST proof. Fails open. Ships dark.
   */
  logicClaimRefutationMode?: LogicClaimRefutationMode
  /** SIG-328: telemetry callback per logic finding the claim gate flagged. */
  onLogicClaimRefutationFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: LogicClaimDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-110: perf-finding evidence (added-line text per path + the
   * roleHint:performance AST findings). Threaded so `evaluatePerfFinding`
   * can anchor sev>=4 perf findings to the diff. Absent → the gate no-ops.
   */
  perfEvidence?: PerfEvidence
  /**
   * SIG-110: perf-finding evidence gate mode. `shadow` (default) counts +
   * telemeters but never drops; `enforce` drops rejected findings. Read
   * from `OPENCLAW_PERF_VALIDATOR_MODE` at the call site.
   */
  perfValidatorMode?: PerfValidatorMode
  /**
   * PR3 inline-first routing: per-file new-side added-line text. When
   * a line-scoped, non-suggestion finding lands just outside GitHub's
   * reviewable diff coordinates, validation may repair it to the
   * nearest substantive added line in the same file.
   */
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
  /**
   * SIG-110: telemetry callback fired once per perf finding the gate
   * flagged (reuses the `pr-review-finding-rejected-validation` event with
   * a `gate: "perf"` discriminator).
   */
  onPerfFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: PerfDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-281 PR C (Rec 4): inline-grounding gate mode. `shadow` (default)
   * counts + telemeters but keeps every finding inline; `enforce` DEMOTES
   * ungrounded score 2-3 findings to the review body (never hard-drops).
   * Read from `OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE` at the call site.
   */
  inlineGroundingValidatorMode?: InlineGroundingValidatorMode
  /**
   * SIG-281 PR C: telemetry callback fired once per finding the inline-
   * grounding gate flagged (reuses the `pr-review-finding-rejected-
   * validation` event with a `gate: "inline-grounding"` discriminator).
   * `dropped` here means "demoted to body" (enforce), not hard-dropped.
   */
  onInlineGroundingFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: InlineGroundingDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-290 v1: absence-claim grounding gate mode. `off` (default) skips
   * the gate entirely; `shadow` counts + telemeters but keeps every
   * finding inline; `enforce` DEMOTES an absence-claim ("lacks tests",
   * "no null check", "missing validation") to the review body when the
   * evidence that would confirm-or-refute the absence was PROVABLY not in
   * the specialist's window (never hard-drops). Read from
   * `OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE` at the call site.
   */
  absenceClaimValidatorMode?: AbsenceClaimValidatorMode
  /**
   * SIG-290 v1: did the packed diff get char-truncated before specialist
   * dispatch? Part of the absence-grounding context (computed at the call
   * site). Default false. Not used alone to suppress in v1.
   */
  wasTruncated?: boolean
  /**
   * SIG-290 v1: paths the batcher dropped from the diff entirely. A
   * non-testing absence-claim on a dropped path is ungrounded (the
   * specialist never saw the file's content). Default [].
   */
  droppedPaths?: readonly string[]
  /**
   * SIG-290 v1: telemetry callback fired once per finding the absence-
   * grounding gate flagged (reuses the `pr-review-finding-rejected-
   * validation` event with a `gate: "absence-grounding"` discriminator).
   * `dropped` here means "demoted to body" (enforce), not hard-dropped.
   */
  onAbsenceFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: AbsenceGroundingDropReason; dropped: boolean },
  ) => void
  /**
   * Cross-cutting over-fire Option B: window-blindness gate mode. `off`
   * (default) skips the gate; `shadow` counts + telemeters but keeps every
   * finding inline; `enforce` DEMOTES a sev>=4 logic positive-misread ("X can
   * be undefined / returns NaN / is unbounded") to the review body when the
   * guard on the SAME cited symbol is provably present in the full file but
   * OUTSIDE the diff window the model saw (never hard-drops). Read from
   * `OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE` at the call site.
   */
  windowBlindnessValidatorMode?: WindowBlindnessValidatorMode
  /**
   * Cross-cutting over-fire Option B: head (post-PR) full file text per path —
   * the orchestrator's `astFilesByPath`. The window-blindness gate reads the
   * COMPLETE file to find a guard the model never saw. Default empty (then the
   * gate keeps every finding, FP-safe).
   */
  fullFileByPath?: ReadonlyMap<string, string>
  /**
   * SIG-336: per-review parse-once AST cache. Threaded into the logic-claim
   * refutation gate so a file cited by N findings is acorn-parsed once (not N
   * times) and the 500KB guard applies. Defaults to a fresh cache when omitted;
   * the caller passes a shared instance so earlier parsers reuse it (Phase 3).
   */
  astCache: AstCache
  /**
   * Cross-cutting over-fire Option B: telemetry callback fired once per finding
   * the window-blindness gate flagged (reuses the `pr-review-finding-rejected-
   * validation` event with a `gate: "window-blindness"` discriminator).
   * `dropped` here means "demoted to body" (enforce), not hard-dropped.
   */
  onWindowBlindnessFindingDropped?: (
    finding: PrReviewFinding,
    info: {
      reason: WindowBlindnessDropReason
      /** the cited symbol whose guard was found out-of-window (shadow telemetry). */
      matchedIdentifier: string
      /** 1-based line of the matching out-of-window guard (shadow telemetry). */
      guardLine: number
      dropped: boolean
    },
  ) => void
  /**
   * SIG-293 v1: security-grounding gate mode. `off` (default) skips the
   * gate entirely; `shadow` counts + telemeters but keeps every finding
   * inline; `enforce` DEMOTES a `secrets-exposure` finding to the review
   * body when its cited line holds no credential token and no scanner fact
   * corroborates it (never hard-drops). Read from
   * `OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE` at the call site. Reuses
   * the `securityManifest` + `addedLineTextByLine` already threaded above.
   */
  securityGroundingValidatorMode?: SecurityGroundingValidatorMode
  /**
   * SIG-293 v1: telemetry callback fired once per finding the security-
   * grounding gate flagged (reuses the `pr-review-finding-rejected-
   * validation` event with a `gate: "security-grounding"` discriminator).
   * `dropped` here means "demoted to body" (enforce), not hard-dropped.
   */
  onSecurityGroundingFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: SecurityGroundingDropReason; dropped: boolean },
  ) => void
  /**
   * SIG-311 Layers A+B: security USAGE-vs-MENTION gate mode. Demotes a sev>=4
   * injection/xss finding on a detector/validator/test/doc path whose cited
   * token is a mention, not a live sink (the PR #296 self-FP family). Read from
   * `OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE` at the call site.
   */
  securityUsageValidatorMode?: SecurityUsageValidatorMode
  /** SIG-311: telemetry callback per usage-gate-flagged finding (reuses the
   *  `pr-review-finding-rejected-validation` event, `gate: "security-usage"`).
   *  `dropped` = demoted to body (enforce). */
  onSecurityUsageFindingDropped?: (
    finding: PrReviewFinding,
    info: { reason: SecurityUsageDropReason; dropped: boolean },
  ) => void
  /**
   * ARC-176/SIG-175: review-tone preset. `assertive` preserves the
   * old score-1 advisory summary aggregation; `chill`/default drops
   * score-1 nits from customer-visible output entirely.
   */
  profile?: SigilixProfile
  /** SIG Trust Ledger v0: when true (flag != off), tag each body-demoted finding
   *  with its `demoteReason` (inline/absence/security-grounding, outside-diff) so
   *  the PR3 render can split outside-diff vs PR-level. Inert metadata nothing reads
   *  yet; gated so `off` stays a true no-op. */
  trustLedgerEnabled?: boolean
  /**
   * SIG-314: the `ast/<ruleId>/<hash>/<line>` ids of the deterministic AST
   * findings the synth was shown. They are admitted as valid provenance so an
   * `emitWhenUnmatched` finding the synth emits standalone (no specialist cited
   * it) survives the hallucination guard. Absent → only specialist ids are
   * valid (back-compat). Only real scanned ids are passed, so this can't be used
   * to smuggle a hallucinated finding through.
   */
  astFindingIds?: readonly string[]
}

export function validateForSubmission(args: ValidateForSubmissionArgs): ValidatedOutput {
  const {
    synthOutput,
    reviewable,
    specialistVerdicts,
    testingEvidence,
    onTestingFindingDropped,
    securityManifest,
    durableObjectClassSpans: doClassSpans = new Map<string, readonly LineSpan[]>(),
    securityValidatorMode = "shadow",
    onSecurityFindingDropped,
    testsValidatorMode = "shadow",
    onTestFindingDropped,
    coverageGaps = new Set<string>(),
    testToSourceRatio = 0,
    logicEvidence,
    logicValidatorMode = "shadow",
    onLogicFindingDropped,
    logicRefutationMode = "off",
    refutationSurvivalMode = "off",
    onLogicRefutationFindingDropped,
    onRefutationSurvivalFindingDropped,
    logicClaimRefutationMode = "off",
    onLogicClaimRefutationFindingDropped,
    perfEvidence,
    perfValidatorMode = "shadow",
    addedLineTextByLine,
    onPerfFindingDropped,
    inlineGroundingValidatorMode = "shadow",
    onInlineGroundingFindingDropped,
    absenceClaimValidatorMode = "off",
    wasTruncated = false,
    droppedPaths = [],
    onAbsenceFindingDropped,
    windowBlindnessValidatorMode = "off",
    fullFileByPath = new Map<string, string>(),
    astCache,
    onWindowBlindnessFindingDropped,
    securityGroundingValidatorMode = "off",
    onSecurityGroundingFindingDropped,
    securityUsageValidatorMode = "off",
    onSecurityUsageFindingDropped,
    profile = "chill",
    trustLedgerEnabled = false,
    astFindingIds = [],
  } = args
  const validIds = new Set<string>()
  const sourceEvidenceById = buildSourceFindingSecurityEvidenceById(specialistVerdicts)
  const sourceRationaleById = buildSourceFindingRationaleById(specialistVerdicts, "logic")
  // SIG-325 (CodeRabbit PR #364): per-lens rationale maps so the security/perf
  // refutation gates judge against a SAME-LENS rationale instead of the
  // logic-scoped global backfill (no cross-lens contamination / false demotes).
  const sourceRationaleByIdSecurity = buildSourceFindingRationaleById(specialistVerdicts, "security")
  const sourceRationaleByIdPerf = buildSourceFindingRationaleById(specialistVerdicts, "performance")
  for (const v of specialistVerdicts) {
    if (!v.verdict) continue
    for (const f of v.verdict.findings) validIds.add(f.id)
  }
  // SIG-314: a deterministic AST emit (emitWhenUnmatched) is a LEGITIMATE source
  // the synth may cite as `ast/<ruleId>/<hash>/<line>` provenance — that is the
  // whole point of the unmatched path (the specialist missed it, the scanner
  // proved it). Without this, the hallucination guard below drops every
  // unmatched emit (SIG-309/310/312/314 all relied on this and were silently
  // dropped in the specialist-missed case — Codex caught it). Only REAL scanned
  // ids are admitted, so a hallucinated `ast/…` still fails the guard.
  for (const id of astFindingIds) validIds.add(id)

  const cleanFindings: PrReviewFinding[] = []
  const cleanFindingProvenance: SynthesizerProvenance["findings"] = []
  const provenanceDropped: SynthesizerProvenance["dropped"] = [
    ...synthOutput.provenance.dropped,
  ]
  const unanchoredFindings: PrReviewFinding[] = []
  let droppedForInvalidLine = 0
  let remappedInvalidLineToInline = 0
  let droppedForHallucination = 0
  let demotedScore1 = 0
  let droppedForVaguePrefix = 0
  let droppedForUncitedTestingEvidence = 0
  let droppedForFailedValidation = 0
  let droppedForFailedTestValidation = 0
  let droppedForFailedLogicValidation = 0
  let droppedForFailedLogicRefutation = 0
  let droppedForFailedLogicClaimRefutation = 0
  let droppedForFailedRefutationSurvival = 0
  let droppedForFailedPerfValidation = 0
  let droppedForFailedInlineGroundingValidation = 0
  let droppedForFailedAbsenceGroundingValidation = 0
  let droppedForFailedWindowBlindnessValidation = 0
  let droppedForFailedSecurityGroundingValidation = 0
  let droppedForFailedSecurityUsageValidation = 0
  const advisoryNits: PrReviewFinding[] = []

  // SIG-290 v1: the reviewable diff's path set for the absence-grounding
  // gate's context. Built once, but only when the gate runs — in `off`
  // mode we skip the key iteration entirely (zero cost).
  const reviewablePaths: ReadonlySet<string> =
    absenceClaimValidatorMode === "off" ? new Set<string>() : new Set(reviewable.keys())

  // Cross-cutting over-fire Option B: the NEW-side (RIGHT) line numbers the
  // specialist actually saw per path — its diff window (changed + context
  // lines). A guard at a full-file line NOT in this set was outside the model's
  // window. Built once, but only when the gate runs (`off` skips entirely).
  const windowLinesByPath: ReadonlyMap<string, ReadonlySet<number>> =
    windowBlindnessValidatorMode === "off"
      ? new Map<string, ReadonlySet<number>>()
      : new Map(
          [...reviewable.entries()].map(([path, positions]) => [
            path,
            new Set(positions.filter((p) => p.side === "RIGHT").map((p) => p.line)),
          ]),
        )

  // Walk by INDEX (v3.1 catch — not by headline).
  for (let i = 0; i < synthOutput.verdict.findings.length; i++) {
    // `let` (not `const`): the SIG-108 auto-enrich path may swap `f` for
    // an enriched CLONE so it never mutates the raw synth finding that
    // telemetry.synthesizer.verdict aliases (CR-1 / CodeRabbit).
    let f = synthOutput.verdict.findings[i]!
    const provenance = synthOutput.provenance.findings[i]

    // Hallucination guard. Defensive against malformed provenance
    // even though isValidProvenance pre-validated (belt + suspenders
    // per CR PR #35 — provenance might be partially valid).
    if (!provenance) {
      droppedForHallucination++
      continue
    }
    const sourceIds = Array.isArray(provenance.sourceFindingIds)
      ? provenance.sourceFindingIds
      : []
    if (sourceIds.length === 0) {
      droppedForHallucination++
      continue
    }
    if (!sourceIds.every((id) => validIds.has(id))) {
      droppedForHallucination++
      continue
    }

    // SIG-117: synth may preserve provenance but omit security
    // evidence fields copied from the original specialist findings.
    // Backfill missing `cweId`/`evidenceId` from the cited source
    // findings BEFORE any validation gates run. The clone keeps raw
    // synth telemetry intact and never overwrites fields the synth
    // already provided.
    f = backfillSecurityEvidenceFromSources(f, sourceIds, sourceEvidenceById)
    // SIG-308 (PR #290 review): restore independentAssessment dropped by
    // synthesis BEFORE the logic-refutation backstop reads it, so a logic
    // finding whose specialist justified survival isn't wrongly flagged.
    f = backfillIndependentAssessmentFromSources(f, sourceIds, sourceRationaleById)
    // Attach once after provenance/security backfills but before the demote-to-body
    // gates below. Dropped findings discard this clone; demoted findings keep the
    // same provenance block when rendered in the review body.
    f = {
      ...f,
      evidence: buildFindingEvidenceRecord({
        finding: f,
        provenance,
        specialistVerdicts,
        sourceEvidenceById,
        validSourceIds: validIds,
      }),
    }

    // SIG-216: normalize scope BEFORE any scope-dependent gates fire.
    // LLM specialists sometimes emit `scope: "file"` for findings that
    // have a concrete `(path, line)` AND that line falls in a reviewable
    // hunk. The renderer routes any non-line scope into the Review Body
    // section, which loses the inline anchor. Force `scope: "line"` for
    // the anchorable shape so the renderer routes inline (PR #173
    // regression class). Telemeter the flip so we can measure how often
    // the LLM under-anchors; prompt tightening is a follow-up.
    {
      const fromScope: ReviewFindingScope | "undefined" = f.scope ?? "undefined"
      const normalized = normalizeFindingScopeForAnchorability(f, reviewable)
      if (normalized !== f) {
        console.log(JSON.stringify({
          event: "pr-review-scope-normalized-to-line",
          fromScope,
          path: f.path,
          line: f.line,
          category: f.category,
        }))
        f = normalized
      }
    }

    // ARC-156: vague-prefix filter. Drop findings whose headline OR
    // body starts with one of the VAGUE_PREFIXES words (case-
    // sensitive, word-boundary). Runs BEFORE score-1 demotion so a
    // vague nit gets dropped outright rather than aggregated into
    // the advisory bucket. Runs AFTER hallucination guard so the
    // counter attribution is unambiguous (hallucinated findings
    // shouldn't have meaningful prefix content anyway).
    if (hasVaguePrefix(f)) {
      droppedForVaguePrefix++
      continue
    }

    // SIG-113: testing-evidence citation gate. Drops
    // `category: "testing"` findings that don't cite evidence —
    // suppresses the PR #110 / PR #111 hallucination class where
    // the specialist asserted "no tests exist" without inspecting
    // any test file. Runs BEFORE score-1 demotion so an unevidenced
    // nit also drops (no advisory bucket leak). Runs AFTER vague-
    // prefix + hallucination guards so the counter attribution
    // stays clean.
    const citationCheck = evaluateTestingFindingCitation(f, testingEvidence, coverageGaps)
    if (!citationCheck.keep) {
      droppedForUncitedTestingEvidence++
      onTestingFindingDropped?.(f, citationCheck.reason)
      continue
    }

    // SIG-111: tests-finding specificity gate. Runs IMMEDIATELY AFTER
    // the SIG-113 citation gate (disjoint question: SIG-113 asks "did
    // it cite something real?", this asks "is the cited finding
    // SPECIFIC enough to be a true positive?"). Applies ONLY to sev>=4
    // `category: "testing"` findings; everything else passes via the
    // pure helper's early returns. Shadow-first: in `shadow` mode the
    // verdict is counted + telemetered but the finding is NOT dropped;
    // only `enforce` actually drops. False-negative-sensitive — the
    // helper biases toward keep (deletion/rename exception preserved,
    // ambiguous shapes kept). The SIG-86 shadow aggregator instruments
    // the would-drop rate; the bake-off harness is NOT built here.
    {
      const testDecision = evaluateTestFinding(f, testingEvidence, coverageGaps)
      if (!testDecision.keep) {
        // SIG-111 / SIG-245: the tests specialist over-fires "X lacks
        // coverage" on glue covered by structural tests or with a vague,
        // non-actionable ask — the dominant labeled-FP class (21/31 in the
        // SIG-161 corpus). FN-safe: in `enforce` the finding is DEMOTED to the
        // body (still visible if the coverage gap is real) rather than dropped,
        // matching the SIG-108 / SIG-307 demote-not-drop discipline. In
        // `shadow` the would-demote is counted + telemetered but the finding is
        // kept inline. `dropped` in the telemetry callback means "actioned".
        const demoted = testsValidatorMode === "enforce"
        droppedForFailedTestValidation++
        onTestFindingDropped?.(f, { reason: testDecision.reason, dropped: demoted })
        if (demoted) {
          // SIG-245: cap below the score>=4 REQUEST_CHANGES floor so the
          // gate-flagged FP becomes a NON-blocking body note — visible if the
          // coverage gap is real, but the bot does NOT block a merge over a
          // coverage finding the gate itself judged low-confidence. (Differs
          // from the SIG-108 security demote, which keeps the score: a
          // weak-evidence security finding still warrants caution; a low-stakes
          // coverage over-fire does not. evaluateTestFinding only fires on
          // score>=4, so this always demotes a P0/P1 to a sub-blocker note.)
          // Clone before mutating: `f` aliases synthOutput.verdict.findings[i],
          // which is recorded to telemetry.synthesizer.verdict — capping the
          // score in place would corrupt the recorded synth score (CR #284).
          const demotedFinding: PrReviewFinding = { ...f, score: Math.min(f.score, 3) }
          if (trustLedgerEnabled) annotateFindingTrust(demotedFinding, { surface: "body", demoteReason: "tests-coverage" })
          unanchoredFindings.push(demotedFinding)
          continue
        }
        // shadow mode: fall through and keep the finding.
      }
    }

    // SIG-347 (AC #3): diff-test-ratio damper. On a visibly test-heavy PR
    // (the diff itself adds substantial tests, ratio > THRESHOLD), de-emphasize
    // a SURVIVING testing finding by one confidence point. Recall-safe: this
    // never drops — a real high-severity finding stays actionable (5→4), a
    // borderline P2 over-fire becomes a quiet P3 body note (4→3). Runs AFTER
    // the SIG-111 gate so it only touches findings the specificity check kept,
    // and clones (never mutates the synth-aliased finding the telemetry holds).
    if (f.category === "testing" && testToSourceRatio > TEST_RATIO_DAMPER_THRESHOLD) {
      const dampedScore = dampTestingScoreForRatio(f.score, testToSourceRatio)
      if (dampedScore !== f.score) {
        console.log(JSON.stringify({
          event: "pr-review-testing-finding-ratio-damped",
          path: f.path,
          line: f.line,
          fromScore: f.score,
          toScore: dampedScore,
          ratio: Number(testToSourceRatio.toFixed(3)),
        }))
        f = { ...f, score: dampedScore }
      }
    }

    // SIG-141: DurableObject method-authz suppression. A DO method is only
    // invokable by the Worker holding the binding, so the binding IS the trust
    // boundary; per-tenant isolation is via the DO id, not per-method authz.
    // The security specialist over-fires "missing access check" on every new
    // DO method (false P1/P2). Suppress authz-bucket findings whose line lands
    // INSIDE a changed DurableObject class body — UNCONDITIONALLY (a
    // correctness drop, not a shadow-gated evidence policy), so it clears even
    // while the security validator runs in shadow. Scoped to the class span so
    // a real authz bug in a co-located top-level helper is still surfaced, and
    // to SECURITY-sourced findings (provenance, like the SIG-108 gate) so an
    // authz-CWE finding that actually came from logic/tests/perf is untouched.
    if (
      sourceRolesInclude(sourceIds, "security") &&
      lineInDurableObjectClass(doClassSpans.get(f.path.trim()), f.line) &&
      deriveSecurityBucket(f) === AUTHZ_BUCKET
    ) {
      droppedForFailedValidation++
      onSecurityFindingDropped?.(f, { reason: "do-method-authz-trust-boundary", dropped: true })
      continue
    }

    // SIG-307: DurableObject intra-instance race FP. A DO serializes EVERY
    // invocation of an instance (requests + alarms run one-at-a-time behind
    // input gates; `await` does not let another invocation of the same instance
    // interleave), so an intra-instance race/concurrency finding on a DO method
    // CANNOT be real — the SIG-141 shape for the concurrency category (observed:
    // a refuted "DO alarm scheduling race" on byte-identical-to-shipped code).
    // FN-safe: DEMOTED to the body (still visible) rather than dropped, because
    // the race-claim regex can't perfectly exclude a cross-await EXTERNAL-state
    // bug — those phrasings are carved out in the detector, and demote-not-drop
    // keeps any residual real finding visible. Logged on every fire so a false
    // demote is observable. Always-on (a correctness rule, like the authz drop).
    if (
      f.category !== "testing" &&
      f.category !== "docs" &&
      lineInDurableObjectClass(doClassSpans.get(f.path.trim()), f.line) &&
      findingClaimsIntraInstanceRace(f)
    ) {
      console.log(JSON.stringify({
        event: "do-race-finding-demoted",
        path: f.path, line: f.line, score: f.score,
        headline: (f.headline ?? "").slice(0, 100),
      }))
      if (trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "do-race" })
      unanchoredFindings.push(f)
      continue
    }

    // SIG-108: security evidence gate. Applies ONLY to findings whose
    // derived role set includes `security` (from provenance, NOT from
    // `finding.category` alone — Codex #3: a merged security+logic
    // finding must still satisfy the evidence rule). A sev>=4 security
    // finding must carry a resolving evidenceId, be auto-enrichable
    // from a manifest fact at the same path/+-10 lines, or — for the
    // authz bucket — set evidenceId:"NONE" with a body justification.
    // Runs AFTER the testing gate (disjoint domains) and BEFORE score-1
    // demotion + line validation (Codex #3). Shadow-first: in `shadow`
    // mode the verdict is counted + telemetered but the finding is NOT
    // dropped; only `enforce` actually drops.
    if (securityManifest && sourceRolesInclude(sourceIds, "security")) {
      const decision = evaluateSecurityFinding(f, securityManifest)
      if (decision.keep) {
        // Auto-enrich: stamp the corroborating fact's evidenceId/cwe so
        // downstream consumers (markers, body rendering) see the
        // citation. CR-1 (CodeRabbit): clone rather than mutate — `f`
        // aliases the raw synth finding held by telemetry.synthesizer
        // .verdict; rewriting it would erase the distinction between
        // "model cited it" and "validator backfilled it" in the shadow
        // data. The enriched clone flows to the validated output; the
        // recorded synth verdict keeps the model's original.
        if (decision.enrich) {
          f = {
            ...f,
            evidenceId: decision.enrich.evidenceId,
            ...(decision.enrich.cweId && !f.cweId ? { cweId: decision.enrich.cweId } : {}),
          }
        }
      } else {
        // SIG-108 (demote-conversion, 2026-06-01): an unsupported sev>=4 security
        // finding is DEMOTED to the review body in `enforce` — NOT hard-dropped.
        // The Trust Ledger now gives it a home (the body) + an honest MODEL/GROUNDED
        // pill, so the guidance stays VISIBLE instead of vanishing (FN-cost >> FP-cost
        // for security). `shadow` keeps it inline (count only). The counter +
        // callback semantics are unchanged: `dropped` = the enforce action fired
        // (now a demote). Currently shadow in prod, so this is inert until the
        // enforce flip.
        const demoted = securityValidatorMode === "enforce"
        droppedForFailedValidation++
        onSecurityFindingDropped?.(f, { reason: decision.reason, dropped: demoted })
        if (demoted) {
          if (trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "security-evidence" })
          unanchoredFindings.push(f)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // SIG-325: refutation-survival backstop for SELF-ORIGINATED security
    // findings — the security analog of the SIG-308 logic gate. A sev>=4
    // security finding with no resolving manifest evidenceId (empty or "NONE")
    // is self-originated: no scanner proposed it, so the SIG-282 candidate-
    // verification path never engaged. It must articulate its mechanism
    // (source→sink→type) in `independentAssessment` or it reads as a CWE label
    // with a confabulated mechanism (the SSRF / path-traversal / prototype-
    // pollution hallucination class). Runs AFTER the SIG-108 evidence gate so an
    // auto-enriched evidenceId already marks a finding tool-backed (and thus
    // exempt). Same shadow-first + demote-to-body (not hard-drop) FN-safety as
    // the security evidence gate; `off` skips entirely.
    if (
      refutationSurvivalMode !== "off" &&
      sourceRolesInclude(sourceIds, "security") &&
      isSelfOriginatedSecurityFinding(f, securityManifest)
    ) {
      // CodeRabbit: judge against the SECURITY-lens rationale, NOT the
      // logic-scoped globally-backfilled field — a merged finding must not pass
      // the security gate on a logic rationale, and a synth-dropped security
      // rationale is restored from the security sources.
      const decision = evaluateRefutationSurvival({
        ...f,
        independentAssessment: resolveLensRationale(
          f.independentAssessment,
          sourceIds,
          sourceRationaleByIdSecurity,
          "security",
        ),
      })
      if (!decision.keep) {
        const demoted = refutationSurvivalMode === "enforce"
        droppedForFailedRefutationSurvival++
        onRefutationSurvivalFindingDropped?.(f, {
          reason: decision.reason,
          dropped: demoted,
          lens: "security",
        })
        if (demoted) {
          if (trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "refutation-survival" })
          unanchoredFindings.push(f)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // SIG-109: logic evidence gate. Applies ONLY to findings whose
    // derived role set includes `logic` (from the `logic-` sourceFindingId
    // prefix, NOT `finding.category` alone — mirrors the SIG-108 security
    // gate's provenance derivation). A sev>=4 logic finding must be
    // anchored to the diff: on a changed path AND backed by a co-located
    // AST hit OR a concrete backticked token on an added line; otherwise
    // it's an unanchored claim. Runs AFTER the SIG-108 security gate
    // (disjoint domains) and BEFORE score-1 demotion + line validation.
    // Shadow-first: in `shadow` mode the verdict is counted + telemetered
    // but the finding is NOT dropped; only `enforce` actually drops. This
    // gate is false-negative-sensitive (logic bugs are LLM-found with no
    // deterministic backing) so the pure helper biases hard toward keep.
    if (logicEvidence && sourceRolesInclude(sourceIds, "logic")) {
      const logicDecision = evaluateLogicFinding(f, logicEvidence)
      if (!logicDecision.keep) {
        const dropped = logicValidatorMode === "enforce"
        droppedForFailedLogicValidation++
        onLogicFindingDropped?.(f, { reason: logicDecision.reason, dropped })
        if (dropped) continue
        // shadow mode: fall through and keep the finding.
      }
    }

    // SIG-308: logic-refutation backstop. A sev>=4 logic-sourced finding that
    // never showed it survives refutation (no `independentAssessment`) is the
    // self-refuting-finding shape (PR #12 `sinceMs`). Phase 1's prompt is the
    // primary control (the model self-clears into `clearedLogicCandidates`);
    // this is the residual safety net. Same shadow-first semantics as the
    // SIG-109 gate — drops (continue) only in `enforce`; `off` skips entirely.
    if (logicRefutationMode !== "off" && sourceRolesInclude(sourceIds, "logic")) {
      const refutationDecision = evaluateLogicRefutation(f)
      if (!refutationDecision.keep) {
        const dropped = logicRefutationMode === "enforce"
        droppedForFailedLogicRefutation++
        onLogicRefutationFindingDropped?.(f, { reason: refutationDecision.reason, dropped })
        if (dropped) continue
        // shadow mode: fall through and keep the finding.
      }
    }

    // SIG-328/SIG-334: logic-claim refutation gate. Drops a sev>=4 logic
    // finding only when a supported claim shape is PROVABLY false against the
    // AST of the cited file. Fails OPEN on every ambiguity (the pure validator
    // re-checks category+sev), so it cannot suppress a real bug. Same
    // shadow-first semantics: only `enforce` drops.
    if (logicClaimRefutationMode !== "off" && sourceRolesInclude(sourceIds, "logic")) {
      const claimDecision = evaluateLogicClaimRefutation(f, { fullFileByPath, astCache })
      if (!claimDecision.keep) {
        const dropped = logicClaimRefutationMode === "enforce"
        droppedForFailedLogicClaimRefutation++
        onLogicClaimRefutationFindingDropped?.(f, { reason: claimDecision.reason, dropped })
        if (dropped) continue
        // shadow mode: fall through and keep the finding.
      }
    }

    // SIG-110: perf-finding evidence gate. A sev>=4 performance-sourced
    // finding (derived from the `performance-` sourceFindingId prefix) must
    // be anchored to the diff: on a changed path AND backed by a co-located
    // AST perf hit OR a concrete token (from backticks / complexityEstimate
    // / hotPathIdentifier) on a changed line. Disjoint domain from the
    // logic/security gates. Shadow-first: only `enforce` drops.
    if (perfEvidence && sourceRolesInclude(sourceIds, "performance")) {
      const perfDecision = evaluatePerfFinding(f, perfEvidence)
      if (!perfDecision.keep) {
        const dropped = perfValidatorMode === "enforce"
        droppedForFailedPerfValidation++
        onPerfFindingDropped?.(f, { reason: perfDecision.reason, dropped })
        if (dropped) continue
        // shadow mode: fall through and keep the finding.
      }
    }

    // SIG-325: refutation-survival backstop for SELF-ORIGINATED perf findings.
    // A sev>=4 perf finding with no co-located AST perf hit (kept only via a
    // changed-token match) is the model's own assertion — no deterministic
    // analyzer flagged it. It must justify why the cost is real (the changed
    // hot path under load) in `independentAssessment` or it reads as a verdict
    // without backing (the PR #18 "recomputes HMAC — no caching" over-claim
    // class). Runs AFTER the SIG-110 evidence gate so an AST-backed perf finding
    // is already marked tool-backed (and thus exempt). Same shadow-first +
    // demote-to-body (not hard-drop) FN-safety; `off` skips entirely.
    if (
      refutationSurvivalMode !== "off" &&
      perfEvidence &&
      sourceRolesInclude(sourceIds, "performance") &&
      perfFindingIsSelfOriginated(f, perfEvidence)
    ) {
      // CodeRabbit: judge against the PERFORMANCE-lens rationale, NOT the
      // logic-scoped globally-backfilled field.
      const decision = evaluateRefutationSurvival({
        ...f,
        independentAssessment: resolveLensRationale(
          f.independentAssessment,
          sourceIds,
          sourceRationaleByIdPerf,
          "performance",
        ),
      })
      if (!decision.keep) {
        const demoted = refutationSurvivalMode === "enforce"
        droppedForFailedRefutationSurvival++
        onRefutationSurvivalFindingDropped?.(f, {
          reason: decision.reason,
          dropped: demoted,
          lens: "performance",
        })
        if (demoted) {
          if (trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "refutation-survival" })
          unanchoredFindings.push(f)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // Score-1 advisory demotion
    if (f.score <= 1) {
      advisoryNits.push(f)
      provenanceDropped.push({
        specialist: firstSpecialistRoleFromSourceIds(sourceIds),
        sourceFindingId: sourceIds[0]!,
        headline: f.headline,
        reason: "score-1-advisory",
      })
      demotedScore1++
      continue
    }

    // SIG-141 + SIG-245 inline-first: a finding anchored to line 1 is often a
    // file-header over-fire (license/imports/opening comment) on a new-file PR.
    // BUT line 1 of a newly-ADDED file IS a real RIGHT diff anchor, so a genuine
    // line-1 finding (e.g. a hardcoded secret on the first line — observed on
    // the e2e repos) must still inline: inline-first means anchorable findings
    // go inline; the body is reserved for code outside the diff. So only
    // body-route a line-1 finding whose line 1 is NOT a reviewable anchor (a
    // header/import on an UNCHANGED file = genuinely outside this PR's diff).
    // When line 1 IS anchorable, fall through to the normal anchor path below,
    // which inlines it (a RIGHT line-1 anchor inlines verbatim; the
    // findRepairableInlineAnchor repair only applies when line 1 resolves
    // LEFT-only). A content over-fire is the grounding/evidence gates' job, not
    // a line-number heuristic's.
    if (f.line === 1 && !deriveSide(reviewable, f.path, 1)) {
      droppedForInvalidLine++
      if (trustLedgerEnabled) annotateFindingTrust(f, { surface: "body", demoteReason: "outside-diff" })
      unanchoredFindings.push(f)
      continue
    }

    // Line validity + side derivation.
    //
    // SIG-216 follow-up (Option A): a multi-line finding whose ENDPOINT
    // isn't in any RIGHT-side hunk may still be inline-anchorable if
    // the MIDDLE of the [startLine, line] range overlaps the diff. The
    // scope-normalizer already flipped scope:"line" for this case; the
    // half-measure was leaving f.line pointing at the original
    // unreviewable line so the downstream POST to GitHub would 422.
    // Rewrite both endpoints to the actually-anchorable subrange (last
    // RIGHT anchor becomes new `line`, first RIGHT anchor becomes new
    // `start_line`) so isCommentAnchorable passes and the inline POST
    // succeeds. PR #175 dogfood class.
    //
    // PR #176 CR follow-up: run the range-aware rewrite FIRST so that
    // `deriveSide` (and any subsequent validation) sees the rewritten
    // endpoints rather than the stale originals. A multi-line finding
    // whose original `startLine` is unanchorable would otherwise slip
    // through to a `start_line` 422 on the GitHub inline POST.
    const rangeAnchor = findRangeAwareAnchor(reviewable, f)
    let workingFinding: PrReviewFinding = f
    let rewroteRange = false
    if (rangeAnchor !== null) {
      // Drop the original `startLine` and re-apply only when the helper
      // returned a distinct top-of-underline anchor; otherwise the
      // stale original (outside the actually-anchorable subrange)
      // would fail `isCommentAnchorable` and the inline POST would
      // 422 on `start_line`.
      const { startLine: _originalStartLine, ...rest } = f
      void _originalStartLine
      workingFinding =
        rangeAnchor.startLine !== undefined
          ? { ...rest, line: rangeAnchor.line, startLine: rangeAnchor.startLine }
          : { ...rest, line: rangeAnchor.line }
      // Only count an actual rewrite (anchor differs from the original
      // endpoints) so the counter isn't inflated for findings whose
      // original anchor was already valid and matched by the helper.
      rewroteRange =
        workingFinding.line !== f.line ||
        workingFinding.startLine !== f.startLine
    }

    // SIG-281 PR C (Rec 4): inline-grounding gate. A finding that reaches
    // here is a real inline candidate — it survived every hard-drop gate
    // (SIG-113/111/141/108/109/110), the score-1 advisory demotion, and
    // the range-aware anchor repair above. If it's a weakly-grounded
    // score 2-3 finding it is DEMOTED to the review body (content
    // preserved — NOT hard-dropped) so the inline surface stays
    // high-signal; score>=4 (believability floor) and score<=1 (already
    // routed to advisory above) are kept by the pure helper.
    //
    // PLACEMENT: AFTER the hard-drop gates (Codex P1 — never demote a
    // finding those gates would drop) AND AFTER anchor repair (CodeRabbit
    // Major — demote `workingFinding` so the body record + downstream
    // withdrawal matching use the REPAIRED anchor, not the raw line).
    // Shadow-first: only `enforce` demotes; `shadow` counts + telemeters
    // and keeps the finding inline.
    {
      const groundingDecision = evaluateInlineGrounding(workingFinding, { addedLineTextByLine })
      if (!groundingDecision.keep) {
        const demoted = inlineGroundingValidatorMode === "enforce"
        droppedForFailedInlineGroundingValidation++
        onInlineGroundingFindingDropped?.(workingFinding, { reason: groundingDecision.reason, dropped: demoted })
        if (demoted) {
          if (trustLedgerEnabled) annotateFindingTrust(workingFinding, { surface: "body", demoteReason: "inline-grounding" })
          unanchoredFindings.push(workingFinding)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // SIG-290 v1: absence-grounding gate. An "absence-claim" finding
    // ("lacks tests", "no null check", "missing validation") is only
    // believable when the evidence that would confirm-or-refute the
    // absence was in the specialist's window. When it was PROVABLY not
    // (the sibling test was never inspected, or the cited path was
    // dropped from the diff) the bot was GUESSING — DEMOTE to the body
    // (content preserved, NOT hard-dropped). FP-safe: non-absence-claims,
    // excluded phrases, performance findings, and every UNKNOWN keep.
    //
    // PLACEMENT mirrors the inline-grounding block above (after the
    // hard-drop gates + anchor repair, so the demote routes `workingFinding`
    // with the repaired anchor). `off` skips the gate entirely; `shadow`
    // counts + telemeters and keeps the finding inline; only `enforce`
    // demotes. No score floor — a P0/P1 ungrounded absence-claim is the
    // worst case and is demoted too.
    if (absenceClaimValidatorMode !== "off") {
      const absenceDecision = evaluateAbsenceGrounding(workingFinding, {
        testingEvidence,
        reviewablePaths,
        wasTruncated,
        droppedPaths,
      })
      if (!absenceDecision.keep) {
        const demoted = absenceClaimValidatorMode === "enforce"
        droppedForFailedAbsenceGroundingValidation++
        onAbsenceFindingDropped?.(workingFinding, { reason: absenceDecision.reason, dropped: demoted })
        if (demoted) {
          if (trustLedgerEnabled) annotateFindingTrust(workingFinding, { surface: "body", demoteReason: "absence-grounding" })
          unanchoredFindings.push(workingFinding)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // Cross-cutting over-fire Option B: window-blindness gate. A sev>=4 LOGIC
    // positive misread ("X can be undefined / returns NaN / is unbounded") is a
    // window-blindness FP when the guard on the SAME cited symbol is provably
    // present in the FULL file but OUTSIDE the diff window the model saw —
    // upstream of the flagged use, at a dominating indent, within the proximity
    // bound. DEMOTE to the body (content preserved, NOT hard-dropped). FP-safe:
    // non-logic, sub-4, non-misread, no full file, no out-of-window guard, and
    // every ambiguity keep. The deterministic backstop to PR #327's prompt fence.
    //
    // PLACEMENT mirrors the absence-grounding block above (after the hard-drop
    // gates + anchor repair, so the demote routes `workingFinding` with the
    // repaired anchor). `off` skips the gate; `shadow` counts + telemeters and
    // keeps inline; only `enforce` demotes.
    if (windowBlindnessValidatorMode !== "off") {
      const wbDecision = evaluateWindowBlindness(workingFinding, {
        fullFileByPath,
        windowLinesByPath,
      })
      if (!wbDecision.keep) {
        const demoted = windowBlindnessValidatorMode === "enforce"
        droppedForFailedWindowBlindnessValidation++
        onWindowBlindnessFindingDropped?.(workingFinding, {
          reason: wbDecision.reason,
          matchedIdentifier: wbDecision.matchedIdentifier,
          guardLine: wbDecision.guardLine,
          dropped: demoted,
        })
        if (demoted) {
          if (trustLedgerEnabled) annotateFindingTrust(workingFinding, { surface: "body", demoteReason: "window-blindness" })
          unanchoredFindings.push(workingFinding)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // SIG-293 v1: security-grounding gate (secrets-exposure). A
    // `secrets-exposure` (CWE-798) finding is only believable when the
    // cited code actually CONTAINS a credential token. One whose cited
    // line holds no credential (the #243 FP: a sev-3 finding that misread
    // `console.log(payload.length)` as a leak) is a hallucination — DEMOTE
    // to the body (content preserved, NOT hard-dropped). v1 gates ONLY
    // secrets-exposure (the single line-level-detectable category); a
    // corroborating scanner fact ALWAYS keeps. Scoped to SECURITY-sourced
    // findings (provenance, like the SIG-108 evidence gate) so a non-
    // security finding that merely carries CWE-798 is untouched.
    //
    // PLACEMENT mirrors the inline/absence blocks above (after the hard-
    // drop gates + anchor repair, so the demote routes `workingFinding`
    // with the repaired anchor). `off` skips the gate; `shadow` counts +
    // telemeters and keeps inline; only `enforce` demotes. No score floor —
    // a P0/P1 ungrounded secrets claim is the worst case and is demoted too.
    if (securityGroundingValidatorMode !== "off" && sourceRolesInclude(sourceIds, "security")) {
      const sgDecision = evaluateSecurityGrounding(workingFinding, {
        addedLineTextByLine,
        manifest: securityManifest,
      })
      if (!sgDecision.keep) {
        const demoted = securityGroundingValidatorMode === "enforce"
        droppedForFailedSecurityGroundingValidation++
        onSecurityGroundingFindingDropped?.(workingFinding, { reason: sgDecision.reason, dropped: demoted })
        if (demoted) {
          if (trustLedgerEnabled) annotateFindingTrust(workingFinding, { surface: "body", demoteReason: "security-grounding" })
          unanchoredFindings.push(workingFinding)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    // SIG-311 Layers A+B: security USAGE-vs-MENTION gate. Demote a sev>=4
    // injection/xss finding on a detector/validator/test/doc path whose cited
    // token is a mention, not a live sink (the PR #296 self-FP family). Same
    // off/shadow/enforce placement as the grounding gate above; DEMOTE-not-drop,
    // keep on any uncertainty (the gate fails closed inside evaluateSecurityUsage).
    if (securityUsageValidatorMode !== "off" && sourceRolesInclude(sourceIds, "security")) {
      const suDecision = evaluateSecurityUsage(workingFinding, { addedLineTextByLine })
      if (!suDecision.keep) {
        const demoted = securityUsageValidatorMode === "enforce"
        droppedForFailedSecurityUsageValidation++
        onSecurityUsageFindingDropped?.(workingFinding, { reason: suDecision.reason, dropped: demoted })
        if (demoted) {
          if (trustLedgerEnabled) annotateFindingTrust(workingFinding, { surface: "body", demoteReason: "security-usage" })
          unanchoredFindings.push(workingFinding)
          continue
        }
        // shadow mode: fall through and keep the finding inline.
      }
    }

    const side = deriveSide(reviewable, workingFinding.path, workingFinding.line)
    if (!side) {
      const repairedLine =
        workingFinding.startLine == null
          ? findRepairableInlineAnchor({ finding: workingFinding, reviewable, addedLineTextByLine })
          : null
      if (repairedLine !== null) {
        cleanFindings.push({ ...workingFinding, line: repairedLine })
        if (provenance) cleanFindingProvenance.push(provenance)
        remappedInvalidLineToInline++
        continue
      }
      droppedForInvalidLine++
      // Preserve for submit-fallback. Inline anchoring would fail here,
      // but the finding's *content* is still actionable when posted as
      // free-form markdown in the body of an anchorless review.
      if (trustLedgerEnabled) annotateFindingTrust(workingFinding, { surface: "body", demoteReason: "outside-diff" })
      unanchoredFindings.push(workingFinding)
      continue
    }
    cleanFindings.push(workingFinding)
    if (rewroteRange) remappedInvalidLineToInline++
    // ARC-189: keep the per-clean-finding provenance aligned by index
    // for the ensemble caller's marker-emission step. `provenance` is
    // narrowed by the hallucination guard above (sourceIds.length >= 1
    // implies provenance was non-null).
    if (provenance) cleanFindingProvenance.push(provenance)
  }

  // Aggregate score-1 advisory nits only when the repo opts into
  // assertive review tone. Default/chill keeps these out of
  // customer-visible output entirely while preserving audit provenance.
  let summary = synthOutput.verdict.summary
  if (profile === "assertive" && advisoryNits.length > 0) {
    advisoryNits.sort((a, b) => b.score - a.score || a.headline.localeCompare(b.headline))
    const top = advisoryNits.slice(0, MAX_ADVISORY_NITS)
    const rest = advisoryNits.length - top.length
    const headlines = top.map((n) => n.headline).join("; ")
    const tail = rest > 0 ? `; plus ${rest} more advisory nits` : ""
    summary = `${summary}\n\n**Advisory nits:** ${headlines}${tail}`
  }

  // Inlines-only / outside-diff (founder ask, Codex #333): tag every finding
  // whose `path` is NOT a changed file as out-of-PR-scope — it's about code the
  // model raised from graph/retrieval context, not this PR's changes. Computed
  // from the reviewable changed-file set, INDEPENDENT of the trust-ledger flag.
  // An inline finding always anchored to a changed line, so its path is in the
  // set → never tagged. A body finding on a CHANGED file that merely failed to
  // anchor stays in-scope and still blocks — only a truly different file is
  // out-of-scope, which closes the recall hole of treating anchor-failure as
  // out-of-PR.
  // Normalize both sides with `.trim()` — the path-handling convention across
  // this module (triage-pr-review.ts:702/865, ensemble.ts:9218) — so a model
  // path with stray whitespace can't mismatch a changed-file key and wrongly
  // mark a real blocker out-of-scope (CodeRabbit #334 — recall-relevant).
  const normPath = (p: string): string => p.trim()
  const changedFilePaths = new Set([...reviewable.keys()].map(normPath))
  for (const f of cleanFindings) if (!changedFilePaths.has(normPath(f.path))) f.outOfPrScope = true
  for (const f of unanchoredFindings) if (!changedFilePaths.has(normPath(f.path))) f.outOfPrScope = true

  return {
    verdict: { ...synthOutput.verdict, summary, findings: cleanFindings },
    unanchoredFindings,
    droppedForInvalidLine,
    remappedInvalidLineToInline,
    droppedForHallucination,
    demotedScore1,
    droppedForVaguePrefix,
    droppedForUncitedTestingEvidence,
    droppedForFailedValidation,
    droppedForFailedTestValidation,
    droppedForFailedLogicValidation,
    droppedForFailedLogicRefutation,
    droppedForFailedLogicClaimRefutation,
    droppedForFailedRefutationSurvival,
    droppedForFailedPerfValidation,
    droppedForFailedInlineGroundingValidation,
    droppedForFailedAbsenceGroundingValidation,
    droppedForFailedWindowBlindnessValidation,
    droppedForFailedSecurityGroundingValidation,
    droppedForFailedSecurityUsageValidation,
    cleanFindingProvenance,
    provenance: {
      ...synthOutput.provenance,
      dropped: provenanceDropped,
    },
  }
}

/**
 * SIG-108: derive whether a finding's source role set includes `role`.
 * Uses BOTH the explicit `sourceSpecialists` array AND the prefix of
 * each `sourceFindingId` (e.g. "security-0" → "security") — Codex #3:
 * don't trust `sourceSpecialists` blindly; cross-derive from the
 * validated finding ids too. A merged security+logic finding
 * (sourceSpecialists: ["security","logic"]) still counts as security.
 */
function firstSpecialistRoleFromSourceIds(sourceIds: readonly string[]): SpecialistRole {
  for (const id of sourceIds) {
    const role = ALL_SPECIALISTS.find((candidate) => id.startsWith(`${candidate}-`))
    if (role) return role
  }
  return "logic"
}

function sourceRolesInclude(
  sourceIds: readonly string[],
  role: SpecialistRole,
): boolean {
  // Codex-M1 (review): the `<role>-<index>` finding-id prefixes are
  // assigned deterministically (assignStableFindingIds) and are the
  // authoritative provenance signal. `sourceSpecialists` is synth-
  // reported and can be malformed — e.g. claim "security" while every
  // sourceFindingId is "logic-N". Trusting it would security-gate (and,
  // in enforce mode, DROP) a real logic finding for lacking security
  // evidence. Derive scope from the validated id prefixes ONLY. Under-
  // applying (a genuine security finding whose ids weren't populated)
  // is the safe direction for an FP-reduction gate: it skips the check,
  // never drops a real finding.
  const prefix = `${role}-`
  return sourceIds.some((id) => typeof id === "string" && id.startsWith(prefix))
}
