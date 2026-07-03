-- sig-user-profile — per-user profile + preferences store.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`
-- (NOT auto on deploy). Additive only — does not touch 0001–0003.
--
-- user_profile: one row per signed-in GitHub user, keyed by the session's
-- githubUserId (a stable numeric GitHub id — see auth-session.ts SessionRecord).
-- Written by PATCH /v1/profile (user-profile-route.ts) and read by GET /v1/profile
-- and the portal's account menu / greeting.
--   • display_name — the name the user chose for themselves. NULL until they set
--     one; consumers fall back to the GitHub display name, then the login.
--   • settings — a JSON blob of user preferences (opaque to D1). NOT NULL, defaults
--     to '{}' so a freshly-inserted row is always valid JSON. Schema is owned by the
--     application layer (user-profile-store.ts), not the database.
--   • created_at / updated_at — ISO-8601 UTC instants, set by the app on write.
CREATE TABLE user_profile (
  github_user_id  INTEGER PRIMARY KEY,
  display_name    TEXT,
  settings        TEXT    NOT NULL DEFAULT '{}',
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
