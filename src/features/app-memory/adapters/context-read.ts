import {
  MAX_APP_MEMORY_CONTEXT_CANDIDATES_PER_SCOPE,
  selectAppMemoryContext,
  type AppMemoryContextCandidate,
  type AppMemoryContextSelection,
} from "@/src/features/app-memory/domain/context"
import { MAX_APP_MEMORY_CONTENT_LENGTH } from "@/src/features/app-memory/domain/types"
import type { Env } from "@/src/shared/types/env"

interface ContextRow {
  id: string
  content: string
  created_at_ms: number
}

export type AppMemoryContextReadResult =
  | { status: "ok"; selection: AppMemoryContextSelection }
  | { status: "unavailable" }

/**
 * Internal CLI context read. Organization and personal rows use independent
 * fixed queries and candidate caps, so activity in one scope cannot starve the
 * other. Any D1 or row-shape failure is fail-soft at the route boundary.
 */
export async function readCliAppMemoryContext(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: { installationId: number; personalUserId: string | null },
): Promise<AppMemoryContextReadResult> {
  if (!env.SIGILIX_PLATFORM_DB || !validInstallationId(args.installationId)) return { status: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB

  try {
    const organizationQuery = readScope(db, {
      installationId: args.installationId,
      scope: "organization",
      ownerUserId: "",
    })
    const personalQuery = args.personalUserId
      ? readScope(db, {
          installationId: args.installationId,
          scope: "personal",
          ownerUserId: args.personalUserId,
        })
      : Promise.resolve<AppMemoryContextCandidate[]>([])
    const [organization, personal] = await Promise.all([organizationQuery, personalQuery])
    return { status: "ok", selection: selectAppMemoryContext({ personal, organization }) }
  } catch {
    // The route emits bounded availability/count/char telemetry. Do not log a
    // D1 error string here: a driver message can echo bound identity/content.
    return { status: "unavailable" }
  }
}

async function readScope(
  db: D1Database,
  args: { installationId: number; scope: "personal" | "organization"; ownerUserId: string },
): Promise<AppMemoryContextCandidate[]> {
  const result = await db
    .prepare(
      `SELECT id, content, created_at_ms FROM app_memory
        WHERE installation_id = ? AND app_id = 'cli' AND scope = ? AND owner_user_id = ?
        ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
    )
    .bind(args.installationId, args.scope, args.ownerUserId, MAX_APP_MEMORY_CONTEXT_CANDIDATES_PER_SCOPE)
    .all<ContextRow>()
  const rows = result.results ?? []
  const candidates = rows.map(mapCandidate)
  if (candidates.some((candidate) => candidate === null)) throw new Error("invalid app-memory context row")
  return candidates.filter((candidate): candidate is AppMemoryContextCandidate => candidate !== null)
}

function mapCandidate(row: ContextRow): AppMemoryContextCandidate | null {
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    typeof row.content !== "string" ||
    row.content.length === 0 ||
    row.content.length > MAX_APP_MEMORY_CONTENT_LENGTH ||
    !Number.isSafeInteger(row.created_at_ms) ||
    row.created_at_ms < 0
  ) {
    return null
  }
  return { id: row.id, content: row.content, createdAtMs: row.created_at_ms }
}

function validInstallationId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
