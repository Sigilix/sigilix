// ARC-265 — auto-labelling pipeline.
//
// On every `pull_request` webhook (opened / synchronize / reopened),
// dispatch enqueues a `pr-labels` job alongside `pr-overview` and
// `pr-review`. The handler:
//
//   1. Loads `sigilix.json::customLabels` at the PR head SHA. If
//      present, it becomes the curated candidate allowlist. If absent,
//      the repo's existing labels become the candidate pool.
//   2. Lists repo labels with descriptions + current PR labels.
//   3. Applies the status/triage denylist and builds the candidate pool.
//   4. Asks Ollama (schema-constrained) to pick 0–5 labels.
//   5. Applies new labels via GitHub API.
//   6. Removes any Sigilix-applied label (tracked in KV) that the
//      model no longer picked. NEVER removes human-applied labels.
//
// All operations are best-effort: a failure logs + returns. Labels
// are an additive UX signal, not load-bearing — a missed labelling
// run doesn't break the review pipeline.

import { generate } from "./ollama"
import { GitHubClient } from "./github"
import { getInstallationToken } from "./github-app"
import { isPrLabelsEnabled, loadSigilixConfig } from "./sigilix-config"
import { parseFirstJsonObject } from "./json-extract"
import { PR_LABEL_SCHEMA } from "./schemas"
import { PR_LABEL_PROMPT } from "../prompts/pr-labels"
import type { Env } from "../index"

const DEFAULT_MODEL = "glm-5.1:cloud"
const MAX_LABELS_PER_RUN = 5

const APPLIED_LABELS_KEY_PREFIX = "sigilix-applied-labels"
// 90 days — long enough that a PR closed for review and reopened
// later still has its applied-labels record. Re-runs refresh the
// TTL automatically.
const APPLIED_LABELS_TTL_SECONDS = 90 * 24 * 60 * 60

const PROMPT_DIFF_LIMIT = 12_000
const PROMPT_BODY_LIMIT = 2_000

const STATUS_LABEL_DENYLIST: ReadonlySet<string> = new Set([
  "blocked",
  "duplicate",
  "good first issue",
  "help wanted",
  "invalid",
  "in progress",
  "needs triage",
  "question",
  "ready for review",
  "triage",
  "wont fix",
  "wontfix",
  "won't fix",
])

export interface PrLabelArgs {
  owner: string
  repo: string
  prNumber: number
  headSha: string
  installationId: number
  env: Env
}

export async function handlePrLabels(args: PrLabelArgs): Promise<void> {
  const { owner, repo, prNumber, headSha, installationId, env } = args
  const tag = { owner, repo, pr_number: prNumber, head_sha: headSha.slice(0, 7) }

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.warn(JSON.stringify({
      event: "pr-labels-skipped",
      reason: "missing-creds",
      ...tag,
    }))
    return
  }

  // CodeRabbit catch on PR #81: a rejection from getInstallationToken
  // would escape `handlePrLabels` and bypass the rest of the
  // best-effort failure pattern (logged skip + clean return). Wrap
  // explicitly. Token-mint failures are typically auth/permissions
  // misconfigurations — surface them in telemetry instead of
  // propagating up the queue handler.
  let client: GitHubClient
  try {
    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    client = new GitHubClient({ token })
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-labels-skipped",
      reason: "token-fetch-failed",
      ...tag,
      err: err instanceof Error ? err.message : String(err),
    }))
    return
  }

  // 1. Load sigilix.json — labels are default-on, but repos can opt
  //    out with `labels.enabled:false`.
  const config = await loadSigilixConfig(client, owner, repo, headSha)
  const customLabels = config.customLabels
  if (!isPrLabelsEnabled(config)) {
    console.log(JSON.stringify({
      event: "pr-labels-skipped",
      reason: "labels-disabled",
      ...tag,
    }))
    return
  }

  // 2. Gather PR context + label candidates in parallel. `meta`
  //    carries the PR's currently-applied labels in `meta.labels`,
  //    so we don't need a separate list call.
  let meta, diff, repoLabels: Array<{ name: string; description: string }>
  try {
    [meta, diff, repoLabels] = await Promise.all([
      client.getPullRequest(owner, repo, prNumber),
      client.getPullRequestDiff(owner, repo, prNumber),
      client.listRepositoryLabels(owner, repo),
    ])
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-labels-fetch-failed",
      ...tag,
      err: err instanceof Error ? err.message : String(err),
    }))
    return
  }

  // Stale-head guard: if a newer commit has landed since we were
  // enqueued, skip — a fresh pr-labels message will be enqueued for
  // the new head. Re-running here would apply labels based on a
  // diff that no longer represents the current PR state.
  if (meta.head?.sha && meta.head.sha !== headSha) {
    console.log(JSON.stringify({
      event: "pr-labels-skipped",
      reason: "stale-head",
      ...tag,
      current_head: meta.head.sha.slice(0, 7),
    }))
    return
  }

  // 3. Build candidate pool. If `customLabels` is present, it is the
  //    curated allowlist. Otherwise, derive candidates from existing
  //    repo labels with descriptions. Status/workflow labels are
  //    excluded in either mode so Sigilix doesn't apply triage state.
  const candidates = buildLabelCandidates(customLabels, repoLabels)
  if (candidates.length === 0) {
    console.log(JSON.stringify({
      event: "pr-labels-skipped",
      reason: "no-candidate-labels",
      ...tag,
    }))
    return
  }

  // code-reviewer HIGH catch on commit 2: GitHub's POST /labels
  // auto-creates labels that don't exist on the repo. A typo in
  // `customLabels` (e.g. `area:secuirty`) would silently mint a
  // phantom label that lives forever. Surface a warning per
  // unmatched customLabel name so operators can spot typos in
  // logs. We don't reject the label — auto-create is sometimes
  // intentional (first-time setup) — but the visibility avoids the
  // silent-phantom failure mode.
  if (customLabels && customLabels.length > 0) {
    const repoLabelNames = new Set(repoLabels.map((r) => r.name))
    for (const cl of customLabels) {
      if (isStatusLabel(cl.name)) {
        console.warn(JSON.stringify({
          event: "pr-labels-custom-label-denied",
          ...tag,
          label: cl.name,
          note: "Status/triage labels are not auto-applied by Sigilix.",
        }))
        continue
      }
      if (!repoLabelNames.has(cl.name)) {
        console.warn(JSON.stringify({
          event: "pr-labels-custom-label-not-in-repo",
          ...tag,
          label: cl.name,
          note: "Label doesn't exist on the repo yet; GitHub will auto-create on first apply. Confirm the name isn't a typo of an existing label.",
        }))
      }
    }
  }

  // 4. Ollama call — pick labels from the candidate pool.
  const prompt = buildLabelPrompt({
    title: meta.title,
    body: meta.body ?? "",
    diff,
    candidates,
  })
  const model = env.OPENCLAW_MODEL ?? DEFAULT_MODEL
  let response: string
  try {
    ;({ text: response } = await generate({
      model,
      prompt,
      apiKey: env.OLLAMA_API_KEY,
      format: PR_LABEL_SCHEMA as unknown as Record<string, unknown>,
    }))
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-labels-ollama-failed",
      ...tag,
      err: err instanceof Error ? err.message : String(err),
    }))
    return
  }

  const picked = parseLabelResponse(response)
  if (picked === null) {
    console.warn(JSON.stringify({
      event: "pr-labels-parse-failed",
      ...tag,
      response_length: response.length,
    }))
    return
  }

  // code-reviewer MEDIUM catch on commit 2: Ollama generate can take
  // 10-60s. A push that lands during generation would leave us
  // applying labels derived from the OLD diff to a PR whose head has
  // moved on. Re-fetch + re-check before mutating labels. One extra
  // REST call per labelling run; cheap vs the cost of mislabelling.
  try {
    const fresh = await client.getPullRequest(owner, repo, prNumber)
    if (fresh.head?.sha && fresh.head.sha !== headSha) {
      console.log(JSON.stringify({
        event: "pr-labels-skipped",
        reason: "stale-head-post-ollama",
        ...tag,
        current_head: fresh.head.sha.slice(0, 7),
      }))
      return
    }
  } catch (err) {
    // Re-fetch failure: bail out rather than applying labels with
    // unverified head state. The next push will re-fire pr-labels.
    console.warn(JSON.stringify({
      event: "pr-labels-skipped",
      reason: "stale-head-recheck-failed",
      ...tag,
      err: err instanceof Error ? err.message : String(err),
    }))
    return
  }

  // 5. Filter to candidates only — drop model hallucinations.
  const validNames = new Set(candidates.map((c) => c.name))
  const desired = [...new Set(picked.filter((n) => validNames.has(n)))].slice(0, MAX_LABELS_PER_RUN)

  // 6. Compute add/remove deltas against the current PR labels +
  //    the KV-tracked "Sigilix applied" record.
  const currentLabels = new Set(
    (meta.labels ?? []).map((l) => l.name).filter((n): n is string => typeof n === "string"),
  )
  const previouslyApplied = await readAppliedLabels(env, owner, repo, prNumber)
  const desiredSet = new Set(desired)

  const toAdd = desired.filter((n) => !currentLabels.has(n))
  // Only remove labels Sigilix applied previously AND no longer wants.
  // Never touches human-applied labels (they aren't in `previouslyApplied`).
  const toRemove = previouslyApplied.filter((n) => !desiredSet.has(n))

  // 7. Apply.
  const addedSuccessfully: string[] = []
  if (toAdd.length > 0) {
    try {
      await client.addLabelsToIssue(owner, repo, prNumber, toAdd)
      addedSuccessfully.push(...toAdd)
      console.log(JSON.stringify({
        event: "pr-labels-applied", ...tag, labels: toAdd,
      }))
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pr-labels-apply-failed",
        ...tag,
        labels: toAdd,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }
  const removedSuccessfully: string[] = []
  for (const name of toRemove) {
    try {
      await client.removeLabelFromIssue(owner, repo, prNumber, name)
      removedSuccessfully.push(name)
    } catch (err) {
      console.warn(JSON.stringify({
        event: "pr-labels-remove-failed",
        ...tag, label: name,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }
  if (removedSuccessfully.length > 0) {
    console.log(JSON.stringify({
      event: "pr-labels-removed", ...tag, labels: removedSuccessfully,
    }))
  }

  // 8. Update KV applied-labels record.
  const nextApplied = new Set<string>()
  // Carry forward previously-applied labels that we DIDN'T remove
  // AND are still desired.
  for (const n of previouslyApplied) {
    if (desiredSet.has(n) && !removedSuccessfully.includes(n)) nextApplied.add(n)
  }
  // Add successful new applications.
  for (const n of addedSuccessfully) nextApplied.add(n)
  await writeAppliedLabels(env, owner, repo, prNumber, [...nextApplied])
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function buildLabelPrompt(ctx: {
  title: string
  body: string
  diff: string
  candidates: ReadonlyArray<{ name: string; description: string }>
}): string {
  const candidatesBlock = ctx.candidates
    .map((c) => `- \`${c.name}\`: ${c.description}`)
    .join("\n")
  const truncatedBody = ctx.body.length > PROMPT_BODY_LIMIT
    ? ctx.body.slice(0, PROMPT_BODY_LIMIT - 12) + "\n[…truncated]"
    : ctx.body
  const truncatedDiff = ctx.diff.length > PROMPT_DIFF_LIMIT
    ? ctx.diff.slice(0, PROMPT_DIFF_LIMIT - 12) + "\n[…truncated]"
    : ctx.diff
  return [
    "[SYSTEM INSTRUCTIONS]",
    PR_LABEL_PROMPT.trim(),
    "",
    "[CANDIDATE LABELS]",
    candidatesBlock,
    "",
    "[PR TITLE]",
    ctx.title,
    "",
    "[PR BODY]",
    truncatedBody.length > 0 ? truncatedBody : "(no description)",
    "",
    "[DIFF]",
    truncatedDiff,
    "",
    "[OUTPUT]",
    "Return only the JSON object.",
  ].join("\n")
}

export function buildLabelCandidates(
  customLabels: ReadonlyArray<{ name: string; description: string }> | undefined,
  repoLabels: ReadonlyArray<{ name: string; description: string }>,
): Array<{ name: string; description: string }> {
  const source = customLabels !== undefined ? customLabels : repoLabels
  const candidatesByName = new Map<string, { name: string; description: string }>()
  for (const label of source) {
    if (label.description.length === 0) continue
    if (isStatusLabel(label.name)) continue
    if (!candidatesByName.has(label.name)) {
      candidatesByName.set(label.name, label)
    }
  }
  return [...candidatesByName.values()]
}

function isStatusLabel(name: string): boolean {
  return STATUS_LABEL_DENYLIST.has(normalizeLabelName(name))
}

function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ")
}

export function parseLabelResponse(text: string): string[] | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null
  if (!Array.isArray(obj.labels)) return null
  const out: string[] = []
  for (const v of obj.labels) {
    if (typeof v === "string" && v.trim().length > 0) out.push(v.trim())
  }
  return out
}

function appliedLabelsKey(owner: string, repo: string, prNumber: number): string {
  return `${APPLIED_LABELS_KEY_PREFIX}:${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}`
}

async function readAppliedLabels(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  try {
    const raw = await env.OPENCLAW_STATE.get(appliedLabelsKey(owner, repo, prNumber))
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    // Corrupt KV value or KV outage → treat as empty. Worst case: we
    // can't remove a previously-Sigilix-applied label this run, which
    // re-converges on the next push.
    return []
  }
}

async function writeAppliedLabels(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
  labels: ReadonlyArray<string>,
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(
      appliedLabelsKey(owner, repo, prNumber),
      JSON.stringify(labels),
      { expirationTtl: APPLIED_LABELS_TTL_SECONDS },
    )
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-labels-kv-write-failed",
      owner, repo, pr_number: prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
}
