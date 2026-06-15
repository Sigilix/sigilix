// SIG-426 (PR 2 of CI-triage→synth) — the IO/orchestration layer that wires the
// PR-1 pure core (`ci-triage-synth.ts`) into a real run.
//
// PR 1 shipped the pure decisions (flag parse, the user-message builder, the two
// stacked gates, the disposition rule, the dedup predicate, the presentation
// renderer). This module performs the IO those decisions need — the single
// `runSynthesizer` ultra call, `prepareReviewSubmissionFindings` anchoring, the
// GitHub reads (prior fingerprints + manifest coarse keys + idempotency scan)
// and the COMMENT-event post — and is called from `runCiTriage` (triage-ci.ts)
// behind `OPENCLAW_CI_TRIAGE_SYNTH_MODE` (off|shadow|enforce, default off).
//
// Mirrors `ci-suggestions.ts`'s pure/IO split: the pure policy stays in
// `ci-triage-synth.ts`; this file is the GitHub/model IO. Kept out of
// `triage-ci.ts` so that handler stays lean.

import { runSynthesizer, SYNTHESIZER_CONFIG } from "@/src/lib/ensemble/adapters/model-provider"
import { modelApiKeys, selectConfigApiKey } from "@/src/lib/ensemble/adapters/model-provider-routing"
import { prepareReviewSubmissionFindings } from "@/src/lib/ensemble/render/submission"
import { SYNTHESIZER_PROMPT } from "@/src/prompts/specialists/synthesizer"
import { CI_SYNTH_PREAMBLE } from "@/src/prompts/specialists/ci-synth"
import { parseDiffToReviewablePositions, deriveSide, type ReviewableMap } from "@/src/shared/util/diff-positions"
import { computeContentFingerprint } from "@/src/lib/review-withdrawal-store"
import { readReviewManifest } from "@/src/lib/review-manifest"
import { parseFindingFingerprint } from "@/src/lib/pr-finding-markers"
import { GitHubHttpError } from "@/src/shared/adapters/github"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { SubmitReviewBody, SubmitReviewComment } from "@/src/shared/types/github"
import type { Env } from "@/src/shared/types/env"
import {
  CI_REVIEW_MARKER,
  buildCiSynthUserMessage,
  ciFindingCoarseKey,
  disposeCiFinding,
  isDuplicateOfExistingReview,
  isLogGrounded,
  matchesExistingCoarseKey,
  renderCiFindingComment,
  type CiFileContext,
  type CiFindingDisposition,
  type ExistingReviewFindings,
} from "@/src/lib/ci-triage-synth"

/**
 * The minimal GitHub client surface this module needs. The real `GitHubClient`
 * satisfies it structurally; tests pass a small fake. (Mirrors
 * `CiSuggestionClient` in ci-suggestions.ts.)
 */
export interface CiSynthClient {
  listPullRequestReviewComments(owner: string, repo: string, prNumber: number): Promise<ReadonlyArray<{ body: string }>>
  listPullRequestReviews(owner: string, repo: string, prNumber: number): Promise<ReadonlyArray<{ body: string }>>
  submitReview(owner: string, repo: string, prNumber: number, review: SubmitReviewBody): Promise<unknown>
}

export interface RunCiTriageSynthArgs {
  client: CiSynthClient
  env: Env
  owner: string
  repo: string
  prNumber: number
  runId: number
  headSha: string
  /** "shadow" telemeters but posts nothing; "enforce" posts grounded inline. */
  mode: "shadow" | "enforce"
  /** The fetched failure log (concatenated failed-job logs) — already in scope in runCiTriage. */
  ciLog: string
  /** The PR's unified diff — already fetched in runCiTriage. */
  diff: string
  /** Current contents of the files the log named — already fetched in runCiTriage. */
  fileContexts: readonly CiFileContext[]
}

/** What the pass decided — returned for telemetry + the handler's logging. */
export interface CiTriageSynthSummary {
  /** Findings the synth emitted (post-parse). */
  candidates: number
  /** Findings whose (path,line) is a RIGHT-side reviewable diff position. */
  anchorable: number
  /** Anchorable findings whose `logExcerpt` corroborated against the log. */
  corroborated: number
  /** Anchorable-but-uncorroborated findings posted with the hedge line. */
  hedged: number
  /** Findings withheld (off-diff, or hard-withheld uncorroborated). */
  withheld: number
  /** Findings hard-dropped as exact duplicates of the existing review. */
  dedupDropped: number
  /** Findings whose coarse (path,headline) key matched the manifest (hint only). */
  coarseHints: number
  /** Inline comments actually posted (0 in shadow; 0 in enforce when nothing survives). */
  posted: number
  /** Whether the ultra synth call was made (false when the cost pre-filter skipped). */
  ultraCalled: boolean
  /** Why the pass posted nothing, when applicable (telemetry label). */
  skip: string | null
  elapsedMs: number
}

/** The two dispositions that actually post inline (everything else is withheld). */
type InlineDisposition = Extract<CiFindingDisposition, "inline-clean" | "inline-hedged">

/** A surviving CI finding paired with its disposition + computed fingerprint. */
interface SurvivingCiFinding {
  finding: PrReviewFinding
  disposition: InlineDisposition
  contentFingerprint: string
}

/**
 * The `OPENCLAW_CI_TRIAGE_SYNTH_HARD_WITHHOLD` knob (default false): when set,
 * the anchored-but-uncorroborated bucket is HARD-WITHHELD instead of hedged
 * (Codex's stricter "enforce"). DEFAULT false — uncorroborated is hedged-inline,
 * not dropped (DeepSeek recall-safety). The shadow window's true/false rate on
 * the uncorroborated bucket decides whether to flip this on.
 */
function hardWithholdUncorroborated(env: Env): boolean {
  return (env.OPENCLAW_CI_TRIAGE_SYNTH_HARD_WITHHOLD ?? "").trim().toLowerCase() === "true"
}

/**
 * The per-(headSha,runId) idempotency marker stamped on every inline comment
 * body. The bare `CI_REVIEW_MARKER` is invisible to dedup across DISTINCT runs
 * on the same head, so we scope it: a LATER distinct failed run (new runId) on
 * the same head is NOT suppressed. A review-BODY marker is invisible to
 * `listPullRequestReviewComments`, so this rides on the comment body.
 */
function ciRunMarker(headSha: string, runId: number): string {
  return `<!-- sigilix:ci-run:${headSha}:${runId} -->`
}

function runUrl(owner: string, repo: string, runId: number): string {
  return `https://github.com/${owner}/${repo}/actions/runs/${runId}`
}

/**
 * Run the grounded CI-triage synth pass: ONE ultra synth over the CI evidence →
 * ground + anchor → dedup vs the prior review → (enforce) post grounded inline.
 * Returns a summary for telemetry. NEVER throws — any failure (IO or otherwise)
 * degrades to a skip-labeled summary so the caller's legacy path (shadow) or the
 * next push (enforce) recovers. The caller (`handleCiTriage`) wraps `runCiTriage`
 * in a try/finally with NO catch, so a throw here would escape the handler and a
 * queue retry could re-run; the top-level catch below makes the no-throw contract
 * real, not incidental. The caller decides what to do with the legacy sticky
 * based on `mode` (shadow keeps it; enforce suppresses it).
 */
export async function runCiTriageSynth(args: RunCiTriageSynthArgs): Promise<CiTriageSynthSummary> {
  const t0 = Date.now()
  try {
    return await runCiTriageSynthImpl(args, t0)
  } catch (err) {
    // Defensive: no realistic path throws (runSynthesizer returns structured
    // failures; the GitHub/manifest IO is guarded; crypto.subtle is always
    // present), but if one ever did, degrade to a skip so the handler never
    // throws and the dedupe-key release doesn't trigger a re-run.
    return finishSkip(args, t0, 0, 0, 0, 0, 0, "unexpected-error", err)
  }
}

async function runCiTriageSynthImpl(args: RunCiTriageSynthArgs, t0: number): Promise<CiTriageSynthSummary> {
  const { client, env, owner, repo, prNumber, runId, headSha, mode, ciLog, diff, fileContexts } = args
  const empty = (skip: string | null, ultraCalled: boolean): CiTriageSynthSummary => ({
    candidates: 0,
    anchorable: 0,
    corroborated: 0,
    hedged: 0,
    withheld: 0,
    dedupDropped: 0,
    coarseHints: 0,
    posted: 0,
    ultraCalled,
    skip,
    elapsedMs: Date.now() - t0,
  })

  // ── Cost pre-filter (cheap, BEFORE the ultra call) ──────────────────────
  // Skip only the obvious off-diff case: the diff has no RIGHT-side reviewable
  // position at all, so nothing the synth emits could anchor (flaky/infra). Do
  // NOT skip merely because the log names only the test file — the changed
  // source often caused the test failure. Conservative (recall-safe): if there
  // is ANY reviewable RIGHT line, run.
  const reviewable = parseDiffToReviewablePositions(diff)
  if (!hasAnyRightPosition(reviewable)) {
    return empty("no-reviewable-positions", false)
  }

  // ── One ultra synth call ────────────────────────────────────────────────
  const userMessage = buildCiSynthUserMessage({ ciLog, diff, fileContexts })
  const controller = new AbortController()
  // CI-appropriate budget — the synth per-attempt timeout, NOT the 895s
  // orchestrator wall (a CI failure must not pin the queue worker).
  const timer = setTimeout(() => controller.abort(), SYNTHESIZER_CONFIG.perAttemptTimeoutMs)
  let output: Awaited<ReturnType<typeof runSynthesizer>>
  try {
    output = await runSynthesizer({
      apiKey: selectConfigApiKey(SYNTHESIZER_CONFIG, modelApiKeys(env)),
      // The CI preamble OVERRIDES the specialist-merge assumptions that follow,
      // so it must come FIRST (it relaxes the hallucination guard for log-
      // grounded findings and mandates the verbatim `logExcerpt`).
      systemPrompt: CI_SYNTH_PREAMBLE + SYNTHESIZER_PROMPT,
      userMessage,
      // Derive the kill-switch the SAME way the ensemble synth path does
      // (synthesize.ts:544) — "off" HARD-throws in the chat adapter
      // (openrouter-chat.ts:78 / ollama-chat.ts:62), it is NOT a no-tools mode.
      // Hardcoding "off" here killed every CI synth call. Honor the
      // OLLAMA_CHAT_ENABLE kill-switch instead so CI triage runs iff chat is on.
      chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
      signal: controller.signal,
      perfCtx: { owner, repo, prNumber, headSha },
      // No specialist sources on the CI path — provenance reconstruction is a
      // no-op; the model cites the log directly per the preamble.
      provenanceSources: [],
    })
  } finally {
    clearTimeout(timer)
  }

  const verdict = output.verdict
  if (verdict == null || verdict.findings.length === 0) {
    return empty(verdict == null ? "synth-no-verdict" : "synth-no-findings", true)
  }

  // ── Ground + anchor ─────────────────────────────────────────────────────
  // Reuse the PR-review inline-vs-body routing. Without `addedLineTextByLine`
  // the substantive-anchor walk is skipped, so `inlineFindings` may include
  // off-diff lines — we gate `anchored` on an explicit RIGHT-side check below
  // (Codex sign-off point 3). NOTE: this also inherits the PR-review
  // testing-finding policy (`normalizeTestingFindingForFinalPolicy` caps a
  // `testing` finding to score 2; a missing-sibling testing finding is dropped),
  // which is the common CI category — accepted for v1 (the policy is recall-tuned
  // for the review path and CI inherits it unchanged); revisit if shadow shows it
  // over-suppresses CI test findings.
  const prepared = prepareReviewSubmissionFindings({
    rawVerdict: verdict,
    rawUnanchored: [],
    headSha,
    reviewable,
  })

  // Count candidates as what SURVIVED `prepareReviewSubmissionFindings` (some
  // findings — e.g. a missing-sibling testing finding — may be dropped inside it),
  // so the summary buckets reconcile (candidates == anchorable-ish + withheld).
  const candidates = prepared.inlineFindings.length + prepared.unanchored.length
  let anchorable = 0
  let corroborated = 0
  let hedged = 0
  let withheld = prepared.unanchored.length // body-routed = off-diff for the CI path
  const surviving: Array<{ finding: PrReviewFinding; disposition: InlineDisposition }> = []

  const hardWithhold = hardWithholdUncorroborated(env)
  for (const finding of prepared.inlineFindings) {
    const anchored = deriveSide(reviewable, finding.path, finding.line) === "RIGHT"
    const logCorroborated = anchored && isLogGrounded(finding.logExcerpt ?? "", ciLog)
    const disposition = disposeCiFinding({
      anchored,
      logCorroborated,
      hardWithholdUncorroborated: hardWithhold,
    })
    if (anchored) anchorable += 1
    if (disposition === "inline-clean") corroborated += 1
    if (disposition === "inline-hedged") hedged += 1
    if (disposition === "inline-clean" || disposition === "inline-hedged") {
      surviving.push({ finding, disposition })
    } else {
      withheld += 1
    }
  }

  if (surviving.length === 0) {
    return finishSkip(args, t0, candidates, anchorable, corroborated, hedged, withheld, "nothing-survived-gates", null)
  }

  // ── Dedup vs the prior review ───────────────────────────────────────────
  // Fingerprint-exact from posted inline comments (HARD drop); manifest
  // (path,headline) coarse key = a telemetered HINT only (recall-safety). The
  // idempotency scan reuses the inline-comment list — one read serves both.
  let priorComments: ReadonlyArray<{ body: string }>
  try {
    priorComments = await client.listPullRequestReviewComments(owner, repo, prNumber)
  } catch (err) {
    return finishSkip(args, t0, candidates, anchorable, corroborated, hedged, withheld, "dedup-check-failed", err)
  }
  const existing = await buildExistingReviewFindings(env, owner, repo, prNumber, priorComments)

  // Idempotency: if a CI-synth artifact already exists for THIS (headSha,runId),
  // we already posted for this run → skip (covers cross-delivery re-runs after
  // the KV dedupe-guard's 300s TTL). The marker is stamped on BOTH the inline
  // comment bodies (the primary check) AND the review body, so we scan both —
  // belt-and-suspenders in case a future change ever posts a comment-less review.
  const marker = ciRunMarker(headSha, runId)
  if (priorComments.some((c) => typeof c.body === "string" && c.body.includes(marker))) {
    return finishSkip(args, t0, candidates, anchorable, corroborated, hedged, withheld, "already-posted", null)
  }
  let priorReviews: ReadonlyArray<{ body: string }> = []
  try {
    priorReviews = await client.listPullRequestReviews(owner, repo, prNumber)
  } catch {
    // Review-list failure is non-fatal — the inline-comment scan above is the
    // primary idempotency guard. Proceed (a duplicate is bounded by the KV guard).
    priorReviews = []
  }
  if (priorReviews.some((r) => typeof r.body === "string" && r.body.includes(marker))) {
    return finishSkip(args, t0, candidates, anchorable, corroborated, hedged, withheld, "already-posted", null)
  }

  let dedupDropped = 0
  let coarseHints = 0
  const survivors: SurvivingCiFinding[] = []
  for (const { finding, disposition } of surviving) {
    // Compute the fingerprint BEFORE rendering so the comment carries the
    // `sigilix:fingerprint:` marker (which makes THIS CI finding dedup-able by
    // the next run / a dismissal).
    const contentFingerprint = await computeContentFingerprint(finding.category, finding.path, finding.body)
    const candidate = {
      contentFingerprint,
      coarseKey: ciFindingCoarseKey(finding.path, finding.headline),
    }
    if (matchesExistingCoarseKey(candidate, existing)) coarseHints += 1
    if (isDuplicateOfExistingReview(candidate, existing)) {
      dedupDropped += 1
      continue
    }
    survivors.push({ finding, disposition, contentFingerprint })
  }

  if (survivors.length === 0) {
    return finishSkip(args, t0, candidates, anchorable, corroborated, hedged, withheld, "all-deduped", null, {
      dedupDropped,
      coarseHints,
    })
  }

  // ── Shadow: telemeter what we WOULD post, post nothing ──────────────────
  if (mode === "shadow") {
    for (const s of survivors) emitDecision(args, s, "would-post")
    const summary: CiTriageSynthSummary = {
      candidates,
      anchorable,
      corroborated,
      hedged,
      withheld,
      dedupDropped,
      coarseHints,
      posted: 0,
      ultraCalled: true,
      skip: "shadow",
      elapsedMs: Date.now() - t0,
    }
    emitSummary(args, summary)
    return summary
  }

  // ── Enforce: post the grounded inline comments ──────────────────────────
  const comments: SubmitReviewComment[] = survivors.map((s) => ({
    path: s.finding.path,
    line: s.finding.line,
    side: "RIGHT",
    body: buildCommentBody(s, owner, repo, runId, headSha),
  }))
  const review: SubmitReviewBody = {
    body: `${CI_REVIEW_MARKER} ${ciRunMarker(headSha, runId)}\n_Sigilix · grounded CI-failure findings from run \`${runId}\`._`,
    event: "COMMENT",
    commit_id: headSha,
    comments,
  }

  const postResult = await submitCiSynthReview(client, owner, repo, prNumber, review)
  for (const s of survivors) emitDecision(args, s, postResult.posted > 0 ? "posted" : "post-failed")
  const summary: CiTriageSynthSummary = {
    candidates,
    anchorable,
    corroborated,
    hedged,
    withheld,
    dedupDropped,
    coarseHints,
    posted: postResult.posted,
    ultraCalled: true,
    skip: postResult.skip,
    elapsedMs: Date.now() - t0,
  }
  emitSummary(args, summary)
  return summary
}

/** True iff the parsed diff has at least one RIGHT-side reviewable position. */
function hasAnyRightPosition(reviewable: ReviewableMap): boolean {
  for (const positions of reviewable.values()) {
    if (positions.some((p) => p.side === "RIGHT")) return true
  }
  return false
}

/**
 * Build the inline comment body: Kimi's template (via `renderCiFindingComment`),
 * plus the dedup fingerprint marker and the (headSha,runId) idempotency marker.
 * Hedged findings prepend `CI_HEDGE_LINE` (handled inside `renderCiFindingComment`).
 */
function buildCommentBody(s: SurvivingCiFinding, owner: string, repo: string, runId: number, headSha: string): string {
  const presentation = {
    statement: s.finding.body,
    ...(s.finding.fixExample ? { fix: s.finding.fixExample } : {}),
    runId,
    runUrl: runUrl(owner, repo, runId),
  }
  const rendered = renderCiFindingComment(presentation, s.disposition === "inline-hedged")
  return [
    CI_REVIEW_MARKER,
    ciRunMarker(headSha, runId),
    `<!-- sigilix:fingerprint:${s.contentFingerprint} -->`,
    "",
    rendered,
  ].join("\n")
}

/**
 * Read the existing review's already-posted findings as the dedup predicate sees
 * them: fingerprint-exact from posted inline comments + coarse (path,headline)
 * keys rebuilt from the manifest's RAW path/headline (the manifest `key` itself
 * is a SHA, so we re-derive the coarse key with the SAME normalization the
 * candidate uses — `ciFindingCoarseKey`). Degrades to fingerprint-only when the
 * manifest is missing.
 */
async function buildExistingReviewFindings(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  priorComments: ReadonlyArray<{ body: string }>,
): Promise<ExistingReviewFindings> {
  const fingerprints = new Set<string>()
  for (const c of priorComments) {
    if (typeof c.body !== "string") continue
    const fp = parseFindingFingerprint(c.body)
    if (fp) fingerprints.add(fp)
  }

  const coarseKeys = new Set<string>()
  const manifest = await readReviewManifest(env, owner, repo, prNumber)
  if (manifest.kind === "ok") {
    for (const f of manifest.manifest.findings ?? []) {
      coarseKeys.add(ciFindingCoarseKey(f.path, f.headline))
    }
  }

  return { fingerprints, coarseKeys }
}

/**
 * Submit the COMMENT-event review with split-on-422 — mirrors
 * `submitCiSuggestionReview`: one bulk review, and on a 422 *validation* failure
 * (a bad anchor GitHub rejected) re-submit each comment alone so one bad anchor
 * only drops itself. Everything else fails fast. Never throws.
 */
async function submitCiSynthReview(
  client: CiSynthClient,
  owner: string,
  repo: string,
  prNumber: number,
  review: SubmitReviewBody,
): Promise<{ posted: number; skip: string | null }> {
  const comments = review.comments ?? []
  try {
    await client.submitReview(owner, repo, prNumber, review)
    return { posted: comments.length, skip: null }
  } catch (err) {
    const isAnchorValidation =
      err instanceof GitHubHttpError && err.status === 422 && /validation failed/i.test(err.message)
    if (!isAnchorValidation) {
      console.warn(
        JSON.stringify({
          event: "ci-triage-synth-submit-failed",
          owner,
          repo,
          prNumber,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      return { posted: 0, skip: "submit-failed" }
    }
    const results = await Promise.allSettled(
      comments.map((comment) =>
        client.submitReview(owner, repo, prNumber, {
          event: "COMMENT",
          ...(review.commit_id !== undefined ? { commit_id: review.commit_id } : {}),
          comments: [comment],
        }),
      ),
    )
    let posted = 0
    results.forEach((res, i) => {
      if (res.status === "fulfilled") {
        posted += 1
        return
      }
      const comment = comments[i]
      console.warn(
        JSON.stringify({
          event: "ci-triage-synth-anchor-unpostable",
          owner,
          repo,
          prNumber,
          path: comment?.path,
          line: comment?.line,
          err: res.reason instanceof Error ? res.reason.message : String(res.reason),
        }),
      )
    })
    const skip = posted === 0 ? "submit-failed" : posted === comments.length ? "split-recovered" : "partial"
    return { posted, skip }
  }
}

// ───────────────────────────── telemetry ───────────────────────────────────

function emitDecision(
  args: RunCiTriageSynthArgs,
  s: SurvivingCiFinding,
  outcome: "would-post" | "posted" | "post-failed",
): void {
  console.log(
    JSON.stringify({
      event: "ci-triage-synth-decision",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      runId: args.runId,
      headSha: args.headSha.slice(0, 7),
      mode: args.mode,
      path: s.finding.path,
      line: s.finding.line,
      score: s.finding.score,
      disposition: s.disposition,
      outcome,
    }),
  )
}

function emitSummary(args: RunCiTriageSynthArgs, summary: CiTriageSynthSummary): void {
  console.log(
    JSON.stringify({
      event: "ci-triage-synth-summary",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      runId: args.runId,
      headSha: args.headSha.slice(0, 7),
      mode: args.mode,
      ...summary,
    }),
  )
}

/** Build + emit a skip summary and return it. Keeps the early-exit paths tidy. */
function finishSkip(
  args: RunCiTriageSynthArgs,
  t0: number,
  candidates: number,
  anchorable: number,
  corroborated: number,
  hedged: number,
  withheld: number,
  skip: string,
  err: unknown,
  extra?: { dedupDropped: number; coarseHints: number },
): CiTriageSynthSummary {
  if (err != null) {
    console.warn(
      JSON.stringify({
        event: "ci-triage-synth-skip",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        runId: args.runId,
        skip,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  const summary: CiTriageSynthSummary = {
    candidates,
    anchorable,
    corroborated,
    hedged,
    withheld,
    dedupDropped: extra?.dedupDropped ?? 0,
    coarseHints: extra?.coarseHints ?? 0,
    posted: 0,
    ultraCalled: true,
    skip,
    elapsedMs: Date.now() - t0,
  }
  emitSummary(args, summary)
  return summary
}
