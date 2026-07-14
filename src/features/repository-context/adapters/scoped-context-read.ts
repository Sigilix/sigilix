import {
  REPOSITORY_CONTEXT_SCOPED_FORMAT,
  renderRepositoryContextForScopedRepositories,
  type RepositoryContextScopedIdentity,
  type RepositoryContextScopedMode,
} from "@/src/features/repository-context/domain/scoped-context"
import type { RepositoryContextReadResult } from "@/src/features/repository-context/domain/types"
import { readRepositoryContext } from "./d1-store"

const REPOSITORY_CONTEXT_READ_TIMEOUT_MS = 500
const TIMED_OUT = Symbol("repository-context-scoped-read-timeout")

export type RepositoryContextScopedReadOutcome =
  | "off"
  | "missing_identity"
  | "invalid_identity"
  | "unsupported_provider"
  | "timeout"
  | "unavailable"
  | "not_found"
  | "empty"
  | "tombstoned"
  | "scoped_repositories_missing"
  | "shadow"
  | "on"

export interface RepositoryContextScopedReadResult {
  outcome: RepositoryContextScopedReadOutcome
  promptBlock: string
  elapsedMs: number
  repositoryCount: number
  relationshipCount: number
  renderedChars: number
  truncated: boolean
}

export async function readRepositoryContextForScopedRepositories(args: {
  db?: D1Database
  mode: RepositoryContextScopedMode
  identity?: RepositoryContextScopedIdentity | null
}): Promise<RepositoryContextScopedReadResult> {
  const startedAt = safeNow()
  const mode: RepositoryContextScopedMode = args.mode === "shadow" || args.mode === "on" ? args.mode : "off"
  try {
    if (mode === "off") return finish(mode, startedAt, "off")
    if (!args.identity) return finish(mode, startedAt, "missing_identity")
    if (args.identity.provider !== "github") return finish(mode, startedAt, "unsupported_provider")
    if (!validIdentity(args.identity)) return finish(mode, startedAt, "invalid_identity")
    if (!args.db) return finish(mode, startedAt, "unavailable")

    const read = await readWithTimeout(args.db, args.identity)
    if (read === TIMED_OUT) return finish(mode, startedAt, "timeout")
    if (read.status === "unavailable") return finish(mode, startedAt, "unavailable")
    if (read.status === "not_found") return finish(mode, startedAt, "not_found")

    const rendered = renderRepositoryContextForScopedRepositories(read.snapshot, args.identity.repositories)
    if (rendered.status !== "rendered") return finish(mode, startedAt, rendered.status)

    return finish(mode, startedAt, mode, {
      promptBlock: mode === "on" ? rendered.promptBlock : "",
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
  identity: RepositoryContextScopedIdentity,
): Promise<RepositoryContextReadResult | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), REPOSITORY_CONTEXT_READ_TIMEOUT_MS)
  })
  try {
    return await Promise.race([readRepositoryContext(db, "github", identity.scopeId), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function finish(
  mode: RepositoryContextScopedMode,
  startedAt: number,
  outcome: RepositoryContextScopedReadOutcome,
  values: Partial<
    Pick<
      RepositoryContextScopedReadResult,
      "promptBlock" | "repositoryCount" | "relationshipCount" | "renderedChars" | "truncated"
    >
  > = {},
): RepositoryContextScopedReadResult {
  const result: RepositoryContextScopedReadResult = {
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
        event: "repository-context-scoped-read",
        mode,
        rendererVersion: REPOSITORY_CONTEXT_SCOPED_FORMAT,
        outcome: result.outcome,
        elapsedMs: result.elapsedMs,
        repositoryCount: result.repositoryCount,
        relationshipCount: result.relationshipCount,
        renderedChars: result.renderedChars,
        truncated: result.truncated,
      }),
    )
  } catch {
    // Optional context telemetry must never interrupt a Slack reply.
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

function validIdentity(identity: RepositoryContextScopedIdentity): boolean {
  if (!validPositiveDecimal(identity.scopeId) || identity.repositories.length === 0) return false
  const seen = new Set<string>()
  for (const repository of identity.repositories) {
    if (
      !validPositiveDecimal(repository.externalId) ||
      !validFullName(repository.fullName) ||
      seen.has(repository.externalId)
    ) {
      return false
    }
    seen.add(repository.externalId)
  }
  return true
}

function validPositiveDecimal(value: string): boolean {
  if (!/^[1-9]\d*$/u.test(value)) return false
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value
}

function validFullName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)
  )
}
