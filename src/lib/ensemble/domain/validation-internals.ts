// SIG-318 (PR 8) / SIG-386 — validation domain INTERNALS (PR1 relocation).
//
// Private, pure helper clusters lifted verbatim out of `./validation.ts` to
// keep the believability CORE focused on `validateForSubmission` + the gate
// wiring. PR1 is RELOCATION ONLY: every declaration below is byte-identical to
// its prior form modulo the `export` keyword (so the core can re-import) and
// the import lines. No behavior change. These helpers are not part of the
// module's public surface — they had no external importers before the move —
// so they are exported only for the core to consume.
//
// Leaf discipline (SIG-318): this leaf must never VALUE-import its core
// (`./validation`); the only edge back is the type-only `import type` of
// `CollectedVerdict` / `SynthesizerProvenance`, which `verbatimModuleSyntax`
// fully erases (zero runtime cycle).

import type {
  PrReviewFinding,
  EvidenceRecord,
} from "@/src/shared/domain/pr-review-finding"
import { ALL_SPECIALISTS, type SpecialistRole } from "@/src/shared/domain/specialist-role"
import { deriveSide, type ReviewableMap } from "@/src/shared/util/diff-positions"
import { isSubstantiveAnchorLine } from "@/src/shared/util/anchor-lines"
import type { CollectedVerdict, SynthesizerProvenance } from "./validation"

export interface SourceFindingSecurityEvidence {
  cweId?: string
  evidenceId?: string
}

export function buildSourceFindingSecurityEvidenceById(
  specialistVerdicts: CollectedVerdict[],
): Map<string, SourceFindingSecurityEvidence> {
  const out = new Map<string, SourceFindingSecurityEvidence>()
  for (const verdict of specialistVerdicts) {
    if (!verdict.verdict) continue
    for (const finding of verdict.verdict.findings) {
      const entry: SourceFindingSecurityEvidence = {}
      if (hasNonEmptyString(finding.cweId)) entry.cweId = finding.cweId
      if (hasNonEmptyString(finding.evidenceId)) entry.evidenceId = finding.evidenceId
      if (Object.keys(entry).length > 0) out.set(finding.id, entry)
    }
  }
  return out
}

export function backfillSecurityEvidenceFromSources(
  finding: PrReviewFinding,
  sourceIds: readonly string[],
  sourceEvidenceById: ReadonlyMap<string, SourceFindingSecurityEvidence>,
): PrReviewFinding {
  const source = selectSourceEvidenceForBackfill(finding, sourceIds, sourceEvidenceById)
  if (!source) return finding
  return {
    ...finding,
    ...(!hasNonEmptyString(finding.cweId) && source.cweId ? { cweId: source.cweId } : {}),
    ...(!hasNonEmptyString(finding.evidenceId) && source.evidenceId ? { evidenceId: source.evidenceId } : {}),
  }
}

export function uniqueNonEmpty(values: Iterable<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export const DETERMINISTIC_EVIDENCE_ID_PREFIXES = ["secret:", "depvuln:", "sarif:", "ast/"] as const

export const DETERMINISTIC_EVIDENCE_REF_PREFIXES = [
  "coverageGap:",
  "inspectedTestFile:",
  "siblingMapping:",
  "testFileChanged:",
] as const

export function hasDeterministicPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix))
}

export function normalizeSynthDecision(action: unknown): EvidenceRecord["synthDecision"] {
  return action === "kept" || action === "merged" || action === "rewritten" ? action : "unknown"
}

export function specialistReturnedMatchingFinding(
  role: SpecialistRole,
  finding: PrReviewFinding,
  specialistVerdicts: readonly CollectedVerdict[],
): boolean {
  const verdict = specialistVerdicts.find((v) => v.role === role)?.verdict
  if (!verdict) return false
  const findingPath = finding.path.trim()
  const findingEvidenceId = hasNonEmptyString(finding.evidenceId) ? finding.evidenceId.trim() : ""
  return verdict.findings.some((source) => {
    if (source.path.trim() !== findingPath) return false
    if (source.line === finding.line) return true
    const sourceEvidenceId = hasNonEmptyString(source.evidenceId) ? source.evidenceId.trim() : ""
    return findingEvidenceId !== "" && sourceEvidenceId === findingEvidenceId
  })
}

export function rolesFromValidatedSources(
  provenance: SynthesizerProvenance["findings"][number],
  finding: PrReviewFinding,
  specialistVerdicts: readonly CollectedVerdict[],
): SpecialistRole[] {
  const rolesFromIds = ALL_SPECIALISTS.filter((role) =>
    provenance.sourceFindingIds.some((id) => id.startsWith(`${role}-`)),
  )
  if (rolesFromIds.length > 0) return rolesFromIds
  return ALL_SPECIALISTS.filter((role) =>
    provenance.sourceSpecialists.includes(role) &&
    specialistReturnedMatchingFinding(role, finding, specialistVerdicts),
  )
}

export function deterministicFactIdsForFinding(
  finding: PrReviewFinding,
  sourceIds: readonly string[],
  sourceEvidenceById: ReadonlyMap<string, SourceFindingSecurityEvidence>,
  validSourceIds: ReadonlySet<string>,
): string[] {
  const evidenceId = hasNonEmptyString(finding.evidenceId) ? finding.evidenceId.trim() : ""
  const sourceEvidenceIds = sourceIds
    .map((id) => sourceEvidenceById.get(id)?.evidenceId)
    .filter((id): id is string =>
      hasNonEmptyString(id) &&
      id !== "NONE" &&
      hasDeterministicPrefix(id, DETERMINISTIC_EVIDENCE_ID_PREFIXES),
    )
  return uniqueNonEmpty([
    ...(evidenceId !== "" &&
      evidenceId !== "NONE" &&
      hasDeterministicPrefix(evidenceId, DETERMINISTIC_EVIDENCE_ID_PREFIXES)
      ? [evidenceId]
      : []),
    ...sourceEvidenceIds,
    ...(finding.evidenceRefs ?? []).filter((ref) =>
      hasDeterministicPrefix(ref.trim(), DETERMINISTIC_EVIDENCE_REF_PREFIXES),
    ),
    ...sourceIds.filter((id) => id.startsWith("ast/") && validSourceIds.has(id)),
  ])
}

export function buildFindingEvidenceRecord(args: {
  finding: PrReviewFinding
  provenance: SynthesizerProvenance["findings"][number]
  specialistVerdicts: readonly CollectedVerdict[]
  sourceEvidenceById: ReadonlyMap<string, SourceFindingSecurityEvidence>
  validSourceIds: ReadonlySet<string>
}): EvidenceRecord {
  const flagged = rolesFromValidatedSources(args.provenance, args.finding, args.specialistVerdicts)
  const flaggedSet = new Set(flagged)
  const returnedRoles = ALL_SPECIALISTS.filter((role) =>
    args.specialistVerdicts.some((v) => v.role === role && v.verdict !== null),
  )
  return {
    specialistsThatFlagged: flagged,
    specialistsThatDeclined: returnedRoles.filter((role) => !flaggedSet.has(role)),
    deterministicFactIds: deterministicFactIdsForFinding(
      args.finding,
      args.provenance.sourceFindingIds,
      args.sourceEvidenceById,
      args.validSourceIds,
    ),
    // SIG-112 Phase 1: the prompt may have retrieval context, but the
    // synth provenance does not yet carry stable chunk/pr IDs. Keep
    // these explicit empty arrays until SIG-44 exposes structured ids.
    retrievalChunkIds: [],
    relatedPriorPRs: [],
    synthDecision: normalizeSynthDecision(args.provenance.action),
    consensusScore: flagged.length,
  }
}

/**
 * SIG-308 (PR #290 review): map each source finding's id → its trimmed,
 * non-empty `independentAssessment`, for one `role` only. The logic analogue
 * of `buildSourceFindingSecurityEvidenceById` — single-field because that is
 * the only structured field the SIG-308 backstop reads off the synthesized
 * finding. Empty / whitespace-only rationales are skipped (treated as absent,
 * matching `evaluateLogicRefutation`).
 *
 * Role-SCOPED (CodeRabbit, PR #290): `independentAssessment` is shared — a
 * SIG-282 security confirmation and a SIG-308 logic survival rationale live in
 * the same field with lens-specific meaning. The logic gate keys on
 * `sourceRolesInclude(sourceIds, "logic")`, so a cross-lens-merged finding
 * (e.g. ids `["security-0","logic-0"]`) must NOT have a security note satisfy
 * the logic gate. Restricting the map to the gate's role guarantees that.
 */
export function buildSourceFindingRationaleById(
  specialistVerdicts: CollectedVerdict[],
  role: SpecialistRole,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const verdict of specialistVerdicts) {
    if (verdict.role !== role) continue
    if (!verdict.verdict) continue
    for (const finding of verdict.verdict.findings) {
      if (hasNonEmptyString(finding.independentAssessment)) {
        out.set(finding.id, finding.independentAssessment.trim())
      }
    }
  }
  return out
}

/**
 * SIG-308 (PR #290 review): restore a finding's `independentAssessment` from
 * its source findings when synthesis dropped it. The backstop keys on the
 * POST-synthesis finding, but the synthesizer (an LLM) may not echo the
 * rationale — and unlike security evidence there was no deterministic
 * backfill, so a logic finding whose specialist DID justify survival could be
 * wrongly flagged. Pure (no mutation), mirroring
 * `backfillSecurityEvidenceFromSources`. Never overwrites a present value;
 * the security selector is NOT reused because it matches on cweId/evidenceId,
 * which a logic source lacks — here we take the first source id that carries a
 * rationale in `rationaleById`. That map is role-scoped by the caller (see
 * `buildSourceFindingRationaleById`), so for the logic gate only logic-source
 * rationales are eligible — a co-merged security note cannot satisfy it.
 */
export function backfillIndependentAssessmentFromSources(
  finding: PrReviewFinding,
  sourceIds: readonly string[],
  rationaleById: ReadonlyMap<string, string>,
): PrReviewFinding {
  if (hasNonEmptyString(finding.independentAssessment)) return finding
  for (const sourceId of sourceIds) {
    const rationale = rationaleById.get(sourceId)
    if (rationale) return { ...finding, independentAssessment: rationale }
  }
  return finding
}

/**
 * SIG-216: post-emit scope normalization. LLM specialists sometimes
 * emit `scope: "file"` for findings that have a concrete `(path, line)`
 * AND that line falls within a reviewable diff hunk. Those findings
 * SHOULD anchor inline, not fall back to the Review Body section.
 * Force `scope: "line"` for the anchorable shape so the renderer
 * routes them inline.
 *
 * Out of scope: PR-level findings (no concrete path/line) and
 * comment-scope findings (replies to existing comments) stay
 * whatever the LLM emitted.
 *
 * Why post-emit not prompt: the prompt already says "use line when
 * possible" but LLMs over-pick file. Belt-and-braces.
 *
 * SIG-216 fix-up: the predicate requires a RIGHT-side anchor (was:
 * any side). For a file-scoped finding on a DELETED line, a LEFT-only
 * diff position was previously passing the predicate → scope flipped
 * to "line" → validation accepted side=LEFT but `buildReviewSubmission`
 * always emits inline comments with `side: "RIGHT"` → primary submit
 * 422'd.
 *
 * SIG-216 follow-up: relax the strict both-bounds check for multi-line
 * findings. ANY line in the inclusive [startLine, line] range being in
 * a RIGHT-side hunk is sufficient to anchor inline. GitHub accepts
 * multi-line inline comments via start_line + line even when only the
 * middle of the range is in the diff. The prior strict-bounds check
 * over-suppressed (PR #175 dogfood: a 15-line finding range with the
 * diff in the middle got routed to body).
 */
export function isAnyLineInRightHunk(
  anchorLines: ReadonlyArray<{ line: number; side: "LEFT" | "RIGHT" }>,
  startLine: number,
  endLine: number,
): boolean {
  // CR (PR #176): walking the numeric [startLine, endLine] range is
  // O(N*M) where N = range size and M = anchorLines.length. A malformed
  // finding (e.g. `startLine: 1, line: 999999`) would loop a million
  // times. Single-pass scan over the (typically small) anchorLines is
  // O(M) and unbounded-range-safe.
  for (const a of anchorLines) {
    if (a.side === "RIGHT" && a.line >= startLine && a.line <= endLine) {
      return true
    }
  }
  return false
}

export function normalizeFindingScopeForAnchorability(
  finding: PrReviewFinding,
  reviewable: ReviewableMap,
): PrReviewFinding {
  // PR-level / comment-level findings: leave alone — they aren't
  // anchorable by definition.
  if (finding.scope === "pr" || finding.scope === "comment") return finding
  // Already line-scoped: leave alone.
  if (finding.scope === "line") return finding

  // File-scoped (or scope omitted): check if it's actually anchorable.
  const path = typeof finding.path === "string" ? finding.path.trim() : ""
  if (path.length === 0) return finding
  if (typeof finding.line !== "number" || !Number.isFinite(finding.line)) return finding

  // Is the line in a reviewable hunk?
  const anchorLines = reviewable.get(path)
  if (!anchorLines) return finding

  // SIG-216 follow-up: relax the strict both-bounds check. ANY line in
  // the inclusive [startLine, endLine] range being in a RIGHT-side hunk
  // is sufficient to anchor inline. GitHub accepts multi-line inline
  // comments via start_line + line even when only the middle of the
  // range is in the diff. Prior strict-bounds check over-suppressed
  // (PR #175 dogfood: 15-line finding range with diff in the middle
  // got routed to body).
  //
  // LEFT-only positions remain non-anchorable for the scope flip
  // because `buildReviewSubmission` always emits inline comments with
  // `side: "RIGHT"` → a LEFT-only flip would 422 on submit. The
  // RIGHT-side filter inside isAnyLineInRightHunk handles that.
  const endLine = finding.line
  const startLine =
    typeof finding.startLine === "number" && Number.isFinite(finding.startLine)
      ? finding.startLine
      : endLine
  const lo = Math.min(startLine, endLine)
  const hi = Math.max(startLine, endLine)
  if (!isAnyLineInRightHunk(anchorLines, lo, hi)) return finding

  // Force scope=line so the renderer routes inline.
  return { ...finding, scope: "line" as const }
}

export function selectSourceEvidenceForBackfill(
  finding: PrReviewFinding,
  sourceIds: readonly string[],
  sourceEvidenceById: ReadonlyMap<string, SourceFindingSecurityEvidence>,
): SourceFindingSecurityEvidence | undefined {
  for (const sourceId of sourceIds) {
    const source = sourceEvidenceById.get(sourceId)
    if (!source) continue
    if (hasNonEmptyString(finding.evidenceId) && source.evidenceId === finding.evidenceId) return source
    if (hasNonEmptyString(finding.cweId) && source.cweId === finding.cweId) return source
  }
  for (const sourceId of sourceIds) {
    const source = sourceEvidenceById.get(sourceId)
    if (source && (hasNonEmptyString(source.cweId) || hasNonEmptyString(source.evidenceId))) {
      return source
    }
  }
  return undefined
}

export function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * SIG-325 (CodeRabbit PR #364): resolve the `independentAssessment` rationale for
 * a SPECIFIC lens from that lens's source findings, rather than trusting the
 * globally-backfilled `finding.independentAssessment` (which is logic-scoped —
 * SIG-308/PR#290). This stops a merged logic+security/perf finding from
 * satisfying the security/perf refutation gate with a LOGIC rationale, and
 * restores a same-lens rationale the synthesizer may have dropped. Keyed by
 * source id, mirroring `buildSourceFindingRationaleById`.
 */
export function resolveLensRationale(
  current: string | undefined,
  sourceIds: readonly string[],
  rationaleById: ReadonlyMap<string, string>,
  lens: SpecialistRole,
): string {
  for (const id of sourceIds) {
    const r = rationaleById.get(id)
    if (typeof r === "string" && r.trim().length > 0) return r.trim()
  }
  // CodeRabbit (PR #364, round 2): when NO same-lens source carried a rationale,
  // fall back to the synthesized finding's own `independentAssessment` — but ONLY
  // when there is no cross-lens ambiguity (every source id is this lens). Logic
  // contamination reaches `f.independentAssessment` solely via the logic-scoped
  // global backfill (`backfillIndependentAssessmentFromSources`), which requires a
  // `logic-*` id in sourceIds — i.e. always a mixed-lens merge. So restricting the
  // fallback to same-lens-only preserves a synth-authored same-lens rationale
  // (never demote a valid finding) while still rejecting a logic rationale
  // standing in for the security/perf gate.
  const mixedLens = sourceIds.some((id) => !id.startsWith(`${lens}-`))
  return !mixedLens && typeof current === "string" ? current.trim() : ""
}

export const INLINE_ANCHOR_REPAIR_WINDOW = 12

export function findingScopeForInlineRepair(finding: PrReviewFinding): "line" | "file" | "pr" | "comment" {
  return finding.scope ?? "line"
}

export function hasStructuredFixForInlineRepair(finding: PrReviewFinding): boolean {
  const replacement = finding.suggestedReplacement
  const deletion = finding.kind === "delete" && typeof replacement === "string" && replacement.length === 0
  const replace =
    (finding.kind === "replace" || finding.kind === undefined) &&
    typeof replacement === "string" &&
    replacement.length > 0
  return deletion || replace
}

/**
 * SIG-216 follow-up (Option A): when a multi-line finding's `line`
 * endpoint isn't in any RIGHT-side hunk but the scope-normalizer
 * flipped it to scope:"line" because the MIDDLE of the range overlaps
 * the diff, find an actually-anchorable RIGHT position inside the
 * inclusive [startLine, line] range so the inline POST won't 422.
 *
 * Without this rewrite, the half-measure shipped in
 * `normalizeFindingScopeForAnchorability` would flip the scope but
 * leave `f.line = 444` pointing at a non-reviewable line —
 * `deriveSide` at the line-validity check fails, the finding routes to
 * `unanchoredFindings` anyway. PR #175 dogfood class.
 *
 * GitHub multi-line inline-comment semantics: `line` is the bottom of
 * the visible underline; `start_line` is the top. Both must be on the
 * diff (`isCommentAnchorable`). When neither original endpoint
 * survives, we pick the LAST RIGHT anchor in range as the new `line`
 * (closest to the original bottom) and the FIRST RIGHT anchor as the
 * new `start_line` when distinct.
 *
 * Returns null when (a) the finding is single-line (caller falls
 * through to the existing single-line repair / unanchored routing),
 * (b) no RIGHT anchor exists inside the range, or (c) the finding has
 * no usable `path`/`line`. Pure.
 */
export function findRangeAwareAnchor(
  reviewable: ReviewableMap,
  finding: PrReviewFinding,
): { line: number; startLine?: number } | null {
  const path = typeof finding.path === "string" ? finding.path.trim() : ""
  if (path.length === 0) return null
  if (typeof finding.line !== "number" || !Number.isFinite(finding.line)) return null
  const hasMultiLine =
    typeof finding.startLine === "number" &&
    Number.isFinite(finding.startLine) &&
    finding.startLine !== finding.line
  if (!hasMultiLine) return null

  const anchors = reviewable.get(path)
  if (!anchors || anchors.length === 0) return null

  const endLine = finding.line
  const startLine = finding.startLine as number
  const lo = Math.min(startLine, endLine)
  const hi = Math.max(startLine, endLine)

  // Single-pass scan: pick the FIRST and LAST RIGHT-side anchor inside
  // the inclusive [lo, hi] range. Last = closest to the original bottom
  // (becomes the new `line`); first = top of the underline
  // (becomes the new `start_line` if distinct from `line`).
  let firstLine: number | null = null
  let lastLine: number | null = null
  for (const a of anchors) {
    if (a.side !== "RIGHT") continue
    if (a.line < lo || a.line > hi) continue
    if (firstLine === null || a.line < firstLine) firstLine = a.line
    if (lastLine === null || a.line > lastLine) lastLine = a.line
  }
  if (lastLine === null || firstLine === null) return null

  return firstLine < lastLine
    ? { line: lastLine, startLine: firstLine }
    : { line: lastLine }
}

export function findRepairableInlineAnchor(args: {
  finding: PrReviewFinding
  reviewable: ReviewableMap
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined
}): number | null {
  const { finding, reviewable, addedLineTextByLine } = args
  if (findingScopeForInlineRepair(finding) !== "line") return null
  if (hasStructuredFixForInlineRepair(finding)) return null

  const addedLinesForPath = addedLineTextByLine?.get(finding.path)
  if (!addedLinesForPath || addedLinesForPath.size === 0) return null

  let bestLine: number | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let bestIsForward = false

  for (const [candidateLine, text] of addedLinesForPath) {
    const distance = Math.abs(candidateLine - finding.line)
    if (distance > INLINE_ANCHOR_REPAIR_WINDOW) continue
    if (deriveSide(reviewable, finding.path, candidateLine) !== "RIGHT") continue
    if (!isSubstantiveAnchorLine(text)) continue

    const isForward = candidateLine >= finding.line
    if (
      distance < bestDistance ||
      (distance === bestDistance && isForward && !bestIsForward) ||
      (distance === bestDistance && isForward === bestIsForward && bestLine !== null && candidateLine < bestLine)
    ) {
      bestLine = candidateLine
      bestDistance = distance
      bestIsForward = isForward
    }
  }

  return bestLine
}
