// Agent-memory store — GET /v1/memory (list) + DELETE /v1/memory/:id (delete)
// route handlers. The management surface the portal drives so a user can SEE and
// PRUNE the durable memories the CLI agent (and the extract auto-capture leg)
// saved. Read/manage only — the write path stays PUT /v1/memory + /extract.
//
// DUAL AUTH (mirrors workspace-prs-route.ts): a portal browser session cookie
// (requireSession) is tried FIRST since these are portal-first pages; a request
// with no session falls back to a bearer api key (requireApiTenant). Either
// yields a caller SCOPE — the ordered set of exact personal KV prefixes that
// confines every list/delete to the authenticated human's own records.
//
// TENANT ISOLATION — the whole feature's load-bearing invariant. The KV keyspace
// is `agent-memory:<userId>:<repoId>:<id>`, where `<userId>` is derived from
// authenticated identity as `inst:<installationId>:user:<stableUserId>`:
//   - api-key path: `api_key.created_by` is resolved through user_identity and
//     produces ONE exact personal prefix for the key's installation.
//   - session path (portal browser): the SAME installation namespace the CLI wrote
//     to — the session's GitHub user-to-server token is resolved to its
//     installation id(s), then paired with session.userId to produce one exact
//     personal prefix per installation. Admin status never widens personal scope.
// A list/delete NEVER lists outside the caller's own prefixes, and every candidate
// is re-checked with `scope.owns(record)` before it is returned or deleted — a
// defence-in-depth second gate behind the prefix.
//
// CORS: both routes are portal-facing (app.sigilix.ai / localhost dev, a different
// origin) so index.ts adds them to `isPortalCorsPath`, answers OPTIONS via
// handlePortalPreflight, and wraps every response with withPortalCors.

import type { Env } from "@/src/shared/types/env"
import { requireSession, type AuthedSession } from "@/src/lib/auth-middleware"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import type { AgentMemoryKind, AgentMemoryRecord } from "./types"
import { json, MAX_BODY_BYTES, storeMemoryFact } from "./agent-memory-route"
import {
  canonicalTenantId,
  personalMemoryUserId,
  resolveApiPersonalMemoryUserId,
  PERSONAL_CONVENTION_REPO_ID,
} from "./agent-memory-personal-subject"
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
  /** Ordered exact personal prefixes, one per linked installation. */
  prefixes: string[]
  /** Defence-in-depth: is `record` owned by this caller? (The prefixes already
   *  guarantee it; this is the second gate the delete/list re-checks.) */
  owns: (record: AgentMemoryRecord) => boolean
}

type MemoryScopeResult = { response: Response } | { scope: MemoryScope }

/** The record prefix for one exact authenticated personal subject. */
function personalPrefix(personalUserId: string): string {
  return `agent-memory:${personalUserId}:`
}

/** Defence-in-depth ownership check behind the already-exact KV prefix. */
function ownsPersonalSubjects(personalUserIds: string[]): (record: AgentMemoryRecord) => boolean {
  const subjects = new Set(personalUserIds)
  return (record) => subjects.has(record.userId)
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
 * use). Returns `null` when it could NOT enumerate at all (a GitHub error before
 * any id was seen) — distinct from `[]` (enumerated, genuinely none). Read paths
 * collapse both to "no memories"; the write path (create) uses the distinction to
 * return a retryable 503 on a transient GitHub outage rather than silently
 * claiming the user has no installation. A partial enumeration (some ids, later
 * page errored) still returns the ids collected — the user demonstrably has them.
 */
async function fetchUserInstallationIds(accessToken: string): Promise<number[] | null> {
  const ids: number[] = []
  let seen = 0
  let sawError = false
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    let res: Response
    try {
      res = await fetch(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        headers: githubHeaders(accessToken),
      })
    } catch {
      sawError = true
      break
    }
    if (!res.ok) {
      sawError = true
      break
    }
    let body: UserInstallationsResponse
    try {
      body = (await res.json()) as UserInstallationsResponse
    } catch {
      sawError = true
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
  // Total failure (couldn't enumerate anything) → null; otherwise the ids seen.
  return sawError && ids.length === 0 ? null : ids
}

/** Discriminated result of a session→installation resolution. `unavailable`
 *  means we could not resolve (missing key / decrypt failure / GitHub outage) —
 *  as opposed to `ok` with an empty list, which means the user genuinely owns no
 *  installation. Read paths treat both the same (empty scope); the write path
 *  distinguishes them (503 retryable vs 409 no-installation). */
type SessionInstallationsResult = { status: "ok"; ids: number[] } | { status: "unavailable" }

/**
 * Resolve a portal browser session to the installation ids it owns, so its scope
 * lands on the SAME `agent-memory:inst:<id>:` namespace the CLI wrote to. Returns
 * `unavailable` (never throws) on a missing session-encryption key, an
 * access-token decrypt failure, or a GitHub enumeration that could not complete at
 * all (telemetered) — the caller decides whether that degrades to an empty scope
 * (read) or a retryable error (write).
 */
async function resolveSessionInstallationIds(env: Env, session: AuthedSession): Promise<SessionInstallationsResult> {
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    emitTelemetry("agent-memory-session-scope-unavailable", { reason: "missing-encryption-key" })
    return { status: "unavailable" }
  }
  let accessToken: string
  try {
    accessToken = await getValidGithubToken({
      env,
      sessionId: session.sessionId,
      record: session.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
  } catch (err) {
    // Never log the token — only that decryption failed.
    emitTelemetry("agent-memory-session-scope-unavailable", {
      reason: "decrypt-failed",
      err: err instanceof Error ? err.message : String(err),
    })
    return { status: "unavailable" }
  }
  const ids = await fetchUserInstallationIds(accessToken)
  if (ids === null) {
    emitTelemetry("agent-memory-session-scope-unavailable", { reason: "github-enumeration-failed" })
    return { status: "unavailable" }
  }
  return { status: "ok", ids }
}

/**
 * Resolve a GitHub session through the provider-independent identity table. This
 * supports legacy sessions that predate SessionRecord.userId and also rejects a
 * corrupted/stale session whose stored userId disagrees with its authenticated
 * GitHub identity. Non-GitHub sessions have no githubUserId, so their server-side
 * session userId remains the only stable identity available.
 */
export async function resolveSessionStableUserId(env: Env, session: AuthedSession): Promise<string | null> {
  const storedUserId = session.record.userId?.trim()
  const githubUserId = session.record.githubUserId
  if (githubUserId === undefined) return storedUserId || null
  // Session records live server-side behind opaque cookies, so their stable
  // userId remains authoritative when this deployment has no D1 binding. When
  // D1 is bound, re-resolve and compare; a D1 error never takes this fallback.
  if (!env.SIGILIX_PLATFORM_DB) return storedUserId || null

  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare("SELECT user_id FROM user_identity WHERE github_user_id = ?")
      .bind(String(githubUserId))
      .first<{ user_id: string }>()
    const resolvedUserId = row?.user_id?.trim()
    if (!resolvedUserId) return null
    if (storedUserId && canonicalTenantId(storedUserId) !== canonicalTenantId(resolvedUserId)) {
      emitTelemetry("agent-memory-session-identity-mismatch", { githubUserId })
      return null
    }
    return resolvedUserId
  } catch (err) {
    emitTelemetry("agent-memory-session-identity-resolve-failed", {
      githubUserId,
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Resolve the caller's tenant scope from EITHER a portal session cookie OR a
 * bearer api key (session first). Returns the 401 Response (from requireApiTenant)
 * when neither authenticates. See the file header for the prefix derivation.
 */
async function resolveMemoryScope(request: Request, env: Env, ctx?: ExecutionContext): Promise<MemoryScopeResult> {
  const session = await requireSession(request, env, ctx)
  if (session) {
    const stableUserId = await resolveSessionStableUserId(env, session)
    if (!stableUserId) return { response: json({ error: "memory_identity_unavailable" }, 403) }
    // READ fail-soft: an unresolved installation set degrades to an empty scope
    // (200 with no memories), never an error — the management surface's contract.
    const resolved = await resolveSessionInstallationIds(env, session)
    const installationIds = resolved.status === "ok" ? resolved.ids : []
    const personalUserIds = installationIds.map((installationId) => personalMemoryUserId(installationId, stableUserId))
    return {
      scope: {
        prefixes: personalUserIds.map(personalPrefix),
        owns: ownsPersonalSubjects(personalUserIds),
      },
    }
  }

  const apiAuth = await requireApiTenant(request, env, ctx)
  if ("response" in apiAuth) return { response: apiAuth.response }

  const personalUserId = await resolveApiPersonalMemoryUserId(env, apiAuth.caller)
  if (personalUserId === null) return { response: json({ error: "memory_identity_unavailable" }, 403) }
  return {
    scope: {
      prefixes: [personalPrefix(personalUserId)],
      owns: ownsPersonalSubjects([personalUserId]),
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
 * lowercased write keyspace). `?limit=` (default 50, max 100)
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

// ─── POST /v1/memory — create a personal convention ──────────

/** The `kind`s a personal convention may carry. A convention is a durable
 *  self-preference, so only `preference` (default) and `decision` are allowed —
 *  both are plain free-text `AgentMemoryRecord` kinds that carry NO learnings
 *  `polarity` (the record shape has no such field), so a convention can only ADD
 *  non-conflicting context and can never reach `decideLearningSuppressions`. The
 *  dead_end/correction/task_state kinds are agent-authored and out of scope here. */
const CONVENTION_KINDS: ReadonlyArray<AgentMemoryKind> = ["preference", "decision"]

/** Char cap on one convention's content (matches the embedder's window). Longer
 *  than a sentence is almost certainly a paste, not a convention. */
const MAX_CONVENTION_CHARS = 4_000

interface CreateBody {
  content: string
  kind: AgentMemoryKind
}

/**
 * Parse the create body. ONLY `content` (required) + optional `kind` are read —
 * `repoId` is forced to the sentinel and `userId` is derived from the trusted
 * session, so neither is ever taken from the body (the seat-isolation invariant).
 */
function parseCreateBody(raw: unknown): CreateBody | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (typeof b.content !== "string" || b.content.trim() === "") return "content (non-empty string) is required"
  if (b.content.length > MAX_CONVENTION_CHARS) return `content exceeds ${MAX_CONVENTION_CHARS} chars`
  let kind: AgentMemoryKind = "preference"
  if (b.kind !== undefined) {
    if (typeof b.kind !== "string" || !(CONVENTION_KINDS as readonly string[]).includes(b.kind)) {
      return `kind must be one of: ${CONVENTION_KINDS.join(", ")}`
    }
    kind = b.kind as AgentMemoryKind
  }
  return { content: b.content, kind }
}

/** One created convention in the response (per installation the caller owns). */
interface CreatedConvention {
  id: string
  installationId: number
  deduped: boolean
  stored: boolean
}

/**
 * POST /v1/memory — the SESSION-authed create path for a signed-in user's OWN
 * repo-agnostic personal conventions (the "My conventions" bucket). The api-key
 * create path stays PUT /v1/memory; this is portal-only.
 *
 * The record is written under the reserved sentinel repoId
 * ({@link PERSONAL_CONVENTION_REPO_ID}) via the same {@link storeMemoryFact}
 * primitive the CLI write uses — a free-text `preference`/`decision` record that
 * carries NO learnings polarity, so it can only add context, never suppress or
 * require a finding.
 *
 * SEAT ISOLATION: the owning `userId` is derived ENTIRELY from the trusted session
 * (`resolveSessionStableUserId` × each installation the session's GitHub token
 * owns) — never from the body. A caller can therefore only ever write under its
 * OWN `inst:<installationId>:user:<stableUserId>` prefix. The convention is
 * fanned out across ALL the caller's installations (mirroring how GET/DELETE union
 * those same prefixes) so it applies to every one of the user's own sessions.
 *
 * 503 until keyed OR when the installation set can't be resolved (retryable); 401
 * without a session (the api-key create path is PUT); 403 when the session has no
 * resolvable stable identity; 400/413 on a bad/oversized body; 409 when the
 * session genuinely owns no installation (nowhere personal to store it); 500 only
 * on an unexpected write throw. Success: 201
 * `{ ok: true, count, created: [{ id, installationId, deduped, stored }] }`.
 */
export async function handleMemoryCreateRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "memory_endpoint_not_configured" }, 503)
  }

  // SESSION-ONLY: the portal browser cookie. An api key must use PUT /v1/memory.
  const session = await requireSession(request, env, ctx)
  if (!session) return json({ error: "unauthorized" }, 401)
  const stableUserId = await resolveSessionStableUserId(env, session)
  if (!stableUserId) return json({ error: "memory_identity_unavailable" }, 403)

  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null)
      return json({ error: "payload_too_large", detail: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    raw = JSON.parse(capped)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseCreateBody(raw)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  // Every installation the trusted session owns — the SAME set GET/DELETE union.
  // WRITE (not read): distinguish a genuine empty set (409, nowhere to store it)
  // from a resolution failure (503, retryable) so a transient GitHub outage never
  // silently drops the write behind a misleading "no installation".
  const resolved = await resolveSessionInstallationIds(env, session)
  if (resolved.status === "unavailable") return json({ error: "memory_scope_unavailable" }, 503)
  if (resolved.ids.length === 0) return json({ error: "memory_no_installation" }, 409)

  const created: CreatedConvention[] = []
  try {
    for (const installationId of resolved.ids) {
      // Owner derived from trusted identity ONLY — never the body. repoId is the
      // repo-agnostic sentinel; the body cannot influence either.
      const userId = personalMemoryUserId(installationId, stableUserId)
      const result = await storeMemoryFact(env, {
        userId,
        repoId: PERSONAL_CONVENTION_REPO_ID,
        kind: parsed.kind,
        content: parsed.content,
      })
      created.push({ id: result.id, installationId, deduped: result.deduped, stored: result.stored })
    }
  } catch (err) {
    return json({ error: "memory_write_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }

  return json({ ok: true, count: created.length, created }, 201)
}
