-- One-time historical attribution for usage rows written before migration 0029.
--
-- Ground truth was fetched from each exact pull request with the GitHub App
-- token for the stored installation. Repository and PR responses were bound
-- back to their immutable numeric repository ids; logins were never used as
-- identity evidence. Scope at generation: 86 PR groups / 144 rows / 9 repos /
-- 2 installations. A separate exact-token API pass rechecked 5 deterministic
-- samples. This static VALUES approach is deliberately bounded and is not a
-- template for larger backfills.
--
-- Forward-only and idempotent. The staging objects are ordinary tables/views
-- because remote D1 rejects TEMP tables. Wrangler applies each migration in a
-- transaction, so a guard RAISE rolls back both DDL and DML and leaves 0030
-- unapplied. The opening DROP statements also make a failed attempt retryable.

DROP TRIGGER IF EXISTS trg_usage_author_identity_backfill_guard_0030;
DROP VIEW IF EXISTS usage_author_identity_backfill_guard_0030;
DROP TABLE IF EXISTS usage_author_identity_backfill_mapping_0030;

CREATE TABLE usage_author_identity_backfill_mapping_0030 (
  installation_id       INTEGER NOT NULL CHECK (
    installation_id BETWEEN 1 AND 9007199254740991
  ),
  repo_id                INTEGER NOT NULL CHECK (
    repo_id BETWEEN 1 AND 9007199254740991
  ),
  pr_number              INTEGER NOT NULL CHECK (
    pr_number BETWEEN 1 AND 9007199254740991
  ),
  author_github_user_id  TEXT    NOT NULL CHECK (
    author_github_user_id GLOB '[1-9]*'
    AND author_github_user_id NOT GLOB '*[^0-9]*'
    AND CAST(author_github_user_id AS INTEGER) <= 9007199254740991
    AND CAST(CAST(author_github_user_id AS INTEGER) AS TEXT) = author_github_user_id
  ),
  expected_null_rows     INTEGER NOT NULL CHECK (
    expected_null_rows BETWEEN 1 AND 9007199254740991
  ),
  PRIMARY KEY (installation_id, repo_id, pr_number)
);

INSERT INTO usage_author_identity_backfill_mapping_0030
  (installation_id, repo_id, pr_number, author_github_user_id, expected_null_rows)
VALUES
-- mapping-values-start
  (134811639, 1225209204, 719, '145802438', 2),
  (134811639, 1225209204, 720, '145802438', 2),
  (134811639, 1225209204, 721, '145802438', 2),
  (134811639, 1225209204, 722, '145802438', 2),
  (134811639, 1225209204, 724, '280779545', 1),
  (134811639, 1225209204, 751, '280779545', 1),
  (134811639, 1225209204, 766, '145802438', 1),
  (134811639, 1225209204, 767, '145802438', 1),
  (134811639, 1225209204, 776, '145802438', 1),
  (134811639, 1225209204, 777, '145802438', 1),
  (134811639, 1225209204, 778, '145802438', 3),
  (134811639, 1225209204, 779, '145802438', 1),
  (134811639, 1225209204, 780, '145802438', 2),
  (134811639, 1225209204, 781, '145802438', 1),
  (134811639, 1225209204, 808, '145802438', 1),
  (134811639, 1225209204, 857, '145802438', 1),
  (134811639, 1225209204, 858, '145802438', 1),
  (134811639, 1225209204, 859, '145802438', 1),
  (134811639, 1225209204, 860, '145802438', 3),
  (134811639, 1225209204, 861, '145802438', 3),
  (134811639, 1225209204, 862, '145802438', 1),
  (134811639, 1225209204, 863, '145802438', 2),
  (134811639, 1225209204, 864, '145802438', 1),
  (134811639, 1225209204, 865, '145802438', 1),
  (134811639, 1225209204, 866, '145802438', 1),
  (134811639, 1225209204, 885, '145802438', 3),
  (134811639, 1225209204, 893, '145802438', 2),
  (134811639, 1225209204, 894, '145802438', 2),
  (134811639, 1225209204, 897, '145802438', 3),
  (134811639, 1225209204, 924, '145802438', 1),
  (134811639, 1225209204, 925, '145802438', 1),
  (134811639, 1225209204, 928, '145802438', 1),
  (134811639, 1225209204, 934, '145802438', 1),
  (134811639, 1225209204, 977, '280779545', 2),
  (134811639, 1225209204, 980, '280779545', 1),
  (134811639, 1229475209, 55, '145802438', 1),
  (134811639, 1229475209, 56, '145802438', 1),
  (134811639, 1229475209, 57, '145802438', 1),
  (134811639, 1229475209, 58, '145802438', 1),
  (134811639, 1229475209, 65, '145802438', 1),
  (134811639, 1229475209, 66, '145802438', 2),
  (134811639, 1229475209, 115, '145802438', 2),
  (134811639, 1229475209, 116, '145802438', 1),
  (134811639, 1255411274, 31, '280779545', 1),
  (134811639, 1255411274, 32, '280779545', 1),
  (134811639, 1255411274, 33, '280779545', 1),
  (134811639, 1255411274, 35, '280779545', 1),
  (134811639, 1277134852, 73, '145802438', 1),
  (134811639, 1277134852, 74, '145802438', 5),
  (134811639, 1277134852, 89, '145802438', 4),
  (134811639, 1277134852, 91, '145802438', 2),
  (134811639, 1286336645, 11, '145802438', 4),
  (134811639, 1286336645, 26, '145802438', 4),
  (134811639, 1286336645, 40, '145802438', 6),
  (134811639, 1286336645, 43, '145802438', 1),
  (134811639, 1286336645, 53, '145802438', 1),
  (134811639, 1286336645, 54, '145802438', 1),
  (134811639, 1286336645, 55, '145802438', 1),
  (134811639, 1286336645, 57, '145802438', 2),
  (134811639, 1286336645, 60, '145802438', 1),
  (134811639, 1294300352, 6, '145802438', 1),
  (145489160, 1187280079, 139, '195594', 2),
  (145489160, 1187280079, 140, '195594', 1),
  (145489160, 1187280079, 141, '195594', 3),
  (145489160, 1187280079, 142, '195594', 2),
  (145489160, 1187280079, 143, '195594', 1),
  (145489160, 1187280079, 144, '195594', 1),
  (145489160, 1187280079, 145, '195594', 2),
  (145489160, 1187280079, 146, '195594', 1),
  (145489160, 1187280079, 147, '195594', 3),
  (145489160, 1187280079, 148, '195594', 1),
  (145489160, 1187280079, 149, '195594', 3),
  (145489160, 1187280079, 150, '195594', 4),
  (145489160, 1187280079, 151, '195594', 1),
  (145489160, 1233595798, 87, '195594', 1),
  (145489160, 1233595798, 88, '195594', 2),
  (145489160, 1233595798, 89, '195594', 4),
  (145489160, 1233595798, 90, '195594', 1),
  (145489160, 1292043859, 1, '195594', 1),
  (145489160, 1292043859, 2, '195594', 1),
  (145489160, 1292043859, 3, '195594', 1),
  (145489160, 1292043859, 4, '195594', 1),
  (145489160, 1292043859, 5, '195594', 1),
  (145489160, 1292043859, 6, '195594', 1),
  (145489160, 1292043859, 7, '195594', 1),
  (145489160, 1292043859, 8, '195594', 2);
-- mapping-values-end

CREATE VIEW usage_author_identity_backfill_guard_0030 AS
SELECT '' AS phase
WHERE 0;

-- Keep RAISE/WHERE inside an INSTEAD OF trigger: this is the guard shape
-- already accepted by remote D1 in migrations 0024 and 0026.
CREATE TRIGGER trg_usage_author_identity_backfill_guard_0030
INSTEAD OF INSERT ON usage_author_identity_backfill_guard_0030
BEGIN
  SELECT RAISE(ABORT, 'migration_0030_invalid_guard_phase')
    WHERE NEW.phase NOT IN ('before', 'after');

  SELECT RAISE(ABORT, 'migration_0030_manifest_mismatch')
    WHERE NEW.phase = 'before' AND (
      (SELECT COUNT(*) FROM usage_author_identity_backfill_mapping_0030) <> 86
      OR (SELECT SUM(expected_null_rows) FROM usage_author_identity_backfill_mapping_0030) <> 144
    );

  SELECT RAISE(ABORT, 'migration_0030_missing_exact_repo_authority')
    WHERE NEW.phase = 'before' AND EXISTS (
      SELECT 1
      FROM usage_ledger AS usage
      JOIN usage_author_identity_backfill_mapping_0030 AS mapping
        ON mapping.installation_id = usage.installation_id
       AND mapping.repo_id = usage.repo_id
       AND mapping.pr_number = usage.pr_number
      WHERE NOT EXISTS (
        SELECT 1
        FROM repo
        WHERE repo.repo_id = usage.repo_id
          AND repo.installation_id = usage.installation_id
      )
    );

  SELECT RAISE(ABORT, 'migration_0030_identity_conflict')
    WHERE EXISTS (
      SELECT 1
      FROM usage_ledger AS usage
      JOIN usage_author_identity_backfill_mapping_0030 AS mapping
        ON mapping.installation_id = usage.installation_id
       AND mapping.repo_id = usage.repo_id
       AND mapping.pr_number = usage.pr_number
      WHERE usage.author_github_user_id IS NOT NULL
        AND usage.author_github_user_id <> mapping.author_github_user_id
    );

  -- Accept only a genuinely fresh database, the exact generated snapshot, or
  -- an idempotent replay after every mapped row was already enriched. A
  -- partially missing or partially applied snapshot matches none of the three.
  SELECT RAISE(ABORT, 'migration_0030_preconditions')
    WHERE NEW.phase = 'before' AND NOT (
      (
        NOT EXISTS (
          SELECT 1
          FROM usage_ledger AS usage
          JOIN usage_author_identity_backfill_mapping_0030 AS mapping
            ON mapping.installation_id = usage.installation_id
           AND mapping.repo_id = usage.repo_id
           AND mapping.pr_number = usage.pr_number
        )
        AND NOT EXISTS (
          SELECT 1
          FROM usage_ledger AS usage
          WHERE usage.author_github_user_id IS NULL
            AND usage.installation_id IN (
              SELECT DISTINCT installation_id
              FROM usage_author_identity_backfill_mapping_0030
            )
        )
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM usage_ledger AS usage
          WHERE usage.author_github_user_id IS NULL
            AND usage.installation_id IN (
              SELECT DISTINCT installation_id
              FROM usage_author_identity_backfill_mapping_0030
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM usage_author_identity_backfill_mapping_0030 AS mapping
          WHERE (
            SELECT COUNT(*)
            FROM usage_ledger AS usage
            WHERE usage.installation_id = mapping.installation_id
              AND usage.repo_id = mapping.repo_id
              AND usage.pr_number = mapping.pr_number
              AND usage.author_github_user_id = mapping.author_github_user_id
          ) < mapping.expected_null_rows
        )
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM usage_ledger AS usage
          WHERE usage.author_github_user_id IS NULL
            AND usage.installation_id IN (
              SELECT DISTINCT installation_id
              FROM usage_author_identity_backfill_mapping_0030
            )
            AND NOT EXISTS (
              SELECT 1
              FROM usage_author_identity_backfill_mapping_0030 AS mapping
              WHERE mapping.installation_id = usage.installation_id
                AND mapping.repo_id = usage.repo_id
                AND mapping.pr_number = usage.pr_number
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM usage_author_identity_backfill_mapping_0030 AS mapping
          WHERE (
            SELECT COUNT(*)
            FROM usage_ledger AS usage
            WHERE usage.installation_id = mapping.installation_id
              AND usage.repo_id = mapping.repo_id
              AND usage.pr_number = mapping.pr_number
              AND usage.author_github_user_id IS NULL
          ) <> mapping.expected_null_rows
        )
      )
    );

  SELECT RAISE(ABORT, 'migration_0030_postconditions')
    WHERE NEW.phase = 'after' AND NOT (
      (
        NOT EXISTS (
          SELECT 1
          FROM usage_ledger AS usage
          JOIN usage_author_identity_backfill_mapping_0030 AS mapping
            ON mapping.installation_id = usage.installation_id
           AND mapping.repo_id = usage.repo_id
           AND mapping.pr_number = usage.pr_number
        )
        AND NOT EXISTS (
          SELECT 1
          FROM usage_ledger AS usage
          WHERE usage.author_github_user_id IS NULL
            AND usage.installation_id IN (
              SELECT DISTINCT installation_id
              FROM usage_author_identity_backfill_mapping_0030
            )
        )
      )
      OR (
        NOT EXISTS (
          SELECT 1
          FROM usage_ledger AS usage
          WHERE usage.author_github_user_id IS NULL
            AND usage.installation_id IN (
              SELECT DISTINCT installation_id
              FROM usage_author_identity_backfill_mapping_0030
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM usage_author_identity_backfill_mapping_0030 AS mapping
          WHERE (
            SELECT COUNT(*)
            FROM usage_ledger AS usage
            WHERE usage.installation_id = mapping.installation_id
              AND usage.repo_id = mapping.repo_id
              AND usage.pr_number = mapping.pr_number
              AND usage.author_github_user_id = mapping.author_github_user_id
          ) < mapping.expected_null_rows
        )
      )
    );
END;

INSERT INTO usage_author_identity_backfill_guard_0030 (phase)
VALUES ('before');

UPDATE usage_ledger AS usage
SET author_github_user_id = (
  SELECT mapping.author_github_user_id
  FROM usage_author_identity_backfill_mapping_0030 AS mapping
  WHERE mapping.installation_id = usage.installation_id
    AND mapping.repo_id = usage.repo_id
    AND mapping.pr_number = usage.pr_number
)
WHERE usage.author_github_user_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM repo
    WHERE repo.repo_id = usage.repo_id
      AND repo.installation_id = usage.installation_id
  )
  AND EXISTS (
    SELECT 1
    FROM usage_author_identity_backfill_mapping_0030 AS mapping
    WHERE mapping.installation_id = usage.installation_id
      AND mapping.repo_id = usage.repo_id
      AND mapping.pr_number = usage.pr_number
  )
  AND NOT EXISTS (
    SELECT 1
    FROM usage_ledger AS conflict
    WHERE conflict.installation_id = usage.installation_id
      AND conflict.repo_id = usage.repo_id
      AND conflict.pr_number = usage.pr_number
      AND conflict.author_github_user_id IS NOT NULL
      AND conflict.author_github_user_id <> (
        SELECT mapping.author_github_user_id
        FROM usage_author_identity_backfill_mapping_0030 AS mapping
        WHERE mapping.installation_id = usage.installation_id
          AND mapping.repo_id = usage.repo_id
          AND mapping.pr_number = usage.pr_number
      )
  );

INSERT INTO usage_author_identity_backfill_guard_0030 (phase)
VALUES ('after');

DROP TRIGGER trg_usage_author_identity_backfill_guard_0030;
DROP VIEW usage_author_identity_backfill_guard_0030;
DROP TABLE usage_author_identity_backfill_mapping_0030;
