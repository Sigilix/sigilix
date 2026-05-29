// SIG-184 — the provenance gate (run AFTER verifyGitHubOidcToken succeeds).
//
// A valid GitHub OIDC token only proves "GitHub issued this for some workflow
// run." The provenance gate is what makes the receipt a *defensible* proof
// (per the ADR): the run came from Sigilix's pinned reusable workflow, on a
// github-hosted runner (unless an ephemeral self-host is attested), for the
// repo + SHA the SARIF claims. Pure.

import type { ExpectedProvenance, GitHubOidcClaims, ProvenanceResult } from "./types"

const GITHUB_HOSTED = "github-hosted"

/**
 * Split a `owner/repo/path...` workflow ref into its case-INsensitive owner/repo
 * prefix (GitHub treats owner/repo so) and its case-SENSITIVE file path (GitHub
 * paths are). Comparing the whole string byte-for-byte would falsely reject a
 * legitimate `Sigilix/Runner/...` and silently drop the receipt to "unverified".
 */
function splitWorkflowPath(p: string): { ownerRepo: string; path: string } {
  const segs = p.split("/")
  return { ownerRepo: segs.slice(0, 2).join("/").toLowerCase(), path: segs.slice(2).join("/") }
}

/**
 * Validate the load-bearing provenance claims. Order is deliberate: the
 * workflow-ref pin first (it's the "this is OUR runner" proof), then the
 * runner-environment isolation gate, then the repo/repo-id/SHA binding to the
 * SARIF. `expected.repository` and `expected.sha` are REQUIRED by type, so the
 * gate cannot be called in a fail-OPEN way that skips the SARIF binding.
 */
export function validateRunnerProvenance(
  claims: GitHubOidcClaims,
  expected: ExpectedProvenance,
): ProvenanceResult {
  const ref = typeof claims.job_workflow_ref === "string" ? claims.job_workflow_ref : ""
  // `job_workflow_ref` is `owner/repo/path@ref`. Split on the LAST `@` and match
  // the path part exactly (NOT startsWith — a prefix would admit a sibling repo
  // like `sigilix/runner-evil/...`): owner/repo case-insensitively, file path
  // case-sensitively. The `@ref` is intentionally NOT constrained here (see the
  // ExpectedProvenance.workflowRef doc — the receipt attests OUR repo, not the
  // tool VERSION; pin-enforcement is a route-layer policy).
  const got = splitWorkflowPath(atIdxPath(ref))
  const want = splitWorkflowPath(expected.workflowRef)
  if (got.ownerRepo !== want.ownerRepo || got.path !== want.path) {
    return { ok: false, reason: "workflow-ref-mismatch" }
  }
  // Isolation gate: a non-github-hosted runner is not ephemeral by default and
  // can't silently inherit the strong-isolation receipt (ADR / CodeRabbit).
  if (!expected.allowSelfHosted && claims.runner_environment !== GITHUB_HOSTED) {
    return { ok: false, reason: "non-github-hosted-runner" }
  }
  // Bind the token to the SARIF metadata so a token minted by running our
  // reusable workflow in a DIFFERENT (e.g. forked) repo can't vouch for another's
  // findings. owner/repo is case-insensitive; the immutable numeric id (if the
  // route supplies it) is exact and defeats a repo-rename; the SHA is hex.
  if ((claims.repository ?? "").toLowerCase() !== expected.repository.toLowerCase()) {
    return { ok: false, reason: "repository-mismatch" }
  }
  if (expected.repositoryId !== undefined && claims.repository_id !== expected.repositoryId) {
    return { ok: false, reason: "repository-id-mismatch" }
  }
  if ((claims.sha ?? "").toLowerCase() !== expected.sha.toLowerCase()) {
    return { ok: false, reason: "sha-mismatch" }
  }
  return { ok: true }
}

/** Strip the `@ref` suffix (split on the LAST `@`) from a `job_workflow_ref`. */
function atIdxPath(ref: string): string {
  const atIdx = ref.lastIndexOf("@")
  return atIdx >= 0 ? ref.slice(0, atIdx) : ref
}
