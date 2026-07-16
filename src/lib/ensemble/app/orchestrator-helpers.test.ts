// SIG-304 recall-safety: dryRunResult must carry the degraded-coverage signal across
// the dry-run boundary so a headless caller can refuse to read a PARTIAL review as a
// clean pass. (This test fails if the `incomplete` propagation is reverted.)

import { describe, it, expect } from "vitest"
import { capturePrAuthorTelemetry, dryRunResult } from "./orchestrator-helpers"
import type { EnsembleTelemetry } from "./orchestrator-types"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"

type Telemetry = Parameters<typeof dryRunResult>[0]
const verdict = { summary: "s", confidence: 4, findings: [] } as unknown as PrReviewVerdict
const tel = (degradedCoverage: unknown): Telemetry => ({ degradedCoverage }) as unknown as Telemetry

describe("dryRunResult — degraded-coverage propagation", () => {
  it("full coverage (no degradedCoverage) → no incomplete field", () => {
    const r = dryRunResult(tel(undefined), verdict, [])
    expect(r.dryRunReview?.incomplete).toBeUndefined()
  })
  it("a specialist unavailable → incomplete carries the missing roles", () => {
    const r = dryRunResult(tel({ rolesReturned: ["security", "tests"], rolesMissing: ["logic"] }), verdict, [])
    expect(r.dryRunReview?.incomplete).toEqual({ rolesMissing: ["logic"] })
  })
  it("degraded record but zero missing roles → NOT flagged incomplete (it ran fully)", () => {
    const r = dryRunResult(tel({ rolesReturned: ["logic", "security"], rolesMissing: [] }), verdict, [])
    expect(r.dryRunReview?.incomplete).toBeUndefined()
  })
})

describe("capturePrAuthorTelemetry", () => {
  it("captures canonical GitHub identity alongside mutable login", () => {
    const telemetry = {} as EnsembleTelemetry

    capturePrAuthorTelemetry(telemetry, "github", { login: "octocat", id: 123 })

    expect(telemetry.authorLogin).toBe("octocat")
    expect(telemetry.authorGithubUserId).toBe("123")
  })

  it("never labels another provider's numeric author id as a GitHub identity", () => {
    const telemetry = {} as EnsembleTelemetry

    capturePrAuthorTelemetry(telemetry, "gitlab", { login: "tanuki", id: 123 })

    expect(telemetry.authorLogin).toBe("tanuki")
    expect(telemetry.authorGithubUserId).toBeUndefined()
  })
})
