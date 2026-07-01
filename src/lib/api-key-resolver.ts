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
import { resolveInstallation, type InstallationLookup } from "@/src/shared/adapters/github/github-installation"
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

/** Either the resolved caller, or the 401 Response the route should return as-is. */
export type ApiTenantAuth = { response: Response } | { caller: ResolvedApiKey }

/**
 * #155 onboarding-backend slice 2 — the shared auth gate every hosted user-facing
 * endpoint (`/v1/review`, `/v1/context`, `/v1/verify`, `/v1/blast-radius`, `/v1/fleet`,
 * `/v1/memory*`, the Boreas/Pyroeis/Astraeus gateway routes) uses instead of
 * hand-rolling its own `resolveApiKey` + null-check + 401. It is a thin wrapper —
 * ALL the auth logic (D1 lookup, fail-closed-on-fault, legacy global-key fallback)
 * still lives in {@link resolveApiKey} above; this only standardizes the null ->
 * 401 branch so every route returns the identical `{ error: "unauthorized" }` JSON
 * shape those routes already returned before this helper existed.
 *
 * A null resolution — missing/garbage bearer, a revoked key, OR a genuine D1 fault
 * during the lookup (fail-closed, see resolveApiKey's header comment) — always
 * yields the 401 branch here. There is no path from "resolution failed" to the
 * caller branch: never a bypass.
 */
export async function requireApiTenant(
  request: Request,
  env: ResolverEnv,
  ctx?: ExecutionContext,
): Promise<ApiTenantAuth> {
  const caller = await resolveApiKey(request, env, ctx)
  if (!caller) {
    return {
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    }
  }
  return { caller }
}

/**
 * SIG-494 — tenant-scope reconciliation gate for the GitHub-App-backed grounding/
 * retrieval routes (`/v1/context`, `/v1/blast-radius`, `/v1/review` Mode B). Every
 * one of those routes independently re-resolves an installation from a BODY-supplied
 * owner/repo (`resolveInstallation`) to build the real GitHub client / run the
 * retrieval — that resolution is correct on its own, but before this gate nothing
 * checked it against the CALLER's own installationId (from {@link resolveApiKey}).
 * Net effect of the bug: any valid per-tenant key could request grounded
 * retrieval for ANY indexed repo on the platform, not just its own — a
 * cross-tenant leak. This function is the fix: call it with the caller's
 * resolved installationId and the repo's resolved installation lookup; a false
 * result means the caller does not own that repo and the route MUST refuse
 * (403) before touching retrieval.
 *
 * - LEGACY global key ({@link LEGACY_TENANT_INSTALLATION_ID}) — stays BROAD on
 *   purpose. It is Sigilix-internal (never handed to an external tenant), so
 *   restricting it to one installation would break existing internal callers
 *   that legitimately span every installation. Always returns true.
 * - A REAL per-tenant key — the repo's resolved installation must be the SAME
 *   installation the key resolved to. A repo lookup that fails (`lookup.ok ===
 *   false` — not installed / map missing / bad JSON) is NOT "no restriction" —
 *   it fails closed to false, matching this repo's inverted-fail-closed
 *   authentication convention (see the file header).
 */
export function callerOwnsInstallation(callerInstallationId: number, lookup: InstallationLookup): boolean {
  if (callerInstallationId === LEGACY_TENANT_INSTALLATION_ID) return true
  return lookup.ok && lookup.installationId === callerInstallationId
}

/**
 * Convenience wrapper over {@link callerOwnsInstallation} for the (common) case
 * where the caller hasn't already resolved the repo's installation itself — it
 * runs the same `resolveInstallation` lookup every GitHub-App-backed route uses
 * (against `env.OPENCLAW_GITHUB_INSTALLATION_MAP`) and reconciles it in one call.
 */
export function callerOwnsRepo(
  callerInstallationId: number,
  owner: string,
  repo: string,
  installationMapJson: string | undefined,
): boolean {
  return callerOwnsInstallation(callerInstallationId, resolveInstallation(owner, repo, installationMapJson))
}

function warnTouchFailed(error: unknown): void {
  console.warn(
    JSON.stringify({
      event: "api-key-touch-last-used-failed",
      err: error instanceof Error ? error.message : String(error),
    }),
  )
}
