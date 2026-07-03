-- SIG seat management — per-installation billable-seat assignment overrides.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`
-- (NOT auto on deploy). Additive only — does not touch 0001–0006.
--
-- WHY a new table: a "seat" is DERIVED from real activity (distinct
-- usage_ledger.author_login scoped to an installation — see org-overview-route.ts).
-- That derivation makes every active member an ASSIGNED seat by default. This
-- table stores an admin's explicit OVERRIDE of that default so a seat can be
-- UNASSIGNED (stops it counting toward the billed-seat total) and re-ASSIGNED,
-- WITHOUT altering the PR-review-shaped usage_ledger. The billed-seat count is
-- therefore: (distinct active seats) minus (rows here with assigned = 0).
--
-- TENANT ISOLATION: every row is keyed by (installation_id, login); the seat
-- route binds installation_id via a `?` placeholder on every read/write, so an
-- override never crosses installations. `login` is stored lowercased — the seat
-- derivation collapses author_login case-insensitively, so the override key must
-- match that same normalized identity.
--
-- LAST-ADMIN GUARD: `is_admin` marks a seat we KNOW belongs to an org admin (the
-- acting admin's own seat is always known-admin; it is set only from a verified
-- per-installation admin check, never inferred). The seat route refuses to
-- unassign the last assigned admin seat (fail-closed), reading this column.
CREATE TABLE org_seat_assignment (
  installation_id  INTEGER NOT NULL,               -- tenant key (scopes every read/write)
  login            TEXT    NOT NULL,               -- normalized (lowercase) GitHub login
  assigned         INTEGER NOT NULL DEFAULT 1,     -- 1 = holds a billable seat; 0 = explicitly unassigned
  is_admin         INTEGER NOT NULL DEFAULT 0,     -- 1 = a verified org-admin seat (drives the last-admin guard)
  updated_at       TEXT    NOT NULL,
  updated_by       TEXT,                           -- the admin login who last changed this row (audit)
  PRIMARY KEY (installation_id, login)
);
-- Billed-count + guard rollups: WHERE installation_id = ? [AND assigned = ? / is_admin = ?]
CREATE INDEX idx_org_seat_assignment_scan ON org_seat_assignment(installation_id, assigned, is_admin);
