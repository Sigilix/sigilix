// PR-overview triage pipeline. Triggered by `pull_request` webhook on
// opened / synchronize / reopened — fetches the PR + diff + commits,
// asks Ollama Turbo for a structured overview, and posts (or PATCHes
// in place) a single sticky top-level comment.
//
// Ported from rema-portal/tools/openclaw/triage-pr-overview.mjs +
// lib/pr-overview.mjs. No filesystem, no gh CLI — everything goes
// through the GitHubClient.

import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import { GitHubClient, type PrChangedFile, type PrCommit, type PullRequestMeta } from "./github"
import { parseFirstJsonObject } from "./json-extract"
import { PR_OVERVIEW_SCHEMA } from "./schemas"
import { PR_OVERVIEW_PROMPT } from "../prompts/pr-overview"
import { readRepoIndexManifest } from "./repo-index-manifest"
import { LEGACY_WARMUP_MARKER, WARMUP_CALLOUT_MARKER } from "./warmup"
import {
  batchReadFileCache,
  batchWriteFileCache,
  type CachedFileRow,
} from "./pr-overview-file-cache"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const OVERVIEW_MARKER = "<!-- sigilix:pr-overview -->"
// SIG-85: bilingual matcher for the openclaw→sigilix rebrand. Read both
// markers so the existing-comment lookup finds legacy stickies and
// edits them in place instead of creating duplicates. Drop the legacy
// half once all pre-2026-05-18 PRs close.
const LEGACY_OVERVIEW_MARKER = "<!-- openclaw:pr-overview -->"

const LIMITS = {
  prDiff: 28_000,
  prBody: 4_000,
  newCommitsBlock: 2_000,
}

export interface PrOverviewVerdict {
  summary: string
  files: Array<{ path: string; score: number; overview: string; nextStep: string }>
  confidence: number
  confidenceReason: string
  bullets: string[]
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
   */
  force?: boolean
}

const DEDUPE_PREFIX = "pr-overview:"
const DEDUPE_TTL_SECONDS = 300

export async function handlePrOverview(args: PrOverviewArgs): Promise<void> {
  const { owner, repo, prNumber, headSha, installationId, env, force } = args
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
  // ARC-258 follow-up: `force === true` bypasses the dedupe so the
  // pr-review success path can refresh the overview within the
  // same headSha (the initial run's 5-min lock would otherwise
  // suppress the refresh). Webhook-driven enqueues omit `force`
  // and keep the duplicate-comment guard intact.
  if (!force && (await env.OPENCLAW_STATE.get(dedupeKey))) {
    console.log(JSON.stringify({
      event: "pr-overview-skipped",
      dedupe_system: "kv",
      reason: "already_running",
      owner, repo, prNumber, headSha: headSha.slice(0, 7),
    }))
    return
  }
  if (!force) {
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
    })

    const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    since("ollama-start")
    const response = await generate({
      model,
      prompt,
      apiKey: env.OLLAMA_API_KEY,
      format: PR_OVERVIEW_SCHEMA as unknown as Record<string, unknown>,
    })
    since("ollama-done")

    const verdict = parseOverviewResponse(response)
    if (!verdict) {
      console.error("pr-overview verdict did not parse", {
        owner,
        repo,
        prNumber,
        responseLength: response.length,
      })
      return
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
      const manifest = await readRepoIndexManifest(env, repo)
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
    })

    if (existingForWrite != null) {
      await client.updateIssueComment(owner, repo, existingForWrite, body)
      since("comment-updated")
      console.log(
        `pr-overview updated on ${owner}/${repo}#${prNumber} (confidence=${verdict.confidence}/5, ${verdict.files.length} files, warmup=${warmup})`
      )
    } else {
      const created = await client.createIssueComment(owner, repo, prNumber, body)
      since("comment-created")
      console.log(
        `pr-overview created on ${owner}/${repo}#${prNumber} as comment ${created.id} (confidence=${verdict.confidence}/5, ${verdict.files.length} files, warmup=${warmup})`
      )
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
    // Force-mode runs don't set the lock (see above), so don't release
    // it either — we'd risk stomping a sibling non-force run's lock.
    if (!force) {
      await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})
    }
  }
}

interface PromptCtx {
  prNumber: number
  meta: PullRequestMeta
  diff: string
  newCommits: PrCommit[]
  isFirstRun: boolean
}

function buildPrompt(ctx: PromptCtx): string {
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
    "[OUTPUT]",
    "Return only the JSON object. No prose, no Markdown fence, no array.",
  ]
  return sections.join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

/**
 * Parse the model's overview response into a typed verdict. Tolerates:
 *   1. Clean JSON object
 *   2. JSON wrapped in a ```json ... ``` fence
 *   3. JSON embedded in surrounding prose ("Here's the overview: { ... }")
 *
 * Returns null when the output contains no valid JSON object that has
 * the required shape, so callers can fail loudly rather than post junk.
 */
export function parseOverviewResponse(text: string): PrOverviewVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

  const confidence = Number(obj.confidence)
  if (!Number.isFinite(confidence) || confidence < 1 || confidence > 5) return null

  // ARC-263: keep all per-file rows (was capped at 5 here). The
  // schema's `maxItems: 20` is the bound; the renderer truncates to
  // top-5 by score for display.
  const files = Array.isArray(obj.files)
    ? obj.files
        .filter(
          (f): f is Record<string, unknown> =>
            !!f && typeof f === "object" && !Array.isArray(f) && typeof (f as { path?: unknown }).path === "string"
        )
        .filter((f) => (f.path as string).trim().length > 0)
        .slice(0, 20)
        .map((f) => ({
          path: (f.path as string).trim(),
          score: Number.isFinite(Number(f.score))
            ? Math.max(1, Math.min(5, Math.round(Number(f.score))))
            : 3,
          overview: typeof f.overview === "string" ? f.overview.trim() : "",
          nextStep: typeof f.nextStep === "string" ? f.nextStep.trim() : "",
        }))
    : []

  const bullets = Array.isArray(obj.bullets)
    ? obj.bullets
        .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
        .map((b) => b.trim())
    : []

  const confidenceReason =
    typeof obj.confidenceReason === "string" ? obj.confidenceReason.trim() : ""

  return {
    summary,
    files,
    confidence: Math.round(confidence),
    confidenceReason,
    bullets,
  }
}

/**
 * ARC-263: build a scoped unified diff string from the cache-miss
 * subset of changed files. Each file with a `patch` field renders as
 * a standard `diff --git a/<path> b/<path>\n<patch>` block. Files
 * without a patch (binary / >500KB per GitHub) are listed in a
 * trailing note so the model knows they changed but has no diff to
 * inspect (no row is emitted for them).
 *
 * If `misses` is empty (defensive — caller should have early-returned)
 * OR every miss has no patch, returns the original full diff as a
 * fallback so the review still runs. Exposed for unit tests.
 */
export function scopedDiffFromMisses(
  misses: ReadonlyArray<{ filename: string; patch?: string; status?: string }>,
  fallbackDiff: string,
): string {
  // CodeRabbit MAJOR catch on PR #81: all-hit case. When `misses` is
  // empty, every file's row came from cache — we should NOT feed the
  // full PR diff to the model (defeats the cost-saving purpose). The
  // model still needs SOME diff context for the cumulative
  // `summary`/`confidence`/`bullets`, but those are PR-level fields
  // and a short placeholder is enough — the model has commit
  // messages + PR title/body from the rest of the prompt.
  if (misses.length === 0) {
    return "[All file rows were served from the walkthrough cache; no fresh per-file patches needed.]"
  }
  const withPatch = misses.filter(
    (f): f is { filename: string; patch: string; status?: string } =>
      typeof f.patch === "string" && f.patch.length > 0,
  )
  if (withPatch.length === 0) {
    // code-reviewer L3 catch (commit 1): every miss is binary /
    // >500KB / patch missing. Fall back to the full diff — review
    // still runs but the cache's cost-saving purpose is defeated for
    // this run. Distinct from the misses.length === 0 path above:
    // here the misses are REAL changes that simply don't have a
    // textual diff, so we need the full context.
    console.log(JSON.stringify({
      event: "pr-overview-scoped-diff-fellback-to-full",
      miss_count: misses.length,
      reason: "no-patches-available",
    }))
    return fallbackDiff
  }
  const blocks = withPatch.map(
    (f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`,
  )
  const noPatch = misses.filter((f) => typeof f.patch !== "string" || f.patch.length === 0)
  let scoped = blocks.join("\n")
  if (noPatch.length > 0) {
    scoped += `\n\n[Files changed but no patch available (binary or >500KB):]\n${noPatch.map((f) => `- ${f.filename}${f.status ? ` (${f.status})` : ""}`).join("\n")}`
  }
  return scoped
}

/**
 * ARC-263: merge cached per-file rows with the Ollama-fresh rows in
 * a verdict. Fresh rows win on path collision (the model just looked
 * at this file's current patch, so its judgment supersedes any
 * stale-by-chance cache hit). Total rows are truncated to top-5 by
 * score for display — the comment table stays concise even when the
 * PR has 20 changed files. Exposed for unit tests.
 */
export function mergeCachedAndFreshRows(
  verdict: PrOverviewVerdict,
  cachedRows: ReadonlyMap<string, CachedFileRow>,
): PrOverviewVerdict {
  const freshPaths = new Set(verdict.files.map((f) => f.path))
  const merged: PrOverviewVerdict["files"] = [...verdict.files]
  for (const row of cachedRows.values()) {
    if (!freshPaths.has(row.path)) merged.push(row)
  }
  merged.sort((a, b) => b.score - a.score)
  return { ...verdict, files: merged.slice(0, 5) }
}

interface FormatArgs {
  verdict: PrOverviewVerdict
  isFirstRun: boolean
  /** ARC-258 follow-up: `"pending"` renders a "warming up" callout
   *  block at the top of the overview when the indexer hasn't
   *  produced a manifest yet. `"none"` (default) omits the callout. */
  warmup?: "pending" | "none"
}

/**
 * Render the verdict into the markdown body posted on GitHub. The marker
 * on line 1 is what `findExistingOverviewComment` greps for to decide
 * between POST-new and PATCH-in-place.
 */
export function formatOverviewComment({ verdict, isFirstRun, warmup = "none" }: FormatArgs): string {
  const lines: string[] = [OVERVIEW_MARKER, ""]
  lines.push("## Sigilix Overview")
  lines.push("")

  // ARC-258 follow-up + founder pivot (2026-05-17): warmup state is
  // tracked in the overview body but NOT rendered as customer-visible
  // text. Originally we surfaced a "> [!NOTE]" callout explaining the
  // diff-only first review, but the founder pulled the message — it
  // wasn't worth the visual noise on every cold-install PR. The
  // marker stays so `enqueueWarmupRerunsForIndex` can still grep PRs
  // that need the post-indexing rerun; the rerun itself is what
  // delivers the upgraded review, which is signal enough on its own.
  if (warmup === "pending") {
    lines.push(WARMUP_CALLOUT_MARKER)
    lines.push("")
  }

  lines.push(`### Summary${isFirstRun ? "" : " — latest push"}`)
  lines.push("")
  lines.push(verdict.summary)

  if (verdict.files.length > 0) {
    lines.push("")
    lines.push("### Important files")
    lines.push("")
    lines.push("| File | Score | Notes | Next step |")
    lines.push("| --- | :---: | --- | --- |")
    for (const f of verdict.files) {
      // Model output is interpolated into a markdown table — a literal
      // `|` in `overview` or `nextStep` would split the cell and corrupt
      // the table. Escape with `\|` per CommonMark.
      lines.push(
        `| \`${f.path}\` | ${f.score}/5 | ${escapeTableCell(f.overview) || "—"} | ${escapeTableCell(f.nextStep) || "—"} |`
      )
    }
  }

  lines.push("")
  lines.push(`### Confidence: ${verdict.confidence}/5`)
  if (verdict.confidenceReason) {
    lines.push("")
    lines.push(verdict.confidenceReason)
  }

  if (verdict.bullets.length > 0) {
    lines.push("")
    for (const b of verdict.bullets) {
      lines.push(`- ${b}`)
    }
  }

  return lines.join("\n")
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

/**
 * Single pass over PR comments looking for BOTH the overview sticky
 * (so we can decide POST-vs-PATCH) AND the legacy standalone warmup
 * sticky (so we can delete it after writing the overview).
 *
 * Returning both ids in one call means the overview helper doesn't
 * need a separate `listIssueComments` round trip for migration
 * cleanup — keeps the ARC-231 race-test call-count invariants intact
 * and saves one GitHub API call per PR review on repos still
 * carrying pre-unification stickies.
 */
async function scanComments(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ overviewId: number | null; legacyWarmupId: number | null }> {
  const items = await client.listIssueComments(owner, repo, prNumber)
  let overviewId: number | null = null
  let legacyWarmupId: number | null = null
  for (const c of items) {
    if (typeof c.body !== "string") continue
    // SIG-85: bilingual matcher — pick up both `<!-- sigilix:pr-overview -->`
    // and the legacy `<!-- openclaw:pr-overview -->` stickies. Without
    // this, a PR that received its overview pre-rebrand gets a brand
    // new (duplicate) overview comment instead of an in-place edit.
    if (
      overviewId === null &&
      (c.body.includes(OVERVIEW_MARKER) || c.body.includes(LEGACY_OVERVIEW_MARKER))
    ) {
      overviewId = c.id
    }
    if (legacyWarmupId === null && c.body.includes(LEGACY_WARMUP_MARKER)) {
      legacyWarmupId = c.id
    }
    if (overviewId !== null && legacyWarmupId !== null) break
  }
  return { overviewId, legacyWarmupId }
}

/**
 * ARC-258 follow-up: delete the legacy standalone warmup sticky by
 * id. Caller resolved the id from `scanComments`. Best-effort: a
 * 404 (someone else deleted it first) or 403 (App missing perms)
 * logs + returns; never throws.
 */
async function deleteLegacyWarmupSticky(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
): Promise<void> {
  try {
    await client.deleteIssueComment(owner, repo, commentId)
    console.log(JSON.stringify({
      event: "pr-overview-legacy-warmup-deleted",
      owner, repo, prNumber, comment_id: commentId,
    }))
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-overview-legacy-warmup-delete-failed",
      owner, repo, prNumber, comment_id: commentId,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
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
