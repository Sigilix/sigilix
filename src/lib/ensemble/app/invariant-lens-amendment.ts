import type { Env } from "@/src/shared/types/env"
import type { SubmitReviewBody } from "@/src/shared/types/github"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import { assignStableFindingIds } from "@/src/lib/ensemble/domain/findings"
import type {
  CollectedVerdict,
  SynthesizerProvenance,
  ValidateForSubmissionArgs,
} from "@/src/lib/ensemble/domain/validation"
import type { PostReviewWorkOutcome } from "./session"
import type { InvariantLensApplyResult } from "./invariant-lens"
import { validateForSubmission } from "./orchestrator-helpers"
import { buildReviewSubmissionWithMetadata } from "@/src/lib/ensemble/render/submission"
import { SIGILIX_BOT_LOGIN } from "@/src/shared/domain/sigilix-identity"

export const INVARIANT_LENS_AMENDMENT_MARKER = "<!-- sigilix:invariant-lens-amendment -->"

type FindingWithId = PrReviewFinding & { id: string }
type InvariantLensValidationContext = Omit<
  ValidateForSubmissionArgs,
  "synthOutput" | "reviewable" | "specialistVerdicts" | "astCache"
> & { astCache?: ValidateForSubmissionArgs["astCache"] }

export interface InvariantLensAmendmentClient {
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<{ head?: { sha?: string | null } | null }>
  listPullRequestReviews(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<
    Array<{
      id: number
      state: string
      user: { login: string } | null
      body: string
      commitId: string | null
    }>
  >
  submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: SubmitReviewBody,
  ): Promise<{ id: number; state: string }>
}

export type InvariantLensAmendmentOutcome =
  | { status: "no_findings"; findingsCount: number }
  | { status: "posted"; findingsCount: number; reviewId: number }
  | { status: "duplicate"; reviewId: number }
  | { status: "stale_head"; currentHeadSha: string }
  | { status: "failed"; findingsCount: number; error: string }

export interface InvariantLensAmendmentArgs {
  env: Env
  client: InvariantLensAmendmentClient
  owner: string
  repo: string
  prNumber: number
  headSha: string
  lensWork: Promise<InvariantLensApplyResult>
  reviewable: ReviewableMap
  validation?: InvariantLensValidationContext
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
  showEvidence?: boolean
  trustLedger?: boolean
}

export type InvariantLensAmendmentAttachArgs = Omit<InvariantLensAmendmentArgs, "lensWork"> & {
  lensWork?: Promise<InvariantLensApplyResult> | undefined
}

export function attachInvariantLensAmendmentWork<T extends { status: string }>(
  result: T,
  args: InvariantLensAmendmentAttachArgs,
): T | (T & { postReviewWork: Promise<PostReviewWorkOutcome> }) {
  if (result.status !== "posted" || args.lensWork === undefined) return result
  const validation = validationWithAddedLines(args)
  return {
    ...result,
    postReviewWork: runInvariantLensAmendment({
      ...args,
      lensWork: args.lensWork,
      ...(validation !== undefined ? { validation } : {}),
    }).then((outcome) =>
      outcome.status === "failed" ? { status: "failed", error: outcome.error } : { status: "completed" },
    ),
  }
}

export async function runInvariantLensAmendment(
  args: InvariantLensAmendmentArgs,
): Promise<InvariantLensAmendmentOutcome> {
  let lensResult: InvariantLensApplyResult
  try {
    lensResult = await args.lensWork
  } catch (err) {
    return failed(0, err)
  }

  const lensFindings = collectLensFindings(lensResult).filter((finding) => finding.score >= 4)
  if (lensFindings.length === 0) {
    emit("invariant-lens-amendment-noop", args, { reason: "no-high-severity-lens-findings" })
    return { status: "no_findings", findingsCount: 0 }
  }

  const validation = validateLensFindings({
    reviewable: args.reviewable,
    findings: lensFindings,
    validation: args.validation,
  })
  const findingsCount = validation.verdict.findings.length + validation.unanchoredFindings.length
  if (findingsCount < lensFindings.length) {
    emit("invariant-lens-amendment-validation-dropped", args, {
      inputFindings: lensFindings.length,
      outputFindings: findingsCount,
      droppedFindings: lensFindings.length - findingsCount,
    })
  }
  if (findingsCount === 0) {
    emit("invariant-lens-amendment-noop", args, {
      reason: "validation-dropped-all",
      inputFindings: lensFindings.length,
    })
    return { status: "no_findings", findingsCount: 0 }
  }

  const currentHead = await currentHeadSha(args)
  if (currentHead === null) return { status: "failed", findingsCount, error: "head-recheck-failed" }
  if (currentHead !== args.headSha) {
    emit("invariant-lens-amendment-stale-head", args, {
      queuedHeadSha: args.headSha.slice(0, 7),
      currentHeadSha: currentHead.slice(0, 7),
    })
    return { status: "stale_head", currentHeadSha: currentHead }
  }

  const existing = await findExistingAmendment(args)
  if (existing === "lookup-failed") return { status: "failed", findingsCount, error: "dedupe-lookup-failed" }
  if (existing !== null) {
    emit("invariant-lens-amendment-dedupe-hit", args, { reviewId: existing.id })
    return { status: "duplicate", reviewId: existing.id }
  }

  const submission = buildAmendmentSubmission(args, validation)
  let submitted: { id: number; state: string }
  try {
    submitted = await args.client.submitReview(args.owner, args.repo, args.prNumber, submission)
  } catch (err) {
    return failed(findingsCount, err)
  }

  const verified = await reviewPersisted(args, submitted.id)
  if (!verified) return { status: "failed", findingsCount, error: "review-not-persisted" }
  emit("invariant-lens-amendment-posted", args, { findingsCount, reviewId: submitted.id })
  return { status: "posted", findingsCount, reviewId: submitted.id }
}

function collectLensFindings(result: InvariantLensApplyResult): FindingWithId[] {
  const ids = new Set(result.lensFindingIds)
  const out: FindingWithId[] = []
  for (const verdict of result.verdicts) {
    for (const finding of verdict.verdict?.findings ?? []) {
      if (hasFindingId(finding) && ids.has(finding.id)) out.push(finding)
    }
  }
  return out
}

function validateLensFindings(args: {
  reviewable: ReviewableMap
  findings: FindingWithId[]
  validation?: InvariantLensAmendmentArgs["validation"]
}) {
  const verdict = assignStableFindingIds("logic", {
    summary: "Invariant lens follow-up",
    confidence: 5,
    confidenceReason: "Invariant lens findings survived deterministic validation.",
    findings: args.findings,
  } satisfies PrReviewVerdict)
  const provenance: SynthesizerProvenance = {
    findings: verdict.findings.map((finding) => ({
      sourceSpecialists: ["logic"],
      sourceFindingIds: [finding.id],
      action: "kept",
      verifiedViaRetrieval: false,
    })),
    dropped: [],
  }
  const specialistVerdict: CollectedVerdict = {
    role: "logic",
    elapsedMs: 0,
    verdict,
  }
  return validateForSubmission({
    ...(args.validation ?? {}),
    synthOutput: { verdict, provenance },
    reviewable: args.reviewable,
    specialistVerdicts: [specialistVerdict],
  })
}

function validationWithAddedLines(args: InvariantLensAmendmentAttachArgs): InvariantLensAmendmentArgs["validation"] {
  if (args.addedLineTextByLine === undefined) return args.validation
  return { ...(args.validation ?? {}), addedLineTextByLine: args.addedLineTextByLine }
}

async function currentHeadSha(args: InvariantLensAmendmentArgs): Promise<string | null> {
  try {
    const meta = await args.client.getPullRequest(args.owner, args.repo, args.prNumber)
    const sha = meta.head?.sha
    return typeof sha === "string" && sha.length > 0 ? sha : null
  } catch (err) {
    emit("invariant-lens-amendment-head-recheck-failed", args, { error: errorMessage(err) })
    return null
  }
}

async function findExistingAmendment(
  args: InvariantLensAmendmentArgs,
): Promise<{ id: number } | null | "lookup-failed"> {
  let reviews: Awaited<ReturnType<InvariantLensAmendmentClient["listPullRequestReviews"]>>
  try {
    reviews = await args.client.listPullRequestReviews(args.owner, args.repo, args.prNumber)
  } catch (err) {
    emit("invariant-lens-amendment-dedupe-lookup-failed", args, { error: errorMessage(err) })
    return "lookup-failed"
  }
  const marker = amendmentHeadMarker(args.headSha)
  const found = reviews.find(
    (review) =>
      review.user?.login === SIGILIX_BOT_LOGIN &&
      review.commitId === args.headSha &&
      review.body.includes(INVARIANT_LENS_AMENDMENT_MARKER) &&
      review.body.includes(marker),
  )
  return found ? { id: found.id } : null
}

function buildAmendmentSubmission(
  args: InvariantLensAmendmentArgs,
  validated: ReturnType<typeof validateForSubmission>,
): SubmitReviewBody {
  const build = buildReviewSubmissionWithMetadata({
    verdict: validated.verdict,
    prAuthor: null,
    headSha: args.headSha,
    unanchored: validated.unanchoredFindings,
    reviewable: args.reviewable,
    eventOverride: "REQUEST_CHANGES",
    linkContext: { owner: args.owner, repo: args.repo, headSha: args.headSha },
    ...(args.addedLineTextByLine !== undefined ? { addedLineTextByLine: args.addedLineTextByLine } : {}),
    ...(args.showEvidence === true ? { showEvidence: true } : {}),
    ...(args.trustLedger === true ? { trustLedger: true } : {}),
  })
  return {
    ...build.submission,
    body: [INVARIANT_LENS_AMENDMENT_MARKER, amendmentHeadMarker(args.headSha), "", build.submission.body ?? ""].join(
      "\n",
    ),
  }
}

async function reviewPersisted(args: InvariantLensAmendmentArgs, reviewId: number): Promise<boolean> {
  try {
    const reviews = await args.client.listPullRequestReviews(args.owner, args.repo, args.prNumber)
    return reviews.some((review) => review.id === reviewId && review.state !== "PENDING")
  } catch (err) {
    emit("invariant-lens-amendment-verify-failed-closed", args, { reviewId, error: errorMessage(err) })
    return false
  }
}

function amendmentHeadMarker(headSha: string): string {
  return `<!-- sigilix:invariant-lens-amendment:${headSha} -->`
}

function hasFindingId(finding: PrReviewFinding): finding is FindingWithId {
  return typeof (finding as { id?: unknown }).id === "string"
}

function failed(findingsCount: number, err: unknown): InvariantLensAmendmentOutcome {
  return { status: "failed", findingsCount, error: errorMessage(err) }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emit(event: string, args: InvariantLensAmendmentArgs, extra: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      ...extra,
    }),
  )
}
