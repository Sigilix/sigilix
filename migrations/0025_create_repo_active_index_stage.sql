-- Immutable-repository active-vector membership staging. Full index runs span
-- queue deliveries, so each file slice is durably staged before the canonical
-- manifest can publish one complete by-path snapshot. The runtime remains
-- shadow-gated until a later consumer cutover.

PRAGMA foreign_keys = ON;

CREATE TABLE repo_active_index_run (
  github_repo_id      INTEGER NOT NULL CHECK (
    github_repo_id BETWEEN 1 AND 9007199254740991
  ),
  run_id              TEXT    NOT NULL CHECK (
    length(run_id) = 16 AND run_id NOT GLOB '*[^0-9a-f]*'
  ),
  installation_id     INTEGER NOT NULL CHECK (
    installation_id BETWEEN 1 AND 9007199254740991
  ),
  total_files         INTEGER NOT NULL CHECK (
    total_files BETWEEN 0 AND 9007199254740991
  ),
  completed_through   INTEGER NOT NULL DEFAULT 0 CHECK (
    completed_through BETWEEN 0 AND total_files
  ),
  built_mode          TEXT    NOT NULL CHECK (built_mode IN ('shadow', 'on')),
  latest_bookmark     TEXT    CHECK (
    latest_bookmark IS NULL OR (
      length(latest_bookmark) BETWEEN 1 AND 4096
      AND instr(latest_bookmark, char(0)) = 0
    )
  ),
  expires_at_ms       INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN 0 AND 9007199254740991
  ),
  invalidated         INTEGER NOT NULL DEFAULT 0 CHECK (invalidated IN (0, 1)),
  sealed              INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
  CHECK (invalidated = 0 OR sealed = 0),
  CHECK (sealed = 0 OR completed_through = total_files),
  PRIMARY KEY (github_repo_id, run_id)
);

CREATE INDEX idx_repo_active_index_run_expiry
  ON repo_active_index_run (expires_at_ms, github_repo_id, run_id);

CREATE INDEX idx_repo_active_index_run_installation
  ON repo_active_index_run (installation_id, github_repo_id, run_id);

CREATE TABLE repo_active_index_slice (
  github_repo_id  INTEGER NOT NULL,
  run_id          TEXT    NOT NULL,
  slice_lo        INTEGER NOT NULL CHECK (
    slice_lo BETWEEN 0 AND 9007199254740991
  ),
  slice_hi        INTEGER NOT NULL CHECK (
    slice_hi BETWEEN slice_lo AND 9007199254740991
  ),
  part_count      INTEGER NOT NULL CHECK (part_count BETWEEN 0 AND 11000),
  content_sha256  TEXT    NOT NULL CHECK (
    length(content_sha256) = 64
    AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (github_repo_id, run_id, slice_lo),
  FOREIGN KEY (github_repo_id, run_id)
    REFERENCES repo_active_index_run(github_repo_id, run_id)
    ON DELETE CASCADE
);

CREATE TABLE repo_active_index_part (
  github_repo_id  INTEGER NOT NULL,
  run_id          TEXT    NOT NULL,
  slice_lo        INTEGER NOT NULL CHECK (
    slice_lo BETWEEN 0 AND 9007199254740991
  ),
  part_no         INTEGER NOT NULL CHECK (
    part_no BETWEEN 0 AND 9007199254740991
  ),
  entries_json    TEXT    NOT NULL CHECK (
    length(CAST(entries_json AS BLOB)) BETWEEN 2 AND 32768
  ),
  PRIMARY KEY (github_repo_id, run_id, slice_lo, part_no),
  FOREIGN KEY (github_repo_id, run_id)
    REFERENCES repo_active_index_run(github_repo_id, run_id)
    ON DELETE CASCADE
);
