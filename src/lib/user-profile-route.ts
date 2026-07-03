// sig-user-profile — GET /v1/profile + PATCH /v1/profile.
//
// The portal's account menu (name + plan badge), empty-state greeting, and the
// /settings profile editor all read/write through here.
//
// AUTH (fail-closed): session cookie ONLY (requireSession). No bearer/api-key
// path — a profile is a human's, not an installation's. No session → 401.
//
// OWN-PROFILE-ONLY: the row key is ALWAYS session.record.githubUserId. There is
// no userId path/query param, so a caller can only ever read or write their own
// profile — there is no shape of request that reaches another user's row.
//
// display_name resolution: the response's `display_name` is the best available
// label — the persisted name, else the GitHub display name captured at OAuth,
// else the login. `display_name_source` tells the portal which one won so it can
// prettify a bare login for the greeting without guessing.
//
// plan: the caller's REAL plan via resolveUserPlan (resolve-plan.ts — the billing
// seam). Never hardcoded; defaults to "free" until subscription billing lands.
//
// CORS'd for the portal origins (portal-cors.ts, wired in index.ts).

import { requireSession } from "@/src/lib/auth-middleware"
import { resolveUserPlan, type PlanName } from "@/src/lib/resolve-plan"
import { readUserProfile, upsertUserProfile, type UserSettings } from "@/src/lib/user-profile-store"
import type { Env } from "@/src/shared/types/env"

const MAX_DISPLAY_NAME_LEN = 80
/** A generous cap on the serialized settings blob to bound D1 row size + abuse. */
const MAX_SETTINGS_BYTES = 8 * 1024

export type DisplayNameSource = "profile" | "github" | "login"

export interface ProfileResponse {
  display_name: string
  display_name_source: DisplayNameSource
  login: string
  settings: UserSettings
  plan: PlanName
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Best-available display name + which source it came from. */
function resolveDisplayName(
  persisted: string | null,
  githubName: string | null | undefined,
  login: string,
): { name: string; source: DisplayNameSource } {
  if (persisted && persisted.trim() !== "") return { name: persisted, source: "profile" }
  if (githubName && githubName.trim() !== "") return { name: githubName, source: "github" }
  return { name: login, source: "login" }
}

/** GET /v1/profile — session-authed. Returns the caller's own profile. */
export async function handleUserProfileGetRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  const { githubUserId, login } = authed.record
  // Reads degrade gracefully: a missing binding / no row / D1 fault → null, and
  // we fall back to the GitHub identity. Never a 5xx on the read path.
  const profile = await readUserProfile(env, githubUserId)
  const { name, source } = resolveDisplayName(profile?.displayName ?? null, authed.record.name, login)
  const plan = await resolveUserPlan(env, githubUserId)

  const body: ProfileResponse = {
    display_name: name,
    display_name_source: source,
    login,
    settings: profile?.settings ?? {},
    plan,
  }
  return json(body, 200)
}

interface PatchBody {
  display_name?: unknown
  settings?: unknown
}

/** PATCH /v1/profile — session-authed. Updates the caller's OWN display_name / settings. */
export async function handleUserProfilePatchRoute(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  if (!env.SIGILIX_PLATFORM_DB) {
    console.error(JSON.stringify({ event: "user-profile-patch-db-missing" }))
    return json({ error: "unavailable" }, 503)
  }

  let raw: PatchBody
  try {
    raw = (await request.json()) as PatchBody
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return json({ error: "invalid_body" }, 400)
  }

  // display_name: string (trimmed, length-capped), null (clear → fallback), or
  // absent (leave unchanged). Anything else is a 400.
  let displayName: string | null | undefined
  if ("display_name" in raw) {
    const dn = raw.display_name
    if (dn === null) {
      displayName = null
    } else if (typeof dn === "string") {
      const trimmed = dn.trim()
      if (trimmed.length > MAX_DISPLAY_NAME_LEN) {
        return json({ error: "display_name_too_long", max: MAX_DISPLAY_NAME_LEN }, 400)
      }
      displayName = trimmed === "" ? null : trimmed
    } else {
      return json({ error: "invalid_display_name" }, 400)
    }
  }

  // settings: a plain object replaces the whole blob; absent leaves it unchanged.
  let settings: UserSettings | undefined
  if ("settings" in raw) {
    const s = raw.settings
    if (s == null || typeof s !== "object" || Array.isArray(s)) {
      return json({ error: "invalid_settings" }, 400)
    }
    const serialized = JSON.stringify(s)
    if (serialized.length > MAX_SETTINGS_BYTES) {
      return json({ error: "settings_too_large", max_bytes: MAX_SETTINGS_BYTES }, 400)
    }
    settings = s as UserSettings
  }

  if (displayName === undefined && settings === undefined) {
    return json({ error: "no_fields" }, 400)
  }

  try {
    await upsertUserProfile(env, {
      githubUserId: authed.record.githubUserId,
      nowIso: new Date().toISOString(),
      // Only include a field when the caller actually sent it (undefined =
      // "leave unchanged"); exactOptionalPropertyTypes forbids passing undefined.
      ...(displayName !== undefined ? { displayName } : {}),
      ...(settings !== undefined ? { settings } : {}),
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "user-profile-patch-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "update_failed" }, 500)
  }

  // Return the freshly-resolved profile so the client can reflect it immediately.
  return handleUserProfileGetRoute(request, env, ctx)
}
