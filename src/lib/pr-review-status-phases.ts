import { ALL_SPECIALISTS, type SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { GraphContextNode } from "@/src/shared/domain/graph-context"
import type { ReviewStatusUpdate } from "./pr-review-status-reporter"
import type { ReviewStatusFinal } from "./pr-review-status-render"

export function retrievalStatusUpdate(): ReviewStatusUpdate {
  return {
    phase: "retrieval",
    specialists: {
      total: ALL_SPECIALISTS.length,
      completed: 0,
      dispatched: ALL_SPECIALISTS,
    },
  }
}

export function skippedStatusUpdate(args: {
  findingsCount?: number
  notNeeded?: readonly SpecialistRole[]
}): ReviewStatusUpdate {
  return {
    phase: "skipped",
    specialists: {
      total: 0,
      completed: 0,
      notNeeded: args.notNeeded ?? ALL_SPECIALISTS,
    },
    final: {
      status: "skipped",
      findingsCount: args.findingsCount ?? 0,
    },
  }
}

export function specialistsStatusUpdate(args: {
  dispatched: readonly SpecialistRole[]
  droppedFiles: readonly string[]
  graphNodes: readonly GraphContextNode[]
  totalFiles: number
  graphMode: "available" | "none"
}): ReviewStatusUpdate {
  return {
    phase: "specialists",
    specialists: {
      total: args.dispatched.length,
      completed: 0,
      dispatched: args.dispatched,
      notNeeded: notNeededRoles(args.dispatched),
    },
    droppedFiles: args.droppedFiles,
    graphCoverage: {
      mode: args.graphMode,
      filesWithContext: new Set(args.graphNodes.map((n) => n.path)).size,
      totalFiles: args.totalFiles,
      nodes: args.graphNodes.length,
    },
  }
}

export function synthStatusUpdate(args: {
  dispatched: readonly SpecialistRole[]
  succeeded: readonly SpecialistRole[]
  missing: readonly SpecialistRole[]
  droppedFiles: readonly string[]
  graphNodes: readonly GraphContextNode[]
  totalFiles: number
  graphMode: "available" | "none"
}): ReviewStatusUpdate {
  return {
    phase: args.missing.length > 0 ? "degraded" : "synth",
    specialists: {
      total: args.dispatched.length,
      completed: args.succeeded.length,
      dispatched: args.dispatched,
      succeeded: args.succeeded,
      missing: args.missing,
      notNeeded: notNeededRoles(args.dispatched),
    },
    droppedFiles: args.droppedFiles,
    graphCoverage: {
      mode: args.graphMode,
      filesWithContext: new Set(args.graphNodes.map((n) => n.path)).size,
      totalFiles: args.totalFiles,
      nodes: args.graphNodes.length,
    },
  }
}

export function finalStatusUpdate(args: {
  status: "posted" | "shadow_recorded" | "skipped" | "errored" | "stale_head"
  reviewMeta?: { findingsCount?: number; surface?: ReviewStatusFinal["surface"] }
  owner: string
  repo: string
  prNumber: number
}): ReviewStatusUpdate | null {
  if (args.status === "stale_head" || args.status === "shadow_recorded") return null
  const failed = args.status === "errored"
  const skipped = args.status === "skipped"
  return {
    phase: failed ? "failed" : skipped ? "skipped" : "posted",
    final: {
      status: failed ? "failed" : skipped ? "skipped" : "posted",
      findingsCount: args.reviewMeta?.findingsCount ?? 0,
      ...(args.reviewMeta?.surface !== undefined ? { surface: args.reviewMeta.surface } : {}),
      reviewUrl: `https://github.com/${args.owner}/${args.repo}/pull/${args.prNumber}`,
    },
  }
}

function notNeededRoles(dispatched: readonly SpecialistRole[]): readonly SpecialistRole[] {
  const kept = new Set(dispatched)
  return ALL_SPECIALISTS.filter((role) => !kept.has(role))
}
