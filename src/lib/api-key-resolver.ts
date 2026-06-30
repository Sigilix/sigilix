// #155 onboarding-backend FOUNDATION (slice 1 of 2) — the per-installation API
// key resolver.
//
// NOT WIRED INTO ANY ENDPOINT YET. This module is added and tested in this
// slice but nothing calls it — swapping the consuming endpoints (the
// /v1/review-style routes currently authed against the single global
// OPENCLAW_SIGILIX_API_KEY) onto resolveApiKey() is slice 2.
//
// FAIL-CLOSED BY DESIGN — read this before touching this file. Every other
// D1 read in this repo (e.g. d1-tenant-store.ts's readTenantConfig) fails
// OPEN: a D1 error is treated as "no data, proceed anyway", because those
// reads gate non-auth features (rate-limit tiers, telemetry) where a false
// negative is cheap and a request stall is worse. This function gates
// AUTHENTICATION. A real D1 outage (or an attacker-induced fault) must NEVER
// be interpreted as "let the bearer through" — that would turn a database
// blip into an auth bypass. So the rule here is inverted on purpose:
//
//   - D1 binding absent                      -> skip the per-key lookup,
//                                                fall through to the legacy
//                                                global-key compare (this is
//                                                "no DB configured", not a
//                                                fault — same as today's
//                                                global-key-only behavior).
//   - D1 query throws (genuine error)        -> FAIL CLOSED. Return null
//                                                immediately. Do NOT fall
//                                                through to the global key.
//   - D1 query succeeds, no matching row     -> clean "not found" (covers a
//     (revoked or never-issued key)             revoked key, since the query
//                                                filters revoked_at IS NULL).
//                                                Falls through to the legacy
//                                                global-key compare.
//   - D1 query succeeds, row found           -> resolved to that
//                                                installation. last_used_at
//                                                is updated best-effort; a
//                                                touch failure never flips a
//                                                successful resolution to a
//                                                failure.

import { extractBearerToken, requireBearerToken, sha256Hex } from "@/src/lib/auth-bearer"
import { touchApiKeyLastUsed } from "@/src/lib/api-key-store"
import type { Env } from "@/src/shared/types/env"

/**
 * Sentinel installationId returned when a bearer resolves via the legacy
 * shared-secret global key (OPENCLAW_SIGILIX_API_KEY) rather than a
 * per-installation api_key row. No real GitHub installation_id is negative,
 * so this value is unambiguous and downstream code (slice 2) must special-
 * case it to mean "the global legacy key, no specific installation".
 */
export const LEGACY_TENANT_INSTALLATION_ID = -1

export interface ResolvedApiKey {
  installationId: number
}

type ResolverEnv = Pick<Env, "SIGILIX_PLATFORM_DB" | "OPENCLAW_SIGILIX_API_KEY">

export async function resolveApiKey(
  request: Request,
  env: ResolverEnv,
  ctx?: ExecutionContext,
): Promise<ResolvedApiKey | null> {
  const presented = extractBearerToken(request)
  if (!presented) return null

  if (env.SIGILIX_PLATFORM_DB) {
    const db = env.SIGILIX_PLATFORM_DB
    const keyHash = await sha256Hex(presented)
    let row: { installation_id: number } | null
    try {
      row = await db
        .prepare("SELECT installation_id FROM api_key WHERE key_hash = ? AND revoked_at IS NULL")
        .bind(keyHash)
        .first<{ installation_id: number }>()
    } catch (error) {
      // FAIL CLOSED. See file header — never fall through on a genuine D1 fault.
      console.error(
        JSON.stringify({
          event: "api-key-resolve-d1-error-fail-closed",
          err: error instanceof Error ? error.message : String(error),
        }),
      )
      return null
    }
    if (row != null) {
      // Best-effort last_used_at touch. With a ctx (the request path, slice 2),
      // fire-and-forget via waitUntil so it adds no latency to the hot auth
      // path; without one (tests / non-request callers), await it so behavior
      // stays deterministic. A touch failure must NEVER undo a successful auth
      // resolution, so it is always caught and logged, never rethrown.
      const touch = touchApiKeyLastUsed(db, keyHash, new Date().toISOString())
      if (ctx) {
        ctx.waitUntil(touch.catch((error) => warnTouchFailed(error)))
      } else {
        try {
          await touch
        } catch (error) {
          warnTouchFailed(error)
        }
      }
      return { installationId: row.installation_id }
    }
    // Clean "not found" (never issued, or revoked) — fall through below.
  }

  // Legacy fallback — constant-time compare against the single shared global
  // key, preserving the existing /v1/review-style auth behavior unchanged.
  if (await requireBearerToken(request, env.OPENCLAW_SIGILIX_API_KEY ?? "")) {
    return { installationId: LEGACY_TENANT_INSTALLATION_ID }
  }
  return null
}

function warnTouchFailed(error: unknown): void {
  console.warn(
    JSON.stringify({
      event: "api-key-touch-last-used-failed",
      err: error instanceof Error ? error.message : String(error),
    }),
  )
}
