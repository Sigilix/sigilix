// Durable assembly for one canonical, immutable-repository vector-membership
// snapshot. Full repository indexes span queue deliveries, so each file-range
// slice is staged in D1 before the final manifest publishes a complete by-path
// view. This module owns schema-shaped validation and D1 IO; rollout policy is
// handled by the indexer (off/shadow/on).

export type RepoActiveIndexMode = "off" | "shadow" | "on"
export type RepoActiveIndexBuiltMode = Exclude<RepoActiveIndexMode, "off">

export interface RepoActiveIndexSnapshotV1 {
  version: 1
  githubRepoId: number
  builtMode: RepoActiveIndexBuiltMode
  byPath: Record<string, string[]>
}

export interface StageRepoActiveIndexSliceArgs {
  db: D1Database
  githubRepoId: number
  installationId: number
  runId: string
  totalFiles: number
  lo: number
  hi: number
  mode: RepoActiveIndexBuiltMode
  idsByPath: Readonly<Record<string, readonly string[]>>
  bookmark?: string | null
  nowMs?: number
}

export interface RepoActiveIndexStageResult {
  bookmark: string | null
  completedThrough: number
  shardCount: number
}

export interface ReadRepoActiveIndexProgressArgs {
  db: D1Database
  githubRepoId: number
  installationId: number
  runId: string
  totalFiles: number
  mode: RepoActiveIndexBuiltMode
}

export interface RepoActiveIndexProgress {
  bookmark: string | null
  chunkCount: number
  completedThrough: number
  sealed: boolean
  shardCount: number
}

export interface MaterializeRepoActiveIndexArgs {
  db: D1Database
  githubRepoId: number
  runId: string
  bookmark?: string | null
}

export interface RepoActiveIndexMaterializeResult {
  snapshot: RepoActiveIndexSnapshotV1
  bookmark: string | null
}

/** A late divergent replay lost the race to the run's canonical seal. */
export class RepoActiveIndexSealedReplayMismatchError extends Error {
  constructor() {
    super("repo active index sealed replay membership mismatch")
    this.name = "RepoActiveIndexSealedReplayMismatchError"
  }
}

interface RunRow {
  github_repo_id: number
  run_id: string
  installation_id: number
  total_files: number
  completed_through: number
  built_mode: string
  latest_bookmark: string | null
  expires_at_ms: number
  invalidated: number
  sealed: number
}

interface PartRow {
  slice_lo: number
  part_no: number
  entries_json: string
}

interface SliceRow {
  slice_hi: number
  part_count: number
  content_sha256: string
}

interface ProgressRow extends RunRow {
  chunk_count: unknown
  shard_count: unknown
}

type PartEntry = [path: string, ids: string[]]

const RUN_COLUMNS =
  "github_repo_id, run_id, installation_id, total_files, completed_through," +
  " built_mode, latest_bookmark, expires_at_ms, invalidated, sealed"
const RUN_RETENTION_MS = 24 * 60 * 60 * 1_000
const MAX_PART_BYTES = 32 * 1024
const MATERIALIZE_PAGE_SIZE = 16
const MAX_MATERIALIZED_BYTES = 8 * 1024 * 1024
const MAX_SWEEP_ROWS = 100
const PART_ROWS_PER_STATEMENT = 45 // 45 * 2 row binds + 9 fixed/guard binds = 99.
// Worst-case final invocation stages 11k parts in 245 statements, then
// materializes them in 688 pages. With run/bookmark reads and writes this
// remains below D1's 1,000-query paid-Worker invocation ceiling.
const MAX_PARTS_PER_RUN = 11_000
const VECTOR_ID = /^[0-9a-f]{48}$/
const RUN_ID = /^[0-9a-f]{16}$/
const textEncoder = new TextEncoder()

export function parseRepoActiveIndexMode(value: unknown): RepoActiveIndexMode {
  return value === "shadow" || value === "on" ? value : "off"
}

export function parseRepoActiveIndexSnapshot(value: unknown): RepoActiveIndexSnapshotV1 | null {
  try {
    if (!isRecord(value) || !hasExactDataKeys(value, ["version", "githubRepoId", "builtMode", "byPath"])) {
      return null
    }
    if (value.version !== 1 || !validPositiveSafeInteger(value.githubRepoId) || !isBuiltMode(value.builtMode)) {
      return null
    }
    const byPath = parseByPath(value.byPath)
    if (byPath === null) return null
    return { version: 1, githubRepoId: value.githubRepoId, builtMode: value.builtMode, byPath }
  } catch {
    return null
  }
}

/** Read the primary-owned high-water for an at-least-once queue delivery. */
export async function readRepoActiveIndexProgress(
  args: ReadRepoActiveIndexProgressArgs,
): Promise<RepoActiveIndexProgress | null> {
  validateRunIdentity(args)
  const session = args.db.withSession("first-primary")
  const run = await session
    .prepare(
      `SELECT r.*,
        (SELECT COUNT(*) FROM repo_active_index_slice AS slice
          WHERE slice.github_repo_id = r.github_repo_id AND slice.run_id = r.run_id) AS shard_count,
        (SELECT COALESCE(SUM(json_array_length(json_extract(entry.value, '$[1]'))), 0)
           FROM repo_active_index_part AS part, json_each(part.entries_json) AS entry
          WHERE part.github_repo_id = r.github_repo_id AND part.run_id = r.run_id) AS chunk_count
       FROM repo_active_index_run AS r WHERE r.github_repo_id = ? AND r.run_id = ?`,
    )
    .bind(args.githubRepoId, args.runId)
    .first<ProgressRow>()
  if (run === null) return null
  assertRunMetadata(run, args)
  assertRunUsable(run)
  if (!validNonNegativeSafeInteger(run.chunk_count) || !validNonNegativeSafeInteger(run.shard_count)) {
    throw new Error("repo active index progress count is malformed")
  }
  return {
    bookmark: session.getBookmark() ?? run.latest_bookmark,
    chunkCount: run.chunk_count,
    completedThrough: run.completed_through,
    sealed: run.sealed === 1,
    shardCount: run.shard_count,
  }
}

/**
 * Atomically stage one contiguous file range. The run's immutable repository,
 * installation, file-count, and rollout mode are pinned on its first slice.
 * Redelivering an already-completed range is a no-op; skipping ahead rejects.
 */
export async function stageRepoActiveIndexSlice(
  args: StageRepoActiveIndexSliceArgs,
): Promise<RepoActiveIndexStageResult> {
  const nowMs = args.nowMs ?? Date.now()
  validateStageArgs(args, nowMs)
  const expiresAtMs = nowMs + RUN_RETENTION_MS
  if (!Number.isSafeInteger(expiresAtMs)) throw new Error("repo active index expiry is unsafe")
  const parts = encodeParts(args.idsByPath)
  if (parts.length > MAX_PARTS_PER_RUN) {
    throw new Error("repo active index slice exceeds the staged part-count limit")
  }
  const contentSha256 = await sliceDigest(args.lo, args.hi, parts)

  // Arbitration always begins on the primary. A bookmark guarantees only
  // "at least this version" and may lag a concurrent invalidation or seal;
  // it is carried for observability/causality, never used as the authority.
  const session = args.db.withSession("first-primary")
  const before = await readRun(session, args.githubRepoId, args.runId)
  if (before !== null) {
    assertRunMetadata(before, args)
    assertRunUsable(before)
    if (before.completed_through >= args.hi) {
      await assertReplayCompatible(session, args, parts.length, contentSha256)
      return progressResult(session, before, args.bookmark)
    }
    if (before.completed_through !== args.lo) throw new Error("repo active index slice is out of order")
  } else if (args.lo !== 0) {
    throw new Error("repo active index slice is out of order")
  }

  const statements: D1PreparedStatement[] = [
    insertRunStatement(session, args, expiresAtMs),
    insertSliceStatement(session, args, parts.length, contentSha256),
  ]
  for (let offset = 0; offset < parts.length; offset += PART_ROWS_PER_STATEMENT) {
    statements.push(insertPartsStatement(session, args, parts.slice(offset, offset + PART_ROWS_PER_STATEMENT), offset))
  }
  statements.push(advanceRunStatement(session, args, expiresAtMs))

  const results = await session.batch(statements)
  const advance = results.at(-1)
  if (Number(advance?.meta.changes ?? 0) === 1) {
    const stagedBookmark = session.getBookmark()
    if (stagedBookmark !== null) {
      await session
        .prepare(
          "UPDATE repo_active_index_run SET latest_bookmark = ?" +
            " WHERE github_repo_id = ? AND run_id = ? AND completed_through = ?" +
            " AND invalidated = 0 AND sealed = 0",
        )
        .bind(stagedBookmark, args.githubRepoId, args.runId, args.hi)
        .run()
    }
    const staged = await readRun(session, args.githubRepoId, args.runId)
    if (staged === null) throw new Error("repo active index run disappeared while staging")
    return progressResult(session, staged, stagedBookmark)
  }

  // A concurrent primary writer may have advanced the high-water after our
  // first read. Re-read in this primary-anchored session before deciding
  // whether the failed conditional write was a valid replay or a gap.
  const after = await readRun(session, args.githubRepoId, args.runId)
  if (after === null) throw new Error("repo active index run disappeared while staging")
  assertRunMetadata(after, args)
  assertRunUsable(after)
  if (after.completed_through >= args.hi) {
    await assertReplayCompatible(session, args, parts.length, contentSha256)
    return progressResult(session, after, args.bookmark)
  }
  throw new Error("repo active index slice is out of order")
}

/** Materialize one complete run through keyset-paginated, bounded reads. */
export async function materializeRepoActiveIndex(
  args: MaterializeRepoActiveIndexArgs,
): Promise<RepoActiveIndexMaterializeResult> {
  if (!validPositiveSafeInteger(args.githubRepoId) || !RUN_ID.test(args.runId)) {
    throw new Error("invalid repo active index identity")
  }
  // Materialization must observe the latest invalidation/seal decision before
  // its own conditional seal; a replica session anchored by a bookmark is not
  // authoritative for that arbitration.
  const session = args.db.withSession("first-primary")
  const run = await readRun(session, args.githubRepoId, args.runId)
  if (run === null) throw new Error("repo active index run is missing")
  if (!validRunRow(run)) throw new Error("repo active index run metadata is malformed")
  assertRunUsable(run)
  if (run.completed_through !== run.total_files) throw new Error("repo active index run is incomplete")
  const partCountRow = await session
    .prepare("SELECT COUNT(*) AS part_count FROM repo_active_index_part" + " WHERE github_repo_id = ? AND run_id = ?")
    .bind(args.githubRepoId, args.runId)
    .first<{ part_count: unknown }>()
  if (!validNonNegativeSafeInteger(partCountRow?.part_count)) {
    throw new Error("repo active index staged part count is malformed")
  }
  if (partCountRow.part_count > MAX_PARTS_PER_RUN) {
    throw new Error("repo active index staged part count exceeds the query budget")
  }

  const byPath: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  const seenByPath = new Map<string, Set<string>>()
  let retainedBytes = 0
  let cursorLo = -1
  let cursorPart = -1
  let currentSliceLo: number | null = null
  let expectedPartNo = 0

  while (true) {
    const page = await session
      .prepare(
        `SELECT slice_lo, part_no, entries_json FROM repo_active_index_part
          WHERE github_repo_id = ? AND run_id = ?
            AND (slice_lo > ? OR (slice_lo = ? AND part_no > ?))
          ORDER BY slice_lo, part_no
          LIMIT ${MATERIALIZE_PAGE_SIZE}`,
      )
      .bind(args.githubRepoId, args.runId, cursorLo, cursorLo, cursorPart)
      .all<PartRow>()
    for (const row of page.results) {
      if (!validPartCursor(row) || row.slice_lo >= run.total_files) {
        throw new Error("repo active index staged part is malformed")
      }
      if (currentSliceLo !== row.slice_lo) {
        currentSliceLo = row.slice_lo
        expectedPartNo = 0
      }
      if (row.part_no !== expectedPartNo) throw new Error("repo active index staged part is malformed")
      expectedPartNo += 1
      const nextBytes = textEncoder.encode(row.entries_json).byteLength
      if (retainedBytes + nextBytes > MAX_MATERIALIZED_BYTES) {
        throw new Error("repo active index materialization exceeds the byte limit")
      }
      retainedBytes += nextBytes
      mergePart(byPath, seenByPath, parsePart(row.entries_json))
      cursorLo = row.slice_lo
      cursorPart = row.part_no
    }
    if (page.results.length < MATERIALIZE_PAGE_SIZE) break
  }

  const snapshot = parseRepoActiveIndexSnapshot({
    version: 1,
    githubRepoId: run.github_repo_id,
    builtMode: run.built_mode,
    byPath,
  })
  if (snapshot === null) throw new Error("repo active index materialized snapshot is malformed")

  // The conditional primary write is the publication linearization point.
  // A divergent replay may invalidate only while sealed=0; whichever write
  // wins makes the other path fail closed without changing staged parts.
  await session
    .prepare(
      `UPDATE repo_active_index_run SET sealed = 1
        WHERE github_repo_id = ? AND run_id = ? AND completed_through = total_files
          AND completed_through = ? AND total_files = ? AND invalidated = 0 AND sealed = 0`,
    )
    .bind(args.githubRepoId, args.runId, run.completed_through, run.total_files)
    .run()
  const after = await readRun(session, args.githubRepoId, args.runId)
  if (after === null || !validRunRow(after)) throw new Error("repo active index run metadata is malformed")
  assertRunUsable(after)
  if (
    after.completed_through !== run.completed_through ||
    after.total_files !== run.total_files ||
    after.sealed !== 1
  ) {
    throw new Error("repo active index run changed while materializing")
  }

  return { snapshot, bookmark: session.getBookmark() ?? run.latest_bookmark }
}

/** Delete at most 100 expired runs; part rows cascade in the same statement. */
export async function sweepExpiredRepoActiveIndexRuns(args: {
  db: D1Database
  nowMs?: number
  limit?: number
}): Promise<number> {
  const nowMs = args.nowMs ?? Date.now()
  const limit = args.limit ?? MAX_SWEEP_ROWS
  if (!validNonNegativeSafeInteger(nowMs) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SWEEP_ROWS) {
    throw new Error("invalid repo active index sweep bounds")
  }
  const result = await args.db
    .prepare(
      `DELETE FROM repo_active_index_run
        WHERE (github_repo_id, run_id) IN (
          SELECT github_repo_id, run_id FROM repo_active_index_run
           WHERE expires_at_ms <= ?
           ORDER BY expires_at_ms, github_repo_id, run_id
           LIMIT ?
        )`,
    )
    .bind(nowMs, limit)
    .run()
  return Number(result.meta.changes ?? 0)
}

/** Exact immutable-repository cleanup; staged part rows cascade. */
export async function deleteRepoActiveIndexByRepoId(args: { db: D1Database; githubRepoId: number }): Promise<number> {
  if (!validPositiveSafeInteger(args.githubRepoId)) throw new Error("invalid GitHub repository id")
  const result = await args.db
    .prepare("DELETE FROM repo_active_index_run WHERE github_repo_id = ?")
    .bind(args.githubRepoId)
    .run()
  return Number(result.meta.changes ?? 0)
}

/** Installation-scoped repository cleanup for delayed removal webhooks. */
export async function deleteRepoActiveIndexByRepoAndInstallation(args: {
  db: D1Database
  githubRepoId: number
  installationId: number
}): Promise<number> {
  if (!validPositiveSafeInteger(args.githubRepoId)) throw new Error("invalid GitHub repository id")
  if (!validPositiveSafeInteger(args.installationId)) throw new Error("invalid installation id")
  const result = await args.db
    .prepare("DELETE FROM repo_active_index_run WHERE github_repo_id = ? AND installation_id = ?")
    .bind(args.githubRepoId, args.installationId)
    .run()
  return Number(result.meta.changes ?? 0)
}

/** Exact installation cleanup for GitHub App uninstall handling. */
export async function deleteRepoActiveIndexByInstallationId(args: {
  db: D1Database
  installationId: number
}): Promise<number> {
  if (!validPositiveSafeInteger(args.installationId)) throw new Error("invalid installation id")
  const result = await args.db
    .prepare("DELETE FROM repo_active_index_run WHERE installation_id = ?")
    .bind(args.installationId)
    .run()
  return Number(result.meta.changes ?? 0)
}

function validateStageArgs(args: StageRepoActiveIndexSliceArgs, nowMs: number): void {
  validateRunIdentity(args)
  if (!validNonNegativeSafeInteger(args.lo) || !validNonNegativeSafeInteger(args.hi)) {
    throw new Error("invalid repo active index slice")
  }
  if (args.lo > args.hi || args.hi > args.totalFiles || (args.lo === args.hi && args.totalFiles !== 0)) {
    throw new Error("invalid repo active index slice")
  }
  if (!validNonNegativeSafeInteger(nowMs)) throw new Error("invalid repo active index timestamp")
  if (args.bookmark !== undefined && args.bookmark !== null && !validBookmark(args.bookmark)) {
    throw new Error("invalid repo active index bookmark")
  }
}

function validateRunIdentity(args: ReadRepoActiveIndexProgressArgs): void {
  if (!validPositiveSafeInteger(args.githubRepoId)) throw new Error("invalid GitHub repository id")
  if (!validPositiveSafeInteger(args.installationId)) throw new Error("invalid installation id")
  if (!RUN_ID.test(args.runId)) throw new Error("invalid repo active index run id")
  if (!validNonNegativeSafeInteger(args.totalFiles)) throw new Error("invalid repo active index file count")
  if (!isBuiltMode(args.mode)) throw new Error("invalid repo active index rollout mode")
}

async function readRun(session: D1DatabaseSession, githubRepoId: number, runId: string): Promise<RunRow | null> {
  return session
    .prepare(`SELECT ${RUN_COLUMNS} FROM repo_active_index_run WHERE github_repo_id = ? AND run_id = ?`)
    .bind(githubRepoId, runId)
    .first<RunRow>()
}

function insertRunStatement(
  session: D1DatabaseSession,
  args: StageRepoActiveIndexSliceArgs,
  expiresAtMs: number,
): D1PreparedStatement {
  return session
    .prepare(
      `INSERT OR IGNORE INTO repo_active_index_run
        (github_repo_id, run_id, installation_id, total_files, completed_through,
         built_mode, latest_bookmark, expires_at_ms)
       VALUES (?, ?, ?, ?, 0, ?, NULL, ?)`,
    )
    .bind(args.githubRepoId, args.runId, args.installationId, args.totalFiles, args.mode, expiresAtMs)
}

function insertSliceStatement(
  session: D1DatabaseSession,
  args: StageRepoActiveIndexSliceArgs,
  partCount: number,
  contentSha256: string,
): D1PreparedStatement {
  return session
    .prepare(
      `INSERT INTO repo_active_index_slice
        (github_repo_id, run_id, slice_lo, slice_hi, part_count, content_sha256)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM repo_active_index_run
           WHERE github_repo_id = ? AND run_id = ? AND installation_id = ?
             AND total_files = ? AND built_mode = ? AND completed_through = ?
             AND invalidated = 0 AND sealed = 0
        )`,
    )
    .bind(
      args.githubRepoId,
      args.runId,
      args.lo,
      args.hi,
      partCount,
      contentSha256,
      args.githubRepoId,
      args.runId,
      args.installationId,
      args.totalFiles,
      args.mode,
      args.lo,
    )
}

function insertPartsStatement(
  session: D1DatabaseSession,
  args: StageRepoActiveIndexSliceArgs,
  parts: readonly string[],
  partOffset: number,
): D1PreparedStatement {
  const valuePlaceholders = parts.map(() => "(?, ?)").join(", ")
  const rowBinds: unknown[] = []
  for (let index = 0; index < parts.length; index += 1) rowBinds.push(partOffset + index, parts[index])
  return session
    .prepare(
      `WITH incoming(part_no, entries_json) AS (VALUES ${valuePlaceholders})
       INSERT INTO repo_active_index_part
         (github_repo_id, run_id, slice_lo, part_no, entries_json)
       SELECT ?, ?, ?, incoming.part_no, incoming.entries_json FROM incoming
        WHERE EXISTS (
          SELECT 1 FROM repo_active_index_run
           WHERE github_repo_id = ? AND run_id = ? AND installation_id = ?
             AND total_files = ? AND built_mode = ? AND completed_through = ?
             AND invalidated = 0 AND sealed = 0
        )
       ON CONFLICT(github_repo_id, run_id, slice_lo, part_no) DO UPDATE SET
         entries_json = CASE
           WHEN repo_active_index_part.entries_json = excluded.entries_json
             THEN repo_active_index_part.entries_json
           ELSE NULL
         END`,
    )
    .bind(
      ...rowBinds,
      args.githubRepoId,
      args.runId,
      args.lo,
      args.githubRepoId,
      args.runId,
      args.installationId,
      args.totalFiles,
      args.mode,
      args.lo,
    )
}

function advanceRunStatement(
  session: D1DatabaseSession,
  args: StageRepoActiveIndexSliceArgs,
  expiresAtMs: number,
): D1PreparedStatement {
  return session
    .prepare(
      `UPDATE repo_active_index_run
          SET completed_through = ?, expires_at_ms = ?
        WHERE github_repo_id = ? AND run_id = ? AND installation_id = ?
          AND total_files = ? AND built_mode = ? AND completed_through = ?
          AND invalidated = 0 AND sealed = 0`,
    )
    .bind(args.hi, expiresAtMs, args.githubRepoId, args.runId, args.installationId, args.totalFiles, args.mode, args.lo)
}

function assertRunMetadata(row: RunRow, args: ReadRepoActiveIndexProgressArgs): void {
  if (
    !validRunRow(row) ||
    row.github_repo_id !== args.githubRepoId ||
    row.run_id !== args.runId ||
    row.installation_id !== args.installationId ||
    row.total_files !== args.totalFiles ||
    row.built_mode !== args.mode
  ) {
    throw new Error("repo active index run metadata mismatch")
  }
}

async function progressResult(
  session: D1DatabaseSession,
  run: RunRow,
  fallbackBookmark?: string | null,
): Promise<RepoActiveIndexStageResult> {
  if (!validRunRow(run)) throw new Error("repo active index run metadata is malformed")
  const count = await session
    .prepare("SELECT COUNT(*) AS count FROM repo_active_index_slice WHERE github_repo_id = ? AND run_id = ?")
    .bind(run.github_repo_id, run.run_id)
    .first<{ count: unknown }>()
  if (!validNonNegativeSafeInteger(count?.count)) throw new Error("repo active index slice count is malformed")
  return {
    completedThrough: run.completed_through,
    shardCount: count.count,
    bookmark: session.getBookmark() ?? run.latest_bookmark ?? fallbackBookmark ?? null,
  }
}

function assertRunUsable(row: RunRow): void {
  if (row.invalidated !== 0) throw new Error("repo active index run is invalidated")
}

async function assertReplayCompatible(
  session: D1DatabaseSession,
  args: StageRepoActiveIndexSliceArgs,
  partCount: number,
  contentSha256: string,
): Promise<void> {
  const slice = await session
    .prepare(
      "SELECT slice_hi, part_count, content_sha256 FROM repo_active_index_slice" +
        " WHERE github_repo_id = ? AND run_id = ? AND slice_lo = ?",
    )
    .bind(args.githubRepoId, args.runId, args.lo)
    .first<SliceRow>()
  if (slice !== null) {
    // Deadline-based slices can end at a different file on redelivery. The
    // first committed boundary owns the run; a stale worker fast-forwards to
    // that high-water. Exact-boundary replays still prove full membership.
    if (slice.slice_hi !== args.hi) return
    if (slice.part_count === partCount && slice.content_sha256 === contentSha256) return
  }
  const invalidated = await session
    .prepare(
      "UPDATE repo_active_index_run SET invalidated = 1" +
        " WHERE github_repo_id = ? AND run_id = ? AND invalidated = 0 AND sealed = 0",
    )
    .bind(args.githubRepoId, args.runId)
    .run()
  if (Number(invalidated.meta.changes ?? 0) === 0) {
    const run = await readRun(session, args.githubRepoId, args.runId)
    if (run !== null && validRunRow(run) && run.invalidated === 0 && run.sealed === 1) {
      throw new RepoActiveIndexSealedReplayMismatchError()
    }
  }
  throw new Error("repo active index slice replay membership mismatch")
}

function validRunRow(row: RunRow): row is RunRow & { built_mode: RepoActiveIndexBuiltMode } {
  return (
    validPositiveSafeInteger(row.github_repo_id) &&
    RUN_ID.test(row.run_id) &&
    validPositiveSafeInteger(row.installation_id) &&
    validNonNegativeSafeInteger(row.total_files) &&
    validNonNegativeSafeInteger(row.completed_through) &&
    row.completed_through <= row.total_files &&
    isBuiltMode(row.built_mode) &&
    (row.latest_bookmark === null || validBookmark(row.latest_bookmark)) &&
    validNonNegativeSafeInteger(row.expires_at_ms) &&
    (row.invalidated === 0 || row.invalidated === 1) &&
    (row.sealed === 0 || row.sealed === 1)
  )
}

async function sliceDigest(lo: number, hi: number, parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(JSON.stringify([lo, hi, parts])))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function encodeParts(value: unknown): string[] {
  const byPath = parseByPath(value)
  if (byPath === null) throw new Error("repo active index slice membership is malformed")
  const parts: string[] = []
  let pending: PartEntry[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    parts.push(JSON.stringify(pending))
    pending = []
  }

  for (const path of Object.keys(byPath).sort()) {
    const entry: PartEntry = [path, [...(byPath[path] ?? [])].sort()]
    const entryJson = JSON.stringify([entry])
    if (byteLength(entryJson) <= MAX_PART_BYTES) {
      const candidate = JSON.stringify([...pending, entry])
      if (byteLength(candidate) > MAX_PART_BYTES) flush()
      pending.push(entry)
      continue
    }

    flush()
    let offset = 0
    while (offset < entry[1].length) {
      let low = offset + 1
      let high = entry[1].length
      let accepted = offset
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = JSON.stringify([[path, entry[1].slice(offset, middle)]])
        if (byteLength(candidate) <= MAX_PART_BYTES) {
          accepted = middle
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      if (accepted === offset) throw new Error("repo active index path exceeds the staged part byte limit")
      parts.push(JSON.stringify([[path, entry[1].slice(offset, accepted)]]))
      offset = accepted
    }
  }
  flush()
  return parts
}

function parsePart(raw: string): PartEntry[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("repo active index staged part is malformed")
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("repo active index staged part is malformed")
  }
  const entries: PartEntry[] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !validPath(entry[0]) || !Array.isArray(entry[1])) {
      throw new Error("repo active index staged part is malformed")
    }
    const parsedIds = parseIds(entry[1])
    if (parsedIds === null) throw new Error("repo active index staged part is malformed")
    entries.push([entry[0], parsedIds])
  }
  return entries
}

function mergePart(
  byPath: Record<string, string[]>,
  seenByPath: Map<string, Set<string>>,
  entries: readonly PartEntry[],
): void {
  for (const [path, ids] of entries) {
    const seen = seenByPath.get(path) ?? new Set<string>()
    const target = byPath[path] ?? []
    for (const id of ids) {
      if (seen.has(id)) throw new Error("repo active index staged parts conflict")
      seen.add(id)
      target.push(id)
    }
    seenByPath.set(path, seen)
    byPath[path] = target
  }
}

function parseByPath(value: unknown): Record<string, string[]> | null {
  if (!isRecord(value)) return null
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== "string")) return null
  const out: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  for (const path of keys as string[]) {
    if (!validPath(path)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, path)
    if (descriptor === undefined || !("value" in descriptor)) return null
    const ids = parseIds(descriptor.value)
    if (ids === null) return null
    out[path] = ids
  }
  return out
}

function parseIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of value) {
    if (typeof id !== "string" || !VECTOR_ID.test(id) || seen.has(id)) return null
    seen.add(id)
    out.push(id)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactDataKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string")) return false
  const actual = new Set(keys as string[])
  return expected.every((key) => {
    if (!actual.has(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor
  })
}

function isBuiltMode(value: unknown): value is RepoActiveIndexBuiltMode {
  return value === "shadow" || value === "on"
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0")
}

function validBookmark(value: string): boolean {
  return value.length >= 1 && value.length <= 4096 && !value.includes("\0")
}

function validPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function validNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validPartCursor(value: PartRow): boolean {
  return (
    validNonNegativeSafeInteger(value.slice_lo) &&
    validNonNegativeSafeInteger(value.part_no) &&
    typeof value.entries_json === "string" &&
    byteLength(value.entries_json) <= MAX_PART_BYTES
  )
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}
