-- sig-training-data-consent — consent ledger gating the (separate) training store.
-- Forward-only; immutable once applied. Applied via `wrangler d1 migrations apply`
-- (NOT auto on deploy). Additive only — does not touch 0001–0007.
--
-- WHY a new table: consent to let Sigilix TRAIN MODELS on an org's data is a
-- legally-load-bearing signal that is DISTINCT from every operational signal we
-- already store (tenant tier, seat assignment, usage). It must be independently
-- auditable (who set it, when, from where, under which plan) and independently
-- deletable, so it gets its own table rather than a column bolted onto `tenant`.
--
-- ONE ROW PER INSTALLATION (org-level consent). The PRIMARY KEY is installation_id.
-- (`set_by` records WHICH admin last set it — for audit only, not part of the key.)
-- A future per-user/per-seat consent overlay can be added as a sibling table
-- WITHOUT editing this one (forward-only rule); resolveConsent() would then union
-- the two, still fail-closed.
--
-- FAIL-CLOSED SEMANTICS (the whole point): the ABSENCE of a row here does NOT mean
-- "granted". Absence means "no explicit choice" → the resolver falls back to a
-- plan-based DEFAULT that is itself fail-closed (personal paid plans opt-out /
-- default-granted; team + enterprise + free + unknown default-DENIED). A row with
-- consent = 'denied' is an explicit, permanent opt-out that overrides any default.
--
-- `consent`       — 'granted' | 'denied'. CHECK-constrained so a malformed write
--                   can never masquerade as a third, ambiguous state.
-- `set_by`        — the actor who set it (admin GitHub login, or 'system:<reason>'
--                   for a system-applied default that was later persisted). Audit.
-- `set_at`        — ISO-8601 timestamp of the last change. Audit.
-- `source`        — where the decision came from ('portal-admin' | 'api' |
--                   'onboarding' | 'system-default' | ...). Audit + provenance.
-- `plan_at_grant` — the org's resolved plan at the moment consent was recorded, so
--                   a later plan change (e.g. individual → team) is auditable and
--                   never silently re-interprets an old grant.
CREATE TABLE data_learning_consent (
  installation_id  INTEGER PRIMARY KEY,                       -- tenant key (scopes every read/write)
  consent          TEXT    NOT NULL CHECK (consent IN ('granted','denied')),
  set_by           TEXT    NOT NULL,
  set_at           TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  plan_at_grant    TEXT
);
