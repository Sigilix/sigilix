import type { FindingCategory } from "@/src/shared/domain/finding-category"

export type LearningScope = "repo" | "org" | "project"
export type LearningPolarity = "suppress" | "require" | "context"
export type LearningsMode = "off" | "shadow" | "on"

export type LearningSourceKind = "inline-reply" | "top-level" | "qa" | "command"

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
}

export interface LearningStore {
  schemaVersion: 1
  scope: LearningScope
  subjectId: string
  entries: LearningEntry[]
}

export const LEARNINGS_SCHEMA_VERSION = 1 as const
