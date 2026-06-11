// ARC-190 Task 3 — classifyEnsembleError tests.

import { describe, it, expect } from "vitest"
import { classifyEnsembleError, classifyEnsembleStage } from "@/src/do/classify-error"
import { GitHubHttpError } from "@/src/shared/adapters/github"

describe("classifyEnsembleError — TRANSIENT triggers", () => {
  it("HTTP 500 from GitHub → transient", () => {
    expect(classifyEnsembleError(new GitHubHttpError(500, "Internal"))).toBe("transient")
  })

  it("HTTP 503 → transient", () => {
    expect(classifyEnsembleError(new GitHubHttpError(503, "Service Unavailable"))).toBe("transient")
  })

  it("HTTP 502 → transient", () => {
    expect(classifyEnsembleError(new GitHubHttpError(502, "Bad Gateway"))).toBe("transient")
  })

  it("network error TypeError 'fetch failed' → transient", () => {
    const err = new TypeError("fetch failed")
    expect(classifyEnsembleError(err)).toBe("transient")
  })

  it("AbortError-shaped error → transient", () => {
    const err = new Error("The operation was aborted.")
    expect(classifyEnsembleError(err)).toBe("transient")
  })

  it("ensemble failureReason 'timeout' → transient", () => {
    const err = { failureReason: "timeout" }
    expect(classifyEnsembleError(err)).toBe("transient")
  })

  it("ensemble failureReason 'fallback_failed: ...' → transient", () => {
    const err = { failureReason: "fallback_failed: aborted" }
    expect(classifyEnsembleError(err)).toBe("transient")
  })
})

describe("classifyEnsembleError — TERMINAL triggers", () => {
  it("HTTP 422 invalid-anchor from submitReview → terminal", () => {
    const err = new GitHubHttpError(422, "Unprocessable Entity (invalid line)")
    expect(classifyEnsembleError(err)).toBe("terminal")
  })

  it("missing_api_key → terminal", () => {
    const err = { failureReason: "missing_api_key" }
    expect(classifyEnsembleError(err)).toBe("terminal")
  })

  it("outside-config-allowed-paths → terminal", () => {
    const err = new Error("outside-config-allowed-paths")
    expect(classifyEnsembleError(err)).toBe("terminal")
  })

  it("synth_invalid_provenance → terminal", () => {
    const err = { failureReason: "synth_invalid_provenance" }
    expect(classifyEnsembleError(err)).toBe("terminal")
  })

  it("submit-fallback-422 (fallback also failed) → terminal", () => {
    const err = new Error("submit-fallback-failed: 422 invalid line")
    expect(classifyEnsembleError(err)).toBe("terminal")
  })
})

describe("classifyEnsembleError — default fallback", () => {
  it("totally novel error → transient (pessimistic default)", () => {
    expect(classifyEnsembleError(new Error("something nobody anticipated"))).toBe("transient")
  })

  it("plain string → transient", () => {
    expect(classifyEnsembleError("???")).toBe("transient")
  })

  it("undefined → transient", () => {
    expect(classifyEnsembleError(undefined)).toBe("transient")
  })

  it("null → transient", () => {
    expect(classifyEnsembleError(null)).toBe("transient")
  })
})

describe("classifyEnsembleStage — labels", () => {
  it("GitHubHttpError → 'github-http-<status>'", () => {
    expect(classifyEnsembleStage(new GitHubHttpError(503, "x"))).toBe("github-http-503")
    expect(classifyEnsembleStage(new GitHubHttpError(422, "x"))).toBe("github-http-422")
  })

  it("ensemble failureReason → 'ensemble-<reason>'", () => {
    expect(classifyEnsembleStage({ failureReason: "timeout" })).toBe("ensemble-timeout")
    expect(classifyEnsembleStage({ failureReason: "missing_api_key" })).toBe("ensemble-missing_api_key")
  })

  it("network TypeError → 'network'", () => {
    expect(classifyEnsembleStage(new TypeError("fetch failed"))).toBe("network")
  })

  it("abort → 'aborted'", () => {
    expect(classifyEnsembleStage(new Error("The operation was aborted."))).toBe("aborted")
  })

  it("default unknown → 'unknown'", () => {
    expect(classifyEnsembleStage(new Error("???"))).toBe("unknown")
  })
})

describe("classifyEnsembleError — submit_fallback_failed spelling consistency (CR PR #70)", () => {
  // The structured-failureReason path already treats
  // `submit_fallback_failed` (underscored) as terminal. The message-
  // text fallback used to only match the hyphenated form; a plain
  // `Error("submit_fallback_failed")` would fall through to transient
  // and get retried unnecessarily.
  it("Error('submit_fallback_failed') is terminal (underscored)", () => {
    expect(classifyEnsembleError(new Error("submit_fallback_failed"))).toBe("terminal")
  })

  it("Error('submit-fallback-failed') is terminal (hyphenated)", () => {
    expect(classifyEnsembleError(new Error("submit-fallback-failed"))).toBe("terminal")
  })

  it("Error containing 'submit_fallback_failed: <detail>' is terminal", () => {
    expect(classifyEnsembleError(new Error("ensemble: submit_fallback_failed: timeout"))).toBe("terminal")
  })
})
