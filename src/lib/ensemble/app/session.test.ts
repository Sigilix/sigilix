// SIG-304 recall-safety: isDryRunEngineFailure is the shared primitive both headless
// callers (the CLI run-review-in-node + POST /v1/review) use to decide whether a
// dry-run result is an ENGINE FAILURE (→ surface an error) or a legitimately empty
// review (→ clean pass). A reason that means "no verdict produced" must NEVER read as
// clean — the iron rule. NO_VERDICT_FAILURES is derived exhaustively from the
// SkipNoticeReason union so it can't drift; this test pins every reason.

import { describe, it, expect } from "vitest"
import { isDryRunEngineFailure } from "./session"
import type { EnsembleResult } from "./session"
import type { SkipNoticeReason } from "@/src/lib/review-comment-fallback"

const result = (status: string, telemetry: Record<string, unknown>, dryRunReview?: unknown): EnsembleResult =>
  ({ status, telemetry, ...(dryRunReview !== undefined ? { dryRunReview } : {}) }) as unknown as EnsembleResult

const ALL_NO_VERDICT_REASONS: SkipNoticeReason[] = [
  "router_no_specialists",
  "specialists_all_failed",
  "synth_timeout",
  "synth_failed_parse",
  "synth_invalid_provenance",
  "cost_governor_trimmed_all_routable",
  "internal_error",
]

describe("isDryRunEngineFailure (recall-safety)", () => {
  it("an errored run is always a failure", () => {
    expect(isDryRunEngineFailure(result("errored", {}))).toBe(true)
  })

  it.each(ALL_NO_VERDICT_REASONS)("a no-verdict bail (%s) is a failure, never a clean pass", (reason) => {
    expect(isDryRunEngineFailure(result("skipped", { fellBackReason: reason }))).toBe(true)
  })

  it("a produced dryRunReview is never a failure (the engine got a verdict)", () => {
    const review = { verdict: {}, unanchoredFindings: [] }
    expect(isDryRunEngineFailure(result("skipped", { fellBackReason: "synth_timeout" }, review))).toBe(false)
  })

  it("a genuinely empty review (skipped, no failure reason, no verdict) is NOT a failure", () => {
    expect(isDryRunEngineFailure(result("skipped", {}))).toBe(false)
  })
})
