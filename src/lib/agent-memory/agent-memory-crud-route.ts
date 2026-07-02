// Agent-memory store — GET /v1/memory (list) + DELETE /v1/memory/:id (delete)
// route handlers. The management surface the portal drives so a user can SEE and
// PRUNE the durable memories the CLI agent (and the extract auto-capture leg)
// saved. Read/manage only — the write path stays PUT /v1/memory + /extract.
//
// DUAL AUTH (mirrors workspace-prs-route.ts): a portal browser session cookie
// (requireSession) is tried FIRST since these are portal-first pages; a request
// with no session falls back to a bearer api key (requireApiTenant). Either
// yields a caller SCOPE — the ordered set of KV key prefixes that confines every
// list/delete to exactly the caller's own records.
//
// TENANT ISOLATION — the whole feature's load-bearing invariant. The KV keyspace
// is `agent-memory:<userId>:<repoId>:<id>`, where `<userId>` is the SCOPED write
// subject (agent-memory-route.ts's scopeMemoryUserId): a real per-tenant api key
// writes under `inst:<installationId>:<bodyUserId>`. So a caller's scope is the set
// of `agent-memory:inst:<installationId>:` prefixes for the installation(s) it owns:
//   - api-key path (real key): the ONE installation the key resolved to —
//     `agent-memory:inst:<installationId>:`, listing/deleting every seat under THAT
//     installation and no other. The trailing `:` after the numeric id
//     disambiguates `inst:42:` from `inst:421:`.
//   - api-key path (LEGACY global key): broad by design (Sigilix-internal, never
//     handed to a tenant — same exemption scopeMemoryUserId/workspace-prs make) —
//     the single prefix `agent-memory:` owns every record.
//   - session path (portal browser): the SAME installation namespace the CLI wrote
//     to — the session's GitHub user-to-server token is resolved to its
//     installation id(s) via `GET /user/installations` (the workspace-prs-route.ts
//     bridge), and the scope is the union of `agent-memory:inst:<id>:` over them.
//     This is what lets the portal show a user the memories their own CLI saved. A
//     session with NO linked installation (or any resolution failure) → an empty
//     scope → an empty list / 404-on-delete, never an error.
// A list/delete NEVER lists outside the caller's own prefixes, and every candidate
// is re-checked with `scope.owns(record)` before it is returned or deleted — a
// defence-in-depth second gate behind the prefix.
//
// CORS: both routes are portal-facing (app.sigilix.ai / localhost dev, a different
// origin) so index.ts adds them to `isPortalCorsPath`, answers OPTIONS via
// handlePortalPreflight, and wraps every response with withPortalCors.

import type { Env } from "@/src/shared/types/env"
import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { requireApiTenant, LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import { decryptAccessToken } from "@/src/lib/auth-session"
import type { AgentMemoryRecord } from "./types"
import { canonicalTenantId, json } from "./agent-memory-route"
import { deleteRecordAndPointer, findRecordByIdUnderPrefix, listRecords } from "./storage"
import { deleteMemoryVector } from "./retrieval"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

// Pagination cap on GET /user/installations for the session→installation bridge —
// defensive against a runaway loop (mirrors workspace-prs-route.ts).
const MAX_INSTALLATION_PAGES = 20

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

// ─── Caller scope (dual-auth → ordered KV prefixes + ownership predicate) ──

interface MemoryScope {
  /** Ordered set of KV key prefixes that (together) confine every list/delete to
   *  the caller's own records. One entry per owned installation, or the single
   *  broad `agent-memory:` for the legacy global key, or [] for a session with no
   *  linked installation. */
  prefixes: string[]
  /** Defence-in-depth: is `record` owned by this caller? (The prefixes already
   *  guarantee it; this is the second gate the delete/list re-checks.) */
  owns: (record: AgentMemoryRecord) => boolean
}

type MemoryScopeResult = { response: Response } | { scope: MemoryScope }

/** The `agent-memory:inst:<id>:` prefix for one installation. */
function installationPrefix(installationId: number): string {
  return `agent-memory:inst:${installationId}:`
}

/** Owns-predicate for a set of installation ids: a record is owned iff its scoped
 *  write-subject is (or is nested under) one of the caller's installation subjects
 *  — matching scopeMemoryUserId's `inst:<id>:<bodyUserId>` layout. */
function ownsAnyInstallation(installationIds: number[]): (record: AgentMemoryRecord) => boolean {
  const subjects = installationIds.map((id) => `inst:${id}`)
  return (record) => subjects.some((s) => record.userId === s || record.userId.startsWith(`${s}:`))
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

interface UserInstallationsResponse {
  total_count?: number
  installations?: Array<{ id?: number }>
}

/**
 * Every installation id the session's GitHub user-to-server token can see, via
 * `GET /user/installations` (the same call the setup wizard + workspace-prs page
 * use). Soft-fails to [] on any GitHub error — a resolution failure just means the
 * portal shows no memories, never an error (mirrors workspace-prs-route.ts's
 * fetchUserInstallationIds).
 */
async function fetchUserInstallationIds(accessToken: string): Promise<number[]> {
  const ids: number[] = []
  let seen = 0
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: githubHeaders(accessToken),
      })
    } catch {
      break
    }
    if (!res.ok) break
    let body: UserInstallationsResponse
    try {
      body = (await res.json()) as UserInstallationsResponse
    } catch {
      break
    }
    const installs = Array.isArray(body.installations) ? body.installations : []
    for (const inst of installs) {
      if (typeof inst.id === "number") ids.push(inst.id)
    }
    seen += installs.length
    const total = typeof body.total_count === "number" ? body.total_count : seen
    if (installs.length === 0 || seen >= total) break
  }
  return ids
}

/**
 * Resolve a portal browser session to the installation ids it owns, so its scope
 * lands on the SAME `agent-memory:inst:<id>:` namespace the CLI wrote to. SOFT: a
 * missing session-encryption key, an access-token decrypt failure, or any GitHub
 * error resolves to [] (telemetered) — a logged-in user we can't map to an
 * installation simply has no memories to show, which must never surface as a 500
 * on this fail-soft management surface.
 */
async function resolveSessionInstallationIds(env: Env, session: AuthedSession): Promise<number[]> {
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    emitTelemetry("agent-memory-session-scope-unavailable", { reason: "missing-encryption-key" })
    return []
  }
  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
      session.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch (err) {
    // Never log the token — only that decryption failed.
    emitTelemetry("agent-memory-session-scope-unavailable", {
      reason: "decrypt-failed",
      err: err instanceof Error ? err.message : String(err),
    })
    return []
  }
  return fetchUserInstallationIds(accessToken)
}

/**
 * Resolve the caller's tenant scope from EITHER a portal session cookie OR a
 * bearer api key (session first). Returns the 401 Response (from requireApiTenant)
 * when neither authenticates. See the file header for the prefix derivation.
 */
async function resolveMemoryScope(request: Request, env: Env, ctx?: ExecutionContext): Promise<MemoryScopeResult> {
  const session = await requireSession(request, env, ctx)
  if (session) {
    const installationIds = await resolveSessionInstallationIds(env, session)
    return {
      scope: {
        prefixes: installationIds.map(installationPrefix),
        owns: ownsAnyInstallation(installationIds),
      },
    }
  }

  const apiAuth = await requireApiTenant(request, env, ctx)
  if ("response" in apiAuth) return { response: apiAuth.response }

  const installationId = apiAuth.caller.installationId
  if (installationId === LEGACY_TENANT_INSTALLATION_ID) {
    // Legacy global key — broad by design (Sigilix-internal); owns every record.
    return { scope: { prefixes: ["agent-memory:"], owns: () => true } }
  }
  return {
    scope: {
      prefixes: [installationPrefix(installationId)],
      owns: ownsAnyInstallation([installationId]),
    },
  }
}

// ─── Compound pagination cursor (prefix index + KV cursor) ───

/**
 * The list scope can span several prefixes (a session across N installations), so
 * the opaque page cursor tracks BOTH which prefix we're in (`p`) and the KV cursor
 * within it (`k`). base64(JSON) keeps it URL-safe + opaque. A malformed cursor
 * decodes to `{ pi: 0 }` (restart) rather than throwing — matching the opaque-cursor
 * contract.
 */
function encodeCursor(pi: number, kv: string | undefined): string {
  return btoa(JSON.stringify(kv ? { p: pi, k: kv } : { p: pi }))
}

function decodeCursor(raw: string | undefined): { pi: number; kv?: string } {
  if (!raw) return { pi: 0 }
  try {
    const obj = JSON.parse(atob(raw)) as { p?: unknown; k?: unknown }
    const pi = typeof obj.p === "number" && Number.isInteger(obj.p) && obj.p >= 0 ? obj.p : 0
    const kv = typeof obj.k === "string" && obj.k !== "" ? obj.k : undefined
    return kv ? { pi, kv } : { pi }
  } catch {
    return { pi: 0 }
  }
}

// ─── GET /v1/memory — list the caller's memories ─────────────

/** One listed memory in the response (the record minus its internal scope +
 *  dedup fields; `ts` is surfaced as `createdAt`). */
interface ListedMemory {
  id: string
  repoId: string
  kind: AgentMemoryRecord["kind"]
  content: string
  createdAt: string
}

function toListedMemory(record: AgentMemoryRecord): ListedMemory {
  return { id: record.id, repoId: record.repoId, kind: record.kind, content: record.content, createdAt: record.ts }
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

/**
 * GET /v1/memory — list the caller's saved memories, paginated by an opaque
 * `cursor` that walks the caller's prefixes in order (one KV list page per call).
 * Optional `?repoId=` filters to one repo scope (canonicalized to match the
 * lowercased write keyspace; post-filtered since the `inst:<id>:` prefixes have a
 * per-seat bodyUserId between userId and repoId). `?limit=` (default 50, max 100)
 * bounds the page; `?cursor=` continues a previous page.
 *
 * 503 until keyed; 401 without a session OR api key. FAIL-SOFT on the data path: a
 * KV list failure degrades to an empty page (200, via listRecords) — never a 500.
 * Response: `{ memories: [{ id, repoId, kind, content, createdAt }], cursor? }`.
 */
export async function handleMemoryListRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "memory_endpoint_not_configured" }, 503)
  }
  const auth = await resolveMemoryScope(request, env, ctx)
  if ("response" in auth) return auth.response
  const { scope } = auth

  const url = new URL(request.url)
  const repoParam = url.searchParams.get("repoId")
  const repoId = repoParam && repoParam.trim() !== "" ? canonicalTenantId(repoParam) : undefined
  const limit = parseLimit(url.searchParams.get("limit"))
  const { pi, kv } = decodeCursor(url.searchParams.get("cursor") ?? undefined)

  // Past the last prefix (or an empty scope) → nothing more to return.
  if (pi >= scope.prefixes.length) return json({ memories: [], cursor: undefined }, 200)

  const page = await listRecords(env, scope.prefixes[pi]!, { limit, ...(kv ? { cursor: kv } : {}) })

  // Next cursor: another KV page in THIS prefix → stay on `pi`; else advance to the
  // next prefix (a missing page cursor means this prefix is exhausted OR listRecords
  // fail-soft'd — both advance); no more prefixes → no cursor (pagination done).
  let nextCursor: string | undefined
  if (page.cursor) nextCursor = encodeCursor(pi, page.cursor)
  else if (pi + 1 < scope.prefixes.length) nextCursor = encodeCursor(pi + 1, undefined)
  else nextCursor = undefined

  const memories = page.records
    .filter((record) => scope.owns(record) && (repoId === undefined || record.repoId === repoId))
    .map(toListedMemory)

  return json({ memories, cursor: nextCursor }, 200)
}

// ─── DELETE /v1/memory/:id — delete one memory ───────────────

/**
 * DELETE /v1/memory/:id — delete ONE of the caller's memories by id. Scans the
 * caller's own scope prefix(es) for the id (so a hit is by construction owned) and
 * re-checks `scope.owns` before deleting. Deletes BOTH the record key and its
 * content-hash dedup pointer, then best-effort deletes the Vectorize vector (a
 * vector failure never fails the request — the KV record is already gone, so a
 * stale vector hit hydrates to null and is dropped).
 *
 * A record not found under the caller's prefixes (missing, or owned by another
 * tenant) → a plain 404 with NO existence signal — deleting the same id twice
 * therefore returns `{ ok, deleted }` then 404 (the idempotent-safe shape). 503
 * until keyed; 401 without a session OR api key; 500 only on an unexpected KV
 * delete throw. Success: `{ ok: true, deleted: true }`.
 */
export async function handleMemoryDeleteRoute(
  request: Request,
  env: Env,
  id: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "memory_endpoint_not_configured" }, 503)
  }
  const auth = await resolveMemoryScope(request, env, ctx)
  if ("response" in auth) return auth.response
  const { scope } = auth

  if (id.trim() === "") return json({ error: "not_found" }, 404)

  // Scan the caller's own prefix(es) only — a hit is owned by construction.
  let record: AgentMemoryRecord | null = null
  for (const prefix of scope.prefixes) {
    record = await findRecordByIdUnderPrefix(env, prefix, id)
    if (record !== null) break
  }
  // Not found under the caller's prefixes, OR (defence-in-depth) not owned → an
  // indistinguishable 404: never reveal that the id exists for another tenant.
  if (record === null || !scope.owns(record)) return json({ error: "not_found" }, 404)

  try {
    await deleteRecordAndPointer(env, record)
  } catch (err) {
    return json({ error: "memory_delete_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }
  // Best-effort vector delete (soft — never flips a successful KV delete to a failure).
  await deleteMemoryVector(env, record.id)

  return json({ ok: true, deleted: true }, 200)
}
