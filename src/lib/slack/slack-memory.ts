// SIG-196: Slack memory adapter — scoped recall + credential-gated capture over
// the SIG-522 agent-memory store (Vectorize+KV).
//
// Scope keying: userId = "slack:<teamId>" (canonicalized), repoId = the scope's
// primary repo (canonicalized). The repoId namespace is the privacy boundary —
// two Slack channels mapped to different repos cannot see each other's memory;
// two channels on the same repo share repo-level knowledge (intended).
//
// NOTE: this adapter writes to the SAME Vectorize+KV store as the GitHub/CLI
// agent memory, but in a Slack-scoped namespace. True cross-surface identity
// unification (mapping Slack user → GitHub user) is deferred.

import { canonicalTenantId, storeMemoryFact } from "@/src/lib/agent-memory/agent-memory-route"
import { queryMemoryIds } from "@/src/lib/agent-memory/retrieval"
import { readRecord } from "@/src/lib/agent-memory/storage"
import type { AgentMemoryKind } from "@/src/lib/agent-memory/types"
import { containsCredentialToken } from "@/src/lib/secret-scan"
import type { Env } from "@/src/shared/types/env"

export interface SlackMemoryScope {
  /** Slack workspace identifier (from event payload `team_id`). */
  teamId: string
  /** Primary repo for this channel scope in `owner/repo` form. */
  repoId: string
}

// ─── Scope canonicalization ──────────────────────────────────

/**
 * Derive the canonical (userId, repoId) tenant pair for a Slack scope.
 * Both ids are trimmed + lowercased so KV keys and Vectorize namespaces
 * derived from store OR query always agree.
 */
function slackScopeIds(scope: SlackMemoryScope): { userId: string; repoId: string } {
  return {
    userId: canonicalTenantId("slack:" + scope.teamId),
    repoId: canonicalTenantId(scope.repoId),
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Retrieve the semantically-nearest agent memories for a Slack workspace+repo
 * scope. Returns content strings in Vectorize hit order (highest similarity
 * first). Soft-fails to `[]` on any error — retrieval is grounding, not
 * gating, so an error must never block the caller.
 */
export async function recallSlackMemory(
  env: Env,
  scope: SlackMemoryScope,
  query: string,
  topK?: number,
): Promise<string[]> {
  try {
    const { userId, repoId } = slackScopeIds(scope)
    const hits = await queryMemoryIds(env, { userId, repoId, query, topK: topK ?? 5 })
    const records = await Promise.all(hits.map((hit) => readRecord(env, userId, repoId, hit.id)))
    const contents = records.filter((rec) => rec !== null).map((rec) => rec.content)
    return contents
  } catch {
    return []
  }
}

/**
 * Capture a new memory fact for a Slack workspace+repo scope.
 *
 * - If `content` contains a credential token (AWS key, GitHub PAT, Stripe
 *   secret, etc.) the write is SUPPRESSED — `skippedSecret: true`, no store
 *   call. This prevents accidental credential persistence from chat messages.
 * - Otherwise the fact is written via `storeMemoryFact` (dedup, KV, Vectorize).
 *   `stored` mirrors the KV write-success flag. Soft-fails to `stored: false`
 *   on any error from the store path.
 */
export async function captureSlackMemory(
  env: Env,
  scope: SlackMemoryScope,
  args: { kind: AgentMemoryKind; content: string },
): Promise<{ stored: boolean; skippedSecret: boolean }> {
  if (containsCredentialToken(args.content)) {
    return { stored: false, skippedSecret: true }
  }
  try {
    const { userId, repoId } = slackScopeIds(scope)
    const result = await storeMemoryFact(env, { userId, repoId, kind: args.kind, content: args.content })
    return { stored: result.stored, skippedSecret: false }
  } catch {
    return { stored: false, skippedSecret: false }
  }
}
