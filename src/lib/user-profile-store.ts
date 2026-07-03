// sig-user-profile — D1 access for the `user_profile` table (migration 0004).
//
// Keyed strictly by githubUserId. Every function here takes the id explicitly;
// the route layer only ever passes the SESSION's own id, so a caller can never
// read or write another user's row (tenant/self isolation is enforced above).
//
// `settings` is stored as a JSON string. It is opaque to D1 — the shape is owned
// by the application (UserSettings below). Reads tolerate legacy/corrupt JSON by
// falling back to an empty object rather than throwing.

import type { Env } from "@/src/shared/types/env"

type ProfileDbEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

/** User preferences. Intentionally open-ended — new keys are additive. */
export interface UserSettings {
  /** UI theme preference. Absent = follow the app default. */
  theme?: "system" | "dark" | "light"
  /** Free-form "about me" the profile page lets the user set. */
  bio?: string
  [key: string]: unknown
}

export interface UserProfile {
  githubUserId: number
  /** The name the user set for themselves; null when never set. */
  displayName: string | null
  settings: UserSettings
  createdAt: string
  updatedAt: string
}

interface ProfileRow {
  github_user_id: number
  display_name: string | null
  settings: string | null
  created_at: string
  updated_at: string
}

/** Parse the stored settings JSON, tolerating null/corrupt values → {}. */
function parseSettings(raw: string | null): UserSettings {
  if (raw == null || raw.trim() === "") return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as UserSettings) : {}
  } catch {
    return {}
  }
}

function rowToProfile(row: ProfileRow): UserProfile {
  return {
    githubUserId: row.github_user_id,
    displayName: typeof row.display_name === "string" && row.display_name !== "" ? row.display_name : null,
    settings: parseSettings(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Read a single user's profile. Returns null when the binding is missing, no row
 * exists, or D1 faults — the route layer degrades to identity fallbacks so a
 * first-time (never-saved) user still gets a working profile.
 */
export async function readUserProfile(env: ProfileDbEnv, githubUserId: number): Promise<UserProfile | null> {
  if (!env.SIGILIX_PLATFORM_DB) return null
  try {
    const row = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT github_user_id, display_name, settings, created_at, updated_at FROM user_profile WHERE github_user_id = ?",
    )
      .bind(githubUserId)
      .first<ProfileRow>()
    return row ? rowToProfile(row) : null
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "user-profile-read-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
}

export interface UpsertProfileInput {
  githubUserId: number
  /** undefined = leave unchanged; null = clear back to fallback; string = set. */
  displayName?: string | null
  /** undefined = leave unchanged; object = replace the whole settings blob. */
  settings?: UserSettings
  nowIso: string
}

/**
 * Insert or update the caller's own profile row. On conflict, only the fields
 * present in `input` are overwritten (COALESCE keeps the stored value when a
 * field is left unchanged); created_at is preserved. Throws on a real D1 fault
 * so the route returns 5xx rather than a silent no-op.
 */
export async function upsertUserProfile(env: ProfileDbEnv, input: UpsertProfileInput): Promise<UserProfile> {
  const db = env.SIGILIX_PLATFORM_DB
  if (!db) throw new Error("user-profile-store: SIGILIX_PLATFORM_DB not bound")

  // undefined → NULL bind + "keep existing" via COALESCE on conflict. For
  // display_name we distinguish "leave unchanged" (undefined) from "clear"
  // (null) with a sentinel flag column so COALESCE can tell them apart.
  const setDisplay = input.displayName !== undefined
  const displayValue = input.displayName ?? null
  const setSettings = input.settings !== undefined
  const settingsValue = setSettings ? JSON.stringify(input.settings) : null

  // Positional binds only (the D1 shim does not support numbered/reused
  // params), so nowIso + the display/settings values are bound once per slot.
  const displayBind = setDisplay ? displayValue : null
  await db
    .prepare(
      `INSERT INTO user_profile (github_user_id, display_name, settings, created_at, updated_at)
       VALUES (?, ?, COALESCE(?, '{}'), ?, ?)
       ON CONFLICT(github_user_id) DO UPDATE SET
         display_name = CASE WHEN ? = 1 THEN ? ELSE user_profile.display_name END,
         settings     = COALESCE(?, user_profile.settings),
         updated_at   = ?`,
    )
    .bind(
      input.githubUserId, // INSERT github_user_id
      displayBind, // INSERT display_name
      settingsValue, // INSERT settings (COALESCE → '{}')
      input.nowIso, // INSERT created_at
      input.nowIso, // INSERT updated_at
      setDisplay ? 1 : 0, // UPDATE display_name CASE flag
      displayBind, // UPDATE display_name value
      settingsValue, // UPDATE settings (COALESCE → keep)
      input.nowIso, // UPDATE updated_at
    )
    .run()

  const saved = await readUserProfile(env, input.githubUserId)
  if (!saved) throw new Error("user-profile-store: row vanished after upsert")
  return saved
}
