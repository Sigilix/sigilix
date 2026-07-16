-- SIG — immutable GitHub author identity for PR-review usage.
-- Forward-only; immutable once applied (COMPLIANCE.md section 8). Apply with
-- `wrangler d1 migrations apply sigilix-platform` before dependent code ships.
--
-- Historical rows remain NULL and therefore explicitly unresolved. New review
-- writes may persist the positive GitHub account id beside the mutable display
-- login; no billing or seat-assignment policy changes in this migration.

ALTER TABLE usage_ledger
  ADD COLUMN author_github_user_id TEXT CHECK (
    author_github_user_id IS NULL OR (
      author_github_user_id GLOB '[1-9]*'
      AND author_github_user_id NOT GLOB '*[^0-9]*'
      AND CAST(author_github_user_id AS INTEGER) <= 9007199254740991
      AND CAST(CAST(author_github_user_id AS INTEGER) AS TEXT) = author_github_user_id
    )
  );

CREATE INDEX idx_usage_tenant_author_github_identity
  ON usage_ledger(installation_id, author_github_user_id)
  WHERE author_github_user_id IS NOT NULL;

-- Redelivery may race an older in-flight Worker that wrote the same review
-- tuple without the new column. Permit only the monotonic proof upgrade from
-- unresolved NULL to a canonical id; once present, identity cannot be cleared
-- or rebound to another GitHub account.
CREATE TRIGGER trg_usage_author_github_identity_immutable
BEFORE UPDATE OF author_github_user_id ON usage_ledger
WHEN NOT (
  (OLD.author_github_user_id IS NULL AND NEW.author_github_user_id IS NOT NULL)
  OR OLD.author_github_user_id IS NEW.author_github_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'usage author GitHub identity is immutable once set');
END;
