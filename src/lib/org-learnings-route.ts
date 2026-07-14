// sig-portal-memories: the portal's "Memories & Context" API — admin-authored
// codebase facts / guardrails that shape PR reviews + CLI grounding.
//
//   GET    /v1/org/:installationId/learnings[?cursor=&limit=] → { role, entries, cursor? }
//   POST   /v1/org/:installationId/learnings                  → { role, entry } | typed error
//   DELETE /v1/org/:installationId/learnings/:id              → { role, ok }
//
// These write to the ORG LEARNINGS KV store (`learnings:org:<installationId>`)
// via the existing `appendLearning`/`loadLearnings`/`forgetLearning` — the SAME
// store PR review reads (`loadEffectiveLearnings`) and the CLI grounds on. This
// is deliberately NOT the D1 `app_memory` store (app-memory-route.ts), which PR
// review never reads; a manual guardrail typed here has to land in `learnings:*`
// to actually influence a review.
//
// A manual entry is `polarity:"context"` (durable context, NEVER a suppression —
// this route must never write a `suppress` that could silence a real finding) and
// `source.kind:"portal"`. The taxonomy `type` is restricted to the two DURABLE
// tiers (`architectural_fact` | `durable_preference`); the machine/PR-anchored
// tiers (`ephemeral_project` | `transient_feedback`) are rejected — a human
// hand-writing a lasting fact is never ephemeral project state.
//
// SHARED STORE: `learnings:org:*` also holds machine-captured entries from the
// PR-review path (inline-reply/top-level/qa, which can be suppress/require). This
// route governs ONLY the `source.kind:"portal"` subset — GET hides the rest and
// DELETE 404s on a non-portal id — so an admin can never delete a machine-learned
// `require` guardrail through the portal (recall-safety). The MAX_LEARNINGS cap is
// the WHOLE store's ceiling, so the count check spans every entry (never evicting).
//
// AUTH — SESSION-ONLY, PER-INSTALLATION (mirrors review-config-route.ts /
// data-consent-route.ts). Writes require the caller be an admin of THIS exact
// installation via `isAdminOfInstallation` (NOT the aggregate `resolveUserRole`),
// which enforces the admin gate AND tenant isolation in one check — an admin of
// org A gets 403 writing to org B (its install isn't one their token can see /
// admin). GET is allowed for members (read-only) but still scoped to an
// installation the caller belongs to (`resolveExactUserInstallationScope` → 403
// otherwise). Every response echoes `{ role }` so the UI gates without a second
// /auth/me. FAIL-CLOSED on any auth error; FAIL-SOFT (typed error, never a 500
// stack) on store errors.

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
import { requireSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import { isAdminOfInstallation, resolveExactUserInstallationScope } from "@/src/lib/resolve-user-role"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const MAX_BODY_BYTES = 8 * 1024
const MAX_PATH_GLOB_LEN = 256
// The org store holds at most MAX_LEARNINGS (50) entries, so a single page always
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

/** GET — list the org's manual learnings. Member-readable, scoped to the caller's installation. */
export async function handleListOrgLearnings(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  const token = await resolveAuthToken(request, env, ctx)
  if (!token.ok) return token.response
  const scope = await resolveExactUserInstallationScope(token.value.accessToken, token.value.login, installationId)
  if (!scope) return json({ error: "forbidden" }, 403)

  const url = new URL(request.url)
  const limit = parseLimit(url.searchParams.get("limit"))
  const offset = parseCursor(url.searchParams.get("cursor"))
  if (offset === "invalid") return json({ error: "invalid cursor" }, 400)

  const store = await loadLearnings(env, "org", String(installationId))
  // Only portal-authored entries belong to "Memories & Context". The org store
  // is SHARED with the PR-review capture path (inline-reply/top-level/qa entries,
  // which can be suppress/require polarity); those are internal review-tuning
  // state and must never be surfaced to — or deletable by — the portal UI.
  const sorted = portalEntries(store?.entries).sort((a, b) => Date.parse(b.createdTs) - Date.parse(a.createdTs))
  const page = sorted.slice(offset, offset + limit)
  const nextOffset = offset + limit
  return json({
    version: 1,
    installationId,
    role: scope.role,
    entries: page.map(publicLearning),
    ...(nextOffset < sorted.length ? { cursor: encodeCursor(nextOffset) } : {}),
  })
}

/** POST — append a manual learning. Admin-of-this-installation only. */
export async function handleCreateOrgLearning(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  // CSRF guard (SameSite=None session cookie) — force a preflight before the body.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)
  const admin = await authAdmin(request, env, ctx, installationId)
  if (!admin.ok) return admin.response

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
    scope: "org",
    subjectId: String(installationId),
    source: { kind: "portal" },
    createdTs: new Date().toISOString(),
    appliedCount: 0,
    type: parsed.type,
    authorLogin: admin.login,
    ...(parsed.pathGlob ? { pathGlob: parsed.pathGlob } : {}),
  }

  // Honor MAX_LEARNINGS explicitly: `upsertEntry` would SILENTLY evict the
  // least-recently-applied entry at the cap, but the UI needs to see the limit.
  // A genuinely NEW id at the cap is rejected; an existing id (idempotent re-add)
  // is always allowed since it doesn't grow the set.
  // The cap is the SHARED store's 50-entry ceiling (`upsertEntry` would silently
  // evict the LRU entry — possibly a machine-captured guardrail — at the cap, so
  // count the whole store, not just portal entries, to never trigger eviction).
  const store = await loadLearnings(env, "org", String(installationId))
  const existing = store?.entries ?? []
  const priorById = existing.find((e) => e.id === id)
  const deduped = priorById !== undefined
  if (!deduped && existing.length >= MAX_LEARNINGS) {
    return json({ error: "limit_reached", limit: MAX_LEARNINGS }, 409)
  }

  const ok = await appendLearning(env, "org", String(installationId), entry)
  if (!ok) return json({ error: "learnings_unavailable" }, 503)

  emitMutation(deduped ? "org-learning-deduped" : "org-learning-created", {
    installationId,
    learningId: id,
    type: entry.type,
    actorLogin: admin.login,
  })
  // On an idempotent re-add `upsertEntry` keeps the ORIGINAL stored entry (only
  // bumps its applied count), so echo that — not the freshly-built one.
  return json(
    { version: 1, installationId, role: "admin", deduped, entry: publicLearning(priorById ?? entry) },
    deduped ? 200 : 201,
  )
}

/** DELETE — forget a manual learning by id. Admin-of-this-installation only. */
export async function handleDeleteOrgLearning(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
  id: string,
): Promise<Response> {
  if (!validInstallationId(installationId)) return json({ error: "invalid installation id" }, 400)
  if (!SAFE_LEARNING_ID.test(id)) return json({ error: "not found" }, 404)
  const admin = await authAdmin(request, env, ctx, installationId)
  if (!admin.ok) return admin.response

  // Scope deletion to portal-authored entries only: this route must never let an
  // admin forget a machine-captured require/suppress guardrail from the shared
  // store (recall-safety). A non-portal (or absent) id reads as not-found.
  const store = await loadLearnings(env, "org", String(installationId))
  const target = portalEntries(store?.entries).find((e) => e.id === id)
  if (!target) return json({ error: "not found" }, 404)

  const ok = await forgetLearning(env, "org", String(installationId), id)
  if (!ok) return json({ error: "learnings_unavailable" }, 503)

  emitMutation("org-learning-deleted", { installationId, learningId: id, actorLogin: admin.login })
  return json({ role: "admin", ok: true })
}

/**
 * Resolve the session + decrypt the caller's GitHub user-to-server token.
 * FAIL-CLOSED: no session → 401; missing encryption key → 503; decrypt fault →
 * 500. Mirrors review-config-route.ts's authAdmin scaffolding.
 */
async function resolveAuthToken(request: Request, env: Env, ctx: ExecutionContext | undefined): Promise<TokenResult> {
  const session = await requireSession(request, env, ctx)
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) }
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "org-learnings-encryption-key-missing" }))
    return { ok: false, response: json({ error: "learnings_unavailable" }, 503) }
  }
  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
      session.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "org-learnings-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false, response: json({ error: "learnings_failed" }, 500) }
  }
  return { ok: true, value: { login: session.record.login, accessToken } }
}

/** Session + per-installation ADMIN gate (writes). Cross-tenant targets 403 here. */
async function authAdmin(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<{ ok: true; login: string } | { ok: false; response: Response }> {
  const token = await resolveAuthToken(request, env, ctx)
  if (!token.ok) return token
  const isAdmin = await isAdminOfInstallation(token.value.accessToken, token.value.login, installationId)
  if (!isAdmin) return { ok: false, response: json({ error: "forbidden" }, 403) }
  return { ok: true, login: token.value.login }
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

/** The portal-authored subset of a shared org store (a fresh array, safe to sort). */
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

function emitMutation(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}
