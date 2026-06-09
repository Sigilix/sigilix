// SIG-184 PR 3 — review-time consumption of a verified runner receipt.
//
// At review time, look up the receipt for (repositoryId, pull_number) — the
// REVIEW join key, both SIGNED — via the authoritative DO, then BIND it by
// requiring the receipt's OIDC-signed merge sha to equal the PR's current
// merge_commit_sha (CR-4); integrity-check the stored SARIF body against the
// DO's hash, validate the SARIF is internally consistent with the BOUND
// repo/sha (the believability boundary), and return one of three first-class
// states.
//
// THE BELIEVABILITY BOUNDARY (load-bearing): the receipt attests "a GitHub-signed
// run of OUR pinned workflow on (repository, merge sha) produced this exact SARIF
// (by hash)" — NOT "the SARIF's self-described provenance is trustworthy". So the
// rendered repo/sha MUST come from the receipt row (the bound values), never the
// SARIF body; and if the SARIF's own `versionControlProvenance` is present-and-
// inconsistent with the bound merge sha / repo, we DEMOTE to evidence-pending
// rather than show inconsistent findings under a "verified" stamp.

import type { Env } from "../../shared/types/env"
import { queryRunnerReceiptByPull } from "../runner-receipt-client"

/**
 * Rollout posture for runner-evidence consumption (mirrors the graph/gate
 * shadow→post pattern):
 *   - `off`    (default): no lookup, no behavior change.
 *   - `shadow`: look up + emit telemetry + compute the state, but the review
 *               still uses the repo-pull SARIF (observe only).
 *   - `post`:   use the verified receipt's SARIF for the review + render the state.
 * Anything else is treated as `off` defensively.
 */
export type RunnerEvidenceMode = "off" | "shadow" | "post"

export function readRunnerEvidenceMode(env: Env): RunnerEvidenceMode {
  const raw = (env.OPENCLAW_RUNNER_EVIDENCE_MODE ?? "").trim().toLowerCase()
  if (raw === "shadow") return "shadow"
  if (raw === "post") return "post"
  return "off"
}

export type RunnerEvidenceState =
  | {
      state: "verified"
      /** The verified SARIF (the stored, integrity-checked body). */
      sarif: string
      /** BOUND values from the receipt — render THESE, never the SARIF's own. */
      repository: string
      /** The OIDC-signed merge sha (== the PR's merge_commit_sha at review time). */
      sha: string
      pullNumber: number
      runId: string
      runAttempt: string
    }
  // A receipt (or a transient hole) exists but isn't yet renderable-as-verified.
  | { state: "evidence-pending"; reason: string }
  // No receipt for this (repo, pull) — the runner isn't producing evidence here.
  | { state: "runner-absent" }

async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// Sentinel for a NON-GitHub host — can never equal a bound GitHub `owner/repo`,
// so a foreign-host provenance (e.g. `https://gitlab.com/owner/repo`) is treated
// as a MISMATCH, not silently normalized to a match (CR).
const FOREIGN_HOST = " foreign-host "

/**
 * `https://github.com/owner/repo[...]` | bare `owner/repo` → `owner/repo`
 * (lowercased). A URL with a non-`github.com` host → FOREIGN_HOST (forces a
 * mismatch). Unparseable → null (no constraint).
 */
function extractOwnerRepo(uri: string): string | null {
  const host = /^https?:\/\/([^/]+)\//i.exec(uri)?.[1]?.toLowerCase()
  if (host !== undefined && host !== "github.com") return FOREIGN_HOST
  const cleaned = uri.replace(/^https?:\/\/[^/]+\//i, "").replace(/\.git$/i, "")
  const segs = cleaned.split("/").filter(Boolean)
  return segs.length >= 2 ? `${segs[0]}/${segs[1]}`.toLowerCase() : null
}

/**
 * The SARIF's own VCS provenance (if present) must agree with the BOUND merge
 * sha + repository. Absent provenance is accepted (the receipt's signed binding
 * carries the proof; this is defense-in-depth). Never throws — a malformed SARIF
 * demotes.
 */
export function validateRunnerSarifConsistency(
  rawSarif: string,
  bound: { sha: string; repository: string },
): { ok: true } | { ok: false; reason: string } {
  let report: unknown
  try {
    report = JSON.parse(rawSarif)
  } catch {
    return { ok: false, reason: "sarif-parse" }
  }
  const runs = report && typeof report === "object" && Array.isArray((report as { runs?: unknown }).runs)
    ? (report as { runs: unknown[] }).runs
    : []
  const boundSha = bound.sha.toLowerCase()
  const boundRepo = bound.repository.toLowerCase()
  for (const run of runs) {
    const vcsList = run && typeof run === "object" ? (run as { versionControlProvenance?: unknown }).versionControlProvenance : undefined
    if (!Array.isArray(vcsList)) continue
    for (const v of vcsList) {
      if (!v || typeof v !== "object") continue
      const revisionId = (v as { revisionId?: unknown }).revisionId
      // The runner scans the MERGE checkout, so the SARIF's revisionId is the
      // merge commit == claims.sha == the bound sha.
      if (typeof revisionId === "string" && revisionId.toLowerCase() !== boundSha) {
        return { ok: false, reason: "revision-mismatch" }
      }
      const repositoryUri = (v as { repositoryUri?: unknown }).repositoryUri
      if (typeof repositoryUri === "string") {
        const ownerRepo = extractOwnerRepo(repositoryUri)
        if (ownerRepo !== null && ownerRepo !== boundRepo) {
          return { ok: false, reason: "repository-mismatch" }
        }
      }
    }
  }
  return { ok: true }
}

/**
 * Resolve the runner-evidence state for a review of `(repositoryId, prNumber)`
 * whose CURRENT merge commit is `mergeCommitSha` (sourced from GitHub's PR API).
 * The join is on the SIGNED `pull_number`; the receipt is then BOUND by requiring
 * its `sha` (the OIDC-signed merge commit) to equal `mergeCommitSha` — so a stale
 * receipt for an older merge, or any value the body could try to retarget, can't
 * pass (CR-4). Fail-closed: missing inputs → `runner-absent`; transient holes
 * (DO error, missing/mismatched body, inconsistent SARIF) → `evidence-pending`,
 * NEVER a false `verified`.
 */
export async function lookupRunnerEvidence(
  env: Env,
  repositoryId: string,
  prNumber: number,
  mergeCommitSha: string,
): Promise<RunnerEvidenceState> {
  if (!repositoryId || prNumber <= 0 || !mergeCommitSha) return { state: "runner-absent" }

  let row
  try {
    row = await queryRunnerReceiptByPull(env, repositoryId, prNumber)
  } catch {
    // A DO failure is transient — don't claim "absent" (that would render
    // "no runner" while the receipt may be there).
    return { state: "evidence-pending", reason: "receipt-store-error" }
  }
  if (!row) return { state: "runner-absent" }

  // BIND (the forge-proof step): the receipt's OIDC-signed merge sha must equal
  // the PR's current merge commit. A receipt for a different merge — an older
  // head, or any retarget — fails here, NOT a false verified.
  if (row.sha.toLowerCase() !== mergeCommitSha.toLowerCase()) {
    return { state: "evidence-pending", reason: "merge-sha-mismatch" }
  }

  // Fetch the bulky SARIF body by the receipt's exact (repoId, sha, run) key.
  const kvKey = `runner-receipt:repo:${repositoryId}:${row.sha}:${row.runId}:${row.runAttempt}`
  let body: { sarif?: unknown } | null = null
  try {
    body = (await env.OPENCLAW_STATE.get(kvKey, "json")) as { sarif?: unknown } | null
  } catch {
    body = null
  }
  if (!body || typeof body.sarif !== "string") {
    // The DO row exists (defensible record) but the KV body is missing — a prior
    // best-effort put failed and hasn't been backfilled yet. Pending, not absent.
    return { state: "evidence-pending", reason: "body-missing" }
  }

  // Integrity: the stored body must hash to the DO's recorded scrubbed hash, else
  // the KV body was tampered/corrupted — refuse to render it as verified.
  const bodyHash = await sha256Hex(body.sarif)
  if (bodyHash !== row.scrubbedSha256) {
    return { state: "evidence-pending", reason: "integrity-mismatch" }
  }

  // Believability boundary: SARIF-internal consistency with the bound merge/repo.
  const consistency = validateRunnerSarifConsistency(body.sarif, { sha: row.sha, repository: row.repository })
  if (!consistency.ok) {
    return { state: "evidence-pending", reason: `sarif-inconsistent:${consistency.reason}` }
  }

  return {
    state: "verified",
    sarif: body.sarif,
    repository: row.repository, // BOUND value — never the SARIF's self-described repo
    sha: row.sha,
    pullNumber: row.pullNumber,
    runId: row.runId,
    runAttempt: row.runAttempt,
  }
}
