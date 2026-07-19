// SIG-318 (PR 8) / SIG-386 (PR2) — the `validateForSubmission` ARGS type + the
// shared phase-state types + the small pure helpers the per-finding walk needs.
// Split out of the validation core so each sibling stays ≤1k under the SIG-318
// budget. PR2 is a PURE extract-method refactor: the `ValidateForSubmissionArgs`
// type + the vague-prefix / testing-citation public helpers moved here
// byte-identical (and are re-exported from `./validation` so its export surface
// is unchanged). The harness pins behavior.
//
// Leaf discipline (SIG-318): this leaf must never VALUE-import the core
// (`./validation`); the only edge back is the type-only `import type` of
// `CollectedVerdict` / `SynthesizerProvenance`, which `verbatimModuleSyntax`
// fully erases (zero runtime cycle).

import type { PrReviewVerdict, PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { ALL_SPECIALISTS, type SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import type { buildSourceFindingSecurityEvidenceById, buildSourceFindingRationaleById } from "./validation-internals"
import {
  factClassCompatible,
  type SecurityValidatorMode,
  type SecurityDropReason,
} from "./gates/validate-security-finding"
import { parseCoverageGapRef, type TestsValidatorMode, type TestDropReason } from "./gates/validate-test-finding"
import type { AstScanMode } from "./config"
import type { LogicValidatorMode, LogicDropReason, LogicEvidence } from "./gates/validate-logic-finding"
import type { LogicRefutationMode, LogicRefutationDropReason } from "./gates/validate-logic-refutation"
import type { RefutationSurvivalMode, RefutationSurvivalDropReason } from "./gates/validate-refutation-survival"
import type { LogicClaimRefutationMode, LogicClaimDropReason } from "./gates/validate-logic-claim-refutation"
import type { PerfValidatorMode, PerfDropReason, PerfEvidence } from "./gates/validate-perf-finding"
import type { InlineGroundingValidatorMode, InlineGroundingDropReason } from "./gates/validate-inline-grounding"
import type { AbsenceClaimValidatorMode, AbsenceGroundingDropReason } from "./gates/validate-absence-grounding"
import type { WindowBlindnessValidatorMode, WindowBlindnessDropReason } from "./gates/validate-window-blindness"
import type { DiffConsistencyValidatorMode, DiffConsistencyDropReason } from "./gates/validate-diff-consistency"
import type { SecurityGroundingValidatorMode, SecurityGroundingDropReason } from "./gates/validate-security-grounding"
import type { SecurityUsageValidatorMode, SecurityUsageDropReason } from "./gates/validate-security-usage"
import type { TestingEvidencePack } from "@/src/lib/testing-evidence-pack"
import type { SecurityFact } from "@/src/lib/security-evidence-manifest"
import type { SigilixProfile } from "@/src/lib/sigilix-config"
import type { LineSpan, AstCache } from "@/src/features/ast-rules"
import type { CollectedVerdict, SynthesizerProvenance } from "./validation"

export const MAX_ADVISORY_NITS = 5

// ─── vague-prefix public helpers (moved from ./validation, PR2) ───────────────

/**
 * ARC-156 (Greptile port A2): vague-prefix filter — drop any finding
 * whose `headline` or `body` starts with one of these words (case-
 * sensitive, word-boundary). The negative-constraint specialist
 * prompts (see `SHARED_NEGATIVE_CONSTRAINTS` in pr-review-specialists.ts)
 * tell the model not to emit these; this post-processing filter is
 * the backstop for findings that slip through.
 */
export const VAGUE_PREFIXES = ["Ensure", "Verify", "Validate", "Consider", "Review", "Confirm"] as const

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

// ─── testing-citation public gate + self-originated predicate (moved, PR2) ────

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
export function isSelfOriginatedSecurityFinding(
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
 *     finding").
 *   - When pack is present, at least one cited evidence ref must point
 *     at something real in the pack.
 *
 * Pure — exported for unit tests.
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

// ─── private provenance helpers (moved from ./validation, PR2) ────────────────

/**
 * SIG-108: derive whether a finding's source role set includes `role`.
 * Uses BOTH the explicit `sourceSpecialists` array AND the prefix of
 * each `sourceFindingId` (e.g. "security-0" → "security") — Codex #3:
 * don't trust `sourceSpecialists` blindly; cross-derive from the
 * validated finding ids too. A merged security+logic finding
 * (sourceSpecialists: ["security","logic"]) still counts as security.
 */
export function firstSpecialistRoleFromSourceIds(sourceIds: readonly string[]): SpecialistRole {
  for (const id of sourceIds) {
    const role = ALL_SPECIALISTS.find((candidate) => id.startsWith(`${candidate}-`))
    if (role) return role
  }
  return "logic"
}

export function sourceRolesInclude(sourceIds: readonly string[], role: SpecialistRole): boolean {
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

// ─── the `validateForSubmission` args type (moved from ./validation, PR2) ─────

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
  /** SIG-392: reclass-to-logic at the evidence gate's demote branch. */
  securityReclassEnabled?: boolean
  /**
   * SIG-108: optional telemetry callback fired once per security
   * finding the gate flagged (whether or not it was actually dropped —
   * the `dropped` arg distinguishes enforce from shadow). Lets the
   * orchestrator log `pr-review-finding-rejected-validation` with full
   * correlation fields without coupling the pure validator to a logger.
   */
  onSecurityFindingDropped?: (finding: PrReviewFinding, info: { reason: SecurityDropReason; dropped: boolean }) => void
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
   * SIG-488 (recall #5): `off | shadow | on` (default off). `on` demotes a sev>=4
   * finding the vague-prefix / uncited-testing HARD-DROP heuristics would delete to
   * a P2 note instead of dropping it; low-sev nits still drop. `shadow` counts the
   * would-saves only. Sourced from `ensembleConfig.flags.highSevGateDemoteMode`.
   */
  highSevGateDemoteMode?: AstScanMode
  /**
   * SIG-111: optional telemetry callback fired once per testing finding
   * the specificity gate flagged (whether or not it was actually
   * dropped — the `dropped` arg distinguishes enforce from shadow).
   * Lets the orchestrator log `pr-review-finding-rejected-validation`
   * (the SIG-108 event, reused with a `gate: "tests"` discriminator)
   * without coupling the pure validator to a logger.
   */
  onTestFindingDropped?: (finding: PrReviewFinding, info: { reason: TestDropReason; dropped: boolean }) => void
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
  onLogicFindingDropped?: (finding: PrReviewFinding, info: { reason: LogicDropReason; dropped: boolean }) => void
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
  /**
   * SIG-392: reason-scoped enforce allowlist. `undefined` ⇒ `enforce` drops
   * every refuted shape (legacy). A Set ⇒ in `enforce` ONLY these reasons drop;
   * the rest stay shadow. Read from `OPENCLAW_LOGIC_CLAIM_REFUTATION_ENFORCE_REASONS`.
   */
  logicClaimRefutationEnforceReasons?: ReadonlySet<LogicClaimDropReason> | undefined
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
   * SIG-458: per-file old-side DELETED-line text (`buildDeletedLineTextByLine`).
   * Used by `anchorNoLineDeletionFinding` to anchor a no-line file/pr-scope
   * `category:"testing"` finding about a DELETED test onto the deleted `it(...)`
   * line (a LEFT diff position) on a unique guarded content match, so submission's
   * SIG-456 LEFT path inlines it instead of body-routing. Absent → the helper
   * no-ops (back-compat for callers not threading the map).
   */
  deletedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
  /**
   * SIG-110: telemetry callback fired once per perf finding the gate
   * flagged (reuses the `pr-review-finding-rejected-validation` event with
   * a `gate: "perf"` discriminator).
   */
  onPerfFindingDropped?: (finding: PrReviewFinding, info: { reason: PerfDropReason; dropped: boolean }) => void
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
   * SIG-602 v1: diff-consistency gate mode. `off` (default) skips the gate;
   * `shadow` counts + telemeters but keeps every finding inline; `enforce`
   * DEMOTES a finding whose OWN claim is deterministically contradicted by the
   * diff or its own body (a "missing" file present in the PR, an "exported" Go
   * symbol whose identifier is lower-case, or a headline that contradicts its
   * explanation) to the review body (never hard-drops). Reuses `reviewablePaths`
   * + `addedLineTextByLine` already threaded above. Read from
   * `SIGILIX_DIFF_CONSISTENCY_VALIDATOR_MODE` at the call site.
   */
  diffConsistencyValidatorMode?: DiffConsistencyValidatorMode
  /**
   * SIG-602 v1: telemetry callback fired once per finding the diff-consistency
   * gate flagged (reuses the `pr-review-finding-rejected-validation` event with
   * a `gate: "diff-consistency"` discriminator). `dropped` here means "demoted
   * to body" (enforce), not hard-dropped.
   */
  onDiffConsistencyFindingDropped?: (
    finding: PrReviewFinding,
    info: {
      reason: DiffConsistencyDropReason
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
   *  `dropped` remains false for SIG-440 trust-demoted inline findings. */
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
  /** SIG Trust Ledger v0: when true (flag != off), tag trust-demoted and
   *  non-inline findings with `demoteReason` so the renderer can show the right
   *  pill and split outside-diff vs PR-level. Gated so `off` stays a true no-op. */
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

// ─── phase-state types (SIG-386 PR2) ──────────────────────────────────────────

/**
 * SIG-386 (PR2): the single mutable accumulator threaded through the phases.
 * Bundles the ~18 loop-scoped counters + the output arrays the original
 * function declared individually, so the per-finding phase functions increment
 * exactly the same fields the inline loop did. Behavior-identical: each counter
 * is bumped at the same site, in the same order, with the same value.
 */
/**
 * SIG-386: the result of running one HARD-DROP gate. `continue` = the loop would
 * `continue` (finding dropped or demoted-to-body via `state` mutations already);
 * `proceed` carries the (possibly cloned/score-damped) finding to the demote gates.
 * Lives here (shared leaf) so both `validation-walk` and the gate resolvers it
 * delegates to (e.g. `validation-highsev-demote`) reference one type, no cycle.
 */
export type HardDropResult = { kind: "continue" } | { kind: "proceed"; finding: PrReviewFinding }

export interface ValidationState {
  cleanFindings: PrReviewFinding[]
  cleanFindingProvenance: SynthesizerProvenance["findings"]
  provenanceDropped: SynthesizerProvenance["dropped"]
  unanchoredFindings: PrReviewFinding[]
  advisoryNits: PrReviewFinding[]
  droppedForInvalidLine: number
  remappedInvalidLineToInline: number
  droppedForHallucination: number
  demotedScore1: number
  droppedForVaguePrefix: number
  droppedForUncitedTestingEvidence: number
  droppedForFailedValidation: number
  droppedForFailedTestValidation: number
  droppedForFailedLogicValidation: number
  droppedForFailedLogicRefutation: number
  droppedForFailedLogicClaimRefutation: number
  droppedForFailedRefutationSurvival: number
  droppedForFailedPerfValidation: number
  droppedForFailedInlineGroundingValidation: number
  droppedForFailedAbsenceGroundingValidation: number
  droppedForFailedWindowBlindnessValidation: number
  droppedForFailedDiffConsistencyValidation: number
  droppedForFailedSecurityGroundingValidation: number
  droppedForFailedSecurityUsageValidation: number
}

/**
 * SIG-386 (PR2): the immutable, derived context the per-finding phases read —
 * the resolved id/evidence/rationale maps + the gate-context maps built once at
 * Phase 1 init. Bundled so the phase signatures stay readable.
 */
export interface ValidationContext {
  validIds: Set<string>
  sourceEvidenceById: ReturnType<typeof buildSourceFindingSecurityEvidenceById>
  sourceRationaleById: ReturnType<typeof buildSourceFindingRationaleById>
  sourceRationaleByIdSecurity: ReturnType<typeof buildSourceFindingRationaleById>
  sourceRationaleByIdPerf: ReturnType<typeof buildSourceFindingRationaleById>
  reviewablePaths: ReadonlySet<string>
  windowLinesByPath: ReadonlyMap<string, ReadonlySet<number>>
}

/**
 * SIG-386 (PR2): the resolved (defaulted) args bundle used by the phases. The
 * formerly-optional source fields become `T | undefined` (non-optional) so the
 * destructured values — `T | undefined` after the Phase-1 default resolution —
 * assign cleanly under `exactOptionalPropertyTypes`. Callers always supply every
 * key (init builds the object literal), so there is no missing-property hazard.
 */
export interface ResolvedValidationArgs {
  synthOutput: { verdict: PrReviewVerdict; provenance: SynthesizerProvenance }
  reviewable: ReviewableMap
  specialistVerdicts: CollectedVerdict[]
  testingEvidence: TestingEvidencePack | undefined
  onTestingFindingDropped: ValidateForSubmissionArgs["onTestingFindingDropped"]
  securityManifest: Map<string, SecurityFact> | undefined
  doClassSpans: ReadonlyMap<string, readonly LineSpan[]>
  securityValidatorMode: SecurityValidatorMode
  securityReclassEnabled: boolean
  onSecurityFindingDropped: ValidateForSubmissionArgs["onSecurityFindingDropped"]
  testsValidatorMode: TestsValidatorMode
  highSevGateDemoteMode: AstScanMode
  onTestFindingDropped: ValidateForSubmissionArgs["onTestFindingDropped"]
  coverageGaps: ReadonlySet<string>
  testToSourceRatio: number
  logicEvidence: LogicEvidence | undefined
  logicValidatorMode: LogicValidatorMode
  onLogicFindingDropped: ValidateForSubmissionArgs["onLogicFindingDropped"]
  logicRefutationMode: LogicRefutationMode
  refutationSurvivalMode: RefutationSurvivalMode
  onLogicRefutationFindingDropped: ValidateForSubmissionArgs["onLogicRefutationFindingDropped"]
  onRefutationSurvivalFindingDropped: ValidateForSubmissionArgs["onRefutationSurvivalFindingDropped"]
  logicClaimRefutationMode: LogicClaimRefutationMode
  logicClaimRefutationEnforceReasons: ReadonlySet<LogicClaimDropReason> | undefined
  onLogicClaimRefutationFindingDropped: ValidateForSubmissionArgs["onLogicClaimRefutationFindingDropped"]
  perfEvidence: PerfEvidence | undefined
  perfValidatorMode: PerfValidatorMode
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined
  deletedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined
  onPerfFindingDropped: ValidateForSubmissionArgs["onPerfFindingDropped"]
  inlineGroundingValidatorMode: InlineGroundingValidatorMode
  onInlineGroundingFindingDropped: ValidateForSubmissionArgs["onInlineGroundingFindingDropped"]
  absenceClaimValidatorMode: AbsenceClaimValidatorMode
  wasTruncated: boolean
  droppedPaths: readonly string[]
  onAbsenceFindingDropped: ValidateForSubmissionArgs["onAbsenceFindingDropped"]
  windowBlindnessValidatorMode: WindowBlindnessValidatorMode
  fullFileByPath: ReadonlyMap<string, string>
  astCache: AstCache
  onWindowBlindnessFindingDropped: ValidateForSubmissionArgs["onWindowBlindnessFindingDropped"]
  diffConsistencyValidatorMode: DiffConsistencyValidatorMode
  onDiffConsistencyFindingDropped: ValidateForSubmissionArgs["onDiffConsistencyFindingDropped"]
  securityGroundingValidatorMode: SecurityGroundingValidatorMode
  onSecurityGroundingFindingDropped: ValidateForSubmissionArgs["onSecurityGroundingFindingDropped"]
  securityUsageValidatorMode: SecurityUsageValidatorMode
  onSecurityUsageFindingDropped: ValidateForSubmissionArgs["onSecurityUsageFindingDropped"]
  profile: SigilixProfile
  trustLedgerEnabled: boolean
  astFindingIds: readonly string[]
}
