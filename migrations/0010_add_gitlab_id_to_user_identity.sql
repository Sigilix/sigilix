-- sig-gitlab-oauth-login (GitLab support PR 4) — add the GitLab provider key to
-- the persistent user-identity layer so a GitLab dashboard login resolves to a
-- real user_identity row (the same way github_user_id / google_sub do).
--
-- Forward-only; immutable once applied (COMPLIANCE.md §8). Applied via
-- `wrangler d1 migrations apply <db>` — NOT auto on deploy. Additive only:
-- does not touch 0006-0009. A single new nullable column + its UNIQUE partial
-- index; every existing row keeps gitlab_id NULL (github/google/password-only).
--
-- `gitlab_id` is an ISSUER-QUALIFIED GitLab subject — `<instance-host>:<numeric
-- id>` (e.g. `gitlab.com:42`) — NOT a bare numeric id. GitLab user ids are
-- instance-local (every self-managed instance numbers its own users from 1), so
-- qualifying with the host keeps `gitlab.com:42` and `gitlab.example.com:42`
-- distinct accounts if SIGILIX_GITLAB_BASE_URL ever changes (see
-- `gitlabSubject` in auth-oauth-gitlab.ts). It is resolved by provider key ONLY
-- (never cross-linked by an unverified email — see findOrCreateGitlabIdentity),
-- so a GitLab login is takeover-safe exactly like a GitHub login.
ALTER TABLE user_identity ADD COLUMN gitlab_id TEXT; -- issuer-qualified GitLab subject; NULL for non-GitLab rows

-- One GitLab account maps to at most one identity row. Partial (only when set)
-- so the many email-less / GitLab-less rows can coexist, matching the existing
-- github/google unique partial indexes.
CREATE UNIQUE INDEX idx_user_identity_gitlab ON user_identity(gitlab_id) WHERE gitlab_id IS NOT NULL;
