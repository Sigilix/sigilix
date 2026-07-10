// sig-portal-agent — the portal-facing coding-agent surface (composer + run).
//
// Three session-authed, tenant-scoped routes powering the in-portal agent chat
// (repo + branch composer, then a run that edits code + opens a PR):
//
//   GET  /v1/agent/branches?installationId=<n>&repo=<owner/repo>
//        → { defaultBranch, branches: [{ name, protected }] }   — LIVE
//   POST /v1/agent/runs
//        → { runId, dispatched, status }                        — real dispatch
//   GET  /v1/agent/runs/:runId
//        → { runId, status, prUrl?, error? } | null             — run status
//
// TENANT-SAFETY (the whole point). Every route authorizes SERVER-SIDE that the
// signed-in session controls the exact installation + repository before doing
// anything with it:
//   1. requireSession → the portal session cookie (never a client-supplied id
//      is trusted on its own).
//   2. userControlsRepo(...) walks the GitHub user's installations AND each
//      installation's repository list. Any partial/error result fails closed.
//   3. Only then do we mint an installation token (App-scoped to exactly that
//      installation's repos). Status reads additionally bind the run to the
//      creating GitHub user, so different selected-repo grants inside one org
//      installation cannot read each other's runs.
//
// RUNTIME GATING (honest, not faked). The run itself reuses the existing
// SIG-545 agent-runner (`dispatchAgentRun` → AgentRunnerContainer → PR), which
// requires BOTH the global and portal-specific gates. When either is off,
// POST /v1/agent/runs returns `{ dispatched: false, status: "preview" }` — a
// truthful "runtime not enabled yet" state, NOT a fabricated PR. The portal
// renders that as a preview banner.

import { requireSession } from "@/src/lib/auth-middleware"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { listGithubUserInstallationRepos } from "@/src/lib/github-user-repo-scope"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { getInstallationToken } from "@/src/shared/adapters/github/github-app"
import { dispatchAgentRun, getAgentRunStatus } from "@/src/lib/agent-runner/dispatch"
import { resolveAgentRunnerMode } from "@/src/lib/agent-runner/mode"
import type { Env } from "@/src/shared/types/env"

const MAX_BRANCH_PAGES = 10
const MAX_BRANCHES = 300
// A run's exact repository + user owner binding lives in KV so the status route
// can authorize a read WITHOUT trusting the run record for tenant identity. TTL
// comfortably outlives a run (runs are minutes); a stale binding simply 404s.
const AGENT_RUN_OWNER_TTL_S = 86_400
// The agent-runner container defaults to Ollama Turbo (glm-5.2:cloud) so a run
// costs no OpenRouter credits — the same provider the admin proof harness uses.
const AGENT_MODEL_ID = "glm-5.2:cloud"
const AGENT_MODEL_BASE_URL = "https://ollama.com/v1"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** KV key binding a runId to the repository/user that created it. */
function agentRunOwnerKey(runId: string): string {
  return `agent-run-owner:${runId}`
}

interface AgentRunOwner {
  installationId: number
  owner: string
  repo: string
  githubUserId: number
}

/** Persist the exact run owner before dispatch. Failure is fatal: never launch an unpollable run. */
async function writeAgentRunOwner(env: Env, runId: string, owner: AgentRunOwner): Promise<boolean> {
  try {
    await env.OPENCLAW_STATE.put(agentRunOwnerKey(runId), JSON.stringify(owner), {
      expirationTtl: AGENT_RUN_OWNER_TTL_S,
    })
    return true
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "agent-run-owner-write-failed",
        runId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
}

/** Read a structured run owner; legacy/malformed bindings and read faults fail closed. */
async function readAgentRunOwner(env: Env, runId: string): Promise<AgentRunOwner | null> {
  let raw: string | null
  try {
    raw = await env.OPENCLAW_STATE.get(agentRunOwnerKey(runId))
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const owner = parsed as Record<string, unknown>
  if (
    typeof owner.installationId !== "number" ||
    !Number.isSafeInteger(owner.installationId) ||
    owner.installationId <= 0 ||
    typeof owner.owner !== "string" ||
    owner.owner === "" ||
    typeof owner.repo !== "string" ||
    owner.repo === "" ||
    typeof owner.githubUserId !== "number" ||
    !Number.isSafeInteger(owner.githubUserId) ||
    owner.githubUserId <= 0
  ) {
    return null
  }
  return {
    installationId: owner.installationId,
    owner: owner.owner,
    repo: owner.repo,
    githubUserId: owner.githubUserId,
  }
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

/** Authorize the exact App installation + selected repository tuple. */
async function userControlsRepo(
  accessToken: string,
  installationId: number,
  owner: string,
  repo: string,
): Promise<{ ok: true } | { ok: false; reason: "not_owned" | "lookup_failed" }> {
  const scope = await listGithubUserInstallationRepos(accessToken)
  if (!scope.ok) return { ok: false, reason: "lookup_failed" }
  const wantedOwner = owner.toLowerCase()
  const wantedRepo = repo.toLowerCase()
  return scope.repos.some(
    (candidate) =>
      candidate.installationId === installationId &&
      candidate.owner.toLowerCase() === wantedOwner &&
      candidate.repo.toLowerCase() === wantedRepo,
  )
    ? { ok: true }
    : { ok: false, reason: "not_owned" }
}

/**
 * Return a refresh-aware GitHub token. Misconfiguration/integrity failures are
 * typed responses and the token is never logged.
 */
async function sessionAccessToken(
  authed: NonNullable<Awaited<ReturnType<typeof requireSession>>>,
  env: Env,
): Promise<{ ok: true; token: string; githubUserId: number } | { ok: false; response: Response }> {
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "agent-portal-encryption-key-missing" }))
    return { ok: false, response: json({ error: "misconfigured" }, 503) }
  }
  if (
    (authed.record.provider !== undefined && authed.record.provider !== "github") ||
    typeof authed.record.githubUserId !== "number" ||
    !Number.isSafeInteger(authed.record.githubUserId) ||
    authed.record.githubUserId <= 0
  ) {
    return { ok: false, response: json({ error: "forbidden" }, 403) }
  }
  try {
    const token = await getValidGithubToken({
      env,
      sessionId: authed.sessionId,
      record: authed.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
    if (!token) return { ok: false, response: json({ error: "forbidden" }, 403) }
    return { ok: true, token, githubUserId: authed.record.githubUserId }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "agent-portal-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false, response: json({ error: "agent_portal_failed" }, 500) }
  }
}

/** Parse `owner/repo` into its two segments; null when malformed. */
function parseRepo(repo: string): { owner: string; name: string } | null {
  const parts = repo.split("/")
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!owner || !name) return null
  return { owner, name }
}

interface GitHubBranch {
  name?: string
  protected?: boolean
}

export interface AgentBranch {
  name: string
  protected: boolean
}

export interface AgentBranchesResponse {
  defaultBranch: string | null
  branches: AgentBranch[]
}

/**
 * GET /v1/agent/branches?installationId=<n>&repo=<owner/repo>
 *
 * Session-authed + tenant-scoped branch listing for the composer's branch
 * selector. Uses an installation token (App-scoped to that installation's
 * repos) AFTER confirming the session controls the installation, so a forged
 * repo path can't cross tenants. Soft-fails the branch listing itself (a
 * transient GitHub hiccup yields the default branch + whatever was collected)
 * but the AUTH gates are hard.
 */
export async function handleAgentBranchesRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  const url = new URL(request.url)
  const installationIdRaw = url.searchParams.get("installationId")
  const repoRaw = url.searchParams.get("repo")
  const installationId = installationIdRaw ? Number(installationIdRaw) : NaN
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !repoRaw) {
    return json({ error: "installationId (positive int) + repo (owner/repo) required" }, 400)
  }
  const repo = parseRepo(repoRaw)
  if (!repo) return json({ error: "repo must be owner/repo" }, 400)

  const tok = await sessionAccessToken(authed, env)
  if (!tok.ok) return tok.response

  const owns = await userControlsRepo(tok.token, installationId, repo.owner, repo.name)
  if (!owns.ok) {
    return owns.reason === "not_owned" ? json({ error: "forbidden" }, 403) : json({ error: "lookup_failed" }, 502)
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    console.error(JSON.stringify({ event: "agent-portal-github-app-unconfigured" }))
    return json({ error: "misconfigured" }, 503)
  }

  let installationToken: string
  try {
    installationToken = await getInstallationToken({
      kv: env.OPENCLAW_STATE,
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      installationId,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "agent-portal-install-token-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "install_token_failed" }, 502)
  }

  const [defaultBranch, branches] = await Promise.all([
    fetchDefaultBranch(installationToken, repo.owner, repo.name),
    fetchBranches(installationToken, repo.owner, repo.name),
  ])

  return json({ defaultBranch, branches } satisfies AgentBranchesResponse, 200)
}

/** The repo's default branch, or null on any error (soft-fail). */
async function fetchDefaultBranch(token: string, owner: string, name: string): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers: githubHeaders(token) })
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    const body = (await res.json()) as { default_branch?: string }
    return typeof body.default_branch === "string" ? body.default_branch : null
  } catch {
    return null
  }
}

/** Paginated branch listing, capped. Soft-fails to whatever was collected. */
async function fetchBranches(token: string, owner: string, name: string): Promise<AgentBranch[]> {
  const out: AgentBranch[] = []
  for (let page = 1; page <= MAX_BRANCH_PAGES && out.length < MAX_BRANCHES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/repos/${owner}/${name}/branches?per_page=100&page=${page}`, {
        headers: githubHeaders(token),
      })
    } catch {
      break
    }
    if (!res.ok) break
    let body: GitHubBranch[]
    try {
      body = (await res.json()) as GitHubBranch[]
    } catch {
      break
    }
    if (!Array.isArray(body) || body.length === 0) break
    for (const b of body) {
      if (out.length >= MAX_BRANCHES) break
      if (typeof b.name === "string" && b.name) out.push({ name: b.name, protected: b.protected === true })
    }
    if (body.length < 100) break
  }
  return out
}

export interface AgentRunResponse {
  runId: string
  dispatched: boolean
  /** "preview" when the runtime is dark; otherwise the container run status. */
  status: "preview" | "started" | "opened" | "no-change" | "error"
  prUrl?: string
  error?: string
}

/** A separate default-off portal gate keeps the already-live global runner private. */
function isPortalAgentRunnerEnabled(env: Env): boolean {
  const config = env as Env & { SIGILIX_PORTAL_AGENT_RUNNER_MODE?: string }
  return (config.SIGILIX_PORTAL_AGENT_RUNNER_MODE ?? env.OPENCLAW_PORTAL_AGENT_RUNNER_MODE) === "on"
}

/**
 * POST /v1/agent/runs
 *
 * Body: { installationId, repo: "owner/repo", baseBranch?, prompt }
 *
 * Session-authed + tenant-scoped, then dispatches the REAL SIG-545 agent-runner
 * (`dispatchAgentRun` → AgentRunnerContainer → clone → edit → PR). The runner is
 * DARK unless both runner gates are "on"; when either is off, this returns
 * `{ dispatched: false, status: "preview" }` — an honest "runtime not enabled"
 * signal, never a fabricated PR. The container mints its own model key + the
 * installation token server-side; the portal never supplies credentials.
 */
export async function handleAgentRunCreateRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)
  if (!hasJsonContentType(request)) return json({ error: "content_type_must_be_application_json" }, 415)

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: "bad json" }, 400)
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "body must be an object" }, 400)
  const body = raw as Record<string, unknown>

  const installationId = typeof body.installationId === "number" ? body.installationId : NaN
  const repoRaw = typeof body.repo === "string" ? body.repo : null
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
  if (!Number.isSafeInteger(installationId) || installationId <= 0 || !repoRaw || !prompt) {
    return json({ error: "installationId (int) + repo (owner/repo) + prompt (string) required" }, 400)
  }
  const repo = parseRepo(repoRaw)
  if (!repo) return json({ error: "repo must be owner/repo" }, 400)
  const baseBranch = typeof body.baseBranch === "string" && body.baseBranch.trim() ? body.baseBranch.trim() : "main"

  const tok = await sessionAccessToken(authed, env)
  if (!tok.ok) return tok.response

  const owns = await userControlsRepo(tok.token, installationId, repo.owner, repo.name)
  if (!owns.ok) {
    return owns.reason === "not_owned" ? json({ error: "forbidden" }, 403) : json({ error: "lookup_failed" }, 502)
  }

  const runId = crypto.randomUUID()

  // Honest dark gate: a preview is not a run, so it creates no pollable binding.
  if (!isPortalAgentRunnerEnabled(env) || resolveAgentRunnerMode(env) !== "on") {
    return json({ runId, dispatched: false, status: "preview" } satisfies AgentRunResponse, 200)
  }

  const modelKey = env.OLLAMA_API_KEY
  if (!modelKey) {
    console.error(JSON.stringify({ event: "agent-portal-model-key-unconfigured" }))
    return json({ error: "runtime_unconfigured" }, 503)
  }

  // Bind exact repository + user ownership BEFORE dispatch. A failed KV write
  // must not launch a run the owner can never poll.
  const bound = await writeAgentRunOwner(env, runId, {
    installationId,
    owner: repo.owner,
    repo: repo.name,
    githubUserId: tok.githubUserId,
  })
  if (!bound) return json({ error: "run_owner_unavailable" }, 503)

  const result = await dispatchAgentRun(env, {
    runId,
    owner: repo.owner,
    repo: repo.name,
    baseBranch,
    installationId,
    ticket: {
      identifier: `PORTAL-${runId.slice(0, 8)}`,
      title: prompt.split("\n")[0]!.slice(0, 120),
      body: prompt,
      url: "",
    },
    model: { id: AGENT_MODEL_ID, key: modelKey, baseUrl: AGENT_MODEL_BASE_URL },
    // Portal runs use the bounded minimal engine (5-tool loop) — the "full" CLI
    // agent stays reserved for trusted admin/allow-list callers.
    engine: "minimal",
    caps: { maxModelCalls: 12, maxTokens: 800_000, timeoutMs: 600_000 },
  })

  const status: AgentRunResponse["status"] = result.outcome?.status ?? (result.dispatched ? "started" : "error")
  return json(
    {
      runId,
      dispatched: result.dispatched,
      status,
      ...(result.outcome?.prUrl ? { prUrl: result.outcome.prUrl } : {}),
      ...(result.outcome?.error ? { error: result.outcome.error } : {}),
    } satisfies AgentRunResponse,
    200,
  )
}

/**
 * GET /v1/agent/runs/:runId — read the durable run record (null pre-dispatch).
 *
 * TENANT-SAFE (IDOR guard): a session may only read a run created by the same
 * GitHub user for a repository still present in that user's exact live scope.
 * An unknown runId
 * and an owner-mismatch BOTH return 404 (never 403/null) so the endpoint is not
 * an existence oracle for another tenant's run ids. Ownership is checked BEFORE
 * the record is read, so a null record is only ever reached by the real owner —
 * surfaced as a truthful `pending`, never leaking existence.
 */
export async function handleAgentRunStatusRoute(
  request: Request,
  env: Env,
  runId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)
  if (!runId) return json({ error: "runId required" }, 400)

  const owner = await readAgentRunOwner(env, runId)
  if (owner === null) return json({ error: "not_found" }, 404)

  if (authed.record.githubUserId !== owner.githubUserId) return json({ error: "not_found" }, 404)

  const tok = await sessionAccessToken(authed, env)
  if (!tok.ok) return tok.response

  const owns = await userControlsRepo(tok.token, owner.installationId, owner.owner, owner.repo)
  if (!owns.ok) {
    // not_owned → 404 (indistinguishable from an unknown id — no oracle);
    // lookup_failed → 502 (transient GitHub error, fail closed, caller retries).
    return owns.reason === "not_owned" ? json({ error: "not_found" }, 404) : json({ error: "lookup_failed" }, 502)
  }

  const record = await getAgentRunStatus(env, runId)
  if (!record) return json({ runId, status: "pending" }, 200)
  return json(record, 200)
}

export function isAgentPortalPath(pathname: string): boolean {
  return (
    pathname === "/v1/agent/branches" || pathname === "/v1/agent/runs" || /^\/v1\/agent\/runs\/[^/]+$/.test(pathname)
  )
}

/** Group the portal-agent routes so the entry module stays below its size ceiling. */
export async function tryHandleAgentPortalRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/v1/agent/branches") {
    return handleAgentBranchesRoute(request, env, ctx)
  }
  if (request.method === "POST" && url.pathname === "/v1/agent/runs") {
    return handleAgentRunCreateRoute(request, env, ctx)
  }
  const statusMatch = /^\/v1\/agent\/runs\/([^/]+)$/.exec(url.pathname)
  if (request.method === "GET" && statusMatch) {
    let runId: string
    try {
      runId = decodeURIComponent(statusMatch[1]!)
    } catch {
      return json({ error: "bad runId" }, 400)
    }
    return handleAgentRunStatusRoute(request, env, runId, ctx)
  }
  return isAgentPortalPath(url.pathname) ? json({ error: "method_not_allowed" }, 405) : null
}
