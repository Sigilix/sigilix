import {
  canonicalGitLabRepositoryAuthorityIdentity,
  canonicalGitLabRepositoryFullName,
  type GitLabRepositoryAuthorityRepository,
} from "@/src/features/repository-context/domain/authority"

const PROVIDER = "gitlab" as const
const CLAIM_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const EXTERNAL_ID_RE = /^gl:v1:[A-Za-z0-9_-]{43}$/
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER

// The ordering proofs below rely on Cloudflare's documented db.batch contract:
// statements execute sequentially/non-concurrently as one SQL transaction and
// any failed statement rolls the sequence back.
// https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

interface AuthorityScopeRow {
  revision: number
  transition_token: string | null
}

interface AuthorityRepositoryRow {
  scope_id: string
  instance_origin: string
  source_id: number
  external_id: string
  full_name: string
  state: string
  claim_token: string
  claim_expires_at: string
  claim_is_live: number
  activated_at: string | null
}

export type GitLabRepositoryAuthorityReadResult =
  | { status: "ok"; revision: number; repositories: GitLabRepositoryAuthorityRepository[] }
  | { status: "not_found" }
  | { status: "unavailable" }

export type GitLabRepositoryAuthorityClaimResult =
  | {
      status: "claimed"
      claimToken: string
      repository: GitLabRepositoryAuthorityRepository
    }
  | {
      status: "already_active_same_scope" | "claim_in_progress"
      claimToken: string
      repository: GitLabRepositoryAuthorityRepository
    }
  | { status: "owned_by_other" }
  | { status: "unavailable" }

export type GitLabRepositoryAuthorityActivationResult =
  | { status: "activated" | "already_active_same_generation"; revision: number }
  | { status: "lost_or_expired_claim" }
  | { status: "unavailable" }

export type GitLabRepositoryAuthorityAbandonResult = { status: "abandoned" | "lost_claim" } | { status: "unavailable" }

export type GitLabRepositoryAuthorityReleaseResult =
  | { status: "released" | "already_released"; revision: number }
  | { status: "lost_claim" }
  | { status: "unavailable" }

export type GitLabRepositoryAuthorityGenerationResult = { status: "active" | "inactive" | "unavailable" }

export async function claimGitLabRepositoryAuthority(
  db: D1Database,
  args: { scopeId: string; instanceOrigin: string; sourceId: number; fullName: string },
): Promise<GitLabRepositoryAuthorityClaimResult> {
  if (!validScopeId(args.scopeId)) return { status: "unavailable" }
  const [identity, fullName] = await Promise.all([
    canonicalGitLabRepositoryAuthorityIdentity(args.instanceOrigin, args.sourceId),
    Promise.resolve(canonicalGitLabRepositoryFullName(args.fullName)),
  ])
  if (!identity || !fullName) return { status: "unavailable" }
  const claimToken = randomClaimToken()
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  const expires = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+15 minutes')"
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO repository_context_authority_scope
            (provider, scope_id, revision, created_at, updated_at)
           VALUES (?, ?, 0, ${now}, ${now})`,
        )
        .bind(PROVIDER, args.scopeId),
      db
        .prepare(
          `UPDATE repository_context_authority_repository
              SET scope_id = ?, full_name = ?, state = 'pending', claim_token = ?,
                  claimed_at = ${now}, claim_expires_at = ${expires}, activated_at = NULL
            WHERE provider = ? AND instance_origin = ? AND source_id = ?
              AND state = 'pending' AND claim_expires_at < ${now}`,
        )
        .bind(args.scopeId, fullName, claimToken, PROVIDER, identity.instanceOrigin, identity.sourceId),
      db
        .prepare(
          `INSERT INTO repository_context_authority_repository
            (provider, scope_id, instance_origin, source_id, external_id, full_name,
             state, claim_token, claimed_at, claim_expires_at, activated_at)
           SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ${now}, ${expires}, NULL
            WHERE NOT EXISTS (
              SELECT 1 FROM repository_context_authority_repository
               WHERE provider = ? AND instance_origin = ? AND source_id = ?
            )`,
        )
        .bind(
          PROVIDER,
          args.scopeId,
          identity.instanceOrigin,
          identity.sourceId,
          identity.externalId,
          fullName,
          claimToken,
          PROVIDER,
          identity.instanceOrigin,
          identity.sourceId,
        ),
      authorityRepositoryByIdentityStatement(db, identity.instanceOrigin, identity.sourceId),
    ])
    const row = singleRow<AuthorityRepositoryRow>(results[3])
    const repository = row ? await decodeAuthorityRepository(row) : null
    if (!row || !repository) return { status: "unavailable" }
    if (row.claim_token === claimToken && row.scope_id === args.scopeId && row.state === "pending") {
      return { status: "claimed", claimToken, repository }
    }
    if (row.scope_id !== args.scopeId) return { status: "owned_by_other" }
    if (row.state === "active") {
      return { status: "already_active_same_scope", claimToken: row.claim_token, repository }
    }
    if (row.state === "pending") {
      return { status: "claim_in_progress", claimToken: row.claim_token, repository }
    }
    return { status: "unavailable" }
  } catch (error) {
    logFailure("repository-context-authority-claim-failed", error, args.scopeId)
    return { status: "unavailable" }
  }
}

export async function activateGitLabRepositoryAuthority(
  db: D1Database,
  args: { scopeId: string; externalId: string; claimToken: string },
): Promise<GitLabRepositoryAuthorityActivationResult> {
  if (!validExactGeneration(args)) return { status: "unavailable" }
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  const transitionToken = randomAuthorityToken()
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE repository_context_authority_scope
              SET revision = revision + 1, transition_token = ?, updated_at = ${now}
            WHERE provider = ? AND scope_id = ? AND revision < ?
              AND transition_token IS NULL
              AND EXISTS (
                SELECT 1 FROM repository_context_authority_repository
                 WHERE provider = ? AND scope_id = ? AND external_id = ?
                   AND state = 'pending' AND claim_token = ? AND claim_expires_at >= ${now}
              )`,
        )
        .bind(
          transitionToken,
          PROVIDER,
          args.scopeId,
          MAX_SAFE_REVISION,
          PROVIDER,
          args.scopeId,
          args.externalId,
          args.claimToken,
        ),
      db
        .prepare(
          `UPDATE repository_context_authority_repository
              SET state = 'active', activated_at = ${now}
            WHERE provider = ? AND scope_id = ? AND external_id = ?
              AND state = 'pending' AND claim_token = ? AND claim_expires_at >= ${now}
              AND EXISTS (
                SELECT 1 FROM repository_context_authority_scope AS scope
                 WHERE scope.provider = repository_context_authority_repository.provider
                   AND scope.scope_id = repository_context_authority_repository.scope_id
                   AND scope.transition_token = ?
              )`,
        )
        .bind(PROVIDER, args.scopeId, args.externalId, args.claimToken, transitionToken),
      authorityTransitionGuardStatement(db, args, transitionToken, "active"),
      authorityRepositoryByExternalIdStatement(db, args.externalId),
      authorityScopeStatement(db, args.scopeId),
    ])
    const row = singleRow<AuthorityRepositoryRow>(results[3])
    const scope = singleRow<AuthorityScopeRow>(results[4])
    if (!validRevision(scope?.revision) || scope?.transition_token !== null) return { status: "unavailable" }
    const scopeChanges = changes(results[0])
    const repositoryChanges = changes(results[1])
    if (matchesGeneration(row, args) && row?.state === "active") {
      if (scopeChanges === 1 && repositoryChanges === 1) return { status: "activated", revision: scope!.revision }
      if (scopeChanges === 0 && repositoryChanges === 0) {
        return { status: "already_active_same_generation", revision: scope!.revision }
      }
      return { status: "unavailable" }
    }
    if (scopeChanges !== 0 || repositoryChanges !== 0) return { status: "unavailable" }
    if (matchesGeneration(row, args) && row?.state === "pending" && row.claim_is_live === 1) {
      return { status: "unavailable" }
    }
    return { status: "lost_or_expired_claim" }
  } catch (error) {
    logFailure("repository-context-authority-activate-failed", error, args.scopeId)
    return { status: "unavailable" }
  }
}

export async function abandonGitLabRepositoryAuthorityClaim(
  db: D1Database,
  args: { scopeId: string; externalId: string; claimToken: string },
): Promise<GitLabRepositoryAuthorityAbandonResult> {
  if (!validExactGeneration(args)) return { status: "unavailable" }
  try {
    const results = await db.batch([
      db
        .prepare(
          `DELETE FROM repository_context_authority_repository
            WHERE provider = ? AND scope_id = ? AND external_id = ?
              AND state = 'pending' AND claim_token = ?`,
        )
        .bind(PROVIDER, args.scopeId, args.externalId, args.claimToken),
      authorityRepositoryByExternalIdStatement(db, args.externalId),
    ])
    return changes(results[0]) === 1 ? { status: "abandoned" } : { status: "lost_claim" }
  } catch (error) {
    logFailure("repository-context-authority-abandon-failed", error, args.scopeId)
    return { status: "unavailable" }
  }
}

export async function releaseGitLabRepositoryAuthority(
  db: D1Database,
  args: { scopeId: string; externalId: string; claimToken: string },
): Promise<GitLabRepositoryAuthorityReleaseResult> {
  if (!validExactGeneration(args)) return { status: "unavailable" }
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
  const transitionToken = randomAuthorityToken()
  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE repository_context_authority_scope
              SET revision = revision + 1, transition_token = ?, updated_at = ${now}
            WHERE provider = ? AND scope_id = ? AND revision < ?
              AND transition_token IS NULL
              AND EXISTS (
                SELECT 1 FROM repository_context_authority_repository
                 WHERE provider = ? AND scope_id = ? AND external_id = ?
                   AND state = 'active' AND claim_token = ?
              )`,
        )
        .bind(
          transitionToken,
          PROVIDER,
          args.scopeId,
          MAX_SAFE_REVISION,
          PROVIDER,
          args.scopeId,
          args.externalId,
          args.claimToken,
        ),
      db
        .prepare(
          `DELETE FROM repository_context_authority_repository
            WHERE provider = ? AND scope_id = ? AND external_id = ?
              AND claim_token = ?
              AND (
                state = 'pending'
                OR (
                  state = 'active'
                  AND EXISTS (
                    SELECT 1 FROM repository_context_authority_scope AS scope
                     WHERE scope.provider = repository_context_authority_repository.provider
                       AND scope.scope_id = repository_context_authority_repository.scope_id
                       AND scope.transition_token = ?
                  )
                )
              )`,
        )
        .bind(PROVIDER, args.scopeId, args.externalId, args.claimToken, transitionToken),
      authorityTransitionGuardStatement(db, args, transitionToken, "released"),
      authorityRepositoryByExternalIdStatement(db, args.externalId),
      authorityScopeStatement(db, args.scopeId),
    ])
    const scope = singleRow<AuthorityScopeRow>(results[4])
    if (!validRevision(scope?.revision) || scope?.transition_token !== null) return { status: "unavailable" }
    const scopeChanges = changes(results[0])
    const repositoryChanges = changes(results[1])
    if ((scopeChanges === 1 && repositoryChanges === 1) || (scopeChanges === 0 && repositoryChanges === 1)) {
      return { status: "released", revision: scope!.revision }
    }
    if (scopeChanges !== 0 || repositoryChanges !== 0) return { status: "unavailable" }
    const remaining = singleRow<AuthorityRepositoryRow>(results[3])
    if (!remaining) return { status: "already_released", revision: scope!.revision }
    return matchesGeneration(remaining, args) ? { status: "unavailable" } : { status: "lost_claim" }
  } catch (error) {
    logFailure("repository-context-authority-release-failed", error, args.scopeId)
    return { status: "unavailable" }
  }
}

export async function readGitLabRepositoryAuthority(
  db: D1Database,
  scopeId: string,
): Promise<GitLabRepositoryAuthorityReadResult> {
  if (!validScopeId(scopeId)) return { status: "unavailable" }
  try {
    const results = await db.batch([
      authorityScopeStatement(db, scopeId),
      db
        .prepare(
          `SELECT scope_id, instance_origin, source_id, external_id, full_name, state,
                  claim_token, claim_expires_at,
                  CASE WHEN claim_expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 1 ELSE 0 END AS claim_is_live,
                  activated_at
             FROM repository_context_authority_repository
            WHERE provider = ? AND scope_id = ? AND state = 'active'
            ORDER BY instance_origin, source_id`,
        )
        .bind(PROVIDER, scopeId),
    ])
    const scopeRows = rows<AuthorityScopeRow>(results[0])
    const repositoryRows = rows<AuthorityRepositoryRow>(results[1])
    if (!scopeRows || !repositoryRows || scopeRows.length > 1) return { status: "unavailable" }
    if (scopeRows.length === 0) return repositoryRows.length === 0 ? { status: "not_found" } : { status: "unavailable" }
    const revision = scopeRows[0]?.revision
    if (!validRevision(revision) || scopeRows[0]?.transition_token !== null) return { status: "unavailable" }
    const repositories = await Promise.all(repositoryRows.map(decodeAuthorityRepository))
    if (repositories.some((repository) => repository === null)) return { status: "unavailable" }
    return {
      status: "ok",
      revision: revision!,
      repositories: repositories.filter(
        (repository): repository is GitLabRepositoryAuthorityRepository => repository !== null,
      ),
    }
  } catch (error) {
    logFailure("repository-context-authority-read-failed", error, scopeId)
    return { status: "unavailable" }
  }
}

export async function verifyActiveGitLabRepositoryAuthorityGeneration(
  db: D1Database,
  args: { scopeId: string; externalId: string; claimToken: string },
): Promise<GitLabRepositoryAuthorityGenerationResult> {
  if (!validExactGeneration(args)) return { status: "unavailable" }
  try {
    const results = await db.batch([
      db
        .prepare(
          `SELECT 1 AS active
             FROM repository_context_authority_repository AS repository
             JOIN repository_context_authority_scope AS scope
               ON scope.provider = repository.provider AND scope.scope_id = repository.scope_id
            WHERE repository.provider = ? AND repository.scope_id = ?
              AND repository.external_id = ? AND repository.claim_token = ?
              AND repository.state = 'active' AND scope.transition_token IS NULL
            LIMIT 1`,
        )
        .bind(PROVIDER, args.scopeId, args.externalId, args.claimToken),
    ])
    const activeRows = rows<{ active: number }>(results[0])
    if (!activeRows || activeRows.length > 1) return { status: "unavailable" }
    return { status: activeRows.length === 1 && activeRows[0]?.active === 1 ? "active" : "inactive" }
  } catch (error) {
    logFailure("repository-context-authority-generation-read-failed", error, args.scopeId)
    return { status: "unavailable" }
  }
}

function authorityScopeStatement(db: D1Database, scopeId: string): D1PreparedStatement {
  return db
    .prepare(
      "SELECT revision, transition_token FROM repository_context_authority_scope" +
        " WHERE provider = ? AND scope_id = ? LIMIT 1",
    )
    .bind(PROVIDER, scopeId)
}

function authorityRepositoryByIdentityStatement(
  db: D1Database,
  instanceOrigin: string,
  sourceId: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT scope_id, instance_origin, source_id, external_id, full_name, state,
              claim_token, claim_expires_at,
              CASE WHEN claim_expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 1 ELSE 0 END AS claim_is_live,
              activated_at
         FROM repository_context_authority_repository
        WHERE provider = ? AND instance_origin = ? AND source_id = ? LIMIT 1`,
    )
    .bind(PROVIDER, instanceOrigin, sourceId)
}

function authorityRepositoryByExternalIdStatement(db: D1Database, externalId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT scope_id, instance_origin, source_id, external_id, full_name, state,
              claim_token, claim_expires_at,
              CASE WHEN claim_expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') THEN 1 ELSE 0 END AS claim_is_live,
              activated_at
         FROM repository_context_authority_repository
        WHERE provider = ? AND external_id = ? LIMIT 1`,
    )
    .bind(PROVIDER, externalId)
}

function authorityTransitionGuardStatement(
  db: D1Database,
  args: { scopeId: string; externalId: string; claimToken: string },
  transitionToken: string,
  targetState: "active" | "released",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO repository_context_authority_transition_guard
        (provider, scope_id, transition_token, external_id, claim_token, target_state)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM repository_context_authority_scope
           WHERE provider = ? AND scope_id = ? AND transition_token = ?
        )`,
    )
    .bind(
      PROVIDER,
      args.scopeId,
      transitionToken,
      args.externalId,
      args.claimToken,
      targetState,
      PROVIDER,
      args.scopeId,
      transitionToken,
    )
}

function matchesGeneration(
  row: AuthorityRepositoryRow | null,
  args: { scopeId: string; externalId: string; claimToken: string },
): boolean {
  return row?.scope_id === args.scopeId && row.external_id === args.externalId && row.claim_token === args.claimToken
}

async function decodeAuthorityRepository(
  row: AuthorityRepositoryRow,
): Promise<GitLabRepositoryAuthorityRepository | null> {
  const [identity, fullName] = await Promise.all([
    canonicalGitLabRepositoryAuthorityIdentity(row.instance_origin, row.source_id),
    Promise.resolve(canonicalGitLabRepositoryFullName(row.full_name)),
  ])
  if (
    !identity ||
    !fullName ||
    identity.externalId !== row.external_id ||
    (row.state !== "pending" && row.state !== "active") ||
    !CLAIM_TOKEN_RE.test(row.claim_token) ||
    typeof row.claim_expires_at !== "string" ||
    (row.state === "pending" && row.activated_at !== null) ||
    (row.state === "active" && typeof row.activated_at !== "string")
  ) {
    return null
  }
  return { ...identity, fullName }
}

function validExactGeneration(args: { scopeId: string; externalId: string; claimToken: string }): boolean {
  return validScopeId(args.scopeId) && EXTERNAL_ID_RE.test(args.externalId) && CLAIM_TOKEN_RE.test(args.claimToken)
}

function validScopeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.trim() === value &&
    !value.includes("\u0000")
  )
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function randomClaimToken(): string {
  return randomAuthorityToken()
}

function randomAuthorityToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function rows<T>(result: D1Result | undefined): T[] | null {
  return result && Array.isArray(result.results) ? (result.results as T[]) : null
}

function singleRow<T>(result: D1Result | undefined): T | null {
  const resultRows = rows<T>(result)
  return resultRows?.length === 1 ? resultRows[0]! : null
}

function changes(result: D1Result | undefined): number {
  return typeof result?.meta?.changes === "number" ? result.meta.changes : 0
}

function logFailure(event: string, error: unknown, scopeId: string): void {
  console.warn(
    JSON.stringify({
      event,
      provider: PROVIDER,
      scopeId,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}
