import type { SpecialistRole } from "./ensemble-router"
import type { FindingCategory, PrReviewFinding, ReviewEvent } from "./triage-pr-review"

type BlockingReviewEvent = Exclude<ReviewEvent, "COMMENT">

export interface ApprovalReadinessSourceFinding {
  role: SpecialistRole
  id: string
  finding: PrReviewFinding
  verdictConfidence?: number
}

export interface ApprovalReadinessProvenance {
  findings: ReadonlyArray<{
    sourceFindingIds?: readonly string[]
  }>
  dropped: ReadonlyArray<{
    sourceFindingId?: string
  }>
  softened?: ReadonlyArray<{
    sourceFindingId?: string
  }>
}

export interface ApprovalReadinessBlocker {
  kind: "unaccounted_high_confidence_source_finding"
  sourceFindingId: string
  role: SpecialistRole
  path: string
  line: number
  headline: string
  score: number
  confidence: number
}

export interface ApprovalReadinessDecision {
  event: BlockingReviewEvent
  blockers: ApprovalReadinessBlocker[]
  bodyOnlyFindings: PrReviewFinding[]
}

const BLOCKING_SCORE = 4
const BLOCKING_CONFIDENCE = 4
const MAX_RENDERED_BLOCKERS = 3

/**
 * SIG-205 calibration rule.
 *
 * External reviewers are useful regression benchmarks, but they are not
 * runtime dependencies. A clean Sigilix approval must still account for
 * Sigilix's own high-confidence specialist findings. If a specialist finding
 * crosses the actionability bar, the synth must either keep/merge/rewrite it
 * into the final verdict, soften it, or explicitly drop it with provenance.
 * Otherwise the legacy marker-only approval is withheld and a body-only
 * blocker is rendered for the reviewer.
 */
export function assessApprovalReadiness(args: {
  intendedEvent: BlockingReviewEvent
  sourceFindings: readonly ApprovalReadinessSourceFinding[]
  provenance: ApprovalReadinessProvenance | null | undefined
}): ApprovalReadinessDecision {
  if (args.intendedEvent !== "APPROVE") {
    return {
      event: args.intendedEvent,
      blockers: [],
      bodyOnlyFindings: [],
    }
  }

  const accountedSourceIds = collectAccountedSourceIds(args.provenance)
  const blockers: ApprovalReadinessBlocker[] = []
  for (const source of args.sourceFindings) {
    const confidence = resolveSourceConfidence(source)
    if (source.finding.score < BLOCKING_SCORE) continue
    if (confidence < BLOCKING_CONFIDENCE) continue
    if (accountedSourceIds.has(source.id)) continue

    blockers.push({
      kind: "unaccounted_high_confidence_source_finding",
      sourceFindingId: source.id,
      role: source.role,
      path: source.finding.path,
      line: source.finding.line,
      headline: source.finding.headline,
      score: source.finding.score,
      confidence,
    })
  }

  if (blockers.length === 0) {
    return {
      event: "APPROVE",
      blockers: [],
      bodyOnlyFindings: [],
    }
  }

  return {
    event: "REQUEST_CHANGES",
    blockers,
    bodyOnlyFindings: blockers.slice(0, MAX_RENDERED_BLOCKERS).map((blocker) =>
      renderApprovalBlockerFinding(blocker),
    ),
  }
}

function collectAccountedSourceIds(
  provenance: ApprovalReadinessProvenance | null | undefined,
): Set<string> {
  const ids = new Set<string>()
  if (!provenance) return ids

  for (const finding of provenance.findings) {
    for (const id of finding.sourceFindingIds ?? []) {
      if (typeof id === "string" && id.length > 0) ids.add(id)
    }
  }
  for (const dropped of provenance.dropped) {
    if (typeof dropped.sourceFindingId === "string" && dropped.sourceFindingId.length > 0) {
      ids.add(dropped.sourceFindingId)
    }
  }
  for (const softened of provenance.softened ?? []) {
    if (typeof softened.sourceFindingId === "string" && softened.sourceFindingId.length > 0) {
      ids.add(softened.sourceFindingId)
    }
  }
  return ids
}

function resolveSourceConfidence(source: ApprovalReadinessSourceFinding): number {
  const raw = source.finding.confidence ?? source.verdictConfidence ?? 3
  if (!Number.isFinite(raw)) return 3
  return Math.max(1, Math.min(5, Math.round(raw)))
}

function renderApprovalBlockerFinding(blocker: ApprovalReadinessBlocker): PrReviewFinding {
  return {
    path: blocker.path,
    line: blocker.line,
    scope: "pr",
    score: blocker.score,
    category: categoryForRole(blocker.role),
    headline: `Approval validation lost ${blocker.role} finding: ${blocker.headline}`,
    body: [
      "Sigilix's approval-readiness guard withheld approval because a high-confidence specialist finding was not reconciled by the synthesizer.",
      "",
      `Source finding: \`${blocker.sourceFindingId}\` from the ${blocker.role} specialist at \`${blocker.path}:${blocker.line}\` (score ${blocker.score}, confidence ${blocker.confidence}/5).`,
      "",
      "The finding must be kept, merged, softened, or explicitly dropped in synth provenance before Sigilix can approve this PR.",
    ].join("\n"),
  }
}

function categoryForRole(role: SpecialistRole): FindingCategory {
  return role === "tests" ? "testing" : role
}
