// SIG Trust Ledger v0 — the threading helpers: mode parse, tier precedence
// (order-independent), immutable merge, in-place annotate (identity-preserving),
// and the tier-distribution counter.

import { describe, expect, it } from "vitest"
import {
  parseTrustLedgerMode,
  resolveTier,
  mergeFindingTrust,
  annotateFindingTrust,
  countTrustTiers,
} from "@/src/lib/ensemble/domain/gates/trust-ledger-thread"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

// minimal finding stub — only the fields the helpers touch.
const f = (over: Partial<PrReviewFinding> = {}): PrReviewFinding =>
  ({
    path: "src/a.ts",
    line: 10,
    score: 4,
    category: "logic",
    headline: "h",
    body: "b",
    ...over,
  }) as PrReviewFinding

describe("parseTrustLedgerMode", () => {
  it("accepts shadow/on, defaults everything else to off", () => {
    expect(parseTrustLedgerMode("shadow")).toBe("shadow")
    expect(parseTrustLedgerMode("on")).toBe("on")
    expect(parseTrustLedgerMode("off")).toBe("off")
    expect(parseTrustLedgerMode(undefined)).toBe("off")
    expect(parseTrustLedgerMode("ON")).toBe("off") // case-sensitive
    expect(parseTrustLedgerMode("enforce")).toBe("off")
  })
})

describe("resolveTier — highest-proof wins, order-independent", () => {
  it("runner receipt beats everything", () => {
    expect(resolveTier(["grounded-model", "runner-confirmed", "worker-token-confirmed"])).toBe("runner-confirmed")
  })
  it("deterministic beats worker-token + grounded-model", () => {
    expect(resolveTier(["worker-token-confirmed", "deterministic-grounded", "grounded-model"])).toBe(
      "deterministic-grounded",
    )
  })
  it("deterministic-confirmed sits between reproduced-by-execution and deterministic-grounded", () => {
    // self-confirmed beats deterministic-grounded (and everything weaker)…
    expect(resolveTier(["deterministic-grounded", "deterministic-confirmed", "worker-token-confirmed"])).toBe(
      "deterministic-confirmed",
    )
    // …but a runner (CI) receipt always outranks a self-confirmed finding.
    expect(resolveTier(["deterministic-confirmed", "runner-confirmed"])).toBe("runner-confirmed")
  })
  it("SIG-477: reproduced-by-execution beats deterministic-confirmed but loses to runner-confirmed (rank 7 > 6 > 5)", () => {
    // the execution-sandbox tier outranks the static self-attested tier…
    expect(resolveTier(["deterministic-confirmed", "reproduced-by-execution"])).toBe("reproduced-by-execution")
    expect(resolveTier(["deterministic-grounded", "reproduced-by-execution", "worker-token-confirmed"])).toBe(
      "reproduced-by-execution",
    )
    // …but an independent CI receipt (runner-confirmed) still wins (the moat).
    expect(resolveTier(["reproduced-by-execution", "runner-confirmed"])).toBe("runner-confirmed")
    expect(resolveTier(["runner-confirmed", "reproduced-by-execution", "deterministic-confirmed"])).toBe(
      "runner-confirmed",
    )
  })
  it("worker-token beats plain grounded-model", () => {
    expect(resolveTier(["grounded-model", "worker-token-confirmed"])).toBe("worker-token-confirmed")
  })
  it("ignores null/undefined signals", () => {
    expect(resolveTier([null, undefined, "grounded-model"])).toBe("grounded-model")
  })
  it("no positive signal → body-only-ungrounded", () => {
    expect(resolveTier([])).toBe("body-only-ungrounded")
    expect(resolveTier([null, undefined])).toBe("body-only-ungrounded")
  })
})

describe("mergeFindingTrust — immutable, tier-monotonic", () => {
  it("attaches trust without mutating the input", () => {
    const original = f()
    const out = mergeFindingTrust(original, { signals: ["grounded-model"], surface: "inline" })
    expect(out).not.toBe(original)
    expect(original.trust).toBeUndefined() // input untouched
    expect(out.trust).toEqual({ tier: "grounded-model", surface: "inline" })
  })
  it("a later body-demote patch keeps a STRONGER prior tier (only the surface lowers)", () => {
    const a = mergeFindingTrust(f(), { signals: ["worker-token-confirmed"], surface: "inline" })
    const b = mergeFindingTrust(a, {
      signals: ["body-only-ungrounded"],
      surface: "body",
      demoteReason: "verification-refuted",
    })
    // tier stays worker-token-confirmed (3 > 1); surface + reason update.
    expect(b.trust).toEqual({
      tier: "worker-token-confirmed",
      surface: "body",
      demoteReason: "verification-refuted",
    })
  })
  it("a stronger signal raises the tier", () => {
    const a = mergeFindingTrust(f(), { signals: ["grounded-model"] })
    const b = mergeFindingTrust(a, { signals: ["runner-confirmed"] })
    expect(b.trust?.tier).toBe("runner-confirmed")
  })
  it("preserves prior surface/demoteReason when a patch omits them", () => {
    const a = mergeFindingTrust(f(), {
      signals: ["body-only-ungrounded"],
      surface: "body",
      demoteReason: "outside-diff",
    })
    const b = mergeFindingTrust(a, { signals: ["grounded-model"] })
    expect(b.trust).toEqual({
      tier: "grounded-model",
      surface: "body",
      demoteReason: "outside-diff",
    })
  })
  it("defaults tier to body-only-ungrounded when no signal ever set it", () => {
    const out = mergeFindingTrust(f(), { surface: "body", demoteReason: "outside-diff" })
    expect(out.trust).toEqual({
      tier: "body-only-ungrounded",
      surface: "body",
      demoteReason: "outside-diff",
    })
  })
})

describe("annotateFindingTrust — in-place, identity-preserving", () => {
  it("mutates the SAME object (identity preserved for the demote set)", () => {
    const finding = f()
    annotateFindingTrust(finding, { signals: ["worker-token-confirmed"] })
    expect(finding.trust?.tier).toBe("worker-token-confirmed") // same ref, now annotated
  })
  it("accumulates across calls with tier monotonicity", () => {
    const finding = f()
    annotateFindingTrust(finding, { signals: ["grounded-model"] })
    annotateFindingTrust(finding, { surface: "body", demoteReason: "verification-refuted" })
    annotateFindingTrust(finding, { signals: ["runner-confirmed"] })
    expect(finding.trust).toEqual({
      tier: "runner-confirmed",
      surface: "body",
      demoteReason: "verification-refuted",
    })
  })
})

describe("countTrustTiers", () => {
  it("buckets every tier and totals", () => {
    const findings = [
      f({ trust: { tier: "runner-confirmed" } }),
      f({ trust: { tier: "runner-confirmed" } }),
      f({ trust: { tier: "reproduced-by-execution" } }),
      f({ trust: { tier: "deterministic-confirmed" } }),
      f({ trust: { tier: "deterministic-grounded" } }),
      f({ trust: { tier: "worker-token-confirmed" } }),
      f({ trust: { tier: "grounded-model" } }),
      f({ trust: { tier: "body-only-ungrounded" } }),
      f(), // no trust → counts as body-only-ungrounded
    ]
    expect(countTrustTiers(findings)).toEqual({
      runnerConfirmed: 2,
      reproducedByExecution: 1,
      deterministicConfirmed: 1,
      deterministicGrounded: 1,
      workerTokenConfirmed: 1,
      groundedModel: 1,
      bodyOnlyUngrounded: 2,
      total: 9,
    })
  })
  it("empty → all zero", () => {
    expect(countTrustTiers([])).toEqual({
      runnerConfirmed: 0,
      reproducedByExecution: 0,
      deterministicConfirmed: 0,
      deterministicGrounded: 0,
      workerTokenConfirmed: 0,
      groundedModel: 0,
      bodyOnlyUngrounded: 0,
      total: 0,
    })
  })
})
