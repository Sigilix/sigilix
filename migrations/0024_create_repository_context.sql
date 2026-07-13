-- Canonical provider-aware repository context. This is a dark foundation:
-- no review/chat runtime reads these rows until a later, separately gated
-- cutover. Forward-only; apply before enabling OPENCLAW_REPOSITORY_CONTEXT_API.

PRAGMA foreign_keys = ON;

CREATE TABLE repository_context_scope (
  provider             TEXT    NOT NULL CHECK (provider IN ('github', 'gitlab')),
  scope_id             TEXT    NOT NULL CHECK (
    length(scope_id) BETWEEN 1 AND 128 AND instr(scope_id, char(0)) = 0
  ),
  revision             INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  snapshot_format      INTEGER NOT NULL CHECK (snapshot_format = 1),
  conventions          TEXT    NOT NULL CHECK (
    length(conventions) <= 4000 AND instr(conventions, char(0)) = 0
  ),
  snapshot_sha256      TEXT    NOT NULL CHECK (
    length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  repo_count           INTEGER NOT NULL CHECK (repo_count BETWEEN 0 AND 100),
  relationship_count   INTEGER NOT NULL CHECK (relationship_count BETWEEN 0 AND 200),
  write_token          TEXT    NOT NULL CHECK (
    length(write_token) = 43 AND write_token NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  created_at           TEXT    NOT NULL CHECK (
    length(trim(created_at)) BETWEEN 1 AND 64 AND instr(created_at, char(0)) = 0
  ),
  updated_at           TEXT    NOT NULL CHECK (
    length(trim(updated_at)) BETWEEN 1 AND 64 AND instr(updated_at, char(0)) = 0
  ),
  updated_by           TEXT    NOT NULL CHECK (
    length(trim(updated_by)) BETWEEN 1 AND 256 AND instr(updated_by, char(0)) = 0
  ),
  last_action          TEXT    NOT NULL CHECK (last_action IN ('replaced', 'purged')),
  last_audit_id        TEXT    NOT NULL CHECK (
    length(trim(last_audit_id)) BETWEEN 1 AND 128 AND instr(last_audit_id, char(0)) = 0
  ),
  deleted_at           TEXT    CHECK (
    deleted_at IS NULL OR (
      length(trim(deleted_at)) BETWEEN 1 AND 64 AND instr(deleted_at, char(0)) = 0
    )
  ),
  PRIMARY KEY (provider, scope_id),
  CHECK (
    provider <> 'github' OR (
      scope_id GLOB '[1-9]*'
      AND scope_id NOT GLOB '*[^0-9]*'
      AND CAST(scope_id AS INTEGER) <= 9007199254740991
      AND CAST(CAST(scope_id AS INTEGER) AS TEXT) = scope_id
    )
  ),
  CHECK (
    (last_action = 'replaced' AND deleted_at IS NULL)
    OR (
      last_action = 'purged' AND deleted_at IS NOT NULL
      AND conventions = '' AND repo_count = 0 AND relationship_count = 0
    )
  )
);

CREATE TABLE repository_context_repository (
  provider       TEXT    NOT NULL,
  scope_id       TEXT    NOT NULL,
  external_id    TEXT    NOT NULL CHECK (
    length(external_id) BETWEEN 1 AND 128 AND instr(external_id, char(0)) = 0
  ),
  full_name      TEXT    NOT NULL CHECK (
    length(full_name) BETWEEN 1 AND 512 AND instr(full_name, char(0)) = 0
  ),
  context        TEXT    NOT NULL CHECK (
    length(context) <= 2000 AND instr(context, char(0)) = 0
  ),
  position       INTEGER NOT NULL CHECK (position BETWEEN 0 AND 99),
  PRIMARY KEY (provider, scope_id, external_id),
  UNIQUE (provider, scope_id, position),
  FOREIGN KEY (provider, scope_id)
    REFERENCES repository_context_scope(provider, scope_id),
  CHECK (
    provider <> 'github' OR (
      external_id GLOB '[1-9]*'
      AND external_id NOT GLOB '*[^0-9]*'
      AND CAST(external_id AS INTEGER) <= 9007199254740991
      AND CAST(CAST(external_id AS INTEGER) AS TEXT) = external_id
    )
  )
);

CREATE TABLE repository_context_relationship (
  provider          TEXT    NOT NULL,
  scope_id          TEXT    NOT NULL,
  from_external_id  TEXT    NOT NULL,
  to_external_id    TEXT    NOT NULL,
  label             TEXT    NOT NULL CHECK (
    length(label) BETWEEN 1 AND 200 AND instr(label, char(0)) = 0
  ),
  normalized_label  TEXT    NOT NULL CHECK (
    length(normalized_label) BETWEEN 1 AND 200 AND instr(normalized_label, char(0)) = 0
  ),
  position          INTEGER NOT NULL CHECK (position BETWEEN 0 AND 199),
  PRIMARY KEY (provider, scope_id, from_external_id, to_external_id, normalized_label),
  UNIQUE (provider, scope_id, position),
  FOREIGN KEY (provider, scope_id, from_external_id)
    REFERENCES repository_context_repository(provider, scope_id, external_id),
  FOREIGN KEY (provider, scope_id, to_external_id)
    REFERENCES repository_context_repository(provider, scope_id, external_id),
  CHECK (from_external_id <> to_external_id)
);

CREATE TABLE repository_context_audit (
  provider                    TEXT    NOT NULL,
  scope_id                    TEXT    NOT NULL,
  audit_id                    TEXT    NOT NULL,
  action                      TEXT    NOT NULL CHECK (action IN ('replaced', 'purged')),
  previous_revision           INTEGER CHECK (
    previous_revision IS NULL OR previous_revision BETWEEN 1 AND 9007199254740991
  ),
  next_revision               INTEGER NOT NULL CHECK (next_revision BETWEEN 1 AND 9007199254740991),
  previous_snapshot_format    INTEGER CHECK (
    previous_snapshot_format IS NULL OR previous_snapshot_format = 1
  ),
  next_snapshot_format        INTEGER NOT NULL CHECK (next_snapshot_format = 1),
  previous_snapshot_sha256    TEXT    CHECK (
    previous_snapshot_sha256 IS NULL OR (
      length(previous_snapshot_sha256) = 64
      AND previous_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  next_snapshot_sha256        TEXT    NOT NULL CHECK (
    length(next_snapshot_sha256) = 64 AND next_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  previous_repo_count         INTEGER CHECK (
    previous_repo_count IS NULL OR previous_repo_count BETWEEN 0 AND 100
  ),
  next_repo_count             INTEGER NOT NULL CHECK (next_repo_count BETWEEN 0 AND 100),
  previous_relationship_count INTEGER CHECK (
    previous_relationship_count IS NULL OR previous_relationship_count BETWEEN 0 AND 200
  ),
  next_relationship_count     INTEGER NOT NULL CHECK (next_relationship_count BETWEEN 0 AND 200),
  actor_id                    TEXT    NOT NULL CHECK (
    length(trim(actor_id)) BETWEEN 1 AND 256 AND instr(actor_id, char(0)) = 0
  ),
  created_at                  TEXT    NOT NULL CHECK (
    length(trim(created_at)) BETWEEN 1 AND 64 AND instr(created_at, char(0)) = 0
  ),
  PRIMARY KEY (provider, scope_id, audit_id),
  FOREIGN KEY (provider, scope_id)
    REFERENCES repository_context_scope(provider, scope_id),
  CHECK (
    (previous_revision IS NULL AND previous_snapshot_sha256 IS NULL
      AND previous_snapshot_format IS NULL
      AND previous_repo_count IS NULL AND previous_relationship_count IS NULL)
    OR
    (previous_revision IS NOT NULL AND previous_snapshot_sha256 IS NOT NULL
      AND previous_snapshot_format IS NOT NULL
      AND previous_repo_count IS NOT NULL AND previous_relationship_count IS NOT NULL)
  )
);

CREATE INDEX idx_repository_context_audit_scope_time
  ON repository_context_audit(provider, scope_id, created_at, audit_id);

CREATE TRIGGER trg_repository_context_scope_initial_revision
BEFORE INSERT ON repository_context_scope
WHEN NEW.revision <> 1
  AND NOT EXISTS (
    SELECT 1 FROM repository_context_scope
    WHERE provider = NEW.provider AND scope_id = NEW.scope_id
  )
BEGIN
  SELECT RAISE(ABORT, 'repository context initial revision must be one');
END;

CREATE TRIGGER trg_repository_context_scope_audit_insert
AFTER INSERT ON repository_context_scope
BEGIN
  INSERT INTO repository_context_audit (
    provider, scope_id, audit_id, action,
    previous_revision, next_revision,
    previous_snapshot_format, next_snapshot_format,
    previous_snapshot_sha256, next_snapshot_sha256,
    previous_repo_count, next_repo_count,
    previous_relationship_count, next_relationship_count,
    actor_id, created_at
  ) VALUES (
    NEW.provider, NEW.scope_id, NEW.last_audit_id, NEW.last_action,
    NULL, NEW.revision,
    NULL, NEW.snapshot_format,
    NULL, NEW.snapshot_sha256,
    NULL, NEW.repo_count,
    NULL, NEW.relationship_count,
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER trg_repository_context_scope_identity_immutable
BEFORE UPDATE ON repository_context_scope
WHEN NEW.provider <> OLD.provider
  OR NEW.scope_id <> OLD.scope_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'repository context scope identity is immutable');
END;

CREATE TRIGGER trg_repository_context_scope_revision_sequence
BEFORE UPDATE ON repository_context_scope
WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'repository context revision must increment by one');
END;

CREATE TRIGGER trg_repository_context_scope_requires_audit
BEFORE UPDATE ON repository_context_scope
WHEN NEW.last_audit_id = OLD.last_audit_id OR NEW.write_token = OLD.write_token
BEGIN
  SELECT RAISE(ABORT, 'repository context update requires fresh audit and write token');
END;

CREATE TRIGGER trg_repository_context_scope_audit_update
AFTER UPDATE ON repository_context_scope
BEGIN
  INSERT INTO repository_context_audit (
    provider, scope_id, audit_id, action,
    previous_revision, next_revision,
    previous_snapshot_format, next_snapshot_format,
    previous_snapshot_sha256, next_snapshot_sha256,
    previous_repo_count, next_repo_count,
    previous_relationship_count, next_relationship_count,
    actor_id, created_at
  ) VALUES (
    NEW.provider, NEW.scope_id, NEW.last_audit_id, NEW.last_action,
    OLD.revision, NEW.revision,
    OLD.snapshot_format, NEW.snapshot_format,
    OLD.snapshot_sha256, NEW.snapshot_sha256,
    OLD.repo_count, NEW.repo_count,
    OLD.relationship_count, NEW.relationship_count,
    NEW.updated_by, NEW.updated_at
  );
END;

CREATE TRIGGER trg_repository_context_scope_no_delete
BEFORE DELETE ON repository_context_scope
BEGIN
  SELECT RAISE(ABORT, 'repository context scopes must be tombstoned');
END;

CREATE TRIGGER trg_repository_context_audit_no_update
BEFORE UPDATE ON repository_context_audit
BEGIN
  SELECT RAISE(ABORT, 'repository context audit rows are immutable');
END;

CREATE TRIGGER trg_repository_context_audit_no_delete
BEFORE DELETE ON repository_context_audit
BEGIN
  SELECT RAISE(ABORT, 'repository context audit rows are immutable');
END;

-- A zero-storage assertion seam for D1 batches. The store gates this INSERT
-- on its fresh write_token. A winning CAS reaches the trigger and must have
-- exactly the child rows declared on the scope; otherwise RAISE rolls back the
-- whole batch. A losing CAS never reaches the trigger and is classified from
-- the first batch result's changes=0.
CREATE VIEW repository_context_commit_guard AS
SELECT provider, scope_id, write_token
FROM repository_context_scope
WHERE 0;

CREATE TRIGGER trg_repository_context_commit_guard
INSTEAD OF INSERT ON repository_context_commit_guard
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM repository_context_scope AS scope
    WHERE scope.provider = NEW.provider
      AND scope.scope_id = NEW.scope_id
      AND scope.write_token = NEW.write_token
      AND scope.repo_count = (
        SELECT COUNT(*) FROM repository_context_repository AS repo
        WHERE repo.provider = NEW.provider AND repo.scope_id = NEW.scope_id
      )
      AND scope.relationship_count = (
        SELECT COUNT(*) FROM repository_context_relationship AS rel
        WHERE rel.provider = NEW.provider AND rel.scope_id = NEW.scope_id
      )
  ) THEN RAISE(ABORT, 'repository context child count mismatch') END;
END;
