-- Strong D1 authority for canonical GitLab repository context. KV remains the
-- connector credential/status cache; only active rows in these tables may
-- authorize repository-context reads or writes. Forward-only; apply before
-- deploying code that claims or reads GitLab repository-context authority.

PRAGMA foreign_keys = ON;

CREATE TABLE repository_context_authority_scope (
  provider    TEXT    NOT NULL CHECK (provider = 'gitlab'),
  scope_id    TEXT    NOT NULL CHECK (
    length(scope_id) BETWEEN 1 AND 128 AND instr(scope_id, char(0)) = 0
  ),
  revision    INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  transition_token TEXT CHECK (
    transition_token IS NULL OR (
      length(transition_token) = 43
      AND transition_token NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  created_at  TEXT    NOT NULL CHECK (
    length(trim(created_at)) BETWEEN 1 AND 64 AND instr(created_at, char(0)) = 0
  ),
  updated_at  TEXT    NOT NULL CHECK (
    length(trim(updated_at)) BETWEEN 1 AND 64 AND instr(updated_at, char(0)) = 0
  ),
  PRIMARY KEY (provider, scope_id)
);

CREATE TABLE repository_context_authority_repository (
  provider          TEXT    NOT NULL CHECK (provider = 'gitlab'),
  scope_id          TEXT    NOT NULL CHECK (
    length(scope_id) BETWEEN 1 AND 128 AND instr(scope_id, char(0)) = 0
  ),
  instance_origin   TEXT    NOT NULL CHECK (
    length(instance_origin) BETWEEN 1 AND 512
    AND instr(instance_origin, char(0)) = 0
  ),
  source_id         INTEGER NOT NULL CHECK (
    source_id BETWEEN 1 AND 9007199254740991
  ),
  external_id       TEXT    NOT NULL CHECK (
    length(external_id) = 49
    AND length(external_id) <= 128
    AND substr(external_id, 1, 6) = 'gl:v1:'
    AND substr(external_id, 7) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  full_name         TEXT    NOT NULL CHECK (
    length(full_name) BETWEEN 1 AND 512 AND instr(full_name, char(0)) = 0
  ),
  state             TEXT    NOT NULL CHECK (state IN ('pending', 'active')),
  claim_token       TEXT    NOT NULL CHECK (
    length(claim_token) = 43
    AND claim_token NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  claimed_at        TEXT    NOT NULL CHECK (
    length(trim(claimed_at)) BETWEEN 1 AND 64 AND instr(claimed_at, char(0)) = 0
  ),
  claim_expires_at  TEXT    NOT NULL CHECK (
    length(trim(claim_expires_at)) BETWEEN 1 AND 64
    AND instr(claim_expires_at, char(0)) = 0
  ),
  activated_at      TEXT    CHECK (
    activated_at IS NULL OR (
      length(trim(activated_at)) BETWEEN 1 AND 64
      AND instr(activated_at, char(0)) = 0
    )
  ),
  PRIMARY KEY (provider, scope_id, external_id),
  UNIQUE (provider, instance_origin, source_id),
  UNIQUE (provider, external_id),
  FOREIGN KEY (provider, scope_id)
    REFERENCES repository_context_authority_scope(provider, scope_id)
    ON DELETE CASCADE,
  CHECK (
    (state = 'pending' AND activated_at IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL)
  )
);

CREATE INDEX idx_repository_context_authority_repository_scope_state
  ON repository_context_authority_repository(
    provider, scope_id, state, external_id
  );

CREATE INDEX idx_repository_context_authority_repository_pending_expiry
  ON repository_context_authority_repository(
    provider, state, claim_expires_at, external_id
  );

-- Active-set mutations require a fresh per-operation transition token on the
-- owning scope. The store writes the token and revision with one CAS, gates the
-- repository mutation on that exact token, then reaches the assertion view
-- below. A failed assertion aborts and rolls back the complete D1 batch.
CREATE TRIGGER trg_repository_context_authority_activate_requires_transition
BEFORE UPDATE OF state ON repository_context_authority_repository
WHEN OLD.state = 'pending' AND NEW.state = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM repository_context_authority_scope AS scope
    WHERE scope.provider = OLD.provider
      AND scope.scope_id = OLD.scope_id
      AND scope.transition_token IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'authority activation requires scope transition');
END;

CREATE TRIGGER trg_repository_context_authority_active_delete_requires_transition
BEFORE DELETE ON repository_context_authority_repository
WHEN OLD.state = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM repository_context_authority_scope AS scope
    WHERE scope.provider = OLD.provider
      AND scope.scope_id = OLD.scope_id
      AND scope.transition_token IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'active authority release requires scope transition');
END;

CREATE VIEW repository_context_authority_transition_guard AS
SELECT
  provider,
  scope_id,
  transition_token,
  '' AS external_id,
  '' AS claim_token,
  '' AS target_state
FROM repository_context_authority_scope
WHERE 0;

-- Keep the RAISE/WHERE form: production D1 accepts it while CASE-wrapped
-- RAISE expressions are rejected by its migration parser.
CREATE TRIGGER trg_repository_context_authority_transition_guard
INSTEAD OF INSERT ON repository_context_authority_transition_guard
BEGIN
  SELECT RAISE(ABORT, 'invalid authority transition target')
    WHERE NEW.target_state NOT IN ('active', 'released');
  SELECT RAISE(ABORT, 'authority transition token mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM repository_context_authority_scope AS scope
    WHERE scope.provider = NEW.provider
      AND scope.scope_id = NEW.scope_id
      AND scope.transition_token = NEW.transition_token
  );
  SELECT RAISE(ABORT, 'authority activation did not commit')
    WHERE NEW.target_state = 'active' AND NOT EXISTS (
      SELECT 1 FROM repository_context_authority_repository AS repository
      WHERE repository.provider = NEW.provider
        AND repository.scope_id = NEW.scope_id
        AND repository.external_id = NEW.external_id
        AND repository.claim_token = NEW.claim_token
        AND repository.state = 'active'
    );
  SELECT RAISE(ABORT, 'authority release did not commit')
    WHERE NEW.target_state = 'released' AND EXISTS (
      SELECT 1 FROM repository_context_authority_repository AS repository
      WHERE repository.provider = NEW.provider
        AND repository.scope_id = NEW.scope_id
        AND repository.external_id = NEW.external_id
        AND repository.claim_token = NEW.claim_token
    );
  UPDATE repository_context_authority_scope
     SET transition_token = NULL
   WHERE provider = NEW.provider
     AND scope_id = NEW.scope_id
     AND transition_token = NEW.transition_token;
END;
