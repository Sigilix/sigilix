// SIG-184 PR 2 — POST /runner/ingest: the runner SARIF/receipt ingest endpoint.
//
// A Sigilix reusable workflow in the customer's CI runs the deterministic tools,
// requests a GitHub Actions OIDC token (`id-token: write`), and POSTs the SARIF
// + token here. This route is the "defensible receipt" trust root: it verifies
// the token (PR 1's runner-oidc), runs the provenance gate (binding the token to
// the SARIF's repo+sha), enforces single-use (RunnerReceiptDO), and persists a
// hash-backed receipt. It deliberately does NOT feed findings into the live
// review or render a check-run state (PR 3), nor emit presence metrics (PR 5).
//
// Ordering is load-bearing (DoS + correctness):
//   - verify the token from the HEADER before buffering the (≤2 MiB) body, so an
//     unauthenticated caller can't force a 2 MiB read; and
//   - run the provenance gate BEFORE the (heavier) SARIF parse, so a merely-
//     authenticated-but-unauthorized caller never reaches the parse.

import type { Env } from "../index"
import { verifyGitHubOidcToken } from "./runner-oidc/verify"
import { validateRunnerProvenance } from "./runner-oidc/provenance"
import type { GitHubOidcClaims } from "./runner-oidc/types"
import { makeCachedFetchJwks, forcedRefetchAvailable } from "./runner-oidc/jwks-cache"
import { parseSarif } from "./sarif-evidence/sarif-parser"
import { claimRunnerReceipt } from "./runner-receipt-client"

/** SARIF body cap — mirrors the sarif-evidence runner's REPORT_SIZE_CAP_BYTES. */
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** A JWT is ~1–2 KB; reject an absurd Authorization header before verifying. */
const MAX_TOKEN_BYTES = 8 * 1024
/** Audit-receipt retention (the replay guard lives in the DO at 7 d). */
const RECEIPT_TTL_SECONDS = 30 * 24 * 60 * 60

const SECRET_PATTERNS: RegExp[] = [
  /gh[poustr]_[A-Za-z0-9_]{36,}/g, // classic GitHub token
  /github_pat_[A-Za-z0-9_]{60,}/g, // fine-grained PAT (NOT matched by gh[poustr]_)
  /sk-[A-Za-z0-9]{40,}/g, // OpenAI-style
  /xox[baprs]-[A-Za-z0-9-]{20,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access-key ID
  /(?:aws_secret_access_key|aws_secret_key)["'\s:=]{1,4}[A-Za-z0-9/+]{40}/gi, // AWS secret material (name-anchored to avoid mangling SARIF base64)
]

const BEARER_RE = /^Bearer\s+(.+)$/

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

// Scrub secrets ONLY — do NOT truncate. A byte-truncated SARIF is invalid JSON,
// so the consumption path could never parse it (CR): the receipt would be
// `accepted` yet permanently unverifiable. The body is already bounded to
// MAX_BODY_BYTES (2 MiB) by readBodyCapped, and scrubbing only shrinks (every
// secret pattern is longer than `[REDACTED]`), so the stored blob stays
// parseable + well under KV's 25 MiB value limit.
function scrubSecrets(input: string): string {
  let s = input
  for (const p of SECRET_PATTERNS) s = s.replace(p, "[REDACTED]")
  return s
}

async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0
}

/**
 * Read the request body as text, enforcing a BYTE cap as the stream is consumed
 * (so an oversized body is aborted, not fully buffered). Returns `null` once the
 * cap is exceeded. A cheap Content-Length precheck short-circuits the obvious
 * case; the stream count is the real guard (CL can be absent or lie low).
 */
async function readBodyCapped(request: Request, maxBytes: number): Promise<string | null> {
  const cl = Number(request.headers.get("content-length") ?? "")
  if (Number.isFinite(cl) && cl > maxBytes) return null
  const body = request.body
  if (!body) {
    const t = await request.text()
    return new TextEncoder().encode(t).byteLength > maxBytes ? null : t
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(merged)
}

interface IngestEnvelope {
  sarif: string
  /** The run's `owner/repo` — bound to the token's `repository` claim (anti-spoof). */
  repository: string
  /** The run's commit sha (== github.sha; the MERGE commit for a PR) — bound to
   *  the token's `sha` claim. The PR number + repo id are taken from the SIGNED
   *  claims (`claims.ref` / `claims.repository_id`), never from the body. */
  sha: string
  /** Optional immutable repo id, bound to the token's `repository_id` if present. */
  repositoryId?: string | undefined
}

export async function handleRunnerIngestRoute(request: Request, env: Env): Promise<Response> {
  // (1) Config gate — the audience and the pinned workflow-ref must both be set
  // (they come from the Sigilix runner repo; until then every ingest is 503).
  const expectedAudience = env.OPENCLAW_RUNNER_OIDC_AUDIENCE?.trim()
  const workflowRef = env.OPENCLAW_RUNNER_WORKFLOW_REF?.trim()
  if (!expectedAudience || !workflowRef) {
    return json({ error: "runner_ingest_not_configured" }, 503)
  }

  // (2) Extract the OIDC JWT from `Authorization: Bearer` — NO body read yet.
  const authz = request.headers.get("authorization") ?? ""
  if (authz.length > MAX_TOKEN_BYTES) return json({ error: "unauthorized", reason: "token-too-large" }, 401)
  const token = BEARER_RE.exec(authz)?.[1]?.trim()
  if (!token) return json({ error: "unauthorized", reason: "missing-bearer" }, 401)

  // (3) Verify the token (cached JWKS). On `unknown-kid`, retry ONCE forcing a
  // (throttled) JWKS refetch so a freshly-rotated GitHub key isn't a 401.
  let verified = await verifyGitHubOidcToken(token, { expectedAudience, fetchJwks: makeCachedFetchJwks() })
  if (!verified.ok && verified.reason === "unknown-kid") {
    if (!forcedRefetchAvailable()) {
      // A forced JWKS refresh is cooling down (recent forced refetch). The kid
      // may be a freshly-rotated GitHub key our cache hasn't picked up — tell the
      // runner to RETRY rather than hard-fail a legit run (a genuinely unknown
      // kid will still 401 on a later retry once the cooldown elapses).
      return new Response(
        JSON.stringify({ error: "jwks-refresh-throttled", reason: "retry" }),
        { status: 503, headers: { "content-type": "application/json", "retry-after": "60" } },
      )
    }
    verified = await verifyGitHubOidcToken(token, {
      expectedAudience,
      fetchJwks: makeCachedFetchJwks({ forceRefetch: true }),
    })
  }
  if (!verified.ok) return json({ error: "unauthorized", reason: verified.reason }, 401)
  const claims: GitHubOidcClaims = verified.claims

  // (4) Require every VERIFIED identifier the receipt key is built from — never
  // key off an absent/attacker-omitted claim. run_attempt distinguishes re-runs.
  const repositoryId = typeof claims.repository_id === "string" ? claims.repository_id : ""
  const tokenRepository = typeof claims.repository === "string" ? claims.repository : ""
  const tokenSha = typeof claims.sha === "string" ? claims.sha : ""
  const runId = typeof claims.run_id === "string" ? claims.run_id : ""
  const runAttempt = typeof claims.run_attempt === "string" ? claims.run_attempt : ""
  if (!repositoryId || !tokenRepository || !tokenSha || !runId || !runAttempt) {
    return json({ error: "missing-claim", reason: "token lacks repository_id/repository/sha/run_id/run_attempt" }, 400)
  }

  // (5) Now read the body (post-auth) with a real BYTE cap enforced as the
  // stream is consumed — `request.text()` would buffer the whole body first, and
  // any GitHub workflow can mint a token for our audience, so this path is
  // broadly reachable before provenance. `null` = over the cap.
  let rawBody: string
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null) return json({ error: "payload-too-large" }, 413)
    rawBody = capped
  } catch {
    return json({ error: "invalid-body" }, 400)
  }

  let envelope: IngestEnvelope
  try {
    const parsedBody = JSON.parse(rawBody) as unknown
    if (typeof parsedBody !== "object" || parsedBody === null) throw new Error("not an object")
    const o = parsedBody as Record<string, unknown>
    if (!nonEmptyString(o.sarif) || !nonEmptyString(o.repository) || !nonEmptyString(o.sha)) {
      return json({ error: "bad-envelope", reason: "sarif, repository, sha required" }, 400)
    }
    envelope = {
      sarif: o.sarif,
      repository: o.repository,
      sha: o.sha,
      repositoryId: typeof o.repositoryId === "string" ? o.repositoryId : undefined,
    }
  } catch {
    return json({ error: "invalid-json" }, 400)
  }

  // (6) Provenance gate BEFORE the SARIF parse. repo+sha here are the SARIF's
  // (envelope) — the gate checks the TOKEN's claims against them. This is the
  // load-bearing binding: a token minted in an attacker's fork can't vouch for a
  // victim repo's findings.
  const provenance = validateRunnerProvenance(claims, {
    workflowRef,
    repository: envelope.repository,
    sha: envelope.sha,
    // Pass repositoryId only when provided — exactOptionalPropertyTypes forbids
    // an explicit `undefined` for an optional field.
    ...(envelope.repositoryId !== undefined ? { repositoryId: envelope.repositoryId } : {}),
  })
  if (!provenance.ok) return json({ error: "forbidden", reason: provenance.reason }, 403)

  // (7) Heavier SARIF well-formedness check (post-authorization).
  const parsed = parseSarif(envelope.sarif)
  if (!parsed.ok) return json({ error: "bad-sarif", reason: parsed.reason }, 400)

  // BELIEVABILITY BOUNDARY (read before extending or consuming this receipt):
  // the receipt binds the VERIFIED token to (repository, sha, run_id,
  // run_attempt) + the SARIF content HASH — NOT the SARIF document's internal
  // claims. `parseSarif` is a well-formedness gate only; its parsed body is
  // deliberately not trusted here. A fork-minted token legitimately passes
  // provenance for the attacker's OWN (repo, sha), yet the SARIF body could
  // self-describe a DIFFERENT repo/commit (versionControlProvenance, finding
  // paths). So PR 3 (consumption) MUST render provenance from the receipt's bound
  // repository/sha — NEVER the SARIF's self-described repo/commit — and validate
  // SARIF-internal consistency (paths, revisionId) against the bound sha before
  // surfacing any finding as "verified".

  // (8) Hash the EXACT received SARIF (before scrubbing) — the receipt is
  // content-addressed so a replay is told apart from a conflicting resubmit.
  const sarifSha256 = await sha256Hex(envelope.sarif)
  // The persisted body is SCRUBBED (secrets redacted); hash the scrubbed bytes so
  // consumption can integrity-check the stored body. The raw `sarifSha256` stays
  // the GitHub-attested receipt identity.
  const scrubbedSarif = scrubSecrets(envelope.sarif)
  const scrubbedSha256 = await sha256Hex(scrubbedSarif)
  // The REVIEW-JOIN key is the PR number, parsed from the SIGNED `claims.ref`
  // (`refs/pull/{N}/merge`) — NEVER the untrusted body (CR-4: a body head_sha let
  // a same-repo run retarget another PR's review). The replay key stays
  // `claims.sha` (the merge commit), and the review binds the receipt by checking
  // that `sha` == the PR's GitHub `merge_commit_sha`. A non-pull_request run has
  // no PR ref → pullNumber 0 (stored as an audit record, but never PR-joinable).
  const refMatch = typeof claims.ref === "string" ? /^refs\/pull\/(\d+)\/merge$/.exec(claims.ref) : null
  // `\d+` is unbounded, so a pathological ref could exceed Number.MAX_SAFE_INTEGER
  // (not exploitable — the repository_id scope + merge-sha bind still apply — but a
  // non-safe-integer pull_number is meaningless; treat it as a non-PR run).
  const parsedPull = refMatch ? Number(refMatch[1]) : 0
  const pullNumber = Number.isSafeInteger(parsedPull) ? parsedPull : 0

  // (9) Atomic single-use claim. The DO row IS the defensible receipt; it's
  // keyed off VERIFIED claims (post-provenance these equal the envelope's).
  let claim
  try {
    claim = await claimRunnerReceipt(env, {
      repositoryId,
      sha: tokenSha,
      pullNumber,
      runId,
      runAttempt,
      sarifSha256,
      scrubbedSha256,
      repository: tokenRepository,
      jobWorkflowRef: typeof claims.job_workflow_ref === "string" ? claims.job_workflow_ref : "",
      runnerEnvironment: typeof claims.runner_environment === "string" ? claims.runner_environment : "",
    })
  } catch (err) {
    console.error(JSON.stringify({ event: "runner-evidence-receipt-do-error", repositoryId, sha: tokenSha, error: String(err) }))
    return json({ error: "receipt-store-unavailable" }, 503)
  }

  // A DIFFERENT SARIF for the same run is a conflict (409); an identical one is
  // an idempotent CI retry (200, so a lost-response re-POST is safe).
  if (claim.outcome === "conflict") {
    console.warn(JSON.stringify({ event: "runner-evidence-receipt-conflict", repositoryId, sha: tokenSha, runId, runAttempt }))
    return json({ error: "receipt-conflict", reason: "a different SARIF was already received for this run" }, 409)
  }

  // (10) Persist the bulky scrubbed SARIF to KV — best-effort (the DO already
  // committed the defensible record). On `accepted` write it; on `duplicate`
  // BACKFILL it only if absent — a prior accept's KV put may have failed
  // transiently (it's swallowed below), leaving a bodyless receipt that the
  // idempotent retry now repairs. Keyed for (repoId, sha) lookup by PR 3.
  if (claim.outcome === "accepted" || claim.outcome === "duplicate") {
    const kvKey = `runner-receipt:repo:${repositoryId}:${tokenSha}:${runId}:${runAttempt}`
    try {
      const needsWrite = claim.outcome === "accepted" || (await env.OPENCLAW_STATE.get(kvKey)) === null
      if (needsWrite) {
        await env.OPENCLAW_STATE.put(
          kvKey,
          JSON.stringify({
            schemaVersion: 1,
            repository: tokenRepository,
            repositoryId,
            sha: tokenSha,
            pullNumber,
            runId,
            runAttempt,
            jobWorkflowRef: claims.job_workflow_ref,
            runnerEnvironment: claims.runner_environment,
            sarifSha256,
            scrubbedSha256,
            sarif: scrubbedSarif,
            ingestedAt: new Date().toISOString(),
          }),
          { expirationTtl: RECEIPT_TTL_SECONDS },
        )
      }
    } catch (err) {
      // Non-fatal — the single-use record + defensible receipt already committed.
      console.warn(JSON.stringify({ event: "runner-evidence-receipt-kv-error", repositoryId, sha: tokenSha, error: String(err) }))
    }
  }

  console.log(JSON.stringify({
    event: "runner-evidence-received",
    repositoryId,
    repository: tokenRepository,
    sha: tokenSha,
    runId,
    runAttempt,
    outcome: claim.outcome,
    sarifSha256,
    runnerEnvironment: claims.runner_environment,
  }))

  return json(
    {
      ok: true,
      outcome: claim.outcome, // "accepted" | "duplicate"
      receipt: { repository: tokenRepository, sha: tokenSha, runId, runAttempt, sarifSha256 },
    },
    200,
  )
}
