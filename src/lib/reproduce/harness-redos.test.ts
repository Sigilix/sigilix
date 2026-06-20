// SIG-477 PR-3 — tests for the ReDoS execution harness. These run the REAL QuickJS
// WASM sandbox (loaded via the vitest `.wasm` plugin, same as production), so a
// `reproduced` verdict here genuinely observed catastrophic backtracking and an
// `inconclusive` on a SAFE regex genuinely never tripped the timeout. The
// FP-safety (a safe regex must NEVER be "reproduced") is the load-bearing property.

import { describe, it, expect, afterEach, vi } from "vitest"
import { runRedosHarness, HARNESS_MAX_TOTAL_MS, type RedosHarnessInput } from "./harness-redos"
import type { SandboxCaps } from "./sandbox-runner"

// Minimal cited-code carrier — only the fields the harness reads (all optional).
const withRegexExample = (code: string): RedosHarnessInput => ({ failureExample: code })
const withBody = (body: string): RedosHarnessInput => ({ body })

describe("runRedosHarness — REPRODUCED on real ReDoS regexes (two-sided test fires)", () => {
  it("reproduces /^(a+)+$/ — the textbook nested-unbounded-quantifier ReDoS", async () => {
    const res = await runRedosHarness(withRegexExample(`const re = /^(a+)+$/`))
    expect(res.status).toBe("reproduced")
    expect(res.detail).toContain("catastrophic-backtracking")
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it("reproduces /^(\\w+\\s?)+$/ — a realistic nested-quantifier ReDoS", async () => {
    const res = await runRedosHarness(withRegexExample(`const pat = /^(\\w+\\s?)+$/`))
    expect(res.status).toBe("reproduced")
    expect(res.detail).toContain("catastrophic-backtracking")
  })

  it("extracts the regex from a fenced code block in the body and reproduces", async () => {
    const res = await runRedosHarness(withBody("The bug:\n```js\nconst re = /^(a+)+$/;\n```\n"))
    expect(res.status).toBe("reproduced")
  })
})

describe("runRedosHarness — fires via the CYCLE COUNTER when Date.now() is FROZEN (the Cloudflare regression)", () => {
  // On Cloudflare Workers `Date.now()` is frozen during synchronous compute, so the
  // sandbox's wall-clock deadline never trips for a CPU-bound regex backtrack. These
  // tests stub Date.now to a CONSTANT (frozen clock) and prove the harness's decision
  // logic is UNCHANGED — a textbook ReDoS still "reproduces" (its catastrophic match
  // surfaces as "timed-out" via the cycle counter) and a safe regex stays inconclusive.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const FROZEN = 1_700_000_000_000
  // A small interrupt budget so the catastrophic backtrack trips the COUNTER quickly
  // (a 250ms wall-clock deadline can't help — the clock is frozen). A benign linear
  // match finishes in far fewer interrupt calls, so it stays under this cap. Smaller
  // than the prod default purely to keep the test fast; the path under test is the same.
  const FROZEN_CLOCK_CAPS: SandboxCaps = {
    memoryBytes: 32 * 1024 * 1024,
    maxStackBytes: 256 * 1024,
    deadlineMs: 250,
    maxInterrupts: 5_000,
  }

  it("still reproduces /^(a+)+$/ with Date.now() frozen (timeout surfaces via the counter, not the clock)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FROZEN)
    const res = await runRedosHarness(withRegexExample(`const re = /^(a+)+$/`), FROZEN_CLOCK_CAPS)
    expect(res.status).toBe("reproduced")
    expect(res.detail).toContain("catastrophic-backtracking")
  })

  it("still leaves a SAFE /^[a-z]+$/ inconclusive with Date.now() frozen (counter does not false-trip)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(FROZEN)
    const res = await runRedosHarness(withRegexExample(`const re = /^[a-z]+$/`), FROZEN_CLOCK_CAPS)
    expect(res.status).toBe("inconclusive")
    expect(res.status).not.toBe("reproduced")
  })
})

describe("runRedosHarness — FP-safety: a SAFE regex is NEVER reproduced (inconclusive)", () => {
  it("does NOT reproduce /^[a-z]+$/ (linear, no nested quantifier)", async () => {
    const res = await runRedosHarness(withRegexExample(`const re = /^[a-z]+$/`))
    expect(res.status).toBe("inconclusive")
    expect(res.status).not.toBe("reproduced")
  })

  it("does NOT reproduce /^\\d{1,3}$/ (bounded, linear)", async () => {
    const res = await runRedosHarness(withRegexExample(`const re = /^\\d{1,3}$/`))
    expect(res.status).toBe("inconclusive")
    expect(res.status).not.toBe("reproduced")
  })

  it("does NOT reproduce a simple anchored literal /^hello$/", async () => {
    const res = await runRedosHarness(withRegexExample(`const re = /^hello$/`))
    expect(res.status).toBe("inconclusive")
    expect(res.status).not.toBe("reproduced")
  })
})

describe("runRedosHarness — prefers the BUGGY code over the FIX (extraction order)", () => {
  it("runs the vulnerable failureExample regex, NOT the safe suggestedReplacement", async () => {
    // failureExample = the catastrophic regex; suggestedReplacement = a safe rewrite.
    // The harness must run the BUGGY one → reproduced (not inconclusive on the fix).
    const res = await runRedosHarness({
      failureExample: "const re = /^(a+)+$/",
      suggestedReplacement: "const re = /^a+$/",
    })
    expect(res.status).toBe("reproduced")
  })

  it("falls back to suggestedReplacement only when no buggy source has a regex", async () => {
    // No regex in the buggy fields → the fix field's regex is the only candidate. (A
    // safe fix → inconclusive; this asserts the FIX is reachable as a last resort.)
    const res = await runRedosHarness({
      failureExample: "see the fix below",
      suggestedReplacement: "const re = /^[a-z]+$/",
    })
    expect(res.status).toBe("inconclusive")
    expect(res.status).not.toBe("skipped")
  })

  it("extracts the regex from astEvidence (the quoted buggy code) when that's the source", async () => {
    const res = await runRedosHarness({ astEvidence: "const re = /^(a+)+$/" })
    expect(res.status).toBe("reproduced")
  })
})

describe("runRedosHarness — bounded by the HARD per-harness wall-clock cap", () => {
  it("exposes HARNESS_MAX_TOTAL_MS as the honest per-run worst-case the caller reserves", () => {
    expect(HARNESS_MAX_TOTAL_MS).toBeGreaterThan(0)
  })
})

describe("runRedosHarness — SKIPPED when there is no extractable regex", () => {
  it("skips a finding whose cited code has no regex literal", async () => {
    const res = await runRedosHarness(withRegexExample(`function clamp(i, max) { return i <= max ? i : max }`))
    expect(res.status).toBe("skipped")
    expect(res.detail).toBe("no-regex")
  })

  it("skips a finding with empty cited code", async () => {
    const res = await runRedosHarness({})
    expect(res.status).toBe("skipped")
    expect(res.detail).toBe("no-regex")
  })

  it("skips un-parseable cited code without throwing (no-regex)", async () => {
    const res = await runRedosHarness(withRegexExample(`this is not valid javascript ===`))
    expect(res.status).toBe("skipped")
    expect(res.detail).toBe("no-regex")
  })
})

describe("runRedosHarness — never throws (fail-safe)", () => {
  it("returns a structured result for any input shape, never rejects", async () => {
    // A pathological-but-parseable snippet; whatever happens, we get a structured
    // status and the harness does not throw.
    const res = await runRedosHarness(withRegexExample(`const re = /(x+x+)+y/`))
    expect(["reproduced", "inconclusive", "skipped"]).toContain(res.status)
  })
})
