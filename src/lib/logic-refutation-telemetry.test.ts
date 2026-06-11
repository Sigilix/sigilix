// SIG-308 Phase 2 — pins the `clearedLogicCandidates` constrained-decode
// surface (so the model's emitted field isn't silently dropped) and the pure
// telemetry builder the ensemble uses to log the cleared-rate. Unlike the
// SIG-282 dismissals there is no manifest to reconcile against — logic
// candidates are self-generated — so this stage is pure observability; the
// Phase 3 backstop is the recall safety rail.

import { describe, expect, it } from "vitest"
import { PR_REVIEW_SCHEMA } from "@/src/shared/domain/schemas"
import { buildClearedLogicCandidateTelemetry } from "@/src/lib/triage-pr-review"
import type { ClearedLogicCandidate } from "@/src/lib/triage-pr-review"

describe("PR_REVIEW_SCHEMA — clearedLogicCandidates surface", () => {
  it("declares clearedLogicCandidates so constrained generation can emit it", () => {
    const props = PR_REVIEW_SCHEMA.properties as Record<string, any>
    expect(props.clearedLogicCandidates).toBeTruthy()
    expect(props.clearedLogicCandidates.type).toBe("array")
    const itemProps = props.clearedLogicCandidates.items.properties
    expect(itemProps.path).toEqual({ type: "string" })
    expect(itemProps.line).toEqual({ type: "integer", minimum: 1 })
    expect(itemProps.hypothesis).toEqual({ type: "string" })
    expect(itemProps.mitigation).toEqual({ type: "string" })
  })

  it("does not make clearedLogicCandidates required (optional, logic-only)", () => {
    expect(PR_REVIEW_SCHEMA.required as readonly string[]).not.toContain("clearedLogicCandidates")
  })
})

describe("buildClearedLogicCandidateTelemetry (SIG-308)", () => {
  const ctx = {
    owner: "Sigilix",
    repo: "sigilix-monitor",
    prNumber: 12,
    headSha: "7b890db2255aa1968e3e9909f67b667bf95356aa",
  }
  const cand: ClearedLogicCandidate = {
    path: "src/ui/app.tsx",
    line: 50,
    hypothesis: "hours * 60 * 60 * 1000 could overflow",
    mitigation: "Math.min(parsed, 2160) clamps hours before the multiply",
  }

  it("emits one pr-review-logic-candidate-cleared event per candidate with a running total (the counter)", () => {
    const out = buildClearedLogicCandidateTelemetry([cand, { ...cand, line: 9 }], ctx)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      event: "pr-review-logic-candidate-cleared",
      owner: "Sigilix",
      repo: "sigilix-monitor",
      prNumber: 12,
      headSha: "7b890db", // truncated to 7 chars like the SIG-282 dismissal telemetry
      path: "src/ui/app.tsx",
      line: 50,
      index: 1,
      total: 2,
    })
    expect(out[1]).toMatchObject({ line: 9, index: 2, total: 2 })
  })

  it("returns an empty array when nothing was cleared", () => {
    expect(buildClearedLogicCandidateTelemetry([], ctx)).toEqual([])
  })
})
