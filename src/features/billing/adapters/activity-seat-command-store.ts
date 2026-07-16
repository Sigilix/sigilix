import type { Env } from "@/src/shared/types/env"

type DbEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

export const ACTIVITY_SEAT_ACTIONS = ["opened", "synchronize", "ready_for_review"] as const
export const ACTIVITY_SEAT_ASSOCIATIONS = ["OWNER", "MEMBER"] as const

export type ActivitySeatAction = (typeof ACTIVITY_SEAT_ACTIONS)[number]
export type ActivitySeatAssociation = (typeof ACTIVITY_SEAT_ASSOCIATIONS)[number]

export interface ActivitySeatEvidence {
  deliveryId: string
  /** SHA-256 of the exact HMAC-verified request body. */
  payloadSha256: string
  installationId: number
  repositoryId: number
  prNumber: number
  headSha: string
  action: ActivitySeatAction
  targetGithubUserId: string
  targetLogin?: string
  actorGithubUserId: string
  actorLogin?: string
  authorAssociation: ActivitySeatAssociation
  receivedAtMs: number
}

interface ActivitySeatCommandRow {
  delivery_id: unknown
  payload_sha256: unknown
  installation_id: unknown
  repository_id: unknown
  pr_number: unknown
  head_sha: unknown
  action: unknown
  target_github_user_id: unknown
  target_login: unknown
  actor_github_user_id: unknown
  actor_login: unknown
  author_association: unknown
  received_at_ms: unknown
  created_at: unknown
}

export type PersistActivitySeatCommandResult =
  | { kind: "created"; evidence: ActivitySeatEvidence }
  | { kind: "existing"; evidence: ActivitySeatEvidence }
  | { kind: "conflict" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }

const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER
const SHA256 = /^[0-9a-f]{64}$/u

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0")
}

function canonicalGithubId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_SAFE_ID && String(parsed) === value
}

function optionalLogin(value: unknown): value is string | undefined {
  return value === undefined || boundedText(value, 256)
}

function validEvidence(value: ActivitySeatEvidence): boolean {
  return (
    boundedText(value.deliveryId, 128) &&
    SHA256.test(value.payloadSha256) &&
    positiveSafeInteger(value.installationId) &&
    positiveSafeInteger(value.repositoryId) &&
    positiveSafeInteger(value.prNumber) &&
    boundedText(value.headSha, 128) &&
    (ACTIVITY_SEAT_ACTIONS as readonly string[]).includes(value.action) &&
    canonicalGithubId(value.targetGithubUserId) &&
    optionalLogin(value.targetLogin) &&
    canonicalGithubId(value.actorGithubUserId) &&
    optionalLogin(value.actorLogin) &&
    (ACTIVITY_SEAT_ASSOCIATIONS as readonly string[]).includes(value.authorAssociation) &&
    nonNegativeSafeInteger(value.receivedAtMs)
  )
}

function decodeRow(row: ActivitySeatCommandRow): ActivitySeatEvidence | null {
  const targetLogin = row.target_login === null ? undefined : row.target_login
  const actorLogin = row.actor_login === null ? undefined : row.actor_login
  const evidence = {
    deliveryId: row.delivery_id,
    payloadSha256: row.payload_sha256,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    action: row.action,
    targetGithubUserId: row.target_github_user_id,
    ...(targetLogin !== undefined ? { targetLogin } : {}),
    actorGithubUserId: row.actor_github_user_id,
    ...(actorLogin !== undefined ? { actorLogin } : {}),
    authorAssociation: row.author_association,
    receivedAtMs: row.received_at_ms,
  } as ActivitySeatEvidence
  if (!boundedText(row.created_at, 64) || !validEvidence(evidence)) return null
  return evidence
}

function sameImmutableEvidence(left: ActivitySeatEvidence, right: ActivitySeatEvidence): boolean {
  return (
    left.payloadSha256 === right.payloadSha256 &&
    left.installationId === right.installationId &&
    left.repositoryId === right.repositoryId &&
    left.prNumber === right.prNumber &&
    left.headSha === right.headSha &&
    left.action === right.action &&
    left.targetGithubUserId === right.targetGithubUserId &&
    left.targetLogin === right.targetLogin &&
    left.actorGithubUserId === right.actorGithubUserId &&
    left.actorLogin === right.actorLogin &&
    left.authorAssociation === right.authorAssociation
  )
}

async function readExistingCommand(
  session: D1DatabaseSession,
  evidence: ActivitySeatEvidence,
): Promise<ActivitySeatCommandRow | null> {
  return session
    .prepare(
      `SELECT delivery_id, payload_sha256, installation_id, repository_id, pr_number, head_sha, action,
              target_github_user_id, target_login, actor_github_user_id, actor_login,
              author_association, received_at_ms, created_at
         FROM org_activity_seat_command
        WHERE delivery_id = ? OR payload_sha256 = ?
        ORDER BY CASE WHEN delivery_id = ? THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .bind(evidence.deliveryId, evidence.payloadSha256, evidence.deliveryId)
    .first<ActivitySeatCommandRow>()
}

function existingResult(row: ActivitySeatCommandRow, evidence: ActivitySeatEvidence): PersistActivitySeatCommandResult {
  const stored = decodeRow(row)
  if (!stored) return { kind: "error", reason: "invalid_row" }
  return sameImmutableEvidence(stored, evidence) ? { kind: "existing", evidence: stored } : { kind: "conflict" }
}

/**
 * Persist one immutable, HMAC-verified GitHub activity event before review
 * dispatch. This is audit evidence only; the consumer must authorize the exact
 * installation/repository pair and readiness epoch before any billing effect.
 */
export async function persistActivitySeatCommand(
  env: DbEnv,
  evidence: ActivitySeatEvidence,
): Promise<PersistActivitySeatCommandResult> {
  if (!validEvidence(evidence)) return { kind: "error", reason: "invalid_input" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }

  try {
    const session = env.SIGILIX_PLATFORM_DB.withSession("first-primary")
    try {
      await session
        .prepare(
          `INSERT INTO org_activity_seat_command
          (delivery_id, payload_sha256, installation_id, repository_id, pr_number, head_sha, action,
           target_github_user_id, target_login, actor_github_user_id, actor_login,
           author_association, received_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          evidence.deliveryId,
          evidence.payloadSha256,
          evidence.installationId,
          evidence.repositoryId,
          evidence.prNumber,
          evidence.headSha,
          evidence.action,
          evidence.targetGithubUserId,
          evidence.targetLogin ?? null,
          evidence.actorGithubUserId,
          evidence.actorLogin ?? null,
          evidence.authorAssociation,
          evidence.receivedAtMs,
        )
        .run()
    } catch {
      const raced = await readExistingCommand(session, evidence)
      return raced ? existingResult(raced, evidence) : { kind: "error", reason: "unavailable" }
    }
    const row = await readExistingCommand(session, evidence)
    if (!row) return { kind: "error", reason: "invalid_row" }
    const stored = decodeRow(row)
    if (!stored) return { kind: "error", reason: "invalid_row" }
    return sameImmutableEvidence(stored, evidence) ? { kind: "created", evidence: stored } : { kind: "conflict" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}
