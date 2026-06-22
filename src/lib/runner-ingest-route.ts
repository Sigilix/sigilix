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

import type { Env } from "@/src/shared/types/env"
import { verifyGitHubOidcToken } from "./runner-oidc/verify"
import { validateRunnerProvenance } from "./runner-oidc/provenance"
import type { GitHubOidcClaims } from "./runner-oidc/types"
import { makeCachedFetchJwks, forcedRefetchAvailable } from "./runner-oidc/jwks-cache"
import { parseSarif } from "@/src/features/sarif-evidence"
import { claimRunnerReceipt } from "./runner-receipt-client"
import { recordRunnerToolManifestMetric } from "./runner-tool-metrics-client"
import { isSafeRunnerToolId } from "@/src/shared/domain/runner-tool-catalog"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { GitHubClient } from "@/src/shared/adapters/github"
import { getInstallationToken, resolveRepoInstallationId } from "@/src/shared/adapters/github/github-app"
import type { JobMessage } from "@/src/shared/types/job"

// SARIF body cap. MUST mirror the sarif-evidence runner's REPORT_SIZE_CAP_BYTES
// (8 MiB): a receipt the ingest accepts but consumption later rejects as
// too-large would render a "verified" pill over a silently-dropped SARIF. 8 MiB
// (was 2 MiB) — a real semgrep run on a large repo exceeds 2 MiB (SIG-184
// dogfood 413); the scrubbed body still sits well under KV's 25 MiB.
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** A JWT is ~1–2 KB; reject an absurd Authorization header before verifying. */
const MAX_TOKEN_BYTES = 8 * 1024
/** The manifest is audit metadata, not another findings channel. */
const MAX_SCAN_MANIFEST_BYTES = 64 * 1024
/** Allows runner catalog growth without letting a receipt carry unbounded audit rows. */
const MAX_SCAN_MANIFEST_TOOLS = 64
const MAX_SCAN_MANIFEST_COUNT = 1_000_000
const MAX_SCAN_MANIFEST_PATH_CHARS = 1024
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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// Scrub secrets ONLY — do NOT truncate. A byte-truncated SARIF is invalid JSON,
// so the consumption path could never parse it (CR): the receipt would be
// `accepted` yet permanently unverifiable. The body is already bounded to
// MAX_BODY_BYTES (8 MiB) by readBodyCapped, and scrubbing only shrinks (every
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

const SCAN_MANIFEST_STATUSES = ["disabled", "missing-output", "invalid-output", "empty", "produced"] as const
type ScanManifestStatus = (typeof SCAN_MANIFEST_STATUSES)[number]
const SCAN_MANIFEST_STATUS_SET: ReadonlySet<string> = new Set(SCAN_MANIFEST_STATUSES)

export interface NormalizedScanManifestTool {
  toolId: string
  enabled: boolean
  status: ScanManifestStatus
  runCount?: number
  resultCount?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNonNegativeManifestCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCAN_MANIFEST_COUNT
}

export function scanManifestSummary(tools: readonly NormalizedScanManifestTool[]): Record<string, number> {
  const summary = { enabled: 0, produced: 0, empty: 0, missing: 0, invalid: 0 }
  for (const tool of tools) {
    if (!tool.enabled || tool.status === "disabled") continue
    summary.enabled += 1
    if (tool.status === "missing-output") summary.missing += 1
    else if (tool.status === "invalid-output") summary.invalid += 1
    else if (tool.status === "empty" || tool.status === "produced") summary[tool.status] += 1
  }
  return summary
}

export function normalizeScanManifest(raw: string): string | null {
  if (new TextEncoder().encode(raw).byteLength > MAX_SCAN_MANIFEST_BYTES) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isObject(parsed)) return null
    const manifest = parsed as Record<string, unknown>
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tools)) return null
    if (manifest.tools.length > MAX_SCAN_MANIFEST_TOOLS) return null

    const seen = new Set<string>()
    const tools: NormalizedScanManifestTool[] = []
    for (const rawTool of manifest.tools) {
      if (!isObject(rawTool)) return null
      const toolId = rawTool.toolId
      if (!isSafeRunnerToolId(toolId) || seen.has(toolId)) return null
      seen.add(toolId)
      if (typeof rawTool.enabled !== "boolean") return null
      const status = rawTool.status
      if (typeof status !== "string" || !SCAN_MANIFEST_STATUS_SET.has(status)) return null
      if (!rawTool.enabled && status !== "disabled") return null
      if (rawTool.enabled && status === "disabled") return null
      if (
        rawTool.path !== undefined &&
        (typeof rawTool.path !== "string" || rawTool.path.length > MAX_SCAN_MANIFEST_PATH_CHARS)
      ) {
        return null
      }
      // Runner-local paths are useful for runner-side debugging only. Do not
      // persist them in the receipt; downstream consumers must never treat a
      // manifest path as a worker-readable path.
      const tool: NormalizedScanManifestTool = {
        toolId,
        enabled: rawTool.enabled,
        status: status as ScanManifestStatus,
      }
      if (rawTool.runCount !== undefined) {
        if (!isNonNegativeManifestCount(rawTool.runCount)) return null
        tool.runCount = rawTool.runCount
      }
      if (rawTool.resultCount !== undefined) {
        if (!isNonNegativeManifestCount(rawTool.resultCount)) return null
        tool.resultCount = rawTool.resultCount
      }
      tools.push(tool)
    }

    return JSON.stringify({
      schemaVersion: 1,
      tools,
      summary: scanManifestSummary(tools),
    })
  } catch {
    return null
  }
}

type NormalizedScanManifestToolsResult =
  | { ok: true; tools: NormalizedScanManifestTool[] }
  | { ok: false; tools: NormalizedScanManifestTool[] }

function normalizedScanManifestTools(raw: string): NormalizedScanManifestToolsResult {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isObject(parsed)) return { ok: false, tools: [] }
    const tools = parsed.tools
    if (!Array.isArray(tools)) return { ok: false, tools: [] }
    return { ok: true, tools: tools as NormalizedScanManifestTool[] }
  } catch {
    return { ok: false, tools: [] }
  }
}

function splitRepository(repository: string): { owner: string; repo: string } {
  const m = /^([^/]+)\/([^/]+)$/.exec(repository)
  if (!m) return { owner: "", repo: "" }
  return { owner: m[1]!, repo: m[2]! }
}

function scheduleRunnerToolMetrics(args: {
  ctx: ExecutionContext
  env: Env
  repository: string
  repositoryId: string
  occurredAt: string
  sha: string
  scanManifest: string
}): void {
  const { owner, repo } = splitRepository(args.repository)
  const parsed = normalizedScanManifestTools(args.scanManifest)
  const task = (async () => {
    if (!parsed.ok) {
      console.warn(
        JSON.stringify({
          event: "runner-tool-metrics-manifest-parse-failed",
          repositoryId: args.repositoryId,
          sha: args.sha,
          manifestBytes: new TextEncoder().encode(args.scanManifest).byteLength,
        }),
      )
      return
    }
    if (owner === "" || repo === "") {
      console.warn(
        JSON.stringify({
          event: "runner-tool-metrics-repository-parse-failed",
          repositoryId: args.repositoryId,
          sha: args.sha,
          repository: args.repository,
        }),
      )
      return
    }
    await recordRunnerToolManifestMetric(args.env, {
      owner,
      repo,
      occurredAt: args.occurredAt,
      tools: parsed.tools,
    })
  })().catch((err) => {
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.warn(
      JSON.stringify({
        event: "runner-tool-metrics-record-failed",
        repositoryId: args.repositoryId,
        sha: args.sha,
        error,
      }),
    )
  })
  args.ctx.waitUntil(task)
}

/**
 * SIG-471 (quiet-VERIFIED): on a NEWLY-ACCEPTED PR receipt, enqueue a QUIET
 * `overview-proof-update` job (NOT a full re-review). The job re-runs ONLY the
 * receipt-join over the prior review's findings and patches the Proof line on
 * the editable overview comment in place — no specialist run, no second posted
 * review. This replaces the old noisy full re-review (which re-fired the whole
 * ensemble + posted a second review just to run the join).
 *
 * Best-effort: ANY failure (no App config, no installation, merge-sha not yet
 * computed, 2-parent guard, queue send) is swallowed + logged — the ingest
 * response must never fail because the job couldn't be queued. The CI retry
 * path resubmits the receipt (→ `duplicate`, not `accepted`), so the caller
 * gates on `accepted` to avoid spamming jobs.
 *
 * FORGE-PROOF: the head sha is derived from the SIGNED merge sha
 * (`getCommit(claims.sha).parents[1]` of the 2-parent `refs/pull/N/merge`
 * test-merge), never a caller-supplied value — the same derivation Phase 1
 * uses in `gather-graph.ts`. If that derivation fails we SKIP the enqueue (do
 * not guess a head sha).
 */
async function enqueueOverviewProofUpdate(args: {
  env: Env
  repository: string
  sha: string
  pullNumber: number
  repositoryId: string
}): Promise<void> {
  const { env, repository, sha, pullNumber, repositoryId } = args
  try {
    const { owner, repo } = splitRepository(repository)
    if (owner === "" || repo === "") return
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) return

    const installationId = await resolveRepoInstallationId(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, owner, repo)
    if (installationId === null) return

    const token = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
    const client = new GitHubClient({ token })

    // Derive the head sha from the SIGNED merge sha — parents[1] of a 2-parent
    // `refs/pull/N/merge` test-merge is the PR head (same as Phase 1). Anything
    // unexpected (commit missing, parents !== 2) → skip; never guess.
    const commit = await client.getCommit(owner, repo, sha)
    if (!commit || commit.parents.length !== 2) {
      console.warn(
        JSON.stringify({
          event: "overview-proof-update-enqueue-skipped",
          reason: commit === null ? "merge-commit-unavailable" : "not-two-parent-merge",
          owner,
          repo,
          prNumber: pullNumber,
        }),
      )
      return
    }
    const headSha = commit.parents[1]
    if (typeof headSha !== "string" || headSha.length === 0) return

    // Raw-send a QUIET overview-proof-update JobMessage (NOT a pr-review): the
    // handler re-runs only the receipt-join over the prior review's manifest and
    // patches the overview's Proof line in place — no specialist run, no second
    // review. `attempt` defaults to 0; the handler re-enqueues (bounded) while
    // the prior review's manifest / overview block is still in flight.
    const message: JobMessage = {
      type: "overview-proof-update",
      owner,
      repo,
      prNumber: pullNumber,
      headSha,
      installationId,
      ...(Number.isInteger(Number(repositoryId)) && Number(repositoryId) > 0 ? { repoId: Number(repositoryId) } : {}),
    }
    await env.OPENCLAW_JOBS.send(message)
    console.log(
      JSON.stringify({
        event: "overview-proof-update-enqueued",
        owner,
        repo,
        prNumber: pullNumber,
        headSha: headSha.slice(0, 7),
      }),
    )
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "overview-proof-update-enqueue-error",
        repositoryId,
        sha,
        prNumber: pullNumber,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}

interface IngestEnvelope {
  sarif: string
  /** Optional runner coverage manifest. Stored with the receipt body so
   *  downstream consumers can distinguish empty scans from missing tools. */
  scanManifest?: string
  /** The run's `owner/repo` — bound to the token's `repository` claim (anti-spoof). */
  repository: string
  /** The run's commit sha (== github.sha; the MERGE commit for a PR) — bound to
   *  the token's `sha` claim. The PR number + repo id are taken from the SIGNED
   *  claims (`claims.ref` / `claims.repository_id`), never from the body. */
  sha: string
  /** Optional immutable repo id, bound to the token's `repository_id` if present. */
  repositoryId?: string | undefined
}

export async function handleRunnerIngestRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
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
  let verified = await verifyGitHubOidcToken(token, {
    expectedAudience,
    fetchJwks: makeCachedFetchJwks(),
  })
  if (!verified.ok && verified.reason === "unknown-kid") {
    if (!forcedRefetchAvailable()) {
      // A forced JWKS refresh is cooling down (recent forced refetch). The kid
      // may be a freshly-rotated GitHub key our cache hasn't picked up — tell the
      // runner to RETRY rather than hard-fail a legit run (a genuinely unknown
      // kid will still 401 on a later retry once the cooldown elapses).
      return new Response(JSON.stringify({ error: "jwks-refresh-throttled", reason: "retry" }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "60" },
      })
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
    return json(
      {
        error: "missing-claim",
        reason: "token lacks repository_id/repository/sha/run_id/run_attempt",
      },
      400,
    )
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
    let scanManifest: string | undefined
    if (o.scanManifest !== undefined) {
      if (!nonEmptyString(o.scanManifest)) return json({ error: "bad-scan-manifest" }, 400)
      const normalized = normalizeScanManifest(o.scanManifest)
      if (normalized === null) return json({ error: "bad-scan-manifest" }, 400)
      scanManifest = normalized
    }
    envelope = {
      sarif: o.sarif,
      ...(scanManifest !== undefined ? { scanManifest } : {}),
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
  const scanManifestSha256 = envelope.scanManifest ? await sha256Hex(envelope.scanManifest) : undefined
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
  const ingestedAt = new Date().toISOString()

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
      scanManifestSha256,
      repository: tokenRepository,
      jobWorkflowRef: typeof claims.job_workflow_ref === "string" ? claims.job_workflow_ref : "",
      runnerEnvironment: typeof claims.runner_environment === "string" ? claims.runner_environment : "",
    })
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "runner-evidence-receipt-do-error",
        repositoryId,
        sha: tokenSha,
        error: String(err),
      }),
    )
    return json({ error: "receipt-store-unavailable" }, 503)
  }

  // A DIFFERENT SARIF for the same run is a conflict (409); an identical one is
  // an idempotent CI retry (200, so a lost-response re-POST is safe).
  if (claim.outcome === "conflict") {
    console.warn(
      JSON.stringify({
        event: "runner-evidence-receipt-conflict",
        repositoryId,
        sha: tokenSha,
        runId,
        runAttempt,
      }),
    )
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
            scanManifestSha256,
            sarif: scrubbedSarif,
            scanManifest: envelope.scanManifest,
            ingestedAt,
          }),
          { expirationTtl: RECEIPT_TTL_SECONDS },
        )
      }
    } catch (err) {
      // Non-fatal — the single-use record + defensible receipt already committed.
      console.warn(
        JSON.stringify({
          event: "runner-evidence-receipt-kv-error",
          repositoryId,
          sha: tokenSha,
          error: String(err),
        }),
      )
    }
  }

  console.log(
    JSON.stringify({
      event: "runner-evidence-received",
      repositoryId,
      repository: tokenRepository,
      sha: tokenSha,
      runId,
      runAttempt,
      outcome: claim.outcome,
      sarifSha256,
      runnerEnvironment: claims.runner_environment,
    }),
  )

  if (claim.outcome === "accepted" && envelope.scanManifest !== undefined) {
    if (ctx === undefined) {
      console.warn(
        JSON.stringify({
          event: "runner-tool-metrics-ctx-missing",
          repositoryId,
          sha: tokenSha,
        }),
      )
    } else if (env.RUNNER_TOOL_METRICS_DO === undefined) {
      console.warn(
        JSON.stringify({
          event: "runner-tool-metrics-binding-missing",
          repositoryId,
          sha: tokenSha,
        }),
      )
    } else {
      scheduleRunnerToolMetrics({
        ctx,
        env,
        repository: tokenRepository,
        repositoryId,
        occurredAt: ingestedAt,
        sha: tokenSha,
        scanManifest: envelope.scanManifest,
      })
    }
  }

  // SIG-471 (quiet-VERIFIED): on a NEWLY-ACCEPTED PR receipt, enqueue a QUIET
  // overview-proof-update job (NOT a full re-review) so the receipt-join runs
  // against the now-present receipt and the overview's Proof line is patched in
  // place. ONLY on `accepted` (a `duplicate` is a CI retry — the job was already
  // enqueued on the first accept) AND only for a PR receipt (`pullNumber > 0`; a
  // branch-push audit receipt has no PR overview to patch). Best-effort: the task
  // is detached via `ctx.waitUntil` and self-swallows every error so it can never
  // fail the ingest response. Loop-safe: the quiet job triggers no review.
  if (claim.outcome === "accepted" && pullNumber > 0) {
    const proofUpdate = enqueueOverviewProofUpdate({
      env,
      repository: tokenRepository,
      sha: tokenSha,
      pullNumber,
      repositoryId,
    })
    if (ctx === undefined) {
      // No execution context (non-edge callers / tests that omit it): run inline
      // but never let it reject the response.
      await proofUpdate.catch(() => {})
    } else {
      ctx.waitUntil(proofUpdate)
    }
  }

  return json(
    {
      ok: true,
      outcome: claim.outcome, // "accepted" | "duplicate"
      receipt: { repository: tokenRepository, sha: tokenSha, runId, runAttempt, sarifSha256 },
    },
    200,
  )
}
