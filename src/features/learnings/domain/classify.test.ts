import { describe, expect, it } from "vitest"

import { classifyLearningMemory } from "@/src/features/learnings/domain/classify"

describe("classifyLearningMemory", () => {
  it("classifies a manual command as a durable preference, ignoring any suggestion or PR", () => {
    expect(classifyLearningMemory({ sourceKind: "command", polarity: "context", prNumber: 7 })).toEqual({
      type: "durable_preference",
      lifespanAnchor: { kind: "durable" },
    })
    // Hard override: a vague/contradictory LLM suggestion never downgrades a command.
    expect(
      classifyLearningMemory({
        sourceKind: "command",
        polarity: "context",
        prNumber: 7,
        suggestedType: "transient_feedback",
      }),
    ).toEqual({ type: "durable_preference", lifespanAnchor: { kind: "durable" } })
  })

  it("classifies a PR-thread dismissal (suppress + PR, no suggestion) as transient feedback anchored to the PR", () => {
    expect(classifyLearningMemory({ sourceKind: "inline-reply", polarity: "suppress", prNumber: 42 })).toEqual({
      type: "transient_feedback",
      lifespanAnchor: { kind: "pr", prNumber: 42 },
    })
    expect(classifyLearningMemory({ sourceKind: "qa", polarity: "suppress", prNumber: 42 })).toEqual({
      type: "transient_feedback",
      lifespanAnchor: { kind: "pr", prNumber: 42 },
    })
  })

  it("honors an architectural_fact suggestion with a durable anchor", () => {
    expect(
      classifyLearningMemory({
        sourceKind: "inline-reply",
        polarity: "context",
        prNumber: 7,
        suggestedType: "architectural_fact",
      }),
    ).toEqual({ type: "architectural_fact", lifespanAnchor: { kind: "durable" } })
  })

  it("lets a clear durable_preference suggestion win over the suppress heuristic", () => {
    expect(
      classifyLearningMemory({
        sourceKind: "inline-reply",
        polarity: "suppress",
        prNumber: 7,
        suggestedType: "durable_preference",
      }),
    ).toEqual({ type: "durable_preference", lifespanAnchor: { kind: "durable" } })
  })

  it("anchors an ephemeral_project suggestion to the PR, else the branch, else durable", () => {
    expect(
      classifyLearningMemory({
        sourceKind: "top-level",
        polarity: "context",
        prNumber: 9,
        suggestedType: "ephemeral_project",
      }),
    ).toEqual({ type: "ephemeral_project", lifespanAnchor: { kind: "pr", prNumber: 9 } })
    expect(
      classifyLearningMemory({
        sourceKind: "top-level",
        polarity: "context",
        branchName: "feature/x",
        suggestedType: "ephemeral_project",
      }),
    ).toEqual({ type: "ephemeral_project", lifespanAnchor: { kind: "branch", name: "feature/x" } })
    expect(
      classifyLearningMemory({ sourceKind: "top-level", polarity: "context", suggestedType: "ephemeral_project" }),
    ).toEqual({ type: "ephemeral_project", lifespanAnchor: { kind: "durable" } })
  })

  it("degrades a transient_feedback suggestion without a PR/branch anchor to durable", () => {
    expect(
      classifyLearningMemory({ sourceKind: "qa", polarity: "context", suggestedType: "transient_feedback" }),
    ).toEqual({ type: "transient_feedback", lifespanAnchor: { kind: "durable" } })
  })

  it("falls back to ephemeral_project for a vague non-suppress learning tied to a PR", () => {
    expect(classifyLearningMemory({ sourceKind: "inline-reply", polarity: "require", prNumber: 7 })).toEqual({
      type: "ephemeral_project",
      lifespanAnchor: { kind: "pr", prNumber: 7 },
    })
  })

  it("falls back to durable_preference when there is no suggestion and no PR", () => {
    expect(classifyLearningMemory({ sourceKind: "qa", polarity: "context" })).toEqual({
      type: "durable_preference",
      lifespanAnchor: { kind: "durable" },
    })
  })
})
