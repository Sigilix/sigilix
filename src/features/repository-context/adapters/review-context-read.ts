import {
  makeGitLabRepositoryContextReviewIdentity,
  REPOSITORY_CONTEXT_REVIEW_FORMAT,
  renderRepositoryContextForReview,
  type RepositoryContextReviewIdentity,
  type RepositoryContextReviewMode,
} from "@/src/features/repository-context/domain/review-context"
import type { RepositoryContextReadResult } from "@/src/features/repository-context/domain/types"
import { readRepositoryContext } from "./d1-store"
import { verifyActiveGitLabRepositoryAuthorityGeneration } from "./authority-store"

const REPOSITORY_CONTEXT_READ_TIMEOUT_MS = 500
const TIMED_OUT = Symbol("repository-context-read-timeout")

export type RepositoryContextReviewReadOutcome =
  | "off"
  | "missing_identity"
  | "invalid_identity"
  | "unsupported_provider"
  | "unavailable"
  | "not_found"
  | "empty"
  | "tombstoned"
  | "current_repository_missing"
  | "authority_inactive"
  | "shadow"
  | "post"

export interface RepositoryContextReviewReadResult {
  outcome: RepositoryContextReviewReadOutcome
  promptBlock: string
  elapsedMs: number
  repositoryCount: number
  relationshipCount: number
  renderedChars: number
  truncated: boolean
}

export async function readRepositoryContextForReview(args: {
  db?: D1Database
  mode: RepositoryContextReviewMode
  identity?: RepositoryContextReviewIdentity | null
}): Promise<RepositoryContextReviewReadResult> {
  const startedAt = safeNow()
  const mode: RepositoryContextReviewMode = args.mode === "shadow" || args.mode === "post" ? args.mode : "off"
  try {
    if (mode === "off") return finish(mode, startedAt, "off")
    if (!args.identity) return finish(mode, startedAt, "missing_identity")
    if (args.identity.provider !== "github" && args.identity.provider !== "gitlab") {
      return finish(mode, startedAt, "unsupported_provider")
    }
    if (!validIdentity(args.identity)) {
      return finish(mode, startedAt, "invalid_identity")
    }
    if (!args.db) return finish(mode, startedAt, "unavailable")

    const read = await readWithTimeout(args.db, args.identity)
    if (read === TIMED_OUT || read.status === "unavailable") return finish(mode, startedAt, "unavailable")
    if (read.status === "authority_inactive") return finish(mode, startedAt, "authority_inactive")
    if (read.status === "not_found") return finish(mode, startedAt, "not_found")

    const rendered = renderRepositoryContextForReview(read.snapshot, args.identity.repositoryExternalId)
    if (rendered.status !== "rendered") return finish(mode, startedAt, rendered.status)

    return finish(mode, startedAt, mode, {
      promptBlock: mode === "post" ? rendered.promptBlock : "",
      repositoryCount: rendered.repositoryCount,
      relationshipCount: rendered.relationshipCount,
      renderedChars: rendered.promptBlock.length,
      truncated: rendered.truncated,
    })
  } catch {
    return finish(mode, startedAt, "unavailable")
  }
}

async function readWithTimeout(
  db: D1Database,
  identity: RepositoryContextReviewIdentity,
): Promise<AuthorizedRepositoryContextReadResult | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), REPOSITORY_CONTEXT_READ_TIMEOUT_MS)
  })
  try {
    return await Promise.race([readAuthorizedRepositoryContext(db, identity), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type AuthorizedRepositoryContextReadResult = RepositoryContextReadResult | { status: "authority_inactive" }

async function readAuthorizedRepositoryContext(
  db: D1Database,
  identity: RepositoryContextReviewIdentity,
): Promise<AuthorizedRepositoryContextReadResult> {
  if (identity.provider === "github") return readRepositoryContext(db, "github", identity.scopeId)

  const generation = {
    scopeId: identity.scopeId,
    externalId: identity.repositoryExternalId,
    claimToken: identity.authorityClaimToken,
  }
  const before = await verifyActiveGitLabRepositoryAuthorityGeneration(db, generation)
  if (before.status === "unavailable") return { status: "unavailable" }
  if (before.status !== "active") return { status: "authority_inactive" }

  const read = await readRepositoryContext(db, "gitlab", identity.scopeId)
  const after = await verifyActiveGitLabRepositoryAuthorityGeneration(db, generation)
  if (after.status === "unavailable") return { status: "unavailable" }
  if (after.status !== "active") return { status: "authority_inactive" }
  return read
}

function finish(
  mode: RepositoryContextReviewMode,
  startedAt: number,
  outcome: RepositoryContextReviewReadOutcome,
  values: Partial<
    Pick<
      RepositoryContextReviewReadResult,
      "promptBlock" | "repositoryCount" | "relationshipCount" | "renderedChars" | "truncated"
    >
  > = {},
): RepositoryContextReviewReadResult {
  const result: RepositoryContextReviewReadResult = {
    outcome,
    promptBlock: values.promptBlock ?? "",
    elapsedMs: Math.max(0, safeNow() - startedAt),
    repositoryCount: values.repositoryCount ?? 0,
    relationshipCount: values.relationshipCount ?? 0,
    renderedChars: values.renderedChars ?? 0,
    truncated: values.truncated ?? false,
  }
  try {
    console.log(
      JSON.stringify({
        event: "repository-context-review-read",
        mode,
        rendererVersion: REPOSITORY_CONTEXT_REVIEW_FORMAT,
        outcome: result.outcome,
        elapsedMs: result.elapsedMs,
        repositoryCount: result.repositoryCount,
        relationshipCount: result.relationshipCount,
        renderedChars: result.renderedChars,
        truncated: result.truncated,
      }),
    )
  } catch {
    // Repository-context telemetry must never interrupt the review path.
  }
  return result
}

function safeNow(): number {
  try {
    return Date.now()
  } catch {
    return 0
  }
}

function validPositiveDecimal(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}

function validIdentity(identity: RepositoryContextReviewIdentity): boolean {
  if (identity.provider === "github") {
    return validPositiveDecimal(identity.scopeId) && validPositiveDecimal(identity.repositoryExternalId)
  }
  return (
    makeGitLabRepositoryContextReviewIdentity(
      identity.scopeId,
      identity.repositoryExternalId,
      identity.authorityClaimToken,
    ) !== null
  )
}
