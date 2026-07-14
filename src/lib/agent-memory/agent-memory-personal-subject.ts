import type { Env } from "@/src/shared/types/env"
import { LEGACY_TENANT_INSTALLATION_ID, type ResolvedApiKey } from "@/src/lib/api-key-resolver"

/** Canonical tenant id used by both KV keys and Vectorize namespaces. */
export function canonicalTenantId(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Reserved sentinel `repoId` for a user's REPO-AGNOSTIC personal conventions —
 * the "My conventions" bucket a signed-in user writes from the portal ("I prefer
 * verbose commit messages"). A personal convention is about the person, not a
 * repo, so it lives under this sentinel instead of any real `owner/name`.
 *
 * `"*"` is not a valid repo id — `canonicalTenantId` never derives it from a real
 * repo (real ids are `owner/name` or numeric), and KV `list({prefix})` / the
 * Vectorize namespace treat it as a literal string, not a glob — so it can never
 * collide with a real repo's records.
 *
 * The seat READ paths surface it repo-agnostically:
 *  - GET /v1/memory (list) walks the whole `agent-memory:<userId>:` prefix, so a
 *    sentinel record lists alongside real-repo records (filterable via `?repoId=*`).
 *  - the portal-chat seat read (agent-memory-chat-surface.ts) walks that SAME
 *    prefix, so a convention applies to the user's chat regardless of repo.
 *  - the CLI POST /v1/memory/query is repo-scoped by Vectorize NAMESPACE
 *    (`<userId>/<repoId>`), so a sentinel record does NOT yet surface there — a
 *    dual-namespace read-union is a separate, larger change (its own PR).
 */
export const PERSONAL_CONVENTION_REPO_ID = "*"

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
