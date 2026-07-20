// sig-portal-memories: the portal's repo-scope "Codebase facts" API — the
// dev-writable sibling of org-learnings-route.ts. Where the org route writes
// admin-authored, org-wide guardrails, this one writes REPO-scoped codebase
// facts that any developer with write access to the repo can author.
//
//   GET    /v1/org/:installationId/repos/:repoId/learnings[?cursor=&limit=] → { role, canWrite, entries, cursor? }
//   POST   /v1/org/:installationId/repos/:repoId/learnings                  → { role, canWrite, entry } | typed error
//   DELETE /v1/org/:installationId/repos/:repoId/learnings/:id              → { role, canWrite, ok }
//
// These write to the REPO LEARNINGS KV store (`learnings:repo:<repoId>`) via the
// existing `appendLearning`/`loadLearnings`/`forgetLearning` — the SAME store PR
// review reads for that repo (`loadEffectiveLearnings`) and the CLI grounds on.
// This is deliberately NOT the D1 `app_memory` store (app-memory-route.ts), which
// PR review never reads; a manual fact typed here has to land in `learnings:repo:*`
// to actually influence a review of THIS repo.
//
// A manual entry is `polarity:"context"` (durable context, NEVER a suppression —
// this route must never write a `suppress` that could silence a real finding) and
// `source.kind:"portal"`. The taxonomy `type` is restricted to the two DURABLE
// tiers (`architectural_fact` | `durable_preference`); the machine/PR-anchored
// tiers (`ephemeral_project` | `transient_feedback`) are rejected — a human
// hand-writing a lasting fact is never ephemeral project state.
//
// SHARED STORE: `learnings:repo:*` also holds machine-captured entries from the
// PR-review capture path (inline-reply/top-level/qa, which can be suppress/require).
// This route governs ONLY the `source.kind:"portal"` subset — GET hides the rest
// and DELETE 404s on a non-portal id — so a dev can never delete a machine-learned
// `require` guardrail through the portal (recall-safety). The MAX_LEARNINGS cap is
// the WHOLE store's ceiling, so the count check spans every entry (never evicting).
//
// AUTH — SESSION-ONLY, PER-INSTALLATION + PER-REPO (fail-closed). Unlike the org
// route (admin-gated), writes here require REPO WRITE access — any dev, not just
// admins. The gate is three checks:
//   1. `requireSession` → the caller's session + decrypted GitHub user token.
//   2. `resolveExactUserInstallationScope` → the caller must belong to THIS
//      installation (tenant isolation; 403 otherwise). Yields the caller's
//      installation `role` (echoed for the UI).
//   3. REPO write-access, via the caller's OWN GitHub token: `GET /repositories/
//      {repoId}` → accept a write iff `.permissions.(push|maintain|admin)`. The
//      same call yields `.full_name`, which the CROSS-TENANT guard resolves back
//      through the D1 repo registry (`lookupRepoByFullName`): the repo must be
//      registered under THIS installation (matching installationId AND repoId),
//      else a caller could target `learnings:repo:<foreignRepoId>` for a repo in
//      some other tenant. This is the load-bearing check.
// GET is allowed for any installation member (read-only) but STILL cross-tenant
// gated — a member of org A can never read org B's repo store. Every response
// echoes `{ role, canWrite }` so the UI gates without a second call. FAIL-CLOSED
// on any auth error; FAIL-SOFT (typed error, never a 500 stack) on store errors.

import {
  MAX_LEARNINGS,
  appendLearning,
  computeLearningId,
  forgetLearning,
  loadLearnings,
  normalizeRule,
  type LearningEntry,
  type LearningMemoryType,
} from "@/src/features/learnings"
import { lookupRepoByFullName } from "@/src/features/tenancy"
import { requireSession } from "@/src/lib/auth-middleware"
import { getValidGithubToken } from "@/src/lib/github-user-token"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { resolveExactUserInstallationScope, type UserRole } from "@/src/lib/resolve-user-role"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const MAX_BODY_BYTES = 8 * 1024
const MAX_PATH_GLOB_LEN = 256
// The repo store holds at most MAX_LEARNINGS (50) entries, so a single page always
// covers the whole set — pagination exists only to honor the app-memories envelope.
const DEFAULT_LIMIT = MAX_LEARNINGS
const MAX_LIMIT = MAX_LEARNINGS
// `computeLearningId` returns the first 16 hex chars of a SHA-256.
const SAFE_LEARNING_ID = /^[0-9a-f]{16}$/
// Manual context entries may only be one of the two DURABLE tiers.
const ALLOWED_TYPES: ReadonlySet<LearningMemoryType> = new Set<LearningMemoryType>([
  "architectural_fact",
  "durable_preference",
])

interface AuthToken {
  login: string
  accessToken: string
}

type TokenResult = { ok: true; value: AuthToken } | { ok: false; response: Response }

interface RepoAccess {
  login: string
  role: UserRole
  canWrite: boolean
}

type RepoAccessResult = { ok: true; value: RepoAccess } | { ok: false; response: Response }

/** GET — list the repo's manual learnings. Member-readable, cross-tenant gated. */
export async function handleListRepoLearnings(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  repoId: number,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  if (!validRepoId(repoId)) return json({ error: "invalid repo id" }, 400)
  // Reading requires membership + the cross-tenant guard, NOT repo write access.
  const access = await authRepoAccess(request, env, ctx, installationId, repoId)
  if (!access.ok) return access.response

  const url = new URL(request.url)
  const limit = parseLimit(url.searchParams.get("limit"))
  const offset = parseCursor(url.searchParams.get("cursor"))
  if (offset === "invalid") return json({ error: "invalid cursor" }, 400)

  const store = await loadLearnings(env, "repo", String(repoId))
  // Only portal-authored entries belong to "Codebase facts". The repo store is
  // SHARED with the PR-review capture path (inline-reply/top-level/qa entries,
  // which can be suppress/require polarity); those are internal review-tuning
  // state and must never be surfaced to — or deletable by — the portal UI.
  const sorted = portalEntries(store?.entries).sort((a, b) => Date.parse(b.createdTs) - Date.parse(a.createdTs))
  const page = sorted.slice(offset, offset + limit)
  const nextOffset = offset + limit
  return json({
    version: 1,
    installationId,
    repoId,
    role: access.value.role,
    canWrite: access.value.canWrite,
    entries: page.map(publicLearning),
    ...(nextOffset < sorted.length ? { cursor: encodeCursor(nextOffset) } : {}),
  })
}

/** POST — append a manual learning. Repo-write required (any dev, not just admins). */
export async function handleCreateRepoLearning(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  repoId: number,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  if (!validRepoId(repoId)) return json({ error: "invalid repo id" }, 400)
  // CSRF guard (SameSite=None session cookie) — force a preflight before the body.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const access = await authRepoAccess(request, env, ctx, installationId, repoId)
  if (!access.ok) return access.response
  // Writes require repo write-access — reading membership is not enough.
  if (!access.value.canWrite) return json({ error: "forbidden" }, 403)

  const parsed = await parseCreateBody(request)
  if (parsed instanceof Response) return parsed

  // Redact secrets/emails and strip remember:/note: prefixes BEFORE hashing, so
  // the id is content-addressed on the stored (redacted) rule and a secret never
  // reaches KV.
  const normalized = normalizeRule(parsed.rule)
  if (normalized.length === 0) return json({ error: "invalid request" }, 400)
  const id = await computeLearningId(normalized)

  const entry: LearningEntry = {
    id,
    rule: normalized,
    // Manual context — NEVER a suppression (recall-safety: this route can't silence a finding).
    polarity: "context",
    scope: "repo",
    subjectId: String(repoId),
    source: { kind: "portal" },
    createdTs: new Date().toISOString(),
    appliedCount: 0,
    type: parsed.type,
    authorLogin: access.value.login,
    ...(parsed.pathGlob ? { pathGlob: parsed.pathGlob } : {}),
  }

  // Honor MAX_LEARNINGS explicitly: `upsertEntry` would SILENTLY evict the
  // least-recently-applied entry at the cap, but the UI needs to see the limit.
  // A genuinely NEW id at the cap is rejected; an existing id (idempotent re-add)
  // is always allowed since it doesn't grow the set. The cap is the SHARED store's
  // 50-entry ceiling, so count the whole store, not just portal entries, to never
  // trigger eviction of a machine-captured guardrail.
  const store = await loadLearnings(env, "repo", String(repoId))
  const existing = store?.entries ?? []
  const priorById = existing.find((e) => e.id === id)
  const deduped = priorById !== undefined
  if (!deduped && existing.length >= MAX_LEARNINGS) {
    return json({ error: "limit_reached", limit: MAX_LEARNINGS }, 409)
  }

  const ok = await appendLearning(env, "repo", String(repoId), entry)
  if (!ok) return json({ error: "learnings_unavailable" }, 503)

  emitMutation(deduped ? "repo-learning-deduped" : "repo-learning-created", {
    installationId,
    repoId,
    learningId: id,
    type: entry.type,
    actorLogin: access.value.login,
  })
  // On an idempotent re-add `upsertEntry` keeps the ORIGINAL stored entry (only
  // bumps its applied count), so echo that — not the freshly-built one.
  return json(
    {
      version: 1,
      installationId,
      repoId,
      role: access.value.role,
      canWrite: true,
      deduped,
      entry: publicLearning(priorById ?? entry),
    },
    deduped ? 200 : 201,
  )
}

/** DELETE — forget a manual learning by id. Repo-write required (any dev, not just admins). */
export async function handleDeleteRepoLearning(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  repoId: number,
  id: string,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  if (!validRepoId(repoId)) return json({ error: "invalid repo id" }, 400)
  if (!SAFE_LEARNING_ID.test(id)) return json({ error: "not found" }, 404)
  const access = await authRepoAccess(request, env, ctx, installationId, repoId)
  if (!access.ok) return access.response
  if (!access.value.canWrite) return json({ error: "forbidden" }, 403)

  // Scope deletion to portal-authored entries only: this route must never let a
  // dev forget a machine-captured require/suppress guardrail from the shared
  // store (recall-safety). A non-portal (or absent) id reads as not-found.
  const store = await loadLearnings(env, "repo", String(repoId))
  const target = portalEntries(store?.entries).find((e) => e.id === id)
  if (!target) return json({ error: "not found" }, 404)

  const ok = await forgetLearning(env, "repo", String(repoId), id)
  if (!ok) return json({ error: "learnings_unavailable" }, 503)

  emitMutation("repo-learning-deleted", { installationId, repoId, learningId: id, actorLogin: access.value.login })
  return json({ role: access.value.role, canWrite: true, ok: true })
}

/**
 * Resolve the session + decrypt the caller's GitHub user-to-server token.
 * FAIL-CLOSED: no session → 401; missing encryption key → 503; decrypt fault →
 * 500. Mirrors org-learnings-route.ts's resolveAuthToken.
 */
async function resolveAuthToken(request: Request, env: Env, ctx: ExecutionContext | undefined): Promise<TokenResult> {
  const session = await requireSession(request, env, ctx)
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) }
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "repo-learnings-encryption-key-missing" }))
    return { ok: false, response: json({ error: "learnings_unavailable" }, 503) }
  }
  let accessToken: string
  try {
    accessToken = await getValidGithubToken({
      env,
      sessionId: session.sessionId,
      record: session.record,
      encryptionKeyB64url: env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "repo-learnings-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false, response: json({ error: "learnings_failed" }, 500) }
  }
  return { ok: true, value: { login: session.record.login, accessToken } }
}

/**
 * Session + per-installation membership + per-repo access gate. Returns the
 * caller's installation `role` and whether they have repo WRITE access. Every
 * failure is fail-closed:
 *   • not a member of the installation → 403 (tenant isolation),
 *   • the repo can't be read with the caller's token → 403,
 *   • the repo's full_name is NOT registered under this installation → 403
 *     (the CROSS-TENANT guard — repoId must belong to installationId).
 * `canWrite` is left for the caller to enforce on writes (GET permits reads).
 */
async function authRepoAccess(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  repoId: number,
): Promise<RepoAccessResult> {
  const token = await resolveAuthToken(request, env, ctx)
  if (!token.ok) return token
  const scope = await resolveExactUserInstallationScope(token.value.accessToken, token.value.login, installationId)
  if (!scope) return { ok: false, response: json({ error: "forbidden" }, 403) }

  // The caller's OWN token reads the repo — GitHub returns 404/403 if the caller
  // can't see it, and this yields `.full_name` + `.permissions` in one call.
  const repo = await fetchRepositoryById(token.value.accessToken, repoId)
  if (!repo) return { ok: false, response: json({ error: "forbidden" }, 403) }

  // CROSS-TENANT GUARD (load-bearing): the repo the caller named must actually be
  // registered under THIS installation. Without this a member of installation A
  // could write `learnings:repo:<repoId>` for a repo owned by tenant B.
  const registered = await lookupRepoByFullName(env, repo.fullName)
  if (!registered || registered.installationId !== installationId || registered.repoId !== repoId) {
    return { ok: false, response: json({ error: "forbidden" }, 403) }
  }

  return { ok: true, value: { login: token.value.login, role: scope.role, canWrite: repo.canWrite } }
}

/**
 * Read a repo by its numeric id with the caller's GitHub user token. Returns the
 * repo's `full_name` and whether the caller has WRITE access
 * (`permissions.push|maintain|admin`). FAIL-CLOSED to null on any error / non-2xx
 * / missing full_name — a repo the caller can't see is indistinguishable from one
 * that doesn't exist, and both must deny.
 */
async function fetchRepositoryById(
  accessToken: string,
  repoId: number,
): Promise<{ fullName: string; canWrite: boolean } | null> {
  let res: Response
  try {
    res = await fetch(`https://api.github.com/repositories/${repoId}`, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "sigilix-worker",
      },
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let body: { full_name?: unknown; permissions?: { push?: unknown; maintain?: unknown; admin?: unknown } | null }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return null
  }
  const fullName = typeof body.full_name === "string" ? body.full_name.trim() : ""
  if (!fullName) return null
  const perms = body.permissions ?? {}
  const canWrite = perms.push === true || perms.maintain === true || perms.admin === true
  return { fullName, canWrite }
}

async function parseCreateBody(
  request: Request,
): Promise<{ rule: string; type: LearningMemoryType; pathGlob?: string } | Response> {
  const raw = await readBodyCapped(request, MAX_BODY_BYTES)
  if (raw === null) return json({ error: "payload_too_large" }, 413)
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: "invalid json" }, 400)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid request" }, 400)
  const record = body as Record<string, unknown>

  const rule = typeof record.rule === "string" ? record.rule.trim() : ""
  if (rule.length === 0) return json({ error: "invalid request" }, 400)

  const type = parseType(record.type)
  if (type === "invalid") return json({ error: "invalid type" }, 400)

  const pathGlob = parsePathGlob(record.pathGlob)
  if (pathGlob === "invalid") return json({ error: "invalid pathGlob" }, 400)

  return { rule, type, ...(pathGlob !== undefined ? { pathGlob } : {}) }
}

/** Default `durable_preference`; accept the two durable tiers; REJECT the machine/PR-anchored tiers. */
function parseType(value: unknown): LearningMemoryType | "invalid" {
  if (value === undefined || value === null) return "durable_preference"
  if (typeof value !== "string") return "invalid"
  return ALLOWED_TYPES.has(value as LearningMemoryType) ? (value as LearningMemoryType) : "invalid"
}

function parsePathGlob(value: unknown): string | undefined | "invalid" {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") return "invalid"
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_PATH_GLOB_LEN) return "invalid"
  return trimmed
}

/** The portal-authored subset of a shared repo store (a fresh array, safe to sort). */
function portalEntries(entries: readonly LearningEntry[] | undefined): LearningEntry[] {
  return (entries ?? []).filter((e) => e.source.kind === "portal")
}

function publicLearning(entry: LearningEntry): Record<string, unknown> {
  return {
    id: entry.id,
    rule: entry.rule,
    type: entry.type ?? null,
    pathGlob: entry.pathGlob ?? null,
    polarity: entry.polarity,
    createdAt: entry.createdTs,
    ...(entry.authorLogin ? { authorLogin: entry.authorLogin } : {}),
  }
}

function parseLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

/** Opaque numeric-offset cursor. `null`/empty → 0; a non-negative safe integer → offset; else "invalid". */
function parseCursor(raw: string | null): number | "invalid" {
  if (raw === null || raw === "") return 0
  let decoded: string
  try {
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/")
    decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  } catch {
    return "invalid"
  }
  const parsed = Number(decoded)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : "invalid"
}

function encodeCursor(offset: number): string {
  return btoa(String(offset)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function validRepoId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

function emitMutation(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}
