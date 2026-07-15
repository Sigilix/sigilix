import type { FindingCategory } from "@/src/shared/domain/finding-category"

export type LearningScope = "repo" | "org" | "project"
export type LearningPolarity = "suppress" | "require" | "context"
export type LearningsMode = "off" | "shadow" | "on"

export type LearningSourceKind = "inline-reply" | "top-level" | "qa" | "command" | "chat" | "portal"

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

/**
 * Execution-/tool-verification evidence class captured for a learning at write
 * time (SIG-600). Mirrors the deterministic-evidence vocabulary the suppress
 * gate reads (see `suppress.ts`): AST matches, CWE ids, scanner evidence-ids
 * (`secret:`/`depvuln:`/`sarif:`), test/coverage refs, and specialist provenance.
 * `none` = no runnable check backed it (a plain human decision).
 */
export type LearningEvidenceKind = "ast" | "cwe" | "sarif" | "secret" | "depvuln" | "test" | "specialist" | "none"

export const LEARNING_EVIDENCE_KINDS: ReadonlySet<LearningEvidenceKind> = new Set<LearningEvidenceKind>([
  "ast",
  "cwe",
  "sarif",
  "secret",
  "depvuln",
  "test",
  "specialist",
  "none",
])

/**
 * Whether a learning was execution-/tool-verified at capture time (SIG-600):
 *   - `verified`   — backed by deterministic evidence when written.
 *   - `unverified` — a human decision (dismissal, routing, convention) with
 *                    nothing runnable to check.
 *   - `unknown`    — back-compat default for records persisted before this field.
 */
export type LearningVerificationStatus = "verified" | "unverified" | "unknown"

export const LEARNING_VERIFICATION_STATUSES: ReadonlySet<LearningVerificationStatus> =
  new Set<LearningVerificationStatus>(["verified", "unverified", "unknown"])

/**
 * Verification provenance for a learning (SIG-600). SHADOW-SAFE: this slice only
 * defines + persists the shape; capture wiring (PR2), retrieval/trust-weighting,
 * and training-label export (later slices) do not read it yet.
 */
export interface LearningVerification {
  status: LearningVerificationStatus
  /** Evidence classes that grounded it — empty (or `["none"]`) when unverified. */
  evidence: LearningEvidenceKind[]
  /** Source finding/evidence ids that carried the evidence (attribution). */
  sourceFindingIds?: string[]
}

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
  /**
   * Execution-/tool-verification provenance captured at write time (SIG-600).
   * OPTIONAL for backward compatibility: records persisted before this field
   * existed load without it (treat as `unknown`).
   */
  verification?: LearningVerification
}

export interface LearningStore {
  schemaVersion: 1
  scope: LearningScope
  subjectId: string
  entries: LearningEntry[]
}

export const LEARNINGS_SCHEMA_VERSION = 1 as const
