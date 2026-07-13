import type { Env } from "@/src/shared/types/env"
import { LEGACY_TENANT_INSTALLATION_ID, type ResolvedApiKey } from "@/src/lib/api-key-resolver"

/** Canonical tenant id used by both KV keys and Vectorize namespaces. */
export function canonicalTenantId(value: string): string {
  return value.trim().toLowerCase()
}

/** Installation confinement for one already-authenticated subject. */
export function scopeMemoryUserId(userId: string, installationId: number): string {
  return `inst:${installationId}:${userId}`
}

/** Provider-independent personal subject shared by API-key and portal callers. */
export function personalMemoryUserId(installationId: number, stableUserId: string): string {
  return scopeMemoryUserId(`user:${canonicalTenantId(stableUserId)}`, installationId)
}

/**
 * Resolve a tenant API key to its provider-independent personal-memory subject.
 * The legacy global key and keys whose creator cannot be proven fail closed.
 */
export async function resolveApiPersonalMemoryUserId(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  caller: ResolvedApiKey,
): Promise<string | null> {
  if (
    caller.installationId === LEGACY_TENANT_INSTALLATION_ID ||
    !caller.createdBy?.trim() ||
    !env.SIGILIX_PLATFORM_DB
  ) {
    return null
  }

  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare("SELECT user_id FROM user_identity WHERE github_user_id = ?")
      .bind(caller.createdBy)
      .first<{ user_id: string }>()
    const stableUserId = row?.user_id?.trim()
    return stableUserId ? personalMemoryUserId(caller.installationId, stableUserId) : null
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "agent-memory-personal-subject-resolve-failed",
        installationId: caller.installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}
