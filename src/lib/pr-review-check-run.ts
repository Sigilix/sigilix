// ARC-258 — customer-visible "Sigilix · In progress" check
// run lifecycle. Lives at the dispatcher level (called from
// `dispatchJob`'s `pr-review` case) because the ensemble-post path
// can fall back to Phase 3 on quorum/synth/internal errors, and the
// final conclusion depends on which handler ultimately posted. A
// single dispatcher-level owner avoids the "ensemble marks
// `failure`, then Phase 3 posts a successful review" contradiction
// the first PR #80 attempt produced.
//
// All operations are best-effort: a 403 from a missing `checks:
// write` permission, or a 5xx from GitHub, must NOT fail the
// underlying review pipeline. The check is an indicator ON TOP OF
// the real review — the review must always go through.

import { GitHubClient, GitHubHttpError } from "@/src/shared/adapters/github"
import type { CheckRunAnnotation } from "@/src/shared/types/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { runnerEvidenceBadgeImg } from "./badge-assets"
import type { Env } from "@/src/shared/types/env"

// SIG-216 (founder sign-off 2026-05-25): Sigilix originally followed
// Greptile's pattern of NOT posting Check annotations. GitHub renders
// the annotation `message` field as PLAIN TEXT, so markdown-formatted
// finding bodies (with <details>, **bold**, badge <img> tags) dumped
// literally with raw HTML visible.
//
// SIG-144 (competitive parity with CodeRabbit/Copilot): annotations are
// reinstated as a *configurable, opt-in* second output surface. The
// SIG-216 lesson is honored — annotation text is sanitized to PLAIN
// TEXT before posting (markdown/HTML stripped, see `toPlainTextAnnotation`)
// so it reads cleanly in the Files tab + Checks UI. The rich markdown
// finding bodies still live in the PR review thread. Which surface(s)
// are active is controlled by `OPENCLAW_REVIEW_OUTPUT_SURFACE`
// (`parseReviewOutputSurface`); the default keeps annotations OFF, so a
// deploy with no flag change is byte-for-byte the SIG-216 behavior.

/** SIG-144: which output surface(s) the review posts to. */
export type ReviewOutputSurface = "comments" | "annotations" | "both"

/**
 * SIG-144: parse `OPENCLAW_REVIEW_OUTPUT_SURFACE` into the typed surface.
 * Unset / unrecognized → `"comments"` (the historical default; annotations
 * stay dark). Case-insensitive + trimmed. Pure — exported for tests and
 * shared by the dispatcher (annotation posting) and the ensemble (inline-
 * comment suppression) so both agree on the active surface.
 */
export function parseReviewOutputSurface(raw: string | undefined | null): ReviewOutputSurface {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "annotations":
      return "annotations"
    case "both":
      return "both"
    default:
      return "comments"
  }
}

/** SIG-144: does this surface post Checks annotations? */
export function surfacePostsAnnotations(surface: ReviewOutputSurface): boolean {
  return surface === "annotations" || surface === "both"
}

/** SIG-144: does this surface post inline PR review comments? */
export function surfacePostsInlineComments(surface: ReviewOutputSurface): boolean {
  return surface === "comments" || surface === "both"
}

/**
 * SIG-144: pick which annotations the review's primary success path should
 * carry, so a finding is never dropped and never double-posted:
 *   - `comments` / `both` — anchored findings already post as inline review
 *     COMMENTS, so annotations carry only the body-only (unanchored)
 *     leftovers. A finding appears on exactly one surface.
 *   - `annotations` — inline comments are suppressed, so EVERY finding must
 *     become an annotation or anchored findings vanish from all surfaces.
 *
 * Pure — exported for tests. (CodeRabbit + Sigilix flagged the original
 * always-`bodyOnly` path as dropping anchored findings in annotations-only
 * mode — PR #339 review.)
 */
export function selectPrimarySubmitAnnotations(
  surface: ReviewOutputSurface,
  bodyOnlyAnnotations: CheckRunAnnotation[],
  allFindingAnnotations: CheckRunAnnotation[],
): CheckRunAnnotation[] {
  return surfacePostsInlineComments(surface) ? bodyOnlyAnnotations : allFindingAnnotations
}

/** SIG-144: short, plain copy appended to the review body in annotations-only
 *  mode so the formal review isn't silent about where the findings went. */
export const ANNOTATIONS_ONLY_BODY_NOTE =
  "_Findings are posted as inline check annotations — see the **Files changed** tab and the **Checks** summary._"

/**
 * SIG-144: apply the output surface to a built review submission. In
 * annotations-only mode the findings are delivered as Check annotations, so
 * strip the inline review comments (mutating in place, matching the ensemble's
 * in-place submission build) and point the body at the Checks surface. No-op
 * for `comments` / `both` (inline comments stay). Returns how many comments
 * were suppressed so the caller can log it.
 *
 * Pure-of-IO — exported so the suppression branch is unit-testable without an
 * ensemble harness (Sigilix finding on PR #339).
 */
export function applyOutputSurfaceToSubmission<T extends { comments?: unknown[]; body?: string }>(
  submission: T,
  surface: ReviewOutputSurface,
): { suppressedComments: number } {
  if (surfacePostsInlineComments(surface) || !submission.comments || submission.comments.length === 0) {
    return { suppressedComments: 0 }
  }
  const suppressedComments = submission.comments.length
  submission.comments = []
  submission.body = `${submission.body ?? ""}\n\n${ANNOTATIONS_ONLY_BODY_NOTE}`.trimStart()
  return { suppressedComments }
}

/**
 * SIG-144: GitHub caps `output.annotations[]` at 50 entries per
 * check-run write. To post more, send multiple `PATCH /check-runs/{id}`
 * requests — GitHub *appends* annotations across updates rather than
 * replacing them, so batching accumulates the full set.
 * https://docs.github.com/en/rest/checks/runs#update-a-check-run
 */
const GITHUB_MAX_ANNOTATIONS_PER_REQUEST = 50

/** Name used for the Check Run — renders in the PR's Checks tab.
 *  Kept short ("Sigilix") since the row already carries the
 *  in_progress/completed status; "Sigilix Review" was redundant.
 *  Single string lets future code look up the in-progress check
 *  by name+head_sha if needed. */
export const CHECK_RUN_NAME = "Sigilix"

/** Names that have ever been used for the in-progress check, current
 *  + historical. Used at create time to find and cancel stale
 *  in-progress checks left over from rename deploys or queue
 *  retries — see `cancelStaleInProgressChecks`. */
const KNOWN_CHECK_NAMES: ReadonlySet<string> = new Set([
  CHECK_RUN_NAME,
  "Sigilix Review", // legacy (commit 4 of PR #80, briefly deployed before rename)
])

/** Conclusion subset Sigilix actually emits. Narrower than GitHub's
 *  full set so call sites can't accidentally pass `cancelled` or
 *  `timed_out` (which we don't use). The REST primitive in
 *  `github.ts` keeps the wide union for forward compatibility.
 *
 *  SIG-216 follow-up (founder feedback on PR #176, 2026-05-25): the
 *  Check run signals EXECUTION HEALTH ("did the bot run?"), not
 *  findings count. Industry advisory-bot convention (CodeRabbit,
 *  Greptile) is `success` regardless of findings; review state lives
 *  in the GitHub native review object (APPROVE / COMMENT /
 *  REQUEST_CHANGES). Mapping in `completeCheckRun`:
 *    - `success` → wire `success` (green check, bot ran cleanly)
 *    - `failure` → wire `neutral` (bot errored, ambiguous; reserve
 *      wire `failure` for future opt-in P0 gates)
 *    - `skipped` → wire `neutral` (bot couldn't review — legit
 *      ambiguous state, e.g. stale head). */
export type SigilixCheckConclusion = "success" | "failure" | "skipped"

interface InProgressCheckRun {
  id: number
  client: GitHubClient
  owner: string
  repo: string
}

interface CreateArgs {
  env: Env
  owner: string
  repo: string
  headSha: string
  installationId: number
}

/**
 * Create an `in_progress` check run on the PR's head commit and
 * return a handle the dispatcher can later complete. Returns `null`
 * if the App is missing credentials, if creation 403s (missing
 * `checks: write`), or if any other error fires — the caller treats
 * a null handle as "no check to update."
 */
export async function startInProgressCheckRun(args: CreateArgs): Promise<InProgressCheckRun | null> {
  const { env, owner, repo, headSha, installationId } = args

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-skip-missing-creds",
      owner, repo, head_sha: headSha, installation_id: installationId,
    }))
    return null
  }

  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })

    // Cancel stale Sigilix-named in-progress checks before creating
    // the new one. Two scenarios this handles:
    //   1. Rename-deploy switchovers (founder caught this on PR #80
    //      — "Sigilix Review" check from the prior deploy stayed
    //      in-progress alongside the new "Sigilix" check).
    //   2. Queue retries that re-enter dispatchJob for the same
    //      (PR, headSha) — first run's check is still in_progress
    //      when the retry tries to create another.
    // Best-effort: a failure here logs + continues to the create.
    await cancelStaleInProgressChecks({ client, owner, repo, headSha })

    const created = await client.createCheckRun(owner, repo, {
      name: CHECK_RUN_NAME,
      headSha,
      status: "in_progress",
      startedAt: new Date().toISOString(),
      output: {
        title: "Reviewing this PR…",
        summary: "Sigilix is analyzing the changes. The full review will post as a PR comment when ready.",
      },
    })
    console.log(JSON.stringify({
      event: "pr-review-check-run-created",
      owner, repo, head_sha: headSha, installation_id: installationId,
      check_run_id: created.id,
    }))
    return { id: created.id, client, owner, repo }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-create-failed",
      owner, repo, head_sha: headSha, installation_id: installationId,
      err: err instanceof Error ? err.message : String(err),
    }))
    return null
  }
}

/**
 * SIG-220: rebuild an `InProgressCheckRun` handle when the check was
 * already created upstream (e.g. inside `PrReviewRunDO.handleEnqueue`
 * on the webhook hot-path so the customer sees the Check appear in
 * the GitHub UI within ~1–2s of push) and the dispatcher / watchdog
 * just needs to close it. Returns `null` on any GitHub-token failure
 * — caller treats null the same as "no check to update."
 *
 * Why not just hold the InProgressCheckRun in-memory until the
 * dispatcher fires? Because the consumer is a fresh worker invocation
 * (queue handler), not the same isolate that created the check, so
 * the client instance + token would not survive the hop. We rebuild
 * a fresh client off the installation id we already have.
 */
export interface AttachArgs {
  env: Env
  owner: string
  repo: string
  installationId: number
  checkRunId: number
}

export async function attachExistingCheckRun(args: AttachArgs): Promise<InProgressCheckRun | null> {
  const { env, owner, repo, installationId, checkRunId } = args
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-attach-skip-missing-creds",
      owner, repo, check_run_id: checkRunId, installation_id: installationId,
    }))
    return null
  }
  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    return { id: checkRunId, client: new GitHubClient({ token }), owner, repo }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-attach-failed",
      owner, repo, check_run_id: checkRunId, installation_id: installationId,
      err: err instanceof Error ? err.message : String(err),
    }))
    return null
  }
}

export interface CloseOrphanByHeadShaArgs {
  env: Env
  owner: string
  repo: string
  installationId: number
  headSha: string
  /** Override the closed check's title (defaults to the superseded copy). */
  title?: string
  /** Override the closed check's summary (defaults to the superseded copy). */
  summary?: string
  /**
   * Override the wire conclusion — raw GitHub union, NOT SigilixCheckConclusion
   * (which deliberately excludes these). Defaults to "cancelled"; the watchdog
   * path passes "timed_out" so the closed check's conclusion matches its title.
   */
  conclusion?: "cancelled" | "timed_out"
}

/**
 * SIG-stuck-check: close any orphaned Sigilix-named in-progress check on
 * `headSha` when the DO has no `checkRunId` to attach to. This bites on the
 * cancel + watchdog-terminal paths: when `handleEnqueue`'s synchronous
 * check-create lost its 3s `Promise.race` (GitHub 5xx / timeout under
 * contention), the consumer created the check via `startInProgressCheckRun`
 * and that id never reached the DO — so `RunState.checkRunId` is undefined
 * and the existing attach-by-id close is skipped, leaving the check
 * `in_progress` forever (observed on PR #402 after `/sigilix cancel`).
 *
 * Builds an installation-scoped `GitHubClient` exactly like
 * `attachExistingCheckRun` (the DO never constructs a client directly — it
 * only calls the helpers in this module), then delegates to
 * `cancelStaleInProgressChecks`, which lists the head's check runs and
 * closes the Sigilix-named in_progress/queued ones (idempotent — safe even
 * if the attached-id path already closed one). Best-effort throughout: a
 * missing-creds guard, token failure, or any list/PATCH error logs and
 * returns; nothing thrown reaches the DO state machine.
 */
export async function closeOrphanedInProgressChecksByHeadSha(
  args: CloseOrphanByHeadShaArgs,
): Promise<void> {
  const { env, owner, repo, installationId, headSha, title, summary, conclusion } = args
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-close-orphan-skip-missing-creds",
      owner, repo, head_sha: headSha, installation_id: installationId,
    }))
    return
  }
  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })
    await cancelStaleInProgressChecks({
      client, owner, repo, headSha,
      ...(title !== undefined ? { title } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(conclusion !== undefined ? { conclusion } : {}),
    })
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-close-orphan-failed",
      owner, repo, head_sha: headSha, installation_id: installationId,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}

/**
 * ARC-276: payload threaded from the dispatcher's posted-path so the
 * Check Run title can render the customer-visible verdict (Approved
 * vs N findings). Only meaningful when `conclusion === "success"`
 * and a review was actually posted.
 *
 * ARC-279: `surface` is set to `"comment"` when the ensemble had to
 * route through the synth-body-as-PR-comment fallback (the formal
 * review submit was silently rejected by GitHub). The dispatcher
 * maps that to a `failure` conclusion + a "see PR comment" title
 * so the customer knows the normal review pipeline didn't run even
 * though they have a comment to read.
 *
 * ARC-280 follow-up: `surface === "skip-notice"` is set when the
 * ensemble couldn't generate a verdict (router_no_specialists /
 * specialists_all_failed / synth retry exhausted / internal_error)
 * and posted a minimal "Sigilix couldn't review" comment. The
 * dispatcher maps `errored + surface=skip-notice` to `failure`
 * with a distinct "Couldn't review — see PR comment" title so the
 * customer knows the review didn't run AND can find the explanation
 * comment.
 */
export interface ReviewCheckMeta {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  findingsCount: number
  surface?: "review" | "comment" | "skip-notice"
  /**
   * SIG-144: per-finding Check annotations (path/start_line/end_line/
   * annotation_level) built by the ensemble producer. Posted by `completeCheckRun` ONLY when
   * the active surface includes annotations (`OPENCLAW_REVIEW_OUTPUT_SURFACE`
   * = `annotations` | `both`) and the conclusion is `success`. Sanitized
   * to plain text before posting (SIG-216). Empty/absent → nothing posted.
   * (Was a no-op from SIG-216 until SIG-144 reinstated the surface.)
   */
  checkAnnotations?: CheckRunAnnotation[]
  /**
   * SIG-171: deterministic SARIF/RDF/linter Lane A annotations. These are not
   * model-authored review findings, so they are eligible even when the active
   * review surface is `comments` and when the LLM review degrades after the
   * deterministic scan has run. Stale-head skips still suppress them.
   */
  deterministicCheckAnnotations?: CheckRunAnnotation[]
  /**
   * SIG-216: PR number used to build the `[View review]` link in
   * the Check run summary. Optional so legacy callers without the
   * PR number in scope still get a sensible (link-less) summary.
   */
  prNumber?: number
  /**
   * SIG-184: the runner-evidence trust state for this review, when a
   * receipt was consulted (flag-gated; absent by default). When
   * present, the Check run summary appends a "VERIFIED"/"PENDING"
   * provenance pill. The third runtime state, `runner-absent`, is
   * represented by OMITTING this field — no badge renders, so the
   * default (no runner installed) experience is unchanged.
   */
  runnerEvidence?: "verified" | "evidence-pending"
}

interface CompleteArgs {
  handle: InProgressCheckRun | null
  conclusion: SigilixCheckConclusion
  /** ARC-276: optional; populated by the dispatcher on posted runs. */
  reviewMeta?: ReviewCheckMeta
  /**
   * SIG-144: active output surface (from `OPENCLAW_REVIEW_OUTPUT_SURFACE`).
   * When it includes annotations AND the conclusion is `success`, the
   * findings on `reviewMeta.checkAnnotations` are posted as Check
   * annotations after the completion PATCH. Defaults to `"comments"`
   * (annotations OFF) so existing callers are unaffected.
   */
  surface?: ReviewOutputSurface
}

/**
 * Transition the check run from `in_progress` to `completed` with
 * the given conclusion. No-op when handle is null (creation failed
 * or was skipped). Output copy is derived from the conclusion +
 * (when present) the review verdict, so the customer-visible
 * title differentiates "Approved — no issues found" from "3
 * findings posted" rather than a generic "Review posted."
 */
export async function completeCheckRun(args: CompleteArgs): Promise<void> {
  const { handle, conclusion, reviewMeta } = args
  const surface = args.surface ?? "comments"
  if (handle === null) return
  const output = renderOutputForConclusion(conclusion, reviewMeta, {
    owner: handle.owner,
    repo: handle.repo,
  })
  // SIG-216 follow-up (founder feedback on PR #176, 2026-05-25):
  // Kimi K2.6 (UI design authority) confirmed industry convention —
  // the Check run signals EXECUTION HEALTH, not findings count.
  // CodeRabbit + Greptile both emit `success` regardless of findings;
  // review state lives in the GitHub native review object
  // (APPROVE / COMMENT / REQUEST_CHANGES). Reserve `neutral` for
  // skips/errors (ambiguous "did the bot run?" state). Reserve wire
  // `failure` for future opt-in P0 gates.
  const wireConclusion: "success" | "neutral" =
    conclusion === "success" ? "success"
    : conclusion === "failure" ? "neutral"  // errored — ambiguous, not failing the check
    : "neutral"                              // skipped — legit ambiguous
  try {
    await handle.client.updateCheckRun(handle.owner, handle.repo, handle.id, {
      status: "completed",
      conclusion: wireConclusion,
      completedAt: new Date().toISOString(),
      output,
    })
    console.log(JSON.stringify({
      event: "pr-review-check-run-completed",
      owner: handle.owner, repo: handle.repo,
      check_run_id: handle.id, conclusion: wireConclusion,
      internal_conclusion: conclusion,
    }))
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-complete-failed",
      owner: handle.owner, repo: handle.repo,
      check_run_id: handle.id, conclusion: wireConclusion,
      internal_conclusion: conclusion,
      err: err instanceof Error ? err.message : String(err),
    }))
    return
  }

  // SIG-144: model-authored per-finding annotations stay gated on the active
  // review output surface AND a successful review submit.
  //
  // SIG-171: deterministic Lane A annotations are scanner-derived, not
  // model-authored. Post them whenever the run reached the scan and did not
  // stale-head skip, even if the later LLM review degraded to a skip-notice or
  // comment fallback. Best-effort: annotation failures never disturb the
  // already-completed check or the underlying review.
  const modelAnnotations =
    surfacePostsAnnotations(surface) && conclusion === "success"
      ? reviewMeta?.checkAnnotations ?? []
      : []
  // At this boundary `skipped` means stale-head only. The dispatcher maps
  // user/config skips to `success` and internal errors to `failure`, so this
  // gate suppresses stale-head annotations without hiding post-scan diagnostics.
  const deterministicAnnotations =
    conclusion !== "skipped" ? reviewMeta?.deterministicCheckAnnotations ?? [] : []
  const annotations = [...modelAnnotations, ...deterministicAnnotations]
  if (annotations.length > 0) {
    await postCheckAnnotations({
      handle,
      output,
      annotations,
    })
  }
}

/**
 * SIG-144: post the finding annotations onto the (already-completed)
 * check run. Sanitizes each annotation to plain text (SIG-216 lesson:
 * GitHub renders the `message` field literally), filters out anything
 * GitHub would reject, and writes in batches of ≤50 (the API cap;
 * GitHub appends across PATCHes).
 *
 * Graceful degradation (AC + Sigilix comment): GitHub rejects the WHOLE
 * request if a SINGLE annotation is invalid (stale line, file no longer
 * in the diff, etc.). So if a batch PATCH fails, we retry that batch
 * one annotation at a time and drop only the offenders — a stale
 * annotation never sinks the rest of the review's findings.
 *
 * Best-effort throughout: every failure logs and continues; nothing
 * thrown reaches the dispatcher.
 */
async function postCheckAnnotations(args: {
  handle: InProgressCheckRun
  output: { title: string; summary: string }
  annotations: CheckRunAnnotation[]
}): Promise<void> {
  const { handle, output } = args
  const { owner, repo, id } = handle

  const valid = args.annotations
    .map(toPlainTextAnnotation)
    .filter(isPostableAnnotation)
  const dropped = args.annotations.length - valid.length
  if (dropped > 0) {
    console.warn(JSON.stringify({
      event: "pr-review-check-annotation-prefilter-dropped",
      owner, repo, check_run_id: id, dropped,
    }))
  }
  if (valid.length === 0) return

  let posted = 0
  for (let i = 0; i < valid.length; i += GITHUB_MAX_ANNOTATIONS_PER_REQUEST) {
    const batch = valid.slice(i, i + GITHUB_MAX_ANNOTATIONS_PER_REQUEST)
    try {
      // Re-send title+summary: GitHub requires `output.title` +
      // `output.summary` on any update that carries annotations.
      await handle.client.updateCheckRun(owner, repo, id, {
        output: { title: output.title, summary: output.summary, annotations: batch },
      })
      posted += batch.length
    } catch (err) {
      // GitHub rejects the ENTIRE batch atomically when a SINGLE annotation
      // is invalid (HTTP 422 — stale line after a force-push, file no longer
      // in the diff). Only then is a per-annotation retry both safe and
      // useful: we KNOW nothing from this batch was stored, so re-posting the
      // survivors can't duplicate. For transient / 5xx / network errors the
      // write may have landed server-side (GitHub APPENDS annotations across
      // PATCHes), so a blind retry risks duplicate annotations — log and move
      // on. Mirrors the `submitReview` 422 idempotency reasoning below in
      // triage-pr-review-ensemble.ts. (CodeRabbit + Sigilix, PR #339 review.)
      const isValidationError = err instanceof GitHubHttpError && err.status === 422
      if (!isValidationError) {
        console.warn(JSON.stringify({
          event: "pr-review-check-annotation-batch-failed-transient",
          owner, repo, check_run_id: id, batch_size: batch.length,
          err: err instanceof Error ? err.message : String(err),
        }))
        continue
      }
      console.warn(JSON.stringify({
        event: "pr-review-check-annotation-batch-rejected",
        owner, repo, check_run_id: id, batch_size: batch.length,
        err: err.message,
      }))
      // Re-post survivors SEQUENTIALLY, isolating + dropping the offender.
      // Not parallelized on purpose: GitHub's REST guidance is to serialize
      // mutations (POST/PATCH) — up to 50 concurrent check-run PATCHes risks
      // a secondary-rate-limit 403/429. This path is rare (only a 422-poisoned
      // batch, e.g. a force-push staled a line) and best-effort, so the
      // serial round-trips are an acceptable cost for staying within GitHub's
      // limits. (CodeRabbit secondary-rate-limit finding vs. Sigilix latency
      // finding, PR #339 — GitHub's documented guidance wins.)
      for (const annotation of batch) {
        try {
          await handle.client.updateCheckRun(owner, repo, id, {
            output: { title: output.title, summary: output.summary, annotations: [annotation] },
          })
          posted += 1
        } catch (singleErr) {
          console.warn(JSON.stringify({
            event: "pr-review-check-annotation-dropped",
            owner, repo, check_run_id: id,
            path: annotation.path, start_line: annotation.start_line,
            err: singleErr instanceof Error ? singleErr.message : String(singleErr),
          }))
        }
      }
    }
  }

  console.log(JSON.stringify({
    event: "pr-review-check-annotations-posted",
    owner, repo, check_run_id: id,
    posted, requested: args.annotations.length,
  }))
}

/**
 * SIG-144 / SIG-216: GitHub renders the annotation `title`, `message`,
 * and `raw_details` fields as PLAIN TEXT. The ensemble producer builds
 * annotation bodies from the same markdown the PR-comment surface uses
 * (`**bold**`, `<details>`, badge `<img>` tags, `[link](url)`), which
 * dumps literally. This strips the markup down to readable prose so the
 * annotation reads cleanly in the Files tab + Checks UI.
 *
 * Pure — exported for tests.
 */
export function toPlainTextAnnotation(a: CheckRunAnnotation): CheckRunAnnotation {
  const out: CheckRunAnnotation = {
    path: a.path,
    start_line: a.start_line,
    end_line: a.end_line,
    annotation_level: a.annotation_level,
    message: stripMarkupToPlainText(a.message),
  }
  if (a.title !== undefined) out.title = stripMarkupToPlainText(a.title)
  if (a.raw_details !== undefined) out.raw_details = stripMarkupToPlainText(a.raw_details)
  return out
}

/**
 * SIG-144: reduce GitHub-flavored markdown / HTML to plain text. Order is
 * deliberate: drop dangerous element bodies, then real `<img>`/`<br>`, then
 * unwrap ONLY our renderers' allow-listed tags, then markdown, and **decode
 * HTML entities LAST**. Decoding last is the fix for two PR #339 findings:
 * a literal code example like `` `&lt;details&gt;` `` stays readable text
 * instead of being decoded into a real tag and then deleted by the allow-list
 * (CodeRabbit), and entity-encoded markup can't be normalized into a
 * surviving non-allow-listed tag (Sigilix). Real tags emitted by our
 * renderers are already plain `<...>` (not entity-encoded), so they're
 * stripped before the decode pass runs.
 */
function stripMarkupToPlainText(input: string): string {
  let s = input
  // Best-effort tidy-up: drop dangerous *literal* element bodies so they don't
  // dump as noise. NOT a security control and NOT load-bearing — the output
  // sink (GitHub annotation message/title/raw_details) is rendered as PLAIN
  // TEXT, so nothing here is ever live HTML. Note this runs BEFORE the
  // entity-decode below, so entity-encoded markup an author wrote as an example
  // (e.g. a finding that literally discusses `&lt;script&gt;`) is intentionally
  // preserved as readable text rather than stripped. (PR #339 review.)
  s = s.replace(/<(script|style|iframe|object|embed|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
  // Drop badge / image tags entirely (they carry no readable text).
  s = s.replace(/<img\b[^>]*>/gi, "")
  // <br> → newline so structure isn't lost.
  s = s.replace(/<br\s*\/?>/gi, "\n")
  // Unwrap ONLY the HTML tags our finding renderers actually emit — an
  // ALLOW-LIST, not a blanket `<[a-z]…>` strip. The blanket strip deleted
  // TypeScript generics in finding text (`Map<string, number>` → `Map`,
  // `Promise<void>` → `Promise`) — silently corrupting the very content
  // this surface exists to show. (PR #339 review: P1.)
  s = s.replace(
    /<\/?(?:details|summary|sub|sup|b|i|em|strong|code|pre|a|p|div|span|kbd|ul|ol|li|blockquote|h[1-6]|table|thead|tbody|tr|td|th)\b[^>]*>/gi,
    "",
  )
  // Markdown links [text](url) → "text (url)".
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  // Bold / italic emphasis markers.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1")
  s = s.replace(/__([^_]+)__/g, "$1")
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
  // Code spans / fences → keep inner text, drop backticks.
  s = s.replace(/```[a-z]*\n?/gi, "")
  s = s.replace(/`+/g, "")
  // Heading / blockquote / list leaders at line starts.
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
  s = s.replace(/^[ \t]*>[ \t]?/gm, "")
  // Decode the handful of HTML entities our renderers emit LAST — see the
  // doc-comment: real tags are already stripped, so this only turns
  // entity-encoded example text back into readable literal characters.
  // `&amp;` last to avoid double-decoding.
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  // Collapse 3+ blank lines and trim trailing whitespace per line.
  s = s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n")
  return s.trim()
}

/**
 * SIG-144: GitHub rejects an annotation (and the whole request with it)
 * when required fields are missing or nonsensical. Filter to the ones
 * that can anchor: a real path, finite positive line range with
 * end ≥ start, and a non-empty message. Out-of-range / file-deleted
 * cases that survive this still get caught by the per-annotation retry.
 */
function isPostableAnnotation(a: CheckRunAnnotation): boolean {
  return (
    typeof a.path === "string" && a.path.trim().length > 0 &&
    Number.isInteger(a.start_line) && a.start_line >= 1 &&
    Number.isInteger(a.end_line) && a.end_line >= a.start_line &&
    typeof a.message === "string" && a.message.trim().length > 0
  )
}

/**
 * ARC-258: cancel any Sigilix-named in-progress check runs on this
 * head_sha BEFORE creating a new one. Idempotent — safe to call on
 * every dispatcher entry; returns 0-cancellation early if no stale
 * checks are found. Best-effort throughout: list/PATCH failures
 * log + return without touching the underlying review pipeline.
 *
 * GitHub's Check Runs API does NOT dedupe by name — each
 * `POST /check-runs` creates a new row. Without this cleanup, every
 * queue retry + every name-rename deploy + every concurrent
 * dispatcher run would stack another in-progress row on the PR.
 *
 * SIG-stuck-check: exported so the DO's cancel + watchdog fallback
 * (via `closeOrphanedInProgressChecksByHeadSha`) can reuse the
 * close-by-head-sha logic when it has no `checkRunId` to attach to
 * (the upstream create timed out / 5xx'd and the consumer created
 * the check instead, so the id never reached the DO). The optional
 * `title`/`summary` override lets the cancel path read "Cancelled"
 * and the watchdog path "Timed out" instead of the default
 * superseded copy.
 */
export async function cancelStaleInProgressChecks(args: {
  client: GitHubClient
  owner: string
  repo: string
  headSha: string
  title?: string
  summary?: string
  conclusion?: "cancelled" | "timed_out"
}): Promise<void> {
  const { client, owner, repo, headSha } = args
  const title = args.title ?? "Cancelled (superseded)"
  const summary = args.summary
    ?? "A newer Sigilix review run started for this commit and replaced this check."
  const conclusion = args.conclusion ?? "cancelled"
  let existing: Array<{ id: number; name: string; status: string }>
  try {
    existing = await client.listCheckRunsForRef(owner, repo, headSha)
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-check-run-list-failed",
      owner, repo, head_sha: headSha,
      err: err instanceof Error ? err.message : String(err),
    }))
    return
  }
  const stale = existing.filter((r) =>
    KNOWN_CHECK_NAMES.has(r.name) && (r.status === "in_progress" || r.status === "queued"),
  )
  if (stale.length === 0) return
  for (const run of stale) {
    try {
      await client.updateCheckRun(owner, repo, run.id, {
        status: "completed",
        conclusion,
        completedAt: new Date().toISOString(),
        output: { title, summary },
      })
      console.log(JSON.stringify({
        event: "pr-review-check-run-cancelled-stale",
        owner, repo, head_sha: headSha,
        check_run_id: run.id, name: run.name,
      }))
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pr-review-check-run-cancel-stale-failed",
        owner, repo, head_sha: headSha,
        check_run_id: run.id, name: run.name,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }
}

/**
 * Exported for direct unit tests of the title/summary mapping.
 * The dispatcher calls `completeCheckRun` which wraps this, but the
 * pure mapping is the contract that ARC-276 codifies.
 *
 * SIG-216: the success-path summary is now the Greptile-direction
 * one-liner "N suggestion(s) · [View review](pr-url)". The PR URL
 * is built from `repoCoords` + `reviewMeta.prNumber`; legacy
 * callers without those fields get a link-less variant. The verbose
 * "open the conversation tab and check annotations" copy was
 * removed — annotations are no longer posted.
 */
export function renderOutputForConclusion(
  conclusion: SigilixCheckConclusion,
  reviewMeta?: ReviewCheckMeta,
  repoCoords?: { owner: string; repo: string },
): { title: string; summary: string } {
  const prReviewUrl = buildPrReviewUrl(repoCoords, reviewMeta?.prNumber)
  // SIG-184: trust-pill suffix appended to the success summary when a runner
  // receipt backed this review (Kimi spec). `runner-absent` is the omitted
  // case → empty suffix → byte-identical to the pre-badge summary.
  const runnerBadge = reviewMeta?.runnerEvidence
    ? ` · ${runnerEvidenceBadgeImg(reviewMeta.runnerEvidence)}`
    : ""
  const deterministicCount = reviewMeta?.deterministicCheckAnnotations?.length ?? 0
  const deterministicPhrase = deterministicCount > 0
    ? `${deterministicCount} scanner ${deterministicCount === 1 ? "diagnostic" : "diagnostics"}`
    : ""
  const deterministicSuffix = deterministicCount > 0
    ? ` · ${deterministicPhrase} from deterministic analysis`
    : ""
  switch (conclusion) {
    case "success":
      // ARC-276 + SIG-216: when the dispatcher threads `reviewMeta`,
      // the Check Run title reflects the verdict directly. The
      // summary collapses to a single line pointing at the PR
      // conversation tab. SIG-184: the runner trust pill (when any)
      // is appended to the summary, never the title.
      if (reviewMeta) {
        if (reviewMeta.event === "APPROVE") {
          return {
            title: "Approved — no issues found",
            summary: buildApprovedSummary(prReviewUrl) + deterministicSuffix + runnerBadge,
          }
        }
        const n = reviewMeta.findingsCount
        const noun = n === 1 ? "finding" : "findings"
        const title = reviewMeta.event === "COMMENT"
          ? `${n} non-blocking ${noun} posted`
          : `${n} ${noun} — changes requested`
        return {
          title,
          summary: buildFindingsSummary(n, prReviewUrl) + deterministicSuffix + runnerBadge,
        }
      }
      return {
        title: "Review posted",
        summary: buildLegacyPostedSummary(prReviewUrl) + deterministicSuffix + runnerBadge,
      }
    case "skipped":
      return {
        title: "Review skipped (stale head)",
        summary: "A newer commit was pushed before this review finished. Sigilix will re-review the latest head automatically.",
      }
    case "failure":
      // ARC-279: the dispatcher maps `surface === "comment"` to
      // `failure` so the customer sees that the normal review
      // pipeline didn't run — but the comment fallback DID post
      // synth's body. Title points them at the PR comment so they
      // don't think the bot was entirely silent.
      if (reviewMeta?.surface === "comment") {
        const scannerSummary = deterministicCount > 0
          ? ` Deterministic analysis also found ${deterministicPhrase}.`
          : ""
        return {
          title: "Couldn't post review — see PR comment",
          summary: "GitHub silently rejected Sigilix's formal review submit." + scannerSummary + " Sigilix posted the review content as a regular PR comment instead so the signal isn't lost. Re-run `/sigilix review` to try the formal review again.",
        }
      }
      // ARC-280 follow-up: `surface === "skip-notice"` means the
      // ensemble couldn't even generate a verdict (no specialist
      // ran or synth fully failed after retry) and posted a
      // minimal "couldn't review" comment instead. Different
      // title so log analysis can distinguish.
      if (reviewMeta?.surface === "skip-notice") {
        const scannerSummary = deterministicCount > 0
          ? ` Deterministic analysis still found ${deterministicPhrase}.`
          : ""
        return {
          title: "Couldn't review — see PR comment",
          summary: "Sigilix couldn't generate a model review for this PR (specialists failed, synth couldn't run, or an internal error fired)." + scannerSummary + " A short PR comment explains which path bailed. Re-run `/sigilix review` to try again.",
        }
      }
      return {
        title: "Review failed",
        summary: "Sigilix encountered an error while reviewing this PR. Re-trigger with `/sigilix review` or contact support." + deterministicSuffix,
      }
  }
}

/**
 * SIG-216: build the canonical GitHub PR URL used in the Check run
 * summary's `[View review]` link. Returns `null` when owner/repo or
 * PR number are missing (legacy callers) so the caller can render a
 * link-less fallback.
 */
function buildPrReviewUrl(
  repoCoords: { owner: string; repo: string } | undefined,
  prNumber: number | undefined,
): string | null {
  if (!repoCoords || typeof prNumber !== "number" || !Number.isFinite(prNumber)) {
    return null
  }
  return `https://github.com/${repoCoords.owner}/${repoCoords.repo}/pull/${prNumber}`
}

/**
 * SIG-216: Greptile-direction one-liner for the approve-only path.
 * "Sigilix approved · [View PR](url)" when we can link, plain text
 * otherwise.
 */
function buildApprovedSummary(prReviewUrl: string | null): string {
  return prReviewUrl
    ? `Sigilix approved · [View PR](${prReviewUrl})`
    : "Sigilix approved"
}

/**
 * SIG-216: Greptile-direction one-liner for the findings-posted
 * path. "N suggestion(s) · [View review](url)" when we can link,
 * plain text otherwise.
 */
function buildFindingsSummary(findingsCount: number, prReviewUrl: string | null): string {
  const noun = findingsCount === 1 ? "suggestion" : "suggestions"
  const head = `${findingsCount} ${noun}`
  return prReviewUrl ? `${head} · [View review](${prReviewUrl})` : head
}

/**
 * SIG-216: legacy "we don't know the verdict" path (no reviewMeta).
 * Avoids fabricating a misleading "0 suggestions" line; instead
 * emits a neutral pointer at the PR.
 */
function buildLegacyPostedSummary(prReviewUrl: string | null): string {
  return prReviewUrl
    ? `Sigilix posted a review · [View review](${prReviewUrl})`
    : "Sigilix posted a review"
}
