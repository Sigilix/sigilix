import {
  MAX_REPOSITORY_CONTEXT_CHARS,
  MAX_REPOSITORY_CONTEXT_CONVENTIONS_CHARS,
  MAX_REPOSITORY_CONTEXT_LABEL_CHARS,
  MAX_REPOSITORY_CONTEXT_RELATIONSHIPS,
  MAX_REPOSITORY_CONTEXT_REPOSITORIES,
} from "@/src/features/repository-context/domain/input"
import type {
  PurgeRepositoryContextArgs,
  ReplaceRepositoryContextArgs,
  RepositoryContextAction,
  RepositoryContextProvider,
  RepositoryContextReadResult,
  RepositoryContextRelationship,
  RepositoryContextRepository,
  RepositoryContextSnapshot,
  RepositoryContextWriteResult,
} from "@/src/features/repository-context/domain/types"

interface ScopeRow {
  provider: string
  scope_id: string
  revision: number
  snapshot_format: number
  conventions: string
  snapshot_sha256: string
  repo_count: number
  relationship_count: number
  created_at: string
  updated_at: string
  updated_by: string
  last_action: string
  deleted_at: string | null
}

interface RepositoryRow {
  external_id: string
  full_name: string
  context: string
  position: number
}

interface RelationshipRow {
  from_external_id: string
  to_external_id: string
  label: string
  normalized_label: string
  position: number
}

interface CanonicalMutation {
  provider: RepositoryContextProvider
  scopeId: string
  expectedRevision: number
  repositories: RepositoryContextRepository[]
  relationships: RepositoryContextRelationship[]
  conventions: string
  nowIso: string
  updatedBy: string
  action: RepositoryContextAction
  deletedAt: string | null
}

const SCOPE_COLUMNS =
  "provider, scope_id, revision, snapshot_format, conventions, snapshot_sha256, repo_count," +
  " relationship_count, created_at, updated_at, updated_by, last_action, deleted_at"
const REPOSITORY_COLUMNS = "external_id, full_name, context, position"
const RELATIONSHIP_COLUMNS = "from_external_id, to_external_id, label, normalized_label, position"
const REPOSITORY_INSERT_CHUNK = 24 // 24 * 4 row binds + 3 scope/token binds = 99
const RELATIONSHIP_INSERT_CHUNK = 19 // 19 * 5 row binds + 3 scope/token binds = 98
const SNAPSHOT_FORMAT = 1

export async function readRepositoryContext(
  db: D1Database,
  provider: RepositoryContextProvider,
  scopeId: string,
): Promise<RepositoryContextReadResult> {
  if (!validProvider(provider) || !validScopeId(provider, scopeId)) return { status: "unavailable" }
  try {
    const results = await db.batch(snapshotReadStatements(db, provider, scopeId))
    return decodeReadBatch(results)
  } catch (error) {
    logFailure("repository-context-read-failed", error, provider, scopeId)
    return { status: "unavailable" }
  }
}

export async function replaceRepositoryContext(
  db: D1Database,
  args: ReplaceRepositoryContextArgs,
): Promise<RepositoryContextWriteResult> {
  const canonical = canonicalMutation(args, "replaced", null)
  return canonical ? writeRepositoryContext(db, canonical) : { status: "unavailable" }
}

export async function purgeRepositoryContext(
  db: D1Database,
  args: PurgeRepositoryContextArgs,
): Promise<RepositoryContextWriteResult> {
  const canonical = canonicalMutation(
    { ...args, repositories: [], relationships: [], conventions: "" },
    "purged",
    args.nowIso,
  )
  return canonical ? writeRepositoryContext(db, canonical) : { status: "unavailable" }
}

async function writeRepositoryContext(
  db: D1Database,
  mutation: CanonicalMutation,
): Promise<RepositoryContextWriteResult> {
  const nextRevision = mutation.expectedRevision + 1
  const writeToken = randomWriteToken()
  const auditId = `repoctx_${crypto.randomUUID()}`
  const snapshotSha256 = await computeSnapshotSha256(mutation, mutation.action === "purged" ? "purged" : "active")
  const statements: D1PreparedStatement[] = [
    scopeCasStatement(db, mutation, nextRevision, snapshotSha256, writeToken, auditId),
    deleteRelationshipsStatement(db, mutation, writeToken),
    deleteRepositoriesStatement(db, mutation, writeToken),
    ...repositoryInsertStatements(db, mutation, writeToken),
    ...relationshipInsertStatements(db, mutation, writeToken),
    commitGuardStatement(db, mutation, writeToken),
    ...snapshotReadStatements(db, mutation.provider, mutation.scopeId),
  ]
  try {
    const results = await db.batch(statements)
    const readResults = results.slice(-3)
    if (changes(results[0]) === 0) {
      const currentRevision = decodeCurrentRevision(readResults[0])
      return currentRevision === null ? { status: "unavailable" } : { status: "conflict", currentRevision }
    }
    const read = await decodeReadBatch(readResults)
    if (
      read.status !== "ok" ||
      read.snapshot.revision !== nextRevision ||
      read.snapshot.snapshotSha256 !== snapshotSha256
    ) {
      return { status: "unavailable" }
    }
    return { status: "updated", snapshot: read.snapshot }
  } catch (error) {
    logFailure("repository-context-write-failed", error, mutation.provider, mutation.scopeId)
    return { status: "unavailable" }
  }
}

function scopeCasStatement(
  db: D1Database,
  mutation: CanonicalMutation,
  nextRevision: number,
  snapshotSha256: string,
  writeToken: string,
  auditId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO repository_context_scope
        (provider, scope_id, revision, snapshot_format, conventions, snapshot_sha256, repo_count,
         relationship_count, write_token, created_at, updated_at, updated_by,
         last_action, last_audit_id, deleted_at)
       SELECT ?, ?, ?, ${SNAPSHOT_FORMAT}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ? = 0 OR EXISTS (
         SELECT 1 FROM repository_context_scope
          WHERE provider = ? AND scope_id = ? AND revision = ?
       )
       ON CONFLICT(provider, scope_id) DO UPDATE SET
         revision = excluded.revision,
         snapshot_format = excluded.snapshot_format,
         conventions = excluded.conventions,
         snapshot_sha256 = excluded.snapshot_sha256,
         repo_count = excluded.repo_count,
         relationship_count = excluded.relationship_count,
         write_token = excluded.write_token,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by,
         last_action = excluded.last_action,
         last_audit_id = excluded.last_audit_id,
         deleted_at = excluded.deleted_at
       WHERE repository_context_scope.revision = ?`,
    )
    .bind(
      mutation.provider,
      mutation.scopeId,
      nextRevision,
      mutation.conventions,
      snapshotSha256,
      mutation.repositories.length,
      mutation.relationships.length,
      writeToken,
      mutation.nowIso,
      mutation.nowIso,
      mutation.updatedBy,
      mutation.action,
      auditId,
      mutation.deletedAt,
      mutation.expectedRevision,
      mutation.provider,
      mutation.scopeId,
      mutation.expectedRevision,
      mutation.expectedRevision,
    )
}

function deleteRelationshipsStatement(
  db: D1Database,
  mutation: CanonicalMutation,
  writeToken: string,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM repository_context_relationship
        WHERE provider = ? AND scope_id = ?
          AND EXISTS (
            SELECT 1 FROM repository_context_scope AS scope
             WHERE scope.provider = repository_context_relationship.provider
               AND scope.scope_id = repository_context_relationship.scope_id
               AND scope.write_token = ?
          )`,
    )
    .bind(mutation.provider, mutation.scopeId, writeToken)
}

function deleteRepositoriesStatement(
  db: D1Database,
  mutation: CanonicalMutation,
  writeToken: string,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM repository_context_repository
        WHERE provider = ? AND scope_id = ?
          AND EXISTS (
            SELECT 1 FROM repository_context_scope AS scope
             WHERE scope.provider = repository_context_repository.provider
               AND scope.scope_id = repository_context_repository.scope_id
               AND scope.write_token = ?
          )`,
    )
    .bind(mutation.provider, mutation.scopeId, writeToken)
}

function repositoryInsertStatements(
  db: D1Database,
  mutation: CanonicalMutation,
  writeToken: string,
): D1PreparedStatement[] {
  return chunks(mutation.repositories, REPOSITORY_INSERT_CHUNK).map((batch) => {
    const values = batch.map(() => "(?, ?, ?, ?)").join(", ")
    const bindings = batch.flatMap((repository) => [
      repository.externalId,
      repository.fullName,
      repository.context,
      repository.position,
    ])
    return db
      .prepare(
        `WITH input(external_id, full_name, context, position) AS (VALUES ${values})
         INSERT INTO repository_context_repository
           (provider, scope_id, external_id, full_name, context, position)
         SELECT scope.provider, scope.scope_id, input.external_id, input.full_name, input.context, input.position
           FROM input
           JOIN repository_context_scope AS scope
             ON scope.provider = ? AND scope.scope_id = ? AND scope.write_token = ?`,
      )
      .bind(...bindings, mutation.provider, mutation.scopeId, writeToken)
  })
}

function relationshipInsertStatements(
  db: D1Database,
  mutation: CanonicalMutation,
  writeToken: string,
): D1PreparedStatement[] {
  return chunks(mutation.relationships, RELATIONSHIP_INSERT_CHUNK).map((batch) => {
    const values = batch.map(() => "(?, ?, ?, ?, ?)").join(", ")
    const bindings = batch.flatMap((relationship) => [
      relationship.fromExternalId,
      relationship.toExternalId,
      relationship.label,
      relationship.normalizedLabel,
      relationship.position,
    ])
    return db
      .prepare(
        `WITH input(from_external_id, to_external_id, label, normalized_label, position) AS (VALUES ${values})
         INSERT INTO repository_context_relationship
           (provider, scope_id, from_external_id, to_external_id, label, normalized_label, position)
         SELECT scope.provider, scope.scope_id, input.from_external_id, input.to_external_id,
                input.label, input.normalized_label, input.position
           FROM input
           JOIN repository_context_scope AS scope
             ON scope.provider = ? AND scope.scope_id = ? AND scope.write_token = ?`,
      )
      .bind(...bindings, mutation.provider, mutation.scopeId, writeToken)
  })
}

function commitGuardStatement(db: D1Database, mutation: CanonicalMutation, writeToken: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO repository_context_commit_guard (provider, scope_id, write_token)
       SELECT ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM repository_context_scope
          WHERE provider = ? AND scope_id = ? AND write_token = ?
       )`,
    )
    .bind(mutation.provider, mutation.scopeId, writeToken, mutation.provider, mutation.scopeId, writeToken)
}

function snapshotReadStatements(
  db: D1Database,
  provider: RepositoryContextProvider,
  scopeId: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(`SELECT ${SCOPE_COLUMNS} FROM repository_context_scope WHERE provider = ? AND scope_id = ? LIMIT 1`)
      .bind(provider, scopeId),
    db
      .prepare(
        `SELECT ${REPOSITORY_COLUMNS} FROM repository_context_repository
          WHERE provider = ? AND scope_id = ? ORDER BY position LIMIT ?`,
      )
      .bind(provider, scopeId, MAX_REPOSITORY_CONTEXT_REPOSITORIES + 1),
    db
      .prepare(
        `SELECT ${RELATIONSHIP_COLUMNS} FROM repository_context_relationship
          WHERE provider = ? AND scope_id = ? ORDER BY position LIMIT ?`,
      )
      .bind(provider, scopeId, MAX_REPOSITORY_CONTEXT_RELATIONSHIPS + 1),
  ]
}

async function decodeReadBatch(results: readonly D1Result[]): Promise<RepositoryContextReadResult> {
  if (results.length !== 3) return { status: "unavailable" }
  const scopeRows = rows<ScopeRow>(results[0])
  const repositoryRows = rows<RepositoryRow>(results[1])
  const relationshipRows = rows<RelationshipRow>(results[2])
  if (scopeRows === null || repositoryRows === null || relationshipRows === null) return { status: "unavailable" }
  if (scopeRows.length === 0) {
    return repositoryRows.length === 0 && relationshipRows.length === 0
      ? { status: "not_found" }
      : { status: "unavailable" }
  }
  if (scopeRows.length !== 1) return { status: "unavailable" }
  const scope = scopeRows[0]
  if (!scope) return { status: "unavailable" }
  const snapshot = await decodeSnapshot(scope, repositoryRows, relationshipRows)
  return snapshot ? { status: "ok", snapshot } : { status: "unavailable" }
}

function decodeCurrentRevision(result: D1Result | undefined): number | null {
  const scopeRows = rows<ScopeRow>(result)
  if (scopeRows === null || scopeRows.length > 1) return null
  if (scopeRows.length === 0) return 0
  const scope = scopeRows[0]
  return scope && Number.isSafeInteger(scope.revision) && scope.revision > 0 ? scope.revision : null
}

function rows<T>(result: D1Result | undefined): T[] | null {
  return result && Array.isArray(result.results) ? (result.results as T[]) : null
}

async function decodeSnapshot(
  scope: ScopeRow,
  repositoryRows: readonly RepositoryRow[],
  relationshipRows: readonly RelationshipRow[],
): Promise<RepositoryContextSnapshot | null> {
  if (!validScopeRow(scope)) return null
  if (repositoryRows.length !== scope.repo_count || relationshipRows.length !== scope.relationship_count) return null
  const repositories = repositoryRows.map((row) => decodeRepositoryRow(scope.provider, row))
  if (repositories.some((repository) => repository === null)) return null
  const typedRepositories = repositories.filter((repository): repository is RepositoryContextRepository => !!repository)
  if (
    typedRepositories.some(
      (repository, index) =>
        repository.position !== index ||
        (index > 0 &&
          compareExternalIds(
            scope.provider as RepositoryContextProvider,
            typedRepositories[index - 1]!.externalId,
            repository.externalId,
          ) >= 0),
    )
  ) {
    return null
  }
  const ids = new Set(typedRepositories.map((repository) => repository.externalId))
  const relationships = relationshipRows.map((row) => decodeRelationshipRow(row, ids))
  if (relationships.some((relationship) => relationship === null)) return null
  const typedRelationships = relationships.filter(
    (relationship): relationship is RepositoryContextRelationship => !!relationship,
  )
  if (
    typedRelationships.some(
      (relationship, index) =>
        relationship.position !== index ||
        (index > 0 &&
          compareRelationships(
            scope.provider as RepositoryContextProvider,
            typedRelationships[index - 1]!,
            relationship,
          ) >= 0),
    )
  ) {
    return null
  }
  const provider = scope.provider as RepositoryContextProvider
  const snapshotSha256 = await computeSnapshotSha256(
    {
      repositories: typedRepositories,
      relationships: typedRelationships,
      conventions: scope.conventions,
    },
    scope.last_action === "purged" ? "purged" : "active",
  )
  if (snapshotSha256 !== scope.snapshot_sha256) return null
  return {
    provider,
    scopeId: scope.scope_id,
    revision: scope.revision,
    repositories: typedRepositories,
    relationships: typedRelationships,
    conventions: scope.conventions,
    snapshotSha256,
    createdAt: scope.created_at,
    updatedAt: scope.updated_at,
    updatedBy: scope.updated_by,
    deletedAt: scope.deleted_at,
  }
}

function canonicalMutation(
  args: ReplaceRepositoryContextArgs,
  action: RepositoryContextAction,
  deletedAt: string | null,
): CanonicalMutation | null {
  if (
    !validProvider(args.provider) ||
    !validScopeId(args.provider, args.scopeId) ||
    !Number.isSafeInteger(args.expectedRevision) ||
    args.expectedRevision < 0 ||
    args.expectedRevision >= Number.MAX_SAFE_INTEGER ||
    !validMetadataText(args.nowIso, 64) ||
    !validMetadataText(args.updatedBy, 256) ||
    !Array.isArray(args.repositories) ||
    args.repositories.length > MAX_REPOSITORY_CONTEXT_REPOSITORIES ||
    !Array.isArray(args.relationships) ||
    args.relationships.length > MAX_REPOSITORY_CONTEXT_RELATIONSHIPS ||
    !validMultilineText(args.conventions, MAX_REPOSITORY_CONTEXT_CONVENTIONS_CHARS)
  ) {
    return null
  }
  const repositories = args.repositories
    .map((repository) => canonicalRepository(args.provider, repository))
    .sort((a, b) => compareExternalIds(args.provider, a?.externalId ?? "", b?.externalId ?? ""))
  if (repositories.some((repository) => repository === null)) return null
  const typedRepositories = repositories.filter((repository): repository is RepositoryContextRepository => !!repository)
  const ids = new Set(typedRepositories.map((repository) => repository.externalId))
  if (ids.size !== typedRepositories.length) return null
  typedRepositories.forEach((repository, position) => {
    repository.position = position
  })

  const relationships = args.relationships
    .map((relationship) => canonicalRelationship(args.provider, relationship, ids))
    .sort((a, b) => compareRelationships(args.provider, a, b))
  if (relationships.some((relationship) => relationship === null)) return null
  const typedRelationships = relationships.filter(
    (relationship): relationship is RepositoryContextRelationship => !!relationship,
  )
  const keys = new Set(
    typedRelationships.map(
      (relationship) =>
        `${relationship.fromExternalId}\u0000${relationship.toExternalId}\u0000${relationship.normalizedLabel}`,
    ),
  )
  if (keys.size !== typedRelationships.length) return null
  typedRelationships.forEach((relationship, position) => {
    relationship.position = position
  })
  return {
    provider: args.provider,
    scopeId: args.scopeId,
    expectedRevision: args.expectedRevision,
    repositories: typedRepositories,
    relationships: typedRelationships,
    conventions: normalizeMultiline(args.conventions),
    nowIso: args.nowIso,
    updatedBy: args.updatedBy,
    action,
    deletedAt,
  }
}

function canonicalRepository(
  provider: RepositoryContextProvider,
  repository: RepositoryContextRepository,
): RepositoryContextRepository | null {
  if (
    !repository ||
    !validExternalId(provider, repository.externalId) ||
    !validRepositoryName(provider, repository.fullName) ||
    !validMultilineText(repository.context, MAX_REPOSITORY_CONTEXT_CHARS)
  ) {
    return null
  }
  return {
    externalId: repository.externalId,
    fullName: repository.fullName.normalize("NFC"),
    context: normalizeMultiline(repository.context),
    position: 0,
  }
}

function canonicalRelationship(
  provider: RepositoryContextProvider,
  relationship: RepositoryContextRelationship,
  repositoryIds: ReadonlySet<string>,
): RepositoryContextRelationship | null {
  if (
    !relationship ||
    !validExternalId(provider, relationship.fromExternalId) ||
    !validExternalId(provider, relationship.toExternalId) ||
    relationship.fromExternalId === relationship.toExternalId ||
    !repositoryIds.has(relationship.fromExternalId) ||
    !repositoryIds.has(relationship.toExternalId) ||
    typeof relationship.label !== "string" ||
    hasLabelControl(relationship.label)
  ) {
    return null
  }
  const label = normalizeLabel(relationship.label)
  const normalizedLabel = label.toLowerCase()
  if (
    label.length === 0 ||
    label.length > MAX_REPOSITORY_CONTEXT_LABEL_CHARS ||
    normalizedLabel.length > MAX_REPOSITORY_CONTEXT_LABEL_CHARS
  ) {
    return null
  }
  return {
    fromExternalId: relationship.fromExternalId,
    toExternalId: relationship.toExternalId,
    label,
    normalizedLabel,
    position: 0,
  }
}

function decodeRepositoryRow(provider: string, row: RepositoryRow): RepositoryContextRepository | null {
  if (
    !validProvider(provider) ||
    !validExternalId(provider, row.external_id) ||
    !validRepositoryName(provider, row.full_name) ||
    !validMultilineText(row.context, MAX_REPOSITORY_CONTEXT_CHARS) ||
    row.full_name !== row.full_name.normalize("NFC") ||
    row.context !== normalizeMultiline(row.context) ||
    !Number.isSafeInteger(row.position) ||
    row.position < 0 ||
    row.position >= MAX_REPOSITORY_CONTEXT_REPOSITORIES
  ) {
    return null
  }
  return { externalId: row.external_id, fullName: row.full_name, context: row.context, position: row.position }
}

function decodeRelationshipRow(
  row: RelationshipRow,
  repositoryIds: ReadonlySet<string>,
): RepositoryContextRelationship | null {
  if (
    typeof row.from_external_id !== "string" ||
    typeof row.to_external_id !== "string" ||
    row.from_external_id === row.to_external_id ||
    !repositoryIds.has(row.from_external_id) ||
    !repositoryIds.has(row.to_external_id) ||
    typeof row.label !== "string" ||
    typeof row.normalized_label !== "string" ||
    hasLabelControl(row.label) ||
    hasLabelControl(row.normalized_label) ||
    row.label.length === 0 ||
    row.label.length > MAX_REPOSITORY_CONTEXT_LABEL_CHARS ||
    row.normalized_label.length > MAX_REPOSITORY_CONTEXT_LABEL_CHARS ||
    row.label !== normalizeLabel(row.label) ||
    row.normalized_label !== row.label.toLowerCase() ||
    !Number.isSafeInteger(row.position) ||
    row.position < 0 ||
    row.position >= MAX_REPOSITORY_CONTEXT_RELATIONSHIPS
  ) {
    return null
  }
  return {
    fromExternalId: row.from_external_id,
    toExternalId: row.to_external_id,
    label: row.label,
    normalizedLabel: row.normalized_label,
    position: row.position,
  }
}

function validScopeRow(row: ScopeRow): boolean {
  return (
    validProvider(row.provider) &&
    validScopeId(row.provider, row.scope_id) &&
    Number.isSafeInteger(row.revision) &&
    row.revision > 0 &&
    row.snapshot_format === SNAPSHOT_FORMAT &&
    validMultilineText(row.conventions, MAX_REPOSITORY_CONTEXT_CONVENTIONS_CHARS) &&
    row.conventions === normalizeMultiline(row.conventions) &&
    /^[a-f0-9]{64}$/.test(row.snapshot_sha256) &&
    Number.isSafeInteger(row.repo_count) &&
    row.repo_count >= 0 &&
    row.repo_count <= MAX_REPOSITORY_CONTEXT_REPOSITORIES &&
    Number.isSafeInteger(row.relationship_count) &&
    row.relationship_count >= 0 &&
    row.relationship_count <= MAX_REPOSITORY_CONTEXT_RELATIONSHIPS &&
    validMetadataText(row.created_at, 64) &&
    validMetadataText(row.updated_at, 64) &&
    validMetadataText(row.updated_by, 256) &&
    (row.deleted_at === null || validMetadataText(row.deleted_at, 64)) &&
    ((row.last_action === "replaced" && row.deleted_at === null) ||
      (row.last_action === "purged" &&
        row.deleted_at !== null &&
        row.conventions === "" &&
        row.repo_count === 0 &&
        row.relationship_count === 0))
  )
}

function validProvider(value: unknown): value is RepositoryContextProvider {
  return value === "github" || value === "gitlab"
}

function validScopeId(provider: RepositoryContextProvider, value: unknown): value is string {
  if (typeof value !== "string" || !validMetadataText(value, 128)) return false
  return provider !== "github" || validPositiveDecimal(value)
}

function validExternalId(provider: RepositoryContextProvider, value: unknown): value is string {
  if (typeof value !== "string" || !validMetadataText(value, 128)) return false
  return provider !== "github" || validPositiveDecimal(value)
}

function validPositiveDecimal(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}

function validRepositoryName(provider: RepositoryContextProvider, value: unknown): value is string {
  if (typeof value !== "string" || !validMetadataText(value, 512)) return false
  return provider === "github" ? /^[^/\s]+\/[^/\s]+$/.test(value) : !/^\/|\/$/.test(value)
}

function validMultilineText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
    !hasUnpairedSurrogate(value)
  )
}

function validMetadataText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !hasLabelControl(value)
}

function hasLabelControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value) || hasUnpairedSurrogate(value)
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
}

function normalizeMultiline(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim()
}

function normalizeLabel(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim()
}

function compareExternalIds(provider: RepositoryContextProvider, left: string, right: string): number {
  return provider === "github" ? Number(left) - Number(right) : compareCodepoints(left, right)
}

function compareRelationships(
  provider: RepositoryContextProvider,
  left: RepositoryContextRelationship | null,
  right: RepositoryContextRelationship | null,
): number {
  if (!left) return right ? 1 : 0
  if (!right) return -1
  return (
    compareExternalIds(provider, left.fromExternalId, right.fromExternalId) ||
    compareExternalIds(provider, left.toExternalId, right.toExternalId) ||
    compareCodepoints(left.normalizedLabel, right.normalizedLabel)
  )
}

function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

async function computeSnapshotSha256(
  snapshot: Pick<CanonicalMutation, "repositories" | "relationships" | "conventions">,
  state: "active" | "purged",
): Promise<string> {
  const canonical = JSON.stringify({
    format: SNAPSHOT_FORMAT,
    state,
    conventions: snapshot.conventions,
    repositories: snapshot.repositories.map(({ externalId, fullName, context }) => ({ externalId, fullName, context })),
    relationships: snapshot.relationships.map(({ fromExternalId, toExternalId, label, normalizedLabel }) => ({
      fromExternalId,
      toExternalId,
      label,
      normalizedLabel,
    })),
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function randomWriteToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function changes(result: D1Result | undefined): number {
  const value = result?.meta?.changes
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function logFailure(event: string, error: unknown, provider: string, scopeId: string): void {
  console.error(
    JSON.stringify({
      event,
      provider,
      scopeId,
      err: error instanceof Error ? error.message : String(error),
    }),
  )
}
