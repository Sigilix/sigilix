// PR-overview triage pipeline. Triggered by `pull_request` webhook on
// opened / synchronize / reopened — fetches the PR + diff + commits,
// asks Ollama Turbo for a structured overview, and posts (or PATCHes
// in place) a single sticky top-level comment.
//
// Ported from rema-portal/tools/openclaw/triage-pr-overview.mjs +
// lib/pr-overview.mjs. No filesystem, no gh CLI — everything goes
// through the GitHubClient.

import { generate } from "@/src/shared/adapters/model"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { GitHubClient } from "@/src/shared/adapters/github"
import type { PrChangedFile, PrCommit, PullRequestMeta } from "@/src/shared/types/github"
import { PR_OVERVIEW_SCHEMA } from "@/src/shared/domain/schemas"
import { PR_OVERVIEW_PROMPT } from "@/src/prompts/pr-overview"
import { readRepoIndexManifest } from "./repo-index-manifest"
import { loadSigilixConfig, resolvePreMergeGatesConfig } from "./sigilix-config"
import {
  CODEOWNERS_PATHS,
  mergeSuggestedReviewers,
  parseCodeowners,
  suggestedReviewersFromRules,
} from "./codeowners"
import {
  runPreMergeGates,
  type GateResult,
} from "@/src/shared/domain/pre-merge-gates"
import {
  batchReadFileCache,
  batchWriteFileCache,
} from "./pr-overview-file-cache"
import type { Env } from "@/src/shared/types/env"
// SIG-376 (SIG-318 Tier-1 6/8): the pure parse/transform, render, and
// comment-scan clusters were lifted into three sibling leaves to keep this
// file under the 1,000-line budget. The core imports what `handlePrOverview`
// / `buildPrompt` call and re-exports every previously-exported symbol that
// moved so importers + tests stay unchanged.
import {
  mergeCachedAndFreshRows,
  parseOverviewResponse,
  scopedDiffFromMisses,
} from "./triage-pr-overview-parse"
import {
  formatOverviewComment,
  renderReviewContextBlock,
  truncate,
} from "./triage-pr-overview-format"
import {
  deleteLegacyWarmupSticky,
  findExistingOverviewComment,
  scanComments,
} from "./triage-pr-overview-scan"

// SIG-376: re-export every symbol relocated into the leaves so external
// importers (`./index`, `./pr-overview-stub`, `./ensemble/app/publish`) and
// the unit tests continue to resolve them from `./triage-pr-overview`
// unchanged. `findExistingOverviewComment` is re-exported here (locally,
// not via `export … from`) because the core body also calls it.
export {
  mergeCachedAndFreshRows,
  parseOverviewResponse,
  scopedDiffFromMisses,
} from "./triage-pr-overview-parse"
export {
  formatOverviewComment,
  renderReviewContextBlock,
} from "./triage-pr-overview-format"
export {
  findExistingOverviewCommentId,
  LEGACY_OVERVIEW_MARKER,
  MAX_COMMENT_SCAN_PAGES,
  OVERVIEW_MARKER,
} from "./triage-pr-overview-scan"
export { findExistingOverviewComment }

const DEFAULT_MODEL = "glm-5.1:cloud"

const LIMITS = {
  prDiff: 28_000,
  prBody: 4_000,
  newCommitsBlock: 2_000,
}
const CODEOWNERS_MAX_BYTES = 3 * 1024 * 1024

export interface PrOverviewVerdict {
  summary: string
  files: Array<{ path: string; score: number; overview: string; nextStep: string }>
  confidence: number
  confidenceReason: string
  bullets: string[]
  /**
   * SIG-99 polish fields — all optional + back-compat. The parser
   * clamps each independently; renderer omits the section when
   * absent. Models trained against the older prompt that don't know
   * these fields simply leave them undefined.
   *
   * - `reviewEffort` (1-5): drives a `**Effort:** N/5` badge under the
   *   heading. Independent of `confidence` — a safe-to-merge change
   *   can still demand careful reading.
   * - `suggestedLabels`: 0-3 GitHub label names. Renders as a
   *   `\`label1\` \`label2\`` line. Hooks into `customLabels` config
   *   (SIG-90) when the operator wants filtering.
   * - `suggestedReviewers`: 0-2 GitHub usernames. Rendered as
   *   `@user1, @user2` so GitHub notifies them.
   * - `relatedPrUrls`: 0-3 URLs. Stays empty until SIG-44 (multi-
   *   corpus retrieval) feeds prior-PR context into the prompt;
   *   shipped now so the schema + renderer are in place for the
   *   retrieval-side enablement.
   * - `mermaidDiagram`: an inline Mermaid `sequenceDiagram` block.
   *   GitHub renders fenced ```mermaid blocks natively.
   */
  reviewEffort?: number
  suggestedLabels?: string[]
  suggestedReviewers?: string[]
  relatedPrUrls?: string[]
  mermaidDiagram?: string
}

/**
 * SIG-216: review-time context passed in by `handlePrReviewEnsemble`
 * when the overview is being rendered inline with the review post.
 * When present, the prompt builder appends a short paragraph informing
 * the model of the review's findings so the overview body can reflect
 * the verdict ("3 P1 + 2 P2 concerns surfaced" vs the generic
 * review-independent framing). Omitted by warmup-driven enqueues and
 * any other path that runs the overview without an associated review
 * — those fall back to the pre-SIG-216 prompt.
 */
export interface PrOverviewReviewContext {
  findingsCount: number
  severityBreakdown: Record<string, number>
  categoryBreakdown: Record<string, number>
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
}

export interface PrOverviewArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  env: Env
  /**
   * ARC-258 follow-up: when set, the dedupe-key check below is
   * skipped. Used by the pr-review success path to force a fresh
   * overview render after a review completes — without this flag,
   * the per-(PR, headSha) dedupe (set by the initial pr-overview
   * run earlier in the same headSha) would suppress the refresh.
   * Webhook-driven calls omit this flag and keep dedupe intact.
   *
   * SIG-216: under the new ordering the ensemble passes `force: true`
   * + a `reviewContext` together so the inline-from-review render
   * bypasses any KV lock a prior queued run may have set.
   */
  force?: boolean
  /**
   * SIG-216: optional review-time finding context. When present, the
   * prompt builder appends a paragraph summarizing the review's
   * verdict + finding mix so the overview body can be informed by
   * what the review actually surfaced. Absent → existing
   * review-independent prompt (back-compat for warmup-driven and any
   * legacy queue-dispatched overview runs).
   */
  reviewContext?: PrOverviewReviewContext
  /**
   * SIG-216 fix-up: bypass the per-(PR, headSha) KV dedupe lock
   * WITHOUT bypassing the stale-head guards. Used by the inline-from-
   * review path so a sibling queued run's lock can't block us, while
   * still aborting if the head moves during the Ollama window. Prefer
   * this over `force` for new callers — `force` bypasses both, which
   * is only correct for the legacy review-success refresh path that
   * has already been validated against the live head.
   */
  skipDedupe?: boolean
  /**
   * SIG-216 fix-up: optional external abort signal threaded through
   * to the Ollama `generate` call. The inline-overview retry helper
   * passes a per-attempt controller so the first attempt's in-flight
   * fetch can actually be cancelled when the second attempt fires
   * (otherwise overlapping attempts burn budget against the same
   * deadline). Absent on queue-driven calls.
   */
  abortSignal?: AbortSignal
}

const DEDUPE_PREFIX = "pr-overview:"
const DEDUPE_TTL_SECONDS = 300

export async function handlePrOverview(args: PrOverviewArgs): Promise<void> {
  const {
    owner,
    repo,
    prNumber,
    headSha,
    installationId,
    env,
    force,
    reviewContext,
    skipDedupe,
    abortSignal,
  } = args
  // SIG-216 fix-up: `force` historically bypassed BOTH the KV dedupe
  // lock AND the in-handler stale-head guards. We've split those
  // semantics: `skipDedupe` (preferred for the inline-from-review
  // path) bypasses only the dedupe lock; `force` (kept for legacy
  // queue-driven post-review refresh callers) still bypasses both.
  // `bypassDedupe` is the union — read at every dedupe-lock site.
  const bypassDedupe = skipDedupe === true || force === true
  const t0 = Date.now()
  const since = (label: string): void => {
    console.log(`[pr-overview] ${label} +${Date.now() - t0}ms`, {
      owner,
      repo,
      prNumber,
      headSha: headSha.slice(0, 7),
    })
  }

  since("start")

  // Concurrent-run guard. Two pull_request webhooks fired in quick
  // succession on the same head SHA would otherwise both reach the
  // listIssueComments → no-marker branch and POST a duplicate top-level
  // comment. Keyed on (prNumber, headSha) so a new push (different SHA)
  // still runs again as expected. Released on any exit path via the
  // try/finally below — queue retries can re-attempt without being
  // blocked by a stale lock.
  const dedupeKey = `${DEDUPE_PREFIX}${owner}/${repo}#${prNumber}@${headSha}`
  // ARC-258 follow-up + SIG-216 fix-up: `bypassDedupe` (set by
  // `skipDedupe: true` from the inline-from-review path OR
  // `force: true` from the legacy refresh path) skips the dedupe
  // lock check + write so a sibling queued run's lock can't
  // suppress the refresh. Webhook-driven enqueues set neither and
  // keep the duplicate-comment guard intact.
  if (!bypassDedupe && (await env.OPENCLAW_STATE.get(dedupeKey))) {
    console.log(JSON.stringify({
      event: "pr-overview-skipped",
      dedupe_system: "kv",
      reason: "already_running",
      owner, repo, prNumber, headSha: headSha.slice(0, 7),
    }))
    return
  }
  if (!bypassDedupe) {
    await env.OPENCLAW_STATE.put(dedupeKey, String(Date.now()), {
      expirationTtl: DEDUPE_TTL_SECONDS,
    })
  }

  try {
    const client = await buildClient(env, installationId)
    since("auth-ready")

    // CodeRabbit catch round-2 on PR #81: track `listPullRequestFiles`
    // failure explicitly. When this rejects, we can't compute per-file
    // patch hashes → `missedFiles` ends up empty → the new all-hit
    // short-circuit in `scopedDiffFromMisses` would emit the placeholder
    // ("all served from cache") even though we have zero cache hits
    // and a real diff is available. The fix: pass through `diff` as
    // the prompt diff when file-list fetch failed.
    let listFilesFailed = false
    const [meta, diff, commits, files] = await Promise.all([
      client.getPullRequest(owner, repo, prNumber),
      client.getPullRequestDiff(owner, repo, prNumber),
      client.getPullRequestCommits(owner, repo, prNumber).catch(() => [] as PrCommit[]),
      // ARC-263: per-file patches power the walkthrough cache. The
      // default `maxFiles: 50` would silently drop files 51+ from
      // the cache (code-reviewer H1 catch) — those would never
      // appear as misses, never get a row, never get cached, AND
      // would incorrectly trigger all-hit short-circuits. Raise to
      // 300 (GitHub's hard cap for the /files endpoint is 3000;
      // 300 covers all realistic PRs while keeping per-page paging
      // fast). A failure here degrades to an empty array — review
      // quality preserved; we fall back to the full diff (tracked
      // via `listFilesFailed` so the scoped-diff helper isn't fooled
      // into emitting the all-hit placeholder).
      client.listPullRequestFiles(owner, repo, prNumber, { maxFiles: 300 }).catch((err) => {
        listFilesFailed = true
        console.warn(JSON.stringify({
          event: "pr-overview-list-files-failed",
          owner, repo, prNumber,
          err: err instanceof Error ? err.message : String(err),
        }))
        return [] as PrChangedFile[]
      }),
    ])
    since("pr-fetched")

    // SIG-100: run deterministic pre-merge quality gates (no model).
    // Inputs come from `meta` + `commits`, both already in scope.
    // Loaded config can be EMPTY_CONFIG (no sigilix.json on the PR)
    // — `resolvePreMergeGatesConfig` fills in the locked defaults.
    // Best-effort: a config-load failure falls through to default
    // gate behavior; we don't block the overview render on it.
    let gateResults: GateResult[] = []
    try {
      const sigilixConfig = await loadSigilixConfig(client, owner, repo, headSha)
      const gatesConfig = resolvePreMergeGatesConfig(sigilixConfig.preMergeGates)
      gateResults = runPreMergeGates(
        {
          prTitle: meta.title ?? "",
          prBody: meta.body ?? "",
          commitMessages: commits.map((c) => c.message),
        },
        gatesConfig,
      )
      for (const r of gateResults) {
        console.log(JSON.stringify({
          event: "pr-overview-pre-merge-gate-result",
          gate: r.id,
          passed: r.passed,
          severity: r.severity,
          owner, repo, prNumber, head_sha: headSha.slice(0, 7),
        }))
      }
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pr-overview-pre-merge-gates-failed",
        err: err instanceof Error ? err.message : String(err),
        owner, repo, prNumber,
      }))
    }

    // ─── SIG-84: stale-head guard #1 (pre-Ollama) ───────────────────
    //
    // The pr-overview job carries the headSha that fired the webhook.
    // If a NEW commit landed while this job sat in the queue (or
    // during the `getPullRequest` round-trip), the LIVE PR head differs
    // from `headSha`. Letting this run continue would:
    //   1. burn ~30s of Ollama time on a snapshot the user has already
    //      superseded,
    //   2. then OVERWRITE the new head's stub `_Reviewing…_` body back
    //      to the OLD head's walkthrough — exactly what SIG-84 is
    //      trying to prevent (the overview comment moving backwards).
    //
    // Mirrors the pattern at `triage-pr-review-ensemble.ts:864`.
    // `force === true` callers (legacy post-review refresh) bypass:
    // that path is fired by the review SUCCESS handler with the
    // live head SHA already in hand, and the goal there is to drop
    // the stale warmup callout from the most-recent overview.
    // SIG-216 fix-up: the inline-from-review path now uses
    // `skipDedupe: true` (not `force`), so this guard FIRES on the
    // inline path — catching head moves that landed during the
    // review's own Ollama window. The ensemble's post-overview
    // re-check is the belt-and-braces layer that catches moves
    // landing AFTER this overview call returns.
    if (!force && meta.head?.sha && meta.head.sha !== headSha) {
      console.log(JSON.stringify({
        event: "pr-overview-stale-head-before-ollama",
        owner, repo, prNumber,
        queued_head_sha: headSha.slice(0, 7),
        current_head_sha: meta.head.sha.slice(0, 7),
      }))
      // SIG-237: unified skipped-with-reason event.
      console.log(JSON.stringify({
        event: "pr-overview-skipped-with-reason",
        reason: "stale_head_before_ollama",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        current_head_sha: meta.head.sha.slice(0, 7),
      }))
      return
    }

    const codeownersRef = meta.base?.sha
    if (!codeownersRef) {
      console.warn(JSON.stringify({
        event: "pr-overview-codeowners-no-base-ref",
        owner, repo, prNumber,
      }))
    }
    const codeownersReviewers = codeownersRef
      ? await resolveCodeownersSuggestedReviewers({
        client,
        owner,
        repo,
        prNumber,
        ref: codeownersRef,
        changedPaths: files.map((f) => f.filename),
        prAuthor: meta.user?.login ?? null,
      })
      : []

    // ARC-263: walkthrough cache lookup. For each changed file, look
    // up `(filename, patch-sha256)` in KV. Hits reuse the cached
    // per-file row; misses go through Ollama. The cumulative
    // `summary` / `confidence` / `bullets` regenerate on every run
    // — they're PR-level state, not file-local. Best-effort
    // throughout: cache failures behave like misses.
    //
    // Note: we DO NOT short-circuit on cache-all-hit. Earlier draft
    // returned early when every file's row was cached, but the
    // code-reviewer pass on commit 1 caught two failure modes:
    //   (a) warmup callout transitions (indexer-completion rerun
    //       fires `handlePrOverview` with the manifest now present;
    //       all files hit cache → callout would stick forever)
    //   (b) legacy `<!-- sigilix:warmup -->` sticky migration delete
    //       (one-way migration runs only after a successful overview
    //       write; a quiet PR would keep the legacy sticky forever).
    // The cost of always running Ollama is bounded — the scoped
    // diff feeds 0 patches to the model on an all-hit run, so input
    // tokens are minimal; output tokens are 0 fresh rows (just the
    // cumulative summary/bullets/confidence).
    const { hits: cachedRows, misses: missedFiles } = await batchReadFileCache({
      env, owner, repo, prNumber, files,
    })
    since("cache-checked")

    // Telemetry: cache hit-ratio for observability (code-reviewer M4
    // catch). Lets us answer "is the cache actually helping?" in
    // production without re-instrumenting.
    if (files.length > 0) {
      console.log(JSON.stringify({
        event: "pr-overview-cache-checked",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        file_count: files.length,
        hits: cachedRows.size,
        misses: missedFiles.length,
        hit_ratio: Math.round((cachedRows.size / files.length) * 100) / 100,
      }))
    }

    // Build a scoped diff containing ONLY missed files' patches. The
    // model still sees commit messages + PR title/body for cumulative
    // context, but per-file token cost drops by the cache-hit ratio.
    // If we don't have per-file patches (older API path or list call
    // failed), fall back to the full diff so the review still runs.
    // When `listFilesFailed` is true we MUST use the full diff —
    // `missedFiles=[]` would otherwise hit the all-hit placeholder
    // path and the model would see no real diff context.
    const promptDiff = listFilesFailed
      ? diff
      : scopedDiffFromMisses(missedFiles, diff)

    // Pre-Ollama marker scan. Used to pick the prompt's "first run vs
    // incremental" framing. The post-Ollama re-check below is the source
    // of truth for the POST-vs-PATCH decision (closes the race window
    // where a sibling Worker posts the marker while we're waiting on the
    // model).
    //
    // ARC-258 follow-up: the same scan also surfaces any legacy
    // standalone `<!-- sigilix:warmup -->` sticky from before the
    // unification. We delete it after the successful overview write
    // — caching its id here avoids a third `listIssueComments` round
    // trip that would otherwise contradict the race-test invariants.
    const initialScan = await scanComments(client, owner, repo, prNumber)
    const existingBeforeModel = initialScan.overviewId
    let legacyWarmupId: number | null = initialScan.legacyWarmupId
    since("dedupe-checked")

    // For incremental runs we only show the most recent commits (matches the
    // upstream `commits[-10:]` slice). First-run gets the same window — the
    // prompt says "summarize the whole change" and the diff carries the full
    // story in either case.
    const recentCommits = commits.slice(-10)

    const prompt = buildPrompt({
      prNumber,
      meta,
      diff: promptDiff,
      newCommits: recentCommits,
      isFirstRun: existingBeforeModel == null,
      ...(reviewContext ? { reviewContext } : {}),
    })

    const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    since("ollama-start")
    // SIG-216 fix-up: thread the optional external abort signal into
    // the Ollama call so the inline-overview retry helper can cancel
    // the in-flight first attempt before launching the second.
    const { text: response } = await generate({
      model,
      prompt,
      apiKey: env.OLLAMA_API_KEY,
      format: PR_OVERVIEW_SCHEMA as unknown as Record<string, unknown>,
      ...(abortSignal ? { signal: abortSignal } : {}),
    })
    since("ollama-done")

    const verdict = parseOverviewResponse(response)
    if (!verdict) {
      // SIG-237: surface this as a structured event so on-call can
      // grep `pr-overview-skipped-with-reason` for every silent
      // stub-stays-stuck case. The previous `console.error` printed
      // to logs but wasn't queryable as a structured event.
      //
      // CR catch (PR #192): the `responseHead` field intentionally
      // omitted — the Ollama response can contain repo / diff /
      // source-code content from the prompt, and shipping it into
      // structured telemetry would leak customer code into
      // Cloudflare Logs. `responseLength` alone is enough to size
      // the failure mode; the actual content can be retrieved via
      // `console.error` line below if needed for one-off debugging.
      console.log(JSON.stringify({
        event: "pr-overview-skipped-with-reason",
        reason: "verdict_parse_failed",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        responseLength: response.length,
      }))
      return
    }
    const modelReviewers = excludePrAuthor(verdict.suggestedReviewers, meta.user?.login ?? null)
    const suggestedReviewers = mergeSuggestedReviewers(codeownersReviewers, modelReviewers)
    if (suggestedReviewers) {
      verdict.suggestedReviewers = suggestedReviewers
    } else {
      delete verdict.suggestedReviewers
    }

    // Stage 1 race mitigation (ARC-231). KV remains advisory — Cloudflare
    // KV is eventually consistent across regions, so two Workers can both
    // observe an empty `dedupeKey` and both reach this code path. If we
    // started with no marker visible, re-scan the comments now to see
    // whether a sibling Worker posted one during the 10-30s Ollama window.
    // The final write branches on this late value: PATCH-in-place if found,
    // POST otherwise. Stage 2 (durable serialization mirroring ARC-190's
    // PrReviewRunDO) is tracked separately.
    let existingForWrite = existingBeforeModel
    if (existingForWrite == null) {
      const reScan = await scanComments(client, owner, repo, prNumber)
      existingForWrite = reScan.overviewId
      // Late scan may surface a legacy warmup we missed before (or
      // confirm it's already gone). Update the cached id either way.
      legacyWarmupId = reScan.legacyWarmupId
      if (existingForWrite != null) {
        console.log(JSON.stringify({
          event: "pr-overview-second-pass-dedupe-fired",
          owner, repo, prNumber,
          headSha: headSha.slice(0, 7),
          foundCommentId: existingForWrite,
        }))
      }
    }

    // ARC-258 follow-up: unify warmup + overview into a single sticky.
    // Read the index manifest right before rendering the body — if
    // it's absent, the warmup callout shows at the top of the overview.
    // Once indexing completes, `enqueueWarmupRerunsForIndex` re-fires
    // pr-overview, which re-runs through here with manifest present,
    // edits the existing comment in place, and the callout disappears.
    // Best-effort: a KV failure here defaults to `warmup: "none"` — we'd
    // rather omit the callout on a transient KV blip than fail the
    // overview post.
    let warmup: "pending" | "none" = "none"
    try {
      const manifest = await readRepoIndexManifest(env, owner, repo)
      if (manifest.kind !== "ok") warmup = "pending"
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pr-overview-manifest-read-failed",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        err: err instanceof Error ? err.message : String(err),
      }))
    }

    // ARC-263: merge cached rows with the model's fresh rows. The
    // model emits rows only for missed files (scoped diff). Cached
    // rows fill in the unchanged files so the "Important files"
    // table reflects cumulative PR state, not just this push's
    // delta. Top-5 by score truncation happens inside the merge so
    // the rendered comment stays concise even when total rows > 5.
    const verdictForDisplay = mergeCachedAndFreshRows(verdict, cachedRows)

    // Build the body AFTER the late re-check so a late-discovered marker
    // renders as an incremental "— latest push" update, not a fresh
    // first-run summary.
    const body = formatOverviewComment({
      verdict: verdictForDisplay,
      isFirstRun: existingForWrite == null,
      warmup,
      // SIG-100: thread gate results through to the renderer. Always
      // pass — the formatter checks for an empty array internally and
      // skips the section.
      gateResults,
    })

    // ─── SIG-84: stale-head guard #2 (pre-write) ────────────────────
    //
    // Re-check the PR head right before the write. The Ollama call took
    // 10-30s; a new commit may have landed in that window. Without
    // this, the OLD head's walkthrough would overwrite the NEW head's
    // already-rendered walkthrough (if the new head's overview
    // happened to complete first), moving the comment backwards from
    // the customer's perspective. SIG-216 drop-the-stub pattern: there
    // is no longer a pre-review stub at webhook time to clobber, but
    // the head-moved-during-Ollama race against a sibling overview run
    // remains. Cheap (one extra `getPullRequest` round-trip) and
    // bounded to the path that actually writes — `force`-mode callers
    // bypass since they're invoked by the ensemble on the live head
    // (already guarded by the ensemble's stale-head guard #2).
    // SIG-216 fix-up: the inline-from-review path now uses
    // `skipDedupe: true` (not `force`), so this guard fires on it
    // too — catching head moves between Ollama-done and the comment
    // write. The ensemble adds a third re-check after this whole
    // call returns (post-overview), so all three Ollama windows
    // (review specialists', overview's, and the gap between) are
    // covered.
    if (!force) {
      try {
        const metaCheck = await client.getPullRequest(owner, repo, prNumber)
        if (metaCheck.head?.sha && metaCheck.head.sha !== headSha) {
          console.log(JSON.stringify({
            event: "pr-overview-stale-head-before-write",
            owner, repo, prNumber,
            queued_head_sha: headSha.slice(0, 7),
            current_head_sha: metaCheck.head.sha.slice(0, 7),
          }))
          // SIG-237: also emit the unified skipped-with-reason event
          // so the dashboard can count stub-stays-stuck cases in a
          // single query rather than joining several event names.
          console.log(JSON.stringify({
            event: "pr-overview-skipped-with-reason",
            reason: "stale_head_before_write",
            owner, repo, prNumber, headSha: headSha.slice(0, 7),
          }))
          return
        }
      } catch (err) {
        // CodeRabbit #1 (PR #104, Major): fail CLOSED on a re-check
        // error. Previously this catch fell through to the write —
        // but that opens a race where the head DID move during
        // Ollama and we can't confirm because GitHub is flaky.
        // Writing on uncertain head state is exactly what the guard
        // is meant to prevent (we'd overwrite the newer head's stub /
        // walkthrough with the older head's content). Aborting here
        // costs us one missed overview render at most — GitHub
        // redelivery / next push will re-enter and produce a fresh
        // overview on the live head.
        console.warn(JSON.stringify({
          event: "pr-overview-stale-recheck-failed-aborted",
          owner, repo, prNumber,
          queued_head_sha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
        }))
        // SIG-237: unified skipped-with-reason event.
        console.log(JSON.stringify({
          event: "pr-overview-skipped-with-reason",
          reason: "stale_recheck_failed",
          owner, repo, prNumber, headSha: headSha.slice(0, 7),
          err: err instanceof Error ? err.message : String(err),
        }))
        return
      }
    }

    if (existingForWrite != null) {
      await client.updateIssueComment(owner, repo, existingForWrite, body)
      since("comment-updated")
      console.log(
        `pr-overview updated on ${owner}/${repo}#${prNumber} (confidence=${verdict.confidence}/5, ${verdict.files.length} files, warmup=${warmup})`
      )
    } else {
      // SIG-216 CR fix-up: read-after-write idempotency. The
      // `runInlineOverviewWithRetry` path may retry after a transient
      // `createIssueComment` failure where the comment DID write
      // server-side but the response failed (network hiccup,
      // GitHub 5xx after commit). With `skipDedupe: true` the KV
      // dedupe lock is bypassed, and the post-Ollama re-scan above
      // races against KV / list-comments propagation — a marker
      // written ~milliseconds ago by attempt #1 may not yet show
      // up in attempt #2's `listIssueComments` snapshot. One final
      // targeted rescan immediately before the POST catches that
      // case: if the marker exists, switch to PATCH instead of
      // double-posting.
      const finalRescan = await findExistingOverviewComment(client, owner, repo, prNumber)
      if (finalRescan?.id != null) {
        console.log(JSON.stringify({
          event: "pr-overview-final-rescan-found-marker",
          owner,
          repo,
          prNumber,
          headSha: headSha.slice(0, 7),
          foundCommentId: finalRescan.id,
        }))
        await client.updateIssueComment(owner, repo, finalRescan.id, body)
        since("comment-updated")
        console.log(
          `pr-overview updated on ${owner}/${repo}#${prNumber} (confidence=${verdict.confidence}/5, ${verdict.files.length} files, warmup=${warmup}, via=final-rescan)`
        )
      } else {
        const created = await client.createIssueComment(owner, repo, prNumber, body)
        since("comment-created")
        console.log(
          `pr-overview created on ${owner}/${repo}#${prNumber} as comment ${created.id} (confidence=${verdict.confidence}/5, ${verdict.files.length} files, warmup=${warmup})`
        )
      }
    }

    // ARC-263: write fresh per-file rows to the cache. The misses
    // came from `batchReadFileCache` above — Ollama (hopefully) emitted
    // matching rows; we look them up by path. Best-effort; isolated
    // per-row write failures don't break the overview.
    const writeResult = await batchWriteFileCache({
      env, owner, repo, prNumber,
      misses: missedFiles,
      rows: verdict.files,
    })
    // Telemetry: surfaces silent model-prompt drift (code-reviewer
    // M1 catch). When `written` < missed files with patches, the
    // model failed to emit a row for some misses — those files
    // will re-Ollama on every subsequent push until the model
    // catches up. Production rollout can grep this event to tune
    // the prompt.
    const missedWithPatch = missedFiles.filter((f) => typeof f.patch === "string" && f.patch.length > 0).length
    if (missedWithPatch !== writeResult.written) {
      console.warn(JSON.stringify({
        event: "pr-overview-cache-write-drift",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        expected_writes: missedWithPatch,
        actual_writes: writeResult.written,
        model_emitted_rows: verdict.files.length,
      }))
    }

    // ARC-258 follow-up: one-way migration. Delete the legacy
    // standalone `<!-- sigilix:warmup -->` sticky if our cached scan
    // found one — its content is now inside the overview body.
    // Reusing the cached id avoids another `listIssueComments`
    // round-trip (also keeps the ARC-231 race tests happy — they
    // assert specific call counts).
    if (legacyWarmupId !== null) {
      await deleteLegacyWarmupSticky(client, owner, repo, prNumber, legacyWarmupId)
    }
  } finally {
    // Always release the dedupe lock — even on failure — so the queue's
    // retry can attempt again. Without this, the first failure leaves
    // a 5-min lock that blocks every retry until it expires.
    //
    // Bypass-mode runs (force OR skipDedupe) don't set the lock above,
    // so don't release it either — we'd risk stomping a sibling
    // non-bypass run's lock.
    if (!bypassDedupe) {
      await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})
    }
  }
}

async function resolveCodeownersSuggestedReviewers(args: {
  client: GitHubClient
  owner: string
  repo: string
  prNumber: number
  ref: string
  changedPaths: readonly string[]
  prAuthor: string | null
}): Promise<string[]> {
  if (args.changedPaths.length === 0) return []

  for (const path of CODEOWNERS_PATHS) {
    let text: string | null | undefined
    try {
      text = await args.client.getFileContent(args.owner, args.repo, path, args.ref)
    } catch (err) {
      // `getFileContent` returns null for 404. A throw means the
      // higher-precedence file may exist but could not be read, so fail
      // closed instead of falling through to a lower-precedence path.
      console.warn(JSON.stringify({
        event: "pr-overview-codeowners-fetch-failed",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        path,
        ref: args.ref.slice(0, 12),
        err: err instanceof Error ? err.message : String(err),
      }))
      return []
    }
    if (typeof text !== "string") continue

    if (new TextEncoder().encode(text).length > CODEOWNERS_MAX_BYTES) {
      console.warn(JSON.stringify({
        event: "pr-overview-codeowners-skipped",
        reason: "too_large",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        path,
      }))
      return []
    }

    const parsed = parseCodeowners(text)
    const reviewers = suggestedReviewersFromRules(parsed.rules, args.changedPaths, {
      exclude: args.prAuthor ? [args.prAuthor] : [],
      limit: 2,
    })
    console.log(JSON.stringify({
      event: "pr-overview-codeowners-resolved",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      path,
      changed_files: args.changedPaths.length,
      rules: parsed.rules.length,
      skipped: parsed.skipped.length,
      reviewers: reviewers.length,
    }))
    return reviewers
  }

  return []
}

function excludePrAuthor(reviewers: readonly string[] | undefined, prAuthor: string | null): string[] | undefined {
  if (!reviewers || reviewers.length === 0 || !prAuthor) return reviewers ? [...reviewers] : undefined
  const author = prAuthor.toLowerCase()
  const filtered = reviewers.filter((reviewer) => reviewer.trim().replace(/^@/u, "").toLowerCase() !== author)
  return filtered.length > 0 ? filtered : undefined
}

export interface PromptCtx {
  prNumber: number
  meta: PullRequestMeta
  diff: string
  newCommits: PrCommit[]
  isFirstRun: boolean
  /**
   * SIG-216: when this overview run is paired with a review post,
   * the ensemble passes the verdict + finding mix so the prompt can
   * tell the model what the reviewer concluded. Absent on
   * review-independent runs (warmup-driven, etc.).
   */
  reviewContext?: PrOverviewReviewContext
}

export function buildPrompt(ctx: PromptCtx): string {
  const commitsBlock = ctx.newCommits
    .map((c) => `- ${c.sha?.slice(0, 7) ?? "?"} ${c.message?.split("\n")[0] ?? ""}`)
    .join("\n")

  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    PR_OVERVIEW_PROMPT.trim(),
    "",
    "[PR SCOPE]",
    `Number: #${ctx.prNumber}`,
    `Title: ${ctx.meta.title}`,
    "Body:",
    truncate(ctx.meta.body ?? "(no description)", LIMITS.prBody),
    "",
    ctx.isFirstRun
      ? "[RECENT COMMITS — context for the first overview; the [DIFF] section below is the full change to summarize]"
      : "[NEW COMMITS — only summarize what's been pushed since the previous overview]",
    truncate(commitsBlock, LIMITS.newCommitsBlock),
    "",
    "[DIFF]",
    truncate(ctx.diff, LIMITS.prDiff),
    "",
  ]
  if (ctx.reviewContext) {
    sections.push(
      "[REVIEW VERDICT — Sigilix's specialist review of this same head is being posted alongside your overview. Weave the findings into your summary so the two comments land as one coherent signal; do NOT enumerate the findings (the reviewer can read them inline).]",
      renderReviewContextBlock(ctx.reviewContext),
      "",
    )
  }
  sections.push(
    "[OUTPUT]",
    "Return only the JSON object. No prose, no Markdown fence, no array.",
  )
  return sections.join("\n")
}

async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be configured")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}
