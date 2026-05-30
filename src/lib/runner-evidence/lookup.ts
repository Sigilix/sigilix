// SIG-184 PR 3 — review-time consumption of a verified runner receipt.
//
// At review time, look up the receipt for (repositoryId, headSha) — the REVIEW
// join key, NOT the OIDC/replay sha — via the authoritative DO, integrity-check
// the stored SARIF body against the DO's hash, validate the SARIF is internally
// consistent with the BOUND repo/sha (the believability boundary), and return
// one of three first-class states.
//
// THE BELIEVABILITY BOUNDARY (load-bearing): the receipt attests "a GitHub-signed
// run of OUR pinned workflow on (repository, headSha) produced this exact SARIF
// (by hash)" — NOT "the SARIF's self-described provenance is trustworthy". So the
// rendered repo/sha MUST come from the receipt row (the bound values), never the
// SARIF body; and if the SARIF's own `versionControlProvenance` is present-and-
// inconsistent with the bound head sha / repo, we DEMOTE to evidence-pending
// rather than show inconsistent findings under a "verified" stamp.

import type { Env } from "../../index"
import { queryRunnerReceiptByHead } from "../runner-receipt-client"

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
      sha: string
      headSha: string
      runId: string
      runAttempt: string
    }
  // A receipt (or a transient hole) exists but isn't yet renderable-as-verified.
  | { state: "evidence-pending"; reason: string }
  // No receipt for this (repo, head) — the runner isn't producing evidence here.
  | { state: "runner-absent" }

async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** `https://github.com/owner/repo[...]` | `owner/repo` → `owner/repo` (lowercased), or null. */
function extractOwnerRepo(uri: string): string | null {
  const cleaned = uri.replace(/^https?:\/\/[^/]+\//i, "").replace(/\.git$/i, "")
  const segs = cleaned.split("/").filter(Boolean)
  return segs.length >= 2 ? `${segs[0]}/${segs[1]}`.toLowerCase() : null
}

/**
 * The SARIF's own VCS provenance (if present) must agree with the BOUND head
 * sha + repository. Absent provenance is accepted (the badge attests the receipt,
 * not the SARIF self-provenance). Never throws — a malformed SARIF demotes.
 */
export function validateRunnerSarifConsistency(
  rawSarif: string,
  bound: { headSha: string; repository: string },
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
  const boundSha = bound.headSha.toLowerCase()
  const boundRepo = bound.repository.toLowerCase()
  for (const run of runs) {
    const vcsList = run && typeof run === "object" ? (run as { versionControlProvenance?: unknown }).versionControlProvenance : undefined
    if (!Array.isArray(vcsList)) continue
    for (const v of vcsList) {
      if (!v || typeof v !== "object") continue
      const revisionId = (v as { revisionId?: unknown }).revisionId
      // Compare against the BOUND HEAD sha (the runner checks out + scans head),
      // not the OIDC merge sha.
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
 * Resolve the runner-evidence state for a review of (repositoryId, headSha).
 * Fail-closed: a missing/empty repositoryId yields `runner-absent` (never key a
 * verified lookup off an absent id). Transient holes (DO error, missing KV body,
 * integrity mismatch, inconsistent SARIF) yield `evidence-pending`, NEVER a false
 * `verified`.
 */
export async function lookupRunnerEvidence(
  env: Env,
  repositoryId: string,
  headSha: string,
): Promise<RunnerEvidenceState> {
  if (!repositoryId || !headSha) return { state: "runner-absent" }

  let row
  try {
    row = await queryRunnerReceiptByHead(env, repositoryId, headSha.toLowerCase())
  } catch {
    // A DO failure is transient — don't claim "absent" (that would render
    // "no runner" while the receipt may be there).
    return { state: "evidence-pending", reason: "receipt-store-error" }
  }
  if (!row) return { state: "runner-absent" }

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

  // Believability boundary: SARIF-internal consistency with the bound head/repo.
  const consistency = validateRunnerSarifConsistency(body.sarif, { headSha: row.headSha, repository: row.repository })
  if (!consistency.ok) {
    return { state: "evidence-pending", reason: `sarif-inconsistent:${consistency.reason}` }
  }

  return {
    state: "verified",
    sarif: body.sarif,
    repository: row.repository, // BOUND value — never the SARIF's self-described repo
    sha: row.sha,
    headSha: row.headSha,
    runId: row.runId,
    runAttempt: row.runAttempt,
  }
}
