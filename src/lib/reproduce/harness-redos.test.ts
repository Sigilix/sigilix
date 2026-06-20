// SIG-477 PR-3 — tests for the ReDoS execution harness. These run the REAL QuickJS
// WASM sandbox (loaded via the vitest `.wasm` plugin, same as production), so a
// `reproduced` verdict here genuinely observed catastrophic backtracking and an
// `inconclusive` on a SAFE regex genuinely never tripped the timeout. The
// FP-safety (a safe regex must NEVER be "reproduced") is the load-bearing property.

import { describe, it, expect } from "vitest"
import { runRedosHarness, HARNESS_MAX_TOTAL_MS, type RedosHarnessInput } from "./harness-redos"

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
