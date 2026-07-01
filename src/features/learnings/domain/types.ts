import type { FindingCategory } from "@/src/shared/domain/finding-category"

export type LearningScope = "repo" | "org" | "project"
export type LearningPolarity = "suppress" | "require" | "context"
export type LearningsMode = "off" | "shadow" | "on"

export type LearningSourceKind = "inline-reply" | "top-level" | "qa" | "command"

/**
 * The 4-tier memory taxonomy (Phase-1a of the memory-moat / dynamic-memory arc).
 * A learning is classified into exactly one type at write time:
 *   - `durable_preference`  — a lasting convention/preference (a `@sigilix remember`
 *                             command, or a preference-style rule). Never expires.
 *   - `architectural_fact`  — a factual statement about the codebase structure
 *                             ("X lives in Y", "we use Z"). Never expires.
 *   - `ephemeral_project`   — task/project state tied to an open PR or branch.
 *   - `transient_feedback`  — a one-off review dismissal/correction tied to a PR.
 * SHADOW-SAFE: this slice only classifies + records the type; retrieval, retention,
 * eviction, and decay do not read it yet (later slices).
 */
export type LearningMemoryType =
  | "durable_preference"
  | "architectural_fact"
  | "ephemeral_project"
  | "transient_feedback"

export const LEARNING_MEMORY_TYPES: ReadonlySet<LearningMemoryType> = new Set<LearningMemoryType>([
  "durable_preference",
  "architectural_fact",
  "ephemeral_project",
  "transient_feedback",
])

/**
 * What a learning's lifespan is tied to. `durable` never expires; `pr`/`branch`
 * bind the memory to a transient thing a later Gardener slice can reap once it closes.
 */
export type LearningLifespanAnchor =
  | { kind: "durable" }
  | { kind: "pr"; prNumber: number }
  | { kind: "branch"; name: string }

export interface LearningSource {
  kind: LearningSourceKind
  prNumber?: number
  commentId?: number
}

export interface LearningEntry {
  id: string
  rule: string
  polarity: LearningPolarity
  category?: FindingCategory | null
  pathGlob?: string | null
  scope: LearningScope
  subjectId: string
  source: LearningSource
  createdTs: string
  lastAppliedTs?: string
  appliedCount: number
  authorLogin?: string
  /**
   * The 4-tier memory taxonomy classification (write-time). OPTIONAL for backward
   * compatibility: records persisted before this field existed load without it.
   */
  type?: LearningMemoryType
  /** What this memory's lifespan is anchored to. OPTIONAL for backward compatibility. */
  lifespanAnchor?: LearningLifespanAnchor
}

export interface LearningStore {
  schemaVersion: 1
  scope: LearningScope
  subjectId: string
  entries: LearningEntry[]
}

export const LEARNINGS_SCHEMA_VERSION = 1 as const
