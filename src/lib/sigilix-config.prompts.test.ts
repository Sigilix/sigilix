// ARC-174 — `sigilix.json` config: prompt-builder injection behavior.
//
// Exercises buildSpecialistInitialMessage / buildSynthesizerInitialMessage
// for sigilix.json guidance injection and the [GRAPH CONTEXT] block (SIG-138).

import { describe, it, expect } from "vitest"
import { buildSpecialistInitialMessage, buildSynthesizerInitialMessage } from "@/src/prompts/pr-review-specialists"

describe("buildSpecialistInitialMessage — sigilix.json guidance injection", () => {
  const baseCtx = {
    prNumber: 42,
    title: "feat: add thing",
    body: "Adds a thing.",
    diff: "diff --git a/x.ts b/x.ts\n@@ -0,0 +1 @@\n+export const x = 1",
    retrievalSnapshot: "",
    namespace: "myrepo",
  }

  it("renders without guidance when none is provided (current behavior)", () => {
    const msg = buildSpecialistInitialMessage(baseCtx)
    expect(msg).not.toContain("REPO GUIDANCE")
    expect(msg).toContain("[PR] #42 — feat: add thing")
  })

  it("prepends guidance in a labeled block when present", () => {
    const msg = buildSpecialistInitialMessage({
      ...baseCtx,
      guidance: "Reject any new class declarations.",
    })
    expect(msg).toContain("[REPO GUIDANCE — applies to ALL specialists (from sigilix.json)]")
    expect(msg).toContain("Reject any new class declarations.")
    // Guidance must appear BEFORE the PR header so the model treats it
    // as authoritative context, not as something to reason about.
    expect(msg.indexOf("REPO GUIDANCE")).toBeLessThan(msg.indexOf("[PR]"))
  })

  it("prepends matched path guidance before the PR block", () => {
    const msg = buildSpecialistInitialMessage({
      ...baseCtx,
      guidance: "Repo guidance.",
      pathInstructionsBlock: "[PATH-SCOPED REVIEW GUIDANCE (from sigilix.json)]\nGuidance: Auth paths are sensitive.",
    })
    expect(msg).toContain("[PATH-SCOPED REVIEW GUIDANCE (from sigilix.json)]")
    expect(msg.indexOf("REPO GUIDANCE")).toBeLessThan(msg.indexOf("PATH-SCOPED REVIEW GUIDANCE"))
    expect(msg.indexOf("PATH-SCOPED REVIEW GUIDANCE")).toBeLessThan(msg.indexOf("[PR]"))
  })

  // ARC-176: profile rendering
  it("renders [REVIEW PROFILE — chill] when profile=chill", () => {
    const msg = buildSpecialistInitialMessage({ ...baseCtx, profile: "chill" })
    expect(msg).toContain("[REVIEW PROFILE — chill]")
    expect(msg).toContain("must-fix")
    expect(msg.indexOf("REVIEW PROFILE")).toBeLessThan(msg.indexOf("[PR]"))
  })

  it("renders [REVIEW PROFILE — assertive] when profile=assertive", () => {
    const msg = buildSpecialistInitialMessage({ ...baseCtx, profile: "assertive" })
    expect(msg).toContain("[REVIEW PROFILE — assertive]")
    expect(msg).toContain("nits")
  })

  it("omits the REVIEW PROFILE block entirely when profile is unset", () => {
    const msg = buildSpecialistInitialMessage(baseCtx)
    expect(msg).not.toContain("REVIEW PROFILE")
  })
})

describe("buildSynthesizerInitialMessage — sigilix.json guidance injection", () => {
  const baseCtx = {
    prNumber: 42,
    diff: "diff --git a/x.ts b/x.ts\n@@ ...",
    specialistVerdictsBlock: "=== LOGIC ===\n{}",
  }

  it("renders without guidance when none is provided (current behavior)", () => {
    const msg = buildSynthesizerInitialMessage(baseCtx)
    expect(msg).not.toContain("REPO GUIDANCE")
    expect(msg).toContain("[PR] #42")
  })

  it("prepends guidance in a labeled block when present", () => {
    const msg = buildSynthesizerInitialMessage({
      ...baseCtx,
      guidance: "Always promote security findings to score=5.",
    })
    expect(msg).toContain("[REPO GUIDANCE (from sigilix.json)]")
    expect(msg).toContain("Always promote security findings to score=5.")
    expect(msg.indexOf("REPO GUIDANCE")).toBeLessThan(msg.indexOf("[PR]"))
  })

  it("prepends matched path guidance before the PR block", () => {
    const msg = buildSynthesizerInitialMessage({
      ...baseCtx,
      guidance: "Repo guidance.",
      pathInstructionsBlock: "[PATH-SCOPED REVIEW GUIDANCE (from sigilix.json)]\nGuidance: Auth paths are sensitive.",
    })
    expect(msg).toContain("[PATH-SCOPED REVIEW GUIDANCE (from sigilix.json)]")
    expect(msg.indexOf("REPO GUIDANCE")).toBeLessThan(msg.indexOf("PATH-SCOPED REVIEW GUIDANCE"))
    expect(msg.indexOf("PATH-SCOPED REVIEW GUIDANCE")).toBeLessThan(msg.indexOf("[PR]"))
  })
})

describe("buildSpecialistInitialMessage — [GRAPH CONTEXT] block (SIG-138)", () => {
  const baseCtx = {
    prNumber: 42,
    title: "feat: add thing",
    body: "Adds a thing.",
    diff: "diff --git a/x.ts b/x.ts\n@@ -0,0 +1 @@\n+export const x = 1",
    retrievalSnapshot: "",
    namespace: "myrepo",
  }

  it("renders a [GRAPH CONTEXT] block when graphContext is present, omits it otherwise", () => {
    const withGraph = buildSpecialistInitialMessage({
      ...baseCtx,
      graphContext: "src/b.ts (hop1, import)\nsrc/c.ts (hop2, import)",
    })
    expect(withGraph).toContain("[GRAPH CONTEXT")
    expect(withGraph).toContain("src/b.ts (hop1, import)")
    const without = buildSpecialistInitialMessage(baseCtx)
    expect(without).not.toContain("[GRAPH CONTEXT")
  })

  it("omits the [GRAPH CONTEXT] block when graphContext is an empty string", () => {
    const msg = buildSpecialistInitialMessage({ ...baseCtx, graphContext: "" })
    expect(msg).not.toContain("[GRAPH CONTEXT")
  })

  it("omits the [GRAPH CONTEXT] block when graphContext is whitespace-only", () => {
    const msg = buildSpecialistInitialMessage({ ...baseCtx, graphContext: "   " })
    expect(msg).not.toContain("[GRAPH CONTEXT")
  })

  it("places the [GRAPH CONTEXT] block adjacent to [RETRIEVAL SNAPSHOT]", () => {
    const msg = buildSpecialistInitialMessage({
      ...baseCtx,
      graphContext: "src/b.ts (hop1, import)",
    })
    const retrievalIdx = msg.indexOf("[RETRIEVAL SNAPSHOT]")
    const graphIdx = msg.indexOf("[GRAPH CONTEXT")
    expect(retrievalIdx).toBeGreaterThan(-1)
    expect(graphIdx).toBeGreaterThan(-1)
    // [GRAPH CONTEXT] should appear after [RETRIEVAL SNAPSHOT]
    expect(graphIdx).toBeGreaterThan(retrievalIdx)
  })

  it("renders dynamic evidence after graph context when present", () => {
    const msg = buildSpecialistInitialMessage({
      ...baseCtx,
      graphContext: "src/b.ts (hop1, import)",
      dynamicEvidenceBlock: "[DYNAMIC REVIEW EVIDENCE — changed-symbol context]\nCard 1: src/x.ts:1-3",
    })
    const graphIdx = msg.indexOf("[GRAPH CONTEXT")
    const evidenceIdx = msg.indexOf("[DYNAMIC REVIEW EVIDENCE")
    const namespaceIdx = msg.indexOf("[CODEBASE NAMESPACE")
    expect(graphIdx).toBeGreaterThan(-1)
    expect(evidenceIdx).toBeGreaterThan(graphIdx)
    expect(namespaceIdx).toBeGreaterThan(evidenceIdx)
  })
})

describe("buildSynthesizerInitialMessage — [GRAPH CONTEXT] block (SIG-138)", () => {
  const baseCtx = {
    prNumber: 42,
    diff: "diff --git a/x.ts b/x.ts\n@@ ...",
    specialistVerdictsBlock: "=== LOGIC ===\n{}",
  }

  it("renders a [GRAPH CONTEXT] block when graphContext is present, omits it otherwise", () => {
    const withGraph = buildSynthesizerInitialMessage({
      ...baseCtx,
      graphContext: "src/b.ts (hop1, import)\nsrc/c.ts (hop2, import)",
    })
    expect(withGraph).toContain("[GRAPH CONTEXT")
    expect(withGraph).toContain("src/b.ts (hop1, import)")
    const without = buildSynthesizerInitialMessage(baseCtx)
    expect(without).not.toContain("[GRAPH CONTEXT")
  })

  it("omits the [GRAPH CONTEXT] block when graphContext is an empty string", () => {
    const msg = buildSynthesizerInitialMessage({ ...baseCtx, graphContext: "" })
    expect(msg).not.toContain("[GRAPH CONTEXT")
  })

  it("omits the [GRAPH CONTEXT] block when graphContext is whitespace-only", () => {
    const msg = buildSynthesizerInitialMessage({ ...baseCtx, graphContext: "   " })
    expect(msg).not.toContain("[GRAPH CONTEXT")
  })

  it("renders dynamic evidence before specialist verdicts when present", () => {
    const msg = buildSynthesizerInitialMessage({
      ...baseCtx,
      graphContext: "src/b.ts (hop1, import)",
      dynamicEvidenceBlock: "[DYNAMIC REVIEW EVIDENCE — changed-symbol context]\nCard 1: src/x.ts:1-3",
    })
    const graphIdx = msg.indexOf("[GRAPH CONTEXT")
    const evidenceIdx = msg.indexOf("[DYNAMIC REVIEW EVIDENCE")
    const verdictIdx = msg.indexOf("[SPECIALIST VERDICTS]")
    expect(evidenceIdx).toBeGreaterThan(graphIdx)
    expect(verdictIdx).toBeGreaterThan(evidenceIdx)
  })
})
