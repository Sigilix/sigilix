import { describe, expect, it } from "vitest"

import { classifyLearningVerification } from "@/src/features/learnings/domain/verify-provenance"

describe("classifyLearningVerification", () => {
  it("defaults a human teaching (no evidence) to unverified with the none sentinel", () => {
    expect(classifyLearningVerification()).toEqual({ status: "unverified", evidence: ["none"] })
    expect(classifyLearningVerification({})).toEqual({ status: "unverified", evidence: ["none"] })
    expect(classifyLearningVerification({ evidence: [] })).toEqual({ status: "unverified", evidence: ["none"] })
  })

  it("treats an explicit `none`-only evidence list as unverified", () => {
    expect(classifyLearningVerification({ evidence: ["none"] })).toEqual({ status: "unverified", evidence: ["none"] })
    expect(classifyLearningVerification({ evidence: ["none", "none"] })).toEqual({
      status: "unverified",
      evidence: ["none"],
    })
  })

  it("classifies a real evidence class as verified, dropping the none sentinel", () => {
    expect(classifyLearningVerification({ evidence: ["ast"] })).toEqual({ status: "verified", evidence: ["ast"] })
    expect(classifyLearningVerification({ evidence: ["cwe", "none", "sarif"] })).toEqual({
      status: "verified",
      evidence: ["cwe", "sarif"],
    })
  })

  it("dedupes evidence classes while preserving first-seen order", () => {
    expect(classifyLearningVerification({ evidence: ["test", "ast", "test", "ast"] })).toEqual({
      status: "verified",
      evidence: ["test", "ast"],
    })
  })

  it("attaches deduped source finding ids only when evidence is present", () => {
    expect(classifyLearningVerification({ evidence: ["depvuln"], sourceFindingIds: ["f1", "f1", "f2"] })).toEqual({
      status: "verified",
      evidence: ["depvuln"],
      sourceFindingIds: ["f1", "f2"],
    })
  })

  it("drops source finding ids when there is no evidence (unverified never carries attribution)", () => {
    expect(classifyLearningVerification({ sourceFindingIds: ["f1"] })).toEqual({
      status: "unverified",
      evidence: ["none"],
    })
  })
})
