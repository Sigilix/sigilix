// Port: the runner-receipt READ/lookup seam (SIG-184 / SIG-285). This is a
// LOOKUP, not a sink — at review time the ensemble resolves whether a verified
// runner receipt exists for `(repositoryId, pull_number)` and binds it to the
// PR's current merge sha. The adapter (PR 10/11) holds `env` + the DO/KV handles
// and implements `lookup`; `env` is adapter-internal and never appears here.
// Types only.
//
// COUPLING NOTE (reported): the result type `RunnerEvidenceState` lives in
// `@/lib/runner-evidence/lookup` (a lib sibling), so importing it here would be a
// lateral/outward dependency the dependency-rule forbids. A minimal-but-faithful
// shape is declared LOCALLY below (it mirrors that type's discriminated union).
// When `RunnerEvidenceState` is extracted to a leaf, this port should import it.

/**
 * The three first-class runner-evidence states. Mirrors `RunnerEvidenceState` in
 * `@/lib/runner-evidence/lookup`. Fail-closed: a transient hole is
 * `evidence-pending`, NEVER a false `verified`.
 */
export type RunnerEvidenceState =
  | {
      state: "verified"
      /** The verified SARIF (the stored, integrity-checked body). */
      sarif: string
      /** BOUND value from the receipt — render THIS, never the SARIF's own. */
      repository: string
      /** OIDC-signed merge sha (== the PR's merge_commit_sha at review time). */
      sha: string
      pullNumber: number
      runId: string
      runAttempt: string
    }
  | { state: "evidence-pending"; reason: string }
  | { state: "runner-absent" }

export interface RunnerReceiptPort {
  /**
   * Resolve the runner-evidence state for a review of `(repositoryId, prNumber)`
   * whose current merge commit is `mergeCommitSha`. Missing inputs →
   * `runner-absent`; transient holes → `evidence-pending`.
   */
  lookup(
    repositoryId: string,
    prNumber: number,
    mergeCommitSha: string,
  ): Promise<RunnerEvidenceState>
}
