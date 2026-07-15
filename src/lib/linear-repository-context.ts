import {
  makeGitHubRepositoryContextScopedIdentity,
  parseRepositoryContextScopedMode,
  readRepositoryContextForScopedRepositories,
  type RepositoryContextScopedReadOutcome,
  type RepositoryContextScopedReadResult,
} from "@/src/features/repository-context"
import type { Env } from "@/src/shared/types/env"

export type LinearRepositoryContextSurface = "triage" | "mention"

interface LinearRepositoryContextArgs {
  env: Pick<Env, "SIGILIX_PLATFORM_DB" | "OPENCLAW_REPOSITORY_CONTEXT_LINEAR_MODE">
  surface: LinearRepositoryContextSurface
  installationId: number
  repositories: readonly { repositoryId: number; fullName: string }[]
  enabled: boolean
}

/** Read canonical descriptions for exactly the repositories authorized by a Linear team binding. */
export async function loadLinearRepositoryContext(args: LinearRepositoryContextArgs): Promise<string> {
  const mode = args.enabled ? parseRepositoryContextScopedMode(args.env.OPENCLAW_REPOSITORY_CONTEXT_LINEAR_MODE) : "off"
  const identity = makeGitHubRepositoryContextScopedIdentity(args.installationId, args.repositories)
  let result: RepositoryContextScopedReadResult
  try {
    result = await readRepositoryContextForScopedRepositories({
      ...(args.env.SIGILIX_PLATFORM_DB ? { db: args.env.SIGILIX_PLATFORM_DB } : {}),
      mode,
      identity,
    })
  } catch {
    result = emptyResult("unavailable")
  }
  try {
    console.log(
      JSON.stringify({
        event: "linear-repository-context-read",
        surface: args.surface,
        mode,
        outcome: result.outcome,
        elapsedMs: result.elapsedMs,
        requestedRepositoryCount: args.repositories.length,
        repositoryCount: result.repositoryCount,
        relationshipCount: result.relationshipCount,
        renderedChars: result.renderedChars,
        truncated: result.truncated,
      }),
    )
  } catch {
    // Optional telemetry must never interrupt a Linear request.
  }
  return result.promptBlock
}

function emptyResult(outcome: RepositoryContextScopedReadOutcome): RepositoryContextScopedReadResult {
  return {
    outcome,
    promptBlock: "",
    elapsedMs: 0,
    repositoryCount: 0,
    relationshipCount: 0,
    renderedChars: 0,
    truncated: false,
  }
}
