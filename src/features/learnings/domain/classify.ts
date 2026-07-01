// Write-time memory classification (Phase-1a of the memory-moat arc).
//
// Pure domain logic: given the concrete capture signals plus an OPTIONAL
// LLM-suggested type, decide the 4-tier `LearningMemoryType` and its
// `LearningLifespanAnchor`. The LLM suggestion is primary (it is the only signal
// that can tell an architectural fact from a durable preference); the
// deterministic rules make classification robust when the LLM is vague or absent.
//
// SHADOW-SAFE: the output is only recorded on the entry — retrieval, retention,
// eviction, and decay do not read it in this slice.

import type { LearningLifespanAnchor, LearningMemoryType, LearningPolarity, LearningSourceKind } from "./types"

export interface ClassifyLearningMemoryInput {
  sourceKind: LearningSourceKind
  polarity: LearningPolarity
  /** The PR the learning was captured on, when tied to one. */
  prNumber?: number
  /** The branch the learning was captured on, when tied to one (no capture site plumbs this yet). */
  branchName?: string
  /** The extractor's suggested taxonomy, when the LLM emitted one. */
  suggestedType?: LearningMemoryType | null
}

export interface ClassifiedLearningMemory {
  type: LearningMemoryType
  lifespanAnchor: LearningLifespanAnchor
}

export function classifyLearningMemory(input: ClassifyLearningMemoryInput): ClassifiedLearningMemory {
  const { sourceKind, polarity, prNumber, branchName, suggestedType } = input

  // 1. A manual `@sigilix remember` / command is a human explicitly asking us to
  //    remember a convention → durable preference. Hard override (this path has no
  //    LLM), so a vague suggestion can never downgrade it.
  if (sourceKind === "command") {
    return { type: "durable_preference", lifespanAnchor: { kind: "durable" } }
  }

  // 2. Honor a clear LLM suggestion, reconciling the lifespan anchor to the signals.
  if (suggestedType) {
    return { type: suggestedType, lifespanAnchor: anchorFor(suggestedType, prNumber, branchName) }
  }

  // 3. The LLM was vague/absent — fall back deterministically from concrete signals.
  //    A dismissal (suppress polarity) tied to an open PR is one-off review feedback.
  if (polarity === "suppress" && prNumber !== undefined) {
    return { type: "transient_feedback", lifespanAnchor: { kind: "pr", prNumber } }
  }

  // 4. Anything else tied to an open PR is project state; otherwise a durable preference.
  if (prNumber !== undefined) {
    return { type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber } }
  }
  return { type: "durable_preference", lifespanAnchor: { kind: "durable" } }
}

function anchorFor(
  type: LearningMemoryType,
  prNumber: number | undefined,
  branchName: string | undefined,
): LearningLifespanAnchor {
  switch (type) {
    case "durable_preference":
    case "architectural_fact":
      return { kind: "durable" }
    case "ephemeral_project":
    case "transient_feedback":
      if (prNumber !== undefined) return { kind: "pr", prNumber }
      if (branchName !== undefined && branchName.length > 0) return { kind: "branch", name: branchName }
      // No transient anchor available — degrade to durable rather than fabricate one.
      return { kind: "durable" }
  }
}
