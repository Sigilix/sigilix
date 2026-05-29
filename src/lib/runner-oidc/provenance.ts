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
 * Validate the load-bearing provenance claims. Order is deliberate: the
 * workflow-ref pin first (it's the "this is OUR runner" proof), then the
 * runner-environment isolation gate, then the repo/SHA binding to the SARIF.
 */
export function validateRunnerProvenance(
  claims: GitHubOidcClaims,
  expected: ExpectedProvenance,
): ProvenanceResult {
  const ref = typeof claims.job_workflow_ref === "string" ? claims.job_workflow_ref : ""
  // `job_workflow_ref` is `owner/repo/path@ref`. Split on the LAST `@` and
  // compare the path part for EXACT equality (not startsWith — a prefix would
  // admit a sibling repo like `sigilix/runner-evil/...`). The `@ref` is left
  // open (any ref of OUR workflow is our code).
  const atIdx = ref.lastIndexOf("@")
  const refPath = atIdx >= 0 ? ref.slice(0, atIdx) : ref
  if (refPath !== expected.workflowRef) {
    return { ok: false, reason: "workflow-ref-mismatch" }
  }
  // Isolation gate: a non-github-hosted runner is not ephemeral by default and
  // can't silently inherit the strong-isolation receipt (ADR / CodeRabbit).
  if (!expected.allowSelfHosted && claims.runner_environment !== GITHUB_HOSTED) {
    return { ok: false, reason: "non-github-hosted-runner" }
  }
  // Bind the token to the SARIF metadata so a token from one repo/SHA can't
  // vouch for another's findings.
  if (expected.repository !== undefined && claims.repository !== expected.repository) {
    return { ok: false, reason: "repository-mismatch" }
  }
  if (expected.sha !== undefined && claims.sha !== expected.sha) {
    return { ok: false, reason: "sha-mismatch" }
  }
  return { ok: true }
}
