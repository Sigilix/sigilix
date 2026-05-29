// SIG-184 (worker-side runner-evidence ingest) — GitHub Actions OIDC token
// shapes + verification/provenance results.
//
// The runner (a Sigilix reusable workflow in the customer's CI) authenticates
// its SARIF/receipt POST with a GitHub Actions OIDC token (`id-token: write`).
// The worker VERIFIES that token (RS256 against GitHub's JWKS) and then runs
// the PROVENANCE gate (per the ADR): the token must come from Sigilix's pinned
// reusable workflow (`job_workflow_ref`), a github-hosted runner
// (`runner_environment`) unless an ephemeral self-host is attested, and its
// repo/SHA must match the SARIF metadata. This is the load-bearing
// "defensible receipt" mechanism — without it, inbound SARIF is spoofable.

/** GitHub's Actions OIDC issuer + JWKS endpoint (well-known, stable). */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"
export const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`

/** A JSON Web Key (RSA public key) from GitHub's JWKS. */
export interface Jwk {
  kid: string
  kty: string
  alg?: string
  use?: string
  n: string
  e: string
}

/**
 * The subset of GitHub Actions OIDC claims the provenance gate reads. GitHub
 * includes many more; we keep the type open (`[k: string]`) but name the
 * load-bearing ones. See GitHub's OIDC token claims reference.
 */
export interface GitHubOidcClaims {
  iss: string
  /** Audience — must equal the Sigilix-configured ingest audience. */
  aud: string | string[]
  /** Expiry (epoch seconds). GitHub OIDC tokens are short-lived (~minutes). */
  exp: number
  iat?: number
  nbf?: number
  sub?: string
  /** `owner/repo` of the workflow run. Matched against the SARIF metadata. */
  repository?: string
  repository_id?: string
  /** Commit SHA the run executed against. Matched against the SARIF head SHA. */
  sha?: string
  ref?: string
  /** The called reusable workflow at `owner/repo/path@ref` — the provenance pin. */
  job_workflow_ref?: string
  /** `github-hosted` | `self-hosted` — drives the isolation gate. */
  runner_environment?: string
  workflow?: string
  event_name?: string
  [k: string]: unknown
}

/** Result of cryptographic + standard-claim verification (NOT provenance). */
export type OidcVerifyResult =
  | { ok: true; claims: GitHubOidcClaims }
  | { ok: false; reason: OidcVerifyFailure }

export type OidcVerifyFailure =
  | "malformed-token"
  | "unsupported-alg"
  | "no-kid"
  | "unknown-kid"
  | "bad-signature"
  | "wrong-issuer"
  | "wrong-audience"
  | "expired"
  | "not-yet-valid"
  | "jwks-fetch-failed"

/** Result of the provenance gate (run AFTER a successful verify). */
export type ProvenanceResult = { ok: true } | { ok: false; reason: ProvenanceFailure }

export type ProvenanceFailure =
  | "workflow-ref-mismatch"
  | "non-github-hosted-runner"
  | "repository-mismatch"
  | "sha-mismatch"

/** What the provenance gate requires the token to attest. */
export interface ExpectedProvenance {
  /**
   * The EXACT `owner/repo/path` of Sigilix's pinned reusable workflow (NO
   * `@ref`) — the path part of the token's `job_workflow_ref` must EQUAL this.
   * Exact match, not a prefix: a bare `startsWith` would let a sibling repo
   * (`sigilix/runner-evil/...`) spoof the "this is OUR runner" gate. The
   * `@ref` portion is intentionally unconstrained — any ref of OUR workflow is
   * our code (the customer pins the ref; an attacker can't alter our repo).
   */
  workflowRef: string
  /** If set, the token's `repository` must equal this (the SARIF's repo). */
  repository?: string
  /** If set, the token's `sha` must equal this (the SARIF's head SHA). */
  sha?: string
  /** Allow a self-hosted runner (only when the tenant has attested ephemeral). Default false. */
  allowSelfHosted?: boolean
}
