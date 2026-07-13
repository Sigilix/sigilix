import type { Env } from "@/src/shared/types/env"
import { LEGACY_TENANT_INSTALLATION_ID, type ResolvedApiKey } from "@/src/lib/api-key-resolver"

/** Canonical tenant id used by both KV keys and Vectorize namespaces. */
export function canonicalTenantId(value: string): string {
  return value.trim().toLowerCase()
}

/** Generic installation scope with the historical internal-global-key exemption. */
export function scopeMemoryUserId(userId: string, installationId: number): string {
  if (installationId === LEGACY_TENANT_INSTALLATION_ID) return userId
  return `inst:${installationId}:${userId}`
}

/** Provider-independent personal subject shared by API-key and portal callers.
 * Unlike the generic helper, personal subjects are always installation-scoped;
 * personal HTTP routes reject the legacy key before this helper is reached. */
export function personalMemoryUserId(installationId: number, stableUserId: string): string {
  return `inst:${installationId}:user:${canonicalTenantId(stableUserId)}`
}

export type ApiStableUserIdResolution = { status: "ok"; userId: string | null } | { status: "unavailable" }

/** Resolve an API-key creator to the bare provider-independent D1 user id. */
export async function resolveApiStableUserId(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  caller: ResolvedApiKey,
): Promise<ApiStableUserIdResolution> {
  if (caller.installationId === LEGACY_TENANT_INSTALLATION_ID || !caller.createdBy?.trim()) {
    return { status: "ok", userId: null }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { status: "unavailable" }

  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare("SELECT user_id FROM user_identity WHERE github_user_id = ?")
      .bind(caller.createdBy)
      .first<{ user_id: string }>()
    const stableUserId = row?.user_id?.trim()
    return { status: "ok", userId: stableUserId || null }
  } catch {
    console.error(
      JSON.stringify({
        event: "agent-memory-personal-subject-resolve-failed",
        installationId: caller.installationId,
      }),
    )
    return { status: "unavailable" }
  }
}

/**
 * Resolve a tenant API key to its provider-independent personal-memory subject.
 * The legacy global key and keys whose creator cannot be proven fail closed.
 */
export async function resolveApiPersonalMemoryUserId(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  caller: ResolvedApiKey,
): Promise<string | null> {
  const resolution = await resolveApiStableUserId(env, caller)
  if (resolution.status === "unavailable" || resolution.userId === null) return null
  return personalMemoryUserId(caller.installationId, resolution.userId)
}
