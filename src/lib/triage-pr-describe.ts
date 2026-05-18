// ARC-191: `/sigilix describe` handler. Single-shot LLM pass that
// drafts a PR description / internal changelog / external changelog
// from the PR's diff + metadata. Output is a top-level PR comment
// with visible markers around the draft body and a hidden
// machine-parsable `sigilix-meta` line for a future apply verb
// to anchor against.
//
// Differences from `handlePrImprove`:
//   - `createIssueComment` (top-level) instead of `submitReview`
//     (inline-anchored). Describe doesn't anchor to diff lines.
//   - Mode-keyed coalesce + dedupe so `internal` and `external`
//     on the same head don't suppress each other.
//   - Sensitive-repo gate posts a denial comment (improve drops
//     silently). Rationale: describe is invoked by an explicit
//     `/sigilix describe ...` from a known author who saw the ack;
//     silent-drop after ack is bad UX.
//   - PR body is NEVER written by v1. A future `/sigilix
//     describe apply` verb is what writes the body, using the
//     marker contract this module establishes.

import type { DescribeMode } from "./slash-commands"
import { describeModeFriendlyName } from "./slash-commands"
import { applyDescribeToBody } from "./describe-apply"
import { parseFirstJsonObject } from "./json-extract"
import { PR_DESCRIBE_PROMPTS } from "../prompts/pr-describe"
import { generate } from "./ollama"
import { getInstallationToken } from "./github-app"
import { GitHubClient } from "./github"
import {
  loadSigilixConfig,
  loadSigilixConfigRaw,
  parseSigilixConfigDetailed,
  resolveCommandConfig,
} from "./sigilix-config"
import { postConfigErrorComment } from "./sigilix-config-error-comment"
import { isRepoSensitive } from "./repo-policy"
import { PR_DESCRIBE_SCHEMA } from "./schemas"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"

export interface TriagePrDescribeArgs {
  owner: string
  repo: string
  prNumber: number
  installationId: number
  mode: DescribeMode
  /** ARC-264: when true, write the generated draft into the PR body
   *  between marker fences (`<!-- sigilix:describe:<mode>:start/end -->`)
   *  via PATCH. When false (default), post a top-level comment as in
   *  describe v1. The dedupe key includes this flag so
   *  `describe <mode>` and `describe apply <mode>` don't suppress
   *  each other within the per-hour window. */
  apply: boolean
  env: Env
}

export const LIMITS = {
  prDiff: 80_000,
  prBody: 4_000,
}

export const COMMENT_BODY_CAP = 60_000

/** ARC-264 soft cap for the merged PR-body length. GitHub's hard
 *  cap is ~262144; we cap at 250000 to leave a 12k margin for
 *  multi-byte characters and any future format changes that might
 *  add prefix/suffix bytes. Going over this triggers a clear-error
 *  comment instead of letting GitHub return a generic 422. */
export const PR_BODY_HARD_CAP = 250_000

interface BuildPromptArgs {
  mode: DescribeMode
  prNumber: number
  title: string
  body: string
  diff: string
}

/**
 * Build the full prompt sent to Ollama. Three sections:
 *
 *   1. Mode-specific system prompt (from PR_DESCRIBE_PROMPTS) which
 *      ends with the shared envelope describing the
 *      <UNTRUSTED-CONTENT> contract.
 *   2. The three <UNTRUSTED-CONTENT> blocks: pr-title, pr-body,
 *      pr-diff. Empty-body / empty-diff get sentinel placeholders
 *      so the model doesn't think the input is malformed.
 *   3. A brief output reminder.
 *
 * Diff is truncated at LIMITS.prDiff with the same marker pattern
 * the improve handler uses, so very large PRs don't bomb the
 * context window. PR body is truncated at LIMITS.prBody.
 */
export function buildPrompt(args: BuildPromptArgs, addendum: string | null = null): string {
  const { mode, prNumber, title, body, diff } = args
  const systemPrompt = PR_DESCRIBE_PROMPTS[mode]
  const titleSection = `<UNTRUSTED-CONTENT type="pr-title">${title}</UNTRUSTED-CONTENT>`
  const bodySection = `<UNTRUSTED-CONTENT type="pr-body">${truncate(body || "(no description)", LIMITS.prBody)}</UNTRUSTED-CONTENT>`
  const diffSection = `<UNTRUSTED-CONTENT type="pr-diff">${truncate(diff || "(no diff)", LIMITS.prDiff)}</UNTRUSTED-CONTENT>`
  return [
    "[SYSTEM INSTRUCTIONS]",
    systemPrompt.trim(),
    ...(addendum ? ["", "[REPO-SPECIFIC GUIDANCE]", addendum] : []),
    "",
    `[PR #${prNumber}]`,
    titleSection,
    bodySection,
    diffSection,
    "",
    "[OUTPUT]",
    "Return only the JSON object. No prose, no Markdown fence.",
  ].join("\n")
}

function truncate(value: string, max: number, marker = "\n[…truncated…]"): string {
  if (typeof value !== "string") return ""
  if (value.length <= max) return value
  return value.slice(0, max - marker.length) + marker
}

/**
 * Truncate the model's body field so the rendered comment stays
 * under GitHub's ~65,536-character issue-comment ceiling. The
 * cap (60,000 by default) leaves ~5kB for the surrounding wrapper
 * text (title, summary, markers, subtext, hidden meta). Truncation
 * is on the body only — the wrapper sections are bounded.
 *
 * If the cap is smaller than the marker (edge case in tests),
 * we just truncate hard without crashing.
 */
export function truncateForGitHub(body: string, maxChars: number): string {
  const marker = "\n\n[…truncated to fit GitHub comment limit]"
  if (body.length <= maxChars) return body
  if (maxChars <= marker.length) return body.slice(0, maxChars)
  return body.slice(0, maxChars - marker.length) + marker
}

export interface PrDescribeVerdict {
  summary: string
  body: string
}

const MIN_SUMMARY_CHARS = 10
const MIN_BODY_CHARS = 50

/**
 * Parse the model's JSON response into a verdict. Returns null on
 * any structural problem (parse failure, missing fields, wrong
 * types, too-short content). Caller posts the failure comment +
 * returns (no re-throw — see spec §4 retry contract).
 *
 * Length floors:
 *   - summary ≥ 10 chars (avoid one-word "OK" / "Done" outputs)
 *   - body ≥ 50 chars (Codex spec catch: LLMs occasionally return
 *     a single line for body when context is thin; useless for
 *     a PR description, hard to distinguish from no-op)
 *
 * Whitespace is trimmed before length check so trailing newlines
 * don't accidentally satisfy the floor.
 */
export function parsePrDescribeResponse(text: string): PrDescribeVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null
  const summaryRaw = obj.summary
  const bodyRaw = obj.body
  if (typeof summaryRaw !== "string" || typeof bodyRaw !== "string") return null
  const summary = summaryRaw.trim()
  const body = bodyRaw.trim()
  if (summary.length < MIN_SUMMARY_CHARS) return null
  if (body.length < MIN_BODY_CHARS) return null
  return { summary, body }
}

/**
 * Visible draft + hidden metadata, ready for `createIssueComment`.
 * The hidden `sigilix-meta` line is a single-line JSON object inside
 * an HTML comment, designed so the future apply verb can locate
 * exactly which previous comment owned a given marker pair.
 *
 * Pure — no env / no GitHub call. Tests exercise the snapshot.
 */
export function renderDescribeComment(args: {
  mode: DescribeMode
  headSha: string
  summary: string
  body: string
}): string {
  const { mode, headSha, summary, body } = args
  const friendly = describeModeFriendlyName(mode)
  const sha7 = headSha.slice(0, 7)
  const meta = JSON.stringify({
    kind: "describe",
    mode,
    headSha,
    schema: 1,
    source: "comment-draft",
  })
  // Choose the short-token form so the suggested command matches
  // what the user would type. `pr` / `internal` / `external`.
  const shortToken: Record<DescribeMode, string> = {
    "pr-description": "pr",
    "internal-changelog": "internal",
    "external-changelog": "external",
  }
  return [
    `**Sigilix describe** — \`${friendly}\` draft`,
    "",
    summary,
    "",
    `<!-- sigilix:describe:${mode}:start -->`,
    body,
    `<!-- sigilix:describe:${mode}:end -->`,
    "",
    // ARC-264 update: apply shipped. Point users at it instead of
    // promising a follow-up that already exists.
    `<sub>Run on \`${sha7}\`. Copy the section between markers into the PR description / changelog, or run \`/sigilix describe apply ${shortToken[mode]}\` to write it into the PR body in place.</sub>`,
    "",
    `<!-- sigilix-meta: ${meta} -->`,
  ].join("\n")
}

/**
 * Disabled-config branch. Posted when the per-repo
 * `sigilix.json` has `describe.enabled: false`. Visible signal
 * (rather than silent drop) because the user explicitly typed the
 * command and would otherwise wonder where the output went.
 */
export function renderDisabledComment(): string {
  return [
    "**Sigilix describe** — disabled in `sigilix.json` for this repo.",
    "",
    "Remove `describe.enabled: false` (or set it to `true`) at the PR head ref to re-enable.",
  ].join("\n")
}

/**
 * Sensitive-repo branch. Posted when `OPENCLAW_SENSITIVE_REPOS`
 * matches this owner/repo. Tells the user where to escalate
 * without leaking which other repos are on the denylist.
 */
export function renderSensitiveDenialComment(): string {
  return [
    "**Sigilix describe** — repository is on the Sigilix sensitive denylist.",
    "",
    "No content is sent to language models for this repo. Contact your Sigilix operator if this gating is unexpected.",
  ].join("\n")
}

/**
 * Unknown-arg branch. Posted directly from the webhook handler
 * (BEFORE enqueue / ack) when the mode arg fails to parse. Lists
 * the valid short tokens so the user can self-correct.
 *
 * Codex spec catch: silent fallback to `pr-description` would
 * post the wrong artifact when the user typed `/sigilix describe
 * internel` (typo for "internal"). The audience boundary between
 * internal and external is too important to swallow user typos.
 */
export function renderUsageComment(rawArg: string): string {
  return `**Sigilix describe** — unknown mode \`${rawArg}\`. Try \`pr\`, \`internal\`, or \`external\`.`
}

/**
 * Generic failure branch. Posted when model output fails to
 * parse, fails schema validation, or produces too-short
 * summary/body. Tells the user how to re-run.
 *
 * Resolved per Codex spec catch: post-and-return (NOT post-and-
 * rethrow). Re-throwing would trigger Cloudflare Queues retry,
 * which would re-run the handler, which would post another
 * failure comment — PR spam. The user re-runs explicitly via
 * `/sigilix describe <mode>` if they want to retry.
 */
export function renderFailureComment(mode: DescribeMode): string {
  const shortToken: Record<DescribeMode, string> = {
    "pr-description": "pr",
    "internal-changelog": "internal",
    "external-changelog": "external",
  }
  return `**Sigilix describe** — could not generate \`${mode}\` draft. Error logged; re-run \`/sigilix describe ${shortToken[mode]}\` to retry.`
}

/**
 * ARC-264: fallback comment posted when `apply` mode generates a
 * valid draft but the PR-body PATCH fails with a 4xx. We don't
 * re-throw on 4xx (not queue-retriable), so this comment is the
 * only signal the user gets. Includes the short mode token so the
 * user can re-run with the same arg shape, and the headSha so the
 * user can correlate the failure with their working tree (code-
 * review L7 catch).
 */
export function renderApplyFailureComment(mode: DescribeMode, headSha?: string): string {
  const shortToken: Record<DescribeMode, string> = {
    "pr-description": "pr",
    "internal-changelog": "internal",
    "external-changelog": "external",
  }
  const shaSuffix = typeof headSha === "string" && headSha.length > 0
    ? ` (run on \`${headSha.slice(0, 7)}\`)`
    : ""
  return `**Sigilix describe apply** — generated the \`${mode}\` draft but could not write it to the PR body${shaSuffix} (GitHub PATCH refused). Re-run \`/sigilix describe apply ${shortToken[mode]}\` to retry, or run \`/sigilix describe ${shortToken[mode]}\` to get the draft as a comment instead.`
}

/**
 * ARC-264 (code-review M1): emitted when the merged PR body would
 * exceed `PR_BODY_HARD_CAP`. GitHub would otherwise return a
 * generic 422; this comment tells the user exactly what hit the
 * limit and offers the comment-mode draft as the workaround.
 */
export function renderApplyTooLargeComment(
  mode: DescribeMode,
  currentLength: number,
  mergedLength: number,
): string {
  const shortToken: Record<DescribeMode, string> = {
    "pr-description": "pr",
    "internal-changelog": "internal",
    "external-changelog": "external",
  }
  return [
    `**Sigilix describe apply** — generated the \`${mode}\` draft but the merged PR body (${mergedLength.toLocaleString()} chars) would exceed GitHub's size cap (${PR_BODY_HARD_CAP.toLocaleString()} chars).`,
    "",
    `Current body: ${currentLength.toLocaleString()} chars. Shorten the manual portion of the description, or run \`/sigilix describe ${shortToken[mode]}\` to get the draft as a top-level comment instead.`,
  ].join("\n")
}

/**
 * ARC-264 (code-review M2): inner content written between the
 * marker fences in apply mode. Adds a machine-readable provenance
 * line ahead of the rendered body so a future freshness check
 * can detect "this fenced block was generated against SHA X" and
 * invalidate stale auto-content when base diverges. The whole
 * block (including this line) is replaced on every re-run, so the
 * provenance always reflects the latest generation.
 *
 * Pure — exposed for tests.
 */
export function renderDescribeBlockContent(args: {
  headSha: string
  body: string
}): string {
  const { headSha, body } = args
  const meta = JSON.stringify({
    kind: "describe-apply",
    headSha,
    schema: 1,
  })
  return `<!-- sigilix-meta: ${meta} -->\n${body}`
}

/**
 * No-diff branch. Posted when the PR is closed/merged with no
 * fetchable diff, or the diff fetch returned empty. Avoids an
 * LLM call on input the model can't usefully process.
 */
export function renderNoChangesComment(prNumber: number): string {
  return `**Sigilix describe** — no changes to describe on PR #${prNumber}.`
}

/**
 * Main entry. Wired from the `pr-describe` queue handler in
 * src/index.ts. Pipeline mirrors handlePrImprove with describe-
 * specific gates + post-and-return failure semantics.
 *
 * Failure-retry contract (Codex spec catch + resolution):
 *   - Model parse / validation failures → post failure comment + RETURN
 *     (do NOT re-throw — would cause queue retry → another comment).
 *   - generate() rejection (network / Ollama 5xx) → post failure
 *     comment + RETURN (same path; user re-runs explicitly).
 *   - 5xx posting the SUCCESS draft → re-throw (queue retry path with
 *     fresh dedupe key; the user has not yet seen any output).
 *   - 4xx posting the SUCCESS draft → log + return (4xx isn't queue-
 *     retriable; an idempotent retry would just 4xx again).
 *   - Failure-comment post itself failing → log + return (no nested
 *     error spiral).
 *
 * Dedupe-key release contract (Codex spec catch):
 *   - `successPosted` is set ONLY after a successful real-output post
 *     (the draft, the no-changes notice). Failure-comment posts do NOT
 *     set it — `finally` releases the key so the user can re-run.
 */
export async function handlePrDescribe(args: TriagePrDescribeArgs): Promise<void> {
  const { owner, repo, prNumber, installationId, mode, apply, env } = args
  const tag = { owner, repo, prNumber, mode, apply }

  // Sensitive-repo gate (BEFORE any auth or LLM call). Posts a denial
  // comment unlike improve's silent drop — describe is invoked by an
  // explicit `/sigilix describe` from a known author who saw the ack.
  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    console.log(JSON.stringify({
      event: "pr-describe-skipped",
      reason: "sensitive_repo",
      ...tag,
    }))
    await tryPostComment(env, args, mode, renderSensitiveDenialComment())
    return
  }

  // Auth + meta. We resolve head SHA up front because the dedupe key
  // includes it.
  let client: GitHubClient
  try {
    client = await buildClient(env, installationId)
  } catch (err) {
    console.error(JSON.stringify({
      event: "pr-describe-auth-failed",
      err: err instanceof Error ? err.message : String(err),
      ...tag,
    }))
    return
  }

  const meta = await client.getPullRequest(owner, repo, prNumber)
  const headSha = meta.head.sha

  // ARC-185: load with detailed parse for the parse-error PR
  // comment. On parse failure, post the comment fire-and-forget
  // (idempotent per head SHA) and proceed with EMPTY_CONFIG so the
  // describe still runs in default mode.
  const rawConfig = await loadSigilixConfigRaw(client, owner, repo, headSha)
  let config: Awaited<ReturnType<typeof loadSigilixConfig>>
  if (rawConfig === null) {
    config = await loadSigilixConfig(client, owner, repo, headSha)
  } else {
    const parsed = parseSigilixConfigDetailed(rawConfig)
    if (parsed.ok) {
      config = parsed.config
    } else {
      console.log(JSON.stringify({
        event: "command-config-parse-error",
        owner, repo, prNumber,
        command: "describe",
        reason: parsed.reason,
      }))
      postConfigErrorComment({
        env, client, owner, repo, prNumber, headSha,
        reason: parsed.reason,
        raw: parsed.raw,
      }).catch((err) => {
        console.error(JSON.stringify({
          event: "command-config-error-comment-bubbled",
          err: err instanceof Error ? err.message : String(err),
          owner, repo, prNumber,
        }))
      })
      config = await loadSigilixConfig(client, owner, repo, headSha)
    }
  }
  // Disabled-config gate. Loaded AT the head ref so per-PR config
  // changes are honored.
  if (config.describe?.enabled === false) {
    console.log(JSON.stringify({
      event: "pr-describe-skipped",
      reason: "disabled_in_config",
      headSha,
      ...tag,
    }))
    await tryPostComment(env, args, mode, renderDisabledComment())
    return
  }

  // Per-(PR, headSha, mode, apply) dedupe lock. Mode-keyed so
  // `internal` and `external` on the same head can both run within
  // the hour. Apply-keyed so `/sigilix describe pr` and
  // `/sigilix describe apply pr` (ARC-264) don't suppress each other
  // — one posts a comment, the other writes the PR body. Released
  // in `finally` if successPosted is false, so failed runs leave
  // the lock open for a manual re-run.
  const applySuffix = apply ? ":apply" : ""
  const dedupeKey = `pr-describe:${owner}/${repo}#${prNumber}@${headSha}:${mode}${applySuffix}`
  const seen = await env.OPENCLAW_STATE.get(dedupeKey)
  if (seen) {
    console.log(JSON.stringify({
      event: "pr-describe-skipped",
      dedupe_system: "kv",
      reason: "already_ran",
      headSha,
      ...tag,
    }))
    return
  }
  await env.OPENCLAW_STATE.put(dedupeKey, String(Date.now()), {
    expirationTtl: 60 * 60,
  })

  let successPosted = false
  try {
    const diffRaw = await client.getPullRequestDiff(owner, repo, prNumber)
    if (!diffRaw || diffRaw.trim().length === 0) {
      console.log(JSON.stringify({
        event: "pr-describe-no-diff",
        headSha,
        ...tag,
      }))
      await tryPostComment(env, args, mode, renderNoChangesComment(prNumber))
      successPosted = true
      return
    }

    // Diff truncation telemetry (spec §7). Detect by comparing raw
    // length to the cap; we log BEFORE building the prompt so the
    // builder's internal truncate() is just shaping the prompt.
    if (diffRaw.length > LIMITS.prDiff) {
      console.log(JSON.stringify({
        event: "pr-describe-truncated",
        truncated_diff: true,
        diffRawLength: diffRaw.length,
        diffCap: LIMITS.prDiff,
        headSha,
        ...tag,
      }))
    }

    // ARC-185: per-command config (commands.describe.{prompt.addendum, model.{primary, fallbacks}}).
    const commandConfig = resolveCommandConfig(config, "describe")

    const prompt = buildPrompt({
      mode,
      prNumber,
      title: meta.title ?? "",
      body: meta.body ?? "",
      diff: diffRaw,
    }, commandConfig.promptAddendum)

    const primaryModel = commandConfig.modelPrimary ?? env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    const modelChain = commandConfig.modelFallbacks.override
      ? [primaryModel, ...commandConfig.modelFallbacks.models]
      : [primaryModel]

    if (
      commandConfig.promptAddendum !== null ||
      commandConfig.modelPrimary !== null ||
      commandConfig.modelFallbacks.override
    ) {
      console.log(JSON.stringify({
        event: "command-config-resolved",
        owner, repo, prNumber,
        command: "describe",
        hasPromptAddendum: commandConfig.promptAddendum !== null,
        modelPrimary: commandConfig.modelPrimary,
        modelFallbacksCount: commandConfig.modelFallbacks.override
          ? commandConfig.modelFallbacks.models.length
          : 0,
      }))
    }

    let response: string | null = null
    let modelUsed = primaryModel
    let lastErr: unknown
    for (const m of modelChain) {
      modelUsed = m
      try {
        response = await generate({
          model: m,
          prompt,
          apiKey: env.OLLAMA_API_KEY,
          format: PR_DESCRIBE_SCHEMA as unknown as Record<string, unknown>,
        })
        break
      } catch (err) {
        lastErr = err
        console.error(JSON.stringify({
          event: "pr-describe-generate-failed",
          err: err instanceof Error ? err.message : String(err),
          headSha, model: m,
          ...tag,
        }))
      }
    }
    if (response === null) {
      console.error(JSON.stringify({
        event: "pr-describe-generate-exhausted",
        headSha,
        modelChainLength: modelChain.length,
        err: lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown"),
        ...tag,
      }))
      await tryPostComment(env, args, mode, renderFailureComment(mode))
      return
    }
    void modelUsed // recorded above in telemetry; not used downstream

    const verdict = parsePrDescribeResponse(response)
    if (!verdict) {
      console.error(JSON.stringify({
        event: "pr-describe-parse-failed",
        headSha,
        responseLength: response.length,
        ...tag,
      }))
      await tryPostComment(env, args, mode, renderFailureComment(mode))
      return
    }

    const truncatedBody = truncateForGitHub(verdict.body, COMMENT_BODY_CAP)

    if (apply) {
      // ARC-264 path: write the generated draft into the PR body
      // between marker fences instead of posting a comment. Content
      // outside the markers (user-authored prose, links, screenshots)
      // is preserved across re-runs.
      //
      // Re-fetch the PR body immediately before the PATCH (code-
      // reviewer H2 catch). The LLM call takes ~5s; another bot
      // (Linear sync, walkthrough comment, parallel `/sigilix
      // describe apply` for a different mode) could have edited
      // the body in that window. Reading fresh narrows the race
      // window to the GET→PATCH gap, which is unavoidable without
      // ETag support on the pulls endpoint.
      let currentBody: string
      try {
        const fresh = await client.getPullRequest(owner, repo, prNumber)
        currentBody = fresh.body ?? ""
      } catch (err) {
        // GET failure: fall back to the stale `meta.body` snapshot
        // rather than abort. We'd rather PATCH with a slightly-
        // stale view than fail the apply outright.
        console.warn(JSON.stringify({
          event: "pr-describe-apply-prefetch-failed",
          err: err instanceof Error ? err.message : String(err),
          headSha,
          ...tag,
        }))
        currentBody = meta.body ?? ""
      }
      const hadExistingMarkers = currentBody.includes(`<!-- sigilix:describe:${mode}:start -->`)
      const nextBody = applyDescribeToBody({
        currentBody,
        mode,
        sectionContent: renderDescribeBlockContent({
          headSha,
          body: truncatedBody,
        }),
      })

      // H3: no-op when the merged body matches the existing body
      // byte-for-byte. Avoids body-churn entries in GitHub's PR
      // history on a re-run with identical content (idempotent
      // re-apply should not show up in audit history).
      if (nextBody === currentBody) {
        successPosted = true
        console.log(JSON.stringify({
          event: "pr-describe-applied-noop",
          headSha,
          existing_markers: hadExistingMarkers,
          ...tag,
        }))
      } else if (nextBody.length > PR_BODY_HARD_CAP) {
        // M1: GitHub caps PR bodies at ~262144 chars. If the merged
        // body would exceed our soft cap (well below GitHub's hard
        // cap), surface a clear error to the user rather than let
        // GitHub return a generic 422.
        console.error(JSON.stringify({
          event: "pr-describe-apply-too-large",
          headSha,
          next_body_length: nextBody.length,
          cap: PR_BODY_HARD_CAP,
          existing_markers: hadExistingMarkers,
          ...tag,
        }))
        await tryPostComment(
          env, args, mode,
          renderApplyTooLargeComment(mode, currentBody.length, nextBody.length),
        )
      } else {
        try {
          await client.updatePullRequestBody(owner, repo, prNumber, nextBody)
          successPosted = true
          console.log(JSON.stringify({
            event: "pr-describe-applied",
            headSha,
            truncated: truncatedBody.length < verdict.body.length,
            existing_markers: hadExistingMarkers,
            next_body_length: nextBody.length,
            ...tag,
          }))
        } catch (err) {
          const status = readHttpStatus(err)
          if (status !== null && status >= 500) {
            // 5xx PATCHing the PR body: re-throw → queue retry. Same
            // rationale as the comment-post path; user has not seen
            // any output yet (only the ack).
            throw err
          }
          console.error(JSON.stringify({
            event: "pr-describe-apply-failed",
            status,
            err: err instanceof Error ? err.message : String(err),
            headSha,
            ...tag,
          }))
          // 4xx: post a fallback failure comment so the user knows
          // the apply path didn't land. Best-effort; no re-throw.
          await tryPostComment(env, args, mode, renderApplyFailureComment(mode, headSha))
        }
      }
    } else {
      const commentBody = renderDescribeComment({
        mode,
        headSha,
        summary: verdict.summary,
        body: truncatedBody,
      })

      try {
        await client.createIssueComment(owner, repo, prNumber, commentBody)
        successPosted = true
        console.log(JSON.stringify({
          event: "pr-describe-posted",
          headSha,
          truncated: truncatedBody.length < verdict.body.length,
          ...tag,
        }))
      } catch (err) {
        const status = readHttpStatus(err)
        if (status !== null && status >= 500) {
          // 5xx posting the success draft: re-throw → queue retry.
          // User has not seen any output yet (only the ack), so a
          // single retry is the right behavior. Dedupe key released
          // in `finally` so retry can re-run from scratch.
          throw err
        }
        // 4xx: log + return (4xx isn't queue-retriable).
        console.error(JSON.stringify({
          event: "pr-describe-post-failed",
          status,
          err: err instanceof Error ? err.message : String(err),
          headSha,
          ...tag,
        }))
      }
    }
  } finally {
    if (!successPosted) {
      await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})
    }
  }
}

/**
 * Best-effort comment post for non-success branches (failure /
 * disabled / sensitive / no-changes). Swallows errors to avoid
 * nested error spirals (a comment-post failure for a comment
 * about a failure must not throw). Logs include `mode` per the
 * spec §7 telemetry invariant (Kimi spec catch).
 */
async function tryPostComment(
  env: Env,
  args: { owner: string; repo: string; prNumber: number; installationId: number },
  mode: DescribeMode,
  body: string,
): Promise<void> {
  try {
    const client = await buildClient(env, args.installationId)
    await client.createIssueComment(args.owner, args.repo, args.prNumber, body)
  } catch (err) {
    console.error(JSON.stringify({
      event: "pr-describe-best-effort-post-failed",
      err: err instanceof Error ? err.message : String(err),
      mode,
      owner: args.owner, repo: args.repo, prNumber: args.prNumber,
    }))
  }
}

async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}

/**
 * Best-effort extraction of a numeric HTTP status from an error.
 * Mirrors triage-pr-improve's helper (the GitHubClient throws plain
 * Errors with the status embedded in the message string).
 */
function readHttpStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null
  const m = err.message.match(/\b(\d{3})\b/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}
