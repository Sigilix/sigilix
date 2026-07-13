-- Managed per-app memories for portal users and organizations.
-- Forward-only; immutable once applied. Migration 0020 is reserved by the
-- Stripe seat-reconciliation foundation, so this change deploys after it.

CREATE TABLE app_memory (
  id                  TEXT    PRIMARY KEY,
  installation_id     INTEGER NOT NULL CHECK (installation_id > 0),
  scope               TEXT    NOT NULL CHECK (scope IN ('personal', 'organization')),
  owner_user_id       TEXT    NOT NULL,
  app_id              TEXT    NOT NULL CHECK (length(app_id) BETWEEN 1 AND 64),
  content             TEXT    NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  content_hash        TEXT    NOT NULL CHECK (length(content_hash) = 64),
  created_at_ms       INTEGER NOT NULL CHECK (created_at_ms >= 0),
  CHECK (
    (scope = 'personal' AND length(owner_user_id) > 0) OR
    (scope = 'organization' AND owner_user_id = '')
  ),
  UNIQUE (installation_id, scope, owner_user_id, app_id, content_hash)
);

CREATE INDEX idx_app_memory_list
  ON app_memory (installation_id, app_id, scope, owner_user_id, created_at_ms DESC, id DESC);
