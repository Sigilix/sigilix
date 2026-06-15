// SIG-437: `@sigilix summary` handler. A PR author drops the `@sigilix summary`
// one-liner in the PR BODY; on the `pull_request` `opened`/`edited` webhook the
// trigger gate enqueues a `pr-summary` job, and this handler:
//
//   1. Soft-fails out on a sensitive repo (silent — there was no explicit ack
//      to answer, unlike `/sigilix describe`).
//   2. Re-fetches the PR and confirms the `@sigilix summary` trigger is STILL in
//      the body (the author may have removed it, or another writer may have
//      already produced the managed block) before doing any model work.
//   3. Stale-head guard: if the job's head SHA no longer matches the live PR
//      head, soft-returns — a newer push will have enqueued its own job. (No
//      re-anchoring needed; we always render against the live head.)
//   4. Retrieves codebase context, generates the detailed description, verifies
//      citations, appends a DETERMINISTIC "Related" block (related PRs via the
//      stack detector + the Linear issue via body/branch parsing — no API call),
//      then replaces the trigger / managed block in the PR body via PATCH.
//   5. Idempotent: a re-edit replaces the managed block; a byte-identical merge
//      is a no-op (no PATCH, no body-churn history entry).
//
// Modeled directly on `triage-pr-describe.ts` (ARC-191/264). Same failure-retry
// contract: parse/validation/generate failures soft-return (no re-throw → no
// queue retry → no PR-body churn loop); a 5xx PATCHing the body re-throws (queue
// retry); a 4xx logs + returns. The dispatcher returns this handler directly; the
// outer queue() consumer in src/index.ts is the catch-all that routes any
// (intended 5xx) throw to message.retry().

import { generate } from "@/src/shared/adapters/model"
import { GitHubClient, GitHubHttpError } from "@/src/shared/adapters/github"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { PR_SUMMARY_PROMPT } from "@/src/prompts/pr-summary"
import { PR_SUMMARY_SCHEMA } from "@/src/shared/domain/schemas"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { isRepoSensitive } from "./repo-policy"
import { retrieveChunks, formatChunksForPrompt } from "./retrieval"
import { indexNamespace } from "./repo-index-manifest"
import { verifyAndSanitizeCitations } from "./citation-verifier"
import { detectStack } from "./pr-stack"
import type { StackContext } from "./pr-stack"
import { extractLinearIssueRef, renderAssociations } from "./pr-summary-associate"
import { applySummaryToBody } from "./pr-summary-apply"
import { parseSummaryCommand } from "./pr-summary-command"

const DEFAULT_MODEL = "glm-5.1:cloud"

/** The `pr-summary` queue job (`headSha` is pinned at enqueue time — used for
 *  the stale-head guard, the dedupe key, and the citation-verification ref). */
export type PrSummaryJob = Extract<JobMessage, { type: "pr-summary" }>

export const LIMITS = {
  prDiff: 80_000,
  prBody: 4_000,
}

/** Soft cap on the merged PR-body length. GitHub's hard cap is ~262144; cap at
 *  250000 to leave margin for multibyte chars. Over this → skip the PATCH with a
 *  log (no clear-error comment — the trigger surface is the body, not a command
 *  thread, so there's no natural place to answer). Mirrors describe's cap. */
export const PR_BODY_HARD_CAP = 250_000

const MIN_SUMMARY_CHARS = 10
const MIN_BODY_CHARS = 50

export interface PrSummaryVerdict {
  summary: string
  body: string
}

interface BuildPromptArgs {
  prNumber: number
  title: string
  body: string
  diff: string
  codebaseChunks: string | null
}

/**
 * Build the full prompt. Sections: system prompt, then the untrusted PR
 * title / body / diff / codebase-chunks blocks, then an output reminder. Diff is
 * truncated at LIMITS.prDiff and body at LIMITS.prBody so very large PRs don't
 * blow the context window. Pure — exported for tests.
 */
export function buildPrompt(args: BuildPromptArgs): string {
  const { prNumber, title, body, diff, codebaseChunks } = args
  const titleSection = `<UNTRUSTED-CONTENT type="pr-title">${title}</UNTRUSTED-CONTENT>`
  const bodySection = `<UNTRUSTED-CONTENT type="pr-body">${truncate(body || "(no description)", LIMITS.prBody)}</UNTRUSTED-CONTENT>`
  const diffSection = `<UNTRUSTED-CONTENT type="pr-diff">${truncate(diff || "(no diff)", LIMITS.prDiff)}</UNTRUSTED-CONTENT>`
  const chunksSection = `<UNTRUSTED-CONTENT type="codebase-chunks">${codebaseChunks ?? "(no retrieved context)"}</UNTRUSTED-CONTENT>`
  return [
    "[SYSTEM INSTRUCTIONS]",
    PR_SUMMARY_PROMPT.trim(),
    "",
    `[PR #${prNumber}]`,
    titleSection,
    bodySection,
    diffSection,
    chunksSection,
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
 * Parse the model's JSON response. Returns null on any structural problem
 * (parse failure, missing/short fields). Length floors mirror describe: summary
 * ≥ 10, body ≥ 50 (after trim). Pure — exported for tests.
 */
export function parsePrSummaryResponse(text: string): PrSummaryVerdict | null {
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
 * Compose the managed-block content: the model's description body + the
 * deterministic "Related" block (when there's anything to relate). Pure —
 * exported for tests.
 */
export function composeSummarySection(args: {
  body: string
  stack: StackContext | null
  prBody: string
  branchName: string | null
}): string {
  const linear = extractLinearIssueRef(args.prBody, args.branchName)
  const related = renderAssociations({ stack: args.stack, linear })
  return related ? `${args.body.trimEnd()}\n\n${related}` : args.body
}

/**
 * Best-effort related-PR detection. Lists open PRs + runs the stack detector.
 * Returns null on any failure (no related-PR line then — never blocks the
 * summary). Soft by design.
 */
async function detectRelatedPrs(
  client: GitHubClient,
  owner: string,
  repo: string,
  meta: Awaited<ReturnType<GitHubClient["getPullRequest"]>>,
): Promise<StackContext | null> {
  try {
    const openPrs = await client.listOpenPullRequests(owner, repo, { maxItems: 200 })
    return detectStack({
      currentPr: {
        number: meta.number,
        title: meta.title ?? "",
        headRef: meta.head.ref,
        baseRef: meta.base.ref,
        headRepo: `${owner}/${repo}`,
        baseRepo: `${owner}/${repo}`,
        author: meta.user?.login ?? null,
      },
      openPrs,
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "pr-summary-stack-detect-failed",
        owner,
        repo,
        prNumber: meta.number,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }
}

/**
 * Main entry, wired from the `pr-summary` queue case in src/index-dispatch.ts.
 */
export async function handlePrSummary(job: PrSummaryJob, env: Env): Promise<void> {
  const { owner, repo, prNumber, headSha, installationId } = job
  const tag = { owner, repo, prNumber }

  // Sensitive-repo gate (BEFORE any auth or LLM call). Silent — the trigger is a
  // body marker, not an explicit command with an ack to answer.
  if (isRepoSensitive(env.OPENCLAW_SENSITIVE_REPOS, owner, repo)) {
    console.log(JSON.stringify({ event: "pr-summary-skipped", reason: "sensitive_repo", ...tag }))
    return
  }

  let client: GitHubClient
  try {
    client = await buildClient(env, installationId)
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "pr-summary-auth-failed",
        err: err instanceof Error ? err.message : String(err),
        ...tag,
      }),
    )
    return
  }

  const meta = await client.getPullRequest(owner, repo, prNumber)

  // Stale-head guard (Codex MUST-FIX #2): if the live head has moved past the
  // SHA this job was enqueued for, a newer push has (or will have) enqueued its
  // own job. Soft-return rather than write a description for an old head.
  const liveHeadSha = meta.head.sha
  if (typeof liveHeadSha === "string" && liveHeadSha.length > 0 && liveHeadSha !== headSha) {
    console.log(
      JSON.stringify({
        event: "pr-summary-skipped",
        reason: "stale_head",
        jobHeadSha: headSha.slice(0, 7),
        liveHeadSha: liveHeadSha.slice(0, 7),
        ...tag,
      }),
    )
    return
  }

  // Re-confirm the trigger is still present (author may have removed it; or the
  // managed block already exists, in which case parseSummaryCommand returns null
  // because it strips the block before looking for a fresh trigger).
  if (!parseSummaryCommand(meta.body, env.OPENCLAW_MENTION_TRIGGERS)) {
    console.log(JSON.stringify({ event: "pr-summary-skipped", reason: "marker_absent_on_refetch", ...tag }))
    return
  }

  // Per-(PR, headSha) dedupe lock so a redelivered webhook / job doesn't run the
  // model twice for the same head. Released in `finally` if no success, so a
  // failed run can be re-triggered by a fresh edit.
  const dedupeKey = `pr-summary:${owner}/${repo}#${prNumber}@${headSha}`
  const seen = await env.OPENCLAW_STATE.get(dedupeKey)
  if (seen) {
    console.log(JSON.stringify({ event: "pr-summary-skipped", dedupe_system: "kv", reason: "already_ran", ...tag }))
    return
  }
  await env.OPENCLAW_STATE.put(dedupeKey, String(Date.now()), { expirationTtl: 60 * 60 })

  let success = false
  try {
    const diffRaw = await client.getPullRequestDiff(owner, repo, prNumber)
    if (!diffRaw || diffRaw.trim().length === 0) {
      console.log(JSON.stringify({ event: "pr-summary-no-diff", ...tag }))
      return
    }

    // Codebase retrieval scoped to the repo's Vectorize namespace. Soft-fails to
    // empty (the prompt tolerates "(no retrieved context)").
    let codebaseChunks: string | null = null
    try {
      const chunks = await retrieveChunks({
        text: `${meta.title ?? ""}\n\n${truncate(diffRaw, 4_000)}`,
        teamKey: indexNamespace(owner, repo),
        env,
      })
      codebaseChunks = formatChunksForPrompt(chunks)
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "pr-summary-retrieval-failed",
          err: err instanceof Error ? err.message : String(err),
          ...tag,
        }),
      )
    }

    const prompt = buildPrompt({
      prNumber,
      title: meta.title ?? "",
      body: meta.body ?? "",
      diff: diffRaw,
      codebaseChunks,
    })

    const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
    let response: string
    try {
      response = (
        await generate({
          model,
          prompt,
          apiKey: env.OLLAMA_API_KEY,
          format: PR_SUMMARY_SCHEMA as unknown as Record<string, unknown>,
        })
      ).text
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "pr-summary-generate-failed",
          err: err instanceof Error ? err.message : String(err),
          model,
          ...tag,
        }),
      )
      return
    }

    const verdict = parsePrSummaryResponse(response)
    if (!verdict) {
      console.error(JSON.stringify({ event: "pr-summary-parse-failed", responseLength: response.length, ...tag }))
      return
    }

    // Verify citations against the head SHA; correct any that don't resolve.
    const checkedBody = await verifyAndSanitizeCitations({
      answer: verdict.body,
      ref: headSha,
      fetchFileContent: (path, ref) => client.getFileContent(owner, repo, path, ref),
    })
    if (checkedBody.invalid.length > 0) {
      console.log(
        JSON.stringify({
          event: "pr-summary-citation-verification-corrected",
          invalid: checkedBody.invalid.length,
          headSha: headSha.slice(0, 7),
          ...tag,
        }),
      )
    }

    // Associations: related PRs (best-effort stack detect) + Linear ref
    // (body/branch parse). Both deterministic, appended by us.
    const stack = await detectRelatedPrs(client, owner, repo, meta)
    const sectionContent = composeSummarySection({
      body: checkedBody.answer,
      stack,
      prBody: meta.body ?? "",
      branchName: meta.head.ref ?? null,
    })

    // Re-fetch the PR body immediately before the PATCH (the model call took a
    // few seconds; another writer may have edited the body). Narrows the
    // GET→PATCH race to the unavoidable gap.
    let currentBody: string
    try {
      const fresh = await client.getPullRequest(owner, repo, prNumber)
      currentBody = fresh.body ?? ""
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "pr-summary-prefetch-failed",
          err: err instanceof Error ? err.message : String(err),
          ...tag,
        }),
      )
      currentBody = meta.body ?? ""
    }

    const nextBody = applySummaryToBody({
      currentBody,
      sectionContent,
      ...(env.OPENCLAW_MENTION_TRIGGERS !== undefined ? { envTriggers: env.OPENCLAW_MENTION_TRIGGERS } : {}),
    })

    // Idempotent no-op: identical merge (or nothing to write because the trigger
    // vanished between refetch and now) → no PATCH, no body-churn history entry.
    if (nextBody === currentBody) {
      success = true
      console.log(JSON.stringify({ event: "pr-summary-applied-noop", ...tag }))
      return
    }

    if (nextBody.length > PR_BODY_HARD_CAP) {
      console.error(
        JSON.stringify({
          event: "pr-summary-too-large",
          next_body_length: nextBody.length,
          cap: PR_BODY_HARD_CAP,
          ...tag,
        }),
      )
      return
    }

    try {
      await client.updatePullRequestBody(owner, repo, prNumber, nextBody)
      success = true
      console.log(
        JSON.stringify({
          event: "pr-summary-applied",
          headSha: headSha.slice(0, 7),
          next_body_length: nextBody.length,
          related: sectionContent !== checkedBody.answer,
          ...tag,
        }),
      )
    } catch (err) {
      const status = readHttpStatus(err)
      if (status !== null && status >= 500) {
        // 5xx PATCHing the body: re-throw → queue retry (dedupe key released in
        // `finally` so the retry re-runs cleanly).
        throw err
      }
      // 4xx: log + return (not queue-retriable).
      console.error(
        JSON.stringify({
          event: "pr-summary-apply-failed",
          status,
          err: err instanceof Error ? err.message : String(err),
          ...tag,
        }),
      )
    }
  } finally {
    if (!success) {
      await env.OPENCLAW_STATE.delete(dedupeKey).catch(() => {})
    }
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
 * Best-effort numeric HTTP status from an error. Trusts a typed
 * `GitHubHttpError.status`; else anchors on the literal `HTTP` prefix the client
 * writes into thrown messages (so a 3-digit token in a URL path isn't mistaken
 * for a status). Mirrors triage-pr-describe's helper.
 */
function readHttpStatus(err: unknown): number | null {
  if (err instanceof GitHubHttpError) return err.status
  if (!(err instanceof Error)) return null
  const m = err.message.match(/\bHTTP\s+(\d{3})\b/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}
