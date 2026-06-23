// Agent-memory store — types.
//
// The local CLI agent (running on a developer's machine) persists durable
// per-(user, repo) memories — decisions it made, the user's preferences, dead
// ends it hit, corrections it received, and task state — and later retrieves the
// semantically-relevant ones to ground a fresh turn. The store is the agent's
// long-term memory across sessions, scoped per tenant so one user/repo can never
// read another's.
//
// Pure types module (mirrors review-memory/types.ts). The only runtime export is
// the literal-union array for membership testing. `schemaVersion: 1` keeps schema
// changes value-driven (no re-keying), matching the review-memory record contract.

/**
 * What a memory IS — a small enum-bounded vocabulary so retrieval + future
 * surfacing can reason about the KIND of a memory, not just its text:
 *  - "decision"   — a choice the agent made and should stay consistent with.
 *  - "preference" — a durable user preference ("always use tabs", "no comments").
 *  - "dead_end"   — an approach that failed, so the agent doesn't retry it.
 *  - "correction" — a fix the user applied to the agent's output.
 *  - "task_state" — where a multi-step task was left off.
 */
export type AgentMemoryKind = "decision" | "preference" | "dead_end" | "correction" | "task_state"

export const ALL_AGENT_MEMORY_KINDS: readonly AgentMemoryKind[] = [
  "decision",
  "preference",
  "dead_end",
  "correction",
  "task_state",
]

/**
 * KV record shape. Stored at `agent-memory:<userId>:<repoId>:<id>` (the record)
 * with a parallel content-hash key `agent-memory-hash:<userId>:<repoId>:<hash>`
 * pointing at the id for exact-duplicate dedup.
 *
 * `schemaVersion: 1` enables value-driven schema migration without re-keying
 * (matching ReviewMemoryRecord §4.4).
 */
export interface AgentMemoryRecord {
  schemaVersion: 1
  /** Generated id, `mem_` + crypto.randomUUID(). */
  id: string
  /** Tenant scope — the owning user (opaque caller-supplied id). */
  userId: string
  /** Tenant scope — the owning repo (opaque caller-supplied id). */
  repoId: string
  kind: AgentMemoryKind
  /** The memory text. Embedded for semantic retrieval; capped at embed time. */
  content: string
  /** ISO-8601 UTC; stamped at write time. */
  ts: string
  /** SHA-256 hex of `content` — the dedup key (also the Vectorize vector id). */
  hash: string
}

/** One retrieved memory returned by the query route. */
export interface AgentMemoryQueryResult {
  id: string
  kind: AgentMemoryKind
  content: string
  ts: string
  /** Cosine similarity from Vectorize (0..1). */
  score: number
}
