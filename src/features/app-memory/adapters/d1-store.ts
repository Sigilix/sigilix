import {
  MAX_APP_MEMORIES_PER_SCOPE,
  MAX_APP_MEMORY_CONTENT_LENGTH,
  resolveManagedAppId,
  type AppMemory,
  type AppMemoryScope,
  type ManagedAppId,
} from "@/src/features/app-memory/domain/types"
import type { Env } from "@/src/shared/types/env"

interface AppMemoryRow {
  id: string
  installation_id: number
  scope: string
  owner_user_id: string
  app_id: string
  content: string
  created_at_ms: number
}

export interface AppMemoryCursor {
  createdAtMs: number
  id: string
}

export type AppMemoryCreateResult =
  | { status: "ok"; memory: AppMemory; deduped: boolean }
  | { status: "limit_reached" }
  | { status: "unavailable" }

export type AppMemoryListResult =
  | { status: "ok"; memories: AppMemory[]; nextCursor: AppMemoryCursor | null }
  | { status: "unavailable" }

export type AppMemoryDeleteResult = { status: "deleted" | "not_found" | "unavailable" }

interface CreateAppMemoryArgs {
  installationId: number
  scope: AppMemoryScope
  ownerUserId: string
  appId: ManagedAppId
  content: string
  nowMs: number
}

interface ListAppMemoriesArgs {
  installationId: number
  callerUserId: string
  appId: ManagedAppId
  limit: number
  cursor: AppMemoryCursor | null
}

interface DeleteAppMemoryArgs {
  installationId: number
  callerUserId: string
  appId: ManagedAppId
  memoryId: string
  canManageOrganization: boolean
}

const SELECT_COLUMNS = `id, installation_id, scope, owner_user_id, app_id, content, created_at_ms`

export async function createAppMemory(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: CreateAppMemoryArgs,
): Promise<AppMemoryCreateResult> {
  if (!env.SIGILIX_PLATFORM_DB || !validCreateArgs(args)) return { status: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  const ownerUserId = args.scope === "personal" ? args.ownerUserId : ""
  const contentHash = await sha256Hex(args.content)

  try {
    // D1/SQLite executes this COUNT gate and INSERT as one atomic statement.
    // Concurrent writers are serialized at the database primary, so the cap
    // cannot be crossed by two requests that both observed the same count.
    const result = await db
      .prepare(
        `INSERT INTO app_memory
          (id, installation_id, scope, owner_user_id, app_id, content, content_hash,
           created_at_ms)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE (
            SELECT COUNT(*) FROM app_memory
             WHERE installation_id = ? AND scope = ? AND owner_user_id = ? AND app_id = ?
          ) < ?
         ON CONFLICT (installation_id, scope, owner_user_id, app_id, content_hash) DO NOTHING`,
      )
      .bind(
        `appmem_${crypto.randomUUID()}`,
        args.installationId,
        args.scope,
        ownerUserId,
        args.appId,
        args.content,
        contentHash,
        args.nowMs,
        args.installationId,
        args.scope,
        ownerUserId,
        args.appId,
        MAX_APP_MEMORIES_PER_SCOPE,
      )
      .run()

    const row = await db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM app_memory
          WHERE installation_id = ? AND scope = ? AND owner_user_id = ?
            AND app_id = ? AND content_hash = ?`,
      )
      .bind(args.installationId, args.scope, ownerUserId, args.appId, contentHash)
      .first<AppMemoryRow>()
    const memory = row ? mapRow(row) : null
    if (memory) return { status: "ok", memory, deduped: (result.meta.changes ?? 0) === 0 }
    return { status: "limit_reached" }
  } catch (error) {
    logStoreFailure("app-memory-create-failed", error, args.installationId, args.appId)
    return { status: "unavailable" }
  }
}

export async function listAppMemories(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: ListAppMemoriesArgs,
): Promise<AppMemoryListResult> {
  if (!env.SIGILIX_PLATFORM_DB || !validListArgs(args)) return { status: "unavailable" }
  try {
    const cursorClause = args.cursor ? " AND (created_at_ms < ? OR (created_at_ms = ? AND id < ?))" : ""
    const bindings: unknown[] = [args.installationId, args.appId, args.callerUserId]
    if (args.cursor) bindings.push(args.cursor.createdAtMs, args.cursor.createdAtMs, args.cursor.id)
    bindings.push(args.limit + 1)
    const result = await env.SIGILIX_PLATFORM_DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM app_memory
        WHERE installation_id = ? AND app_id = ?
          AND (scope = 'organization' OR (scope = 'personal' AND owner_user_id = ?))
          ${cursorClause}
        ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
    )
      .bind(...bindings)
      .all<AppMemoryRow>()

    const mapped = result.results.map(mapRow)
    if (mapped.some((memory) => memory === null)) return { status: "unavailable" }
    const memories = mapped.filter((memory): memory is AppMemory => memory !== null)
    const hasMore = memories.length > args.limit
    const page = memories.slice(0, args.limit)
    const last = page[page.length - 1]
    return {
      status: "ok",
      memories: page,
      nextCursor: hasMore && last ? { createdAtMs: last.createdAtMs, id: last.id } : null,
    }
  } catch (error) {
    logStoreFailure("app-memory-list-failed", error, args.installationId, args.appId)
    return { status: "unavailable" }
  }
}

export async function deleteAppMemory(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: DeleteAppMemoryArgs,
): Promise<AppMemoryDeleteResult> {
  if (!env.SIGILIX_PLATFORM_DB || !validDeleteArgs(args)) return { status: "unavailable" }
  try {
    const result = await env.SIGILIX_PLATFORM_DB.prepare(
      `DELETE FROM app_memory
        WHERE id = ? AND installation_id = ? AND app_id = ?
          AND (
            (scope = 'personal' AND owner_user_id = ?)
            OR (scope = 'organization' AND ? = 1)
          )`,
    )
      .bind(args.memoryId, args.installationId, args.appId, args.callerUserId, args.canManageOrganization ? 1 : 0)
      .run()
    return { status: (result.meta.changes ?? 0) === 1 ? "deleted" : "not_found" }
  } catch (error) {
    logStoreFailure("app-memory-delete-failed", error, args.installationId, args.appId)
    return { status: "unavailable" }
  }
}

function mapRow(row: AppMemoryRow): AppMemory | null {
  const scope = row.scope === "personal" || row.scope === "organization" ? row.scope : null
  const appId = resolveManagedAppId(row.app_id)
  if (
    !Number.isSafeInteger(row.installation_id) ||
    row.installation_id <= 0 ||
    !scope ||
    !appId ||
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    typeof row.owner_user_id !== "string" ||
    (scope === "personal" ? row.owner_user_id.length === 0 : row.owner_user_id !== "") ||
    typeof row.content !== "string" ||
    row.content.length === 0 ||
    !Number.isSafeInteger(row.created_at_ms) ||
    row.created_at_ms < 0
  ) {
    return null
  }
  return {
    id: row.id,
    installationId: row.installation_id,
    scope,
    ownerUserId: row.owner_user_id,
    appId,
    content: row.content,
    createdAtMs: row.created_at_ms,
  }
}

function validCreateArgs(args: CreateAppMemoryArgs): boolean {
  return (
    validInstallationId(args.installationId) &&
    resolveManagedAppId(args.appId) !== null &&
    args.ownerUserId.length > 0 &&
    args.content.length > 0 &&
    args.content.length <= MAX_APP_MEMORY_CONTENT_LENGTH &&
    Number.isSafeInteger(args.nowMs) &&
    args.nowMs >= 0
  )
}

function validListArgs(args: ListAppMemoriesArgs): boolean {
  return (
    validInstallationId(args.installationId) &&
    resolveManagedAppId(args.appId) !== null &&
    args.callerUserId.length > 0 &&
    Number.isSafeInteger(args.limit) &&
    args.limit > 0 &&
    args.limit <= 100 &&
    (args.cursor === null ||
      (Number.isSafeInteger(args.cursor.createdAtMs) && args.cursor.createdAtMs >= 0 && args.cursor.id.length > 0))
  )
}

function validDeleteArgs(args: DeleteAppMemoryArgs): boolean {
  return (
    validInstallationId(args.installationId) &&
    resolveManagedAppId(args.appId) !== null &&
    args.callerUserId.length > 0 &&
    args.memoryId.length > 0
  )
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function logStoreFailure(event: string, error: unknown, installationId: number, appId: string): void {
  console.error(
    JSON.stringify({
      event,
      installationId,
      appId,
      err: error instanceof Error ? error.message : String(error),
    }),
  )
}
