// SIG-477 PR-4 — tests for the pure-function-logic execution harness. These run the
// REAL QuickJS WASM sandbox (same as production), so a `reproduced` verdict here
// genuinely observed the buggy + fixed functions return DIFFERENT values at a boundary
// input. Unlike ReDoS, the signal is a DETERMINISTIC OUTPUT COMPARISON — it does not
// depend on timing, the regex engine, or the interrupt cadence, so it reproduces
// IDENTICALLY in node and on Cloudflare (the frozen-clock test below proves it).

import { describe, it, expect, afterEach, vi } from "vitest"
import { runPureLogicHarness, type PureLogicHarnessInput } from "./harness-purelogic"

// Minimal cited-code carriers — only the fields the harness reads.
const withPair = (buggy: string, fixed: string): PureLogicHarnessInput => ({
  failureExample: buggy,
  suggestedReplacement: fixed,
})

describe("runPureLogicHarness — REPRODUCED on a real logic divergence (two-sided fires)", () => {
  it("reproduces an off-by-one inclusive loop bound (<= should be <)", async () => {
    const res = await runPureLogicHarness(
      withPair(
        `function sumTo(n){let s=0;for(let i=0;i<=n;i++){s+=i;}return s;}`,
        `function sumTo(n){let s=0;for(let i=0;i<n;i++){s+=i;}return s;}`,
      ),
    )
    expect(res.status).toBe("reproduced")
    expect(res.detail).toContain("logic-divergence")
  })

  it("reproduces an off-by-one string slice (drops the last char)", async () => {
    const res = await runPureLogicHarness(withPair(`s => s.slice(0, s.length - 1)`, `s => s.slice(0, s.length)`))
    expect(res.status).toBe("reproduced")
  })

  it("reproduces a boundary off-by-one that agrees below the boundary", async () => {
    // Agrees for n < 1 (both return 0), diverges for n >= 1 (buggy adds one) — the
    // off-by-one signature: same behavior except past the boundary.
    const res = await runPureLogicHarness(withPair(`(n) => n < 1 ? 0 : n + 1`, `(n) => n < 1 ? 0 : n`))
    expect(res.status).toBe("reproduced")
  })

  it("reproduces a 2-arg off-by-one that diverges on the FIRST (string) arg — locks battery sampling", async () => {
    // Divergence requires arg0 to be a STRING (length defined). The old truncated
    // cartesian pinned arg0 to its first few numeric pool values → never diverged;
    // even-sampling makes arg0 span the full pool. Agrees when arg0 is a number.
    const res = await runPureLogicHarness(
      withPair(
        `(label, n) => (label.length > n ? label[n] : "x")`,
        `(label, n) => (label.length > n ? label[n - 1] : "x")`,
      ),
    )
    expect(res.status).toBe("reproduced")
  })

  it("reproduces a 3-arg off-by-one that diverges only on the THIRD arg — locks per-position coverage", async () => {
    // Agree/diverge depends solely on arg2 (n): agrees for n < 1, diverges for n >= 1.
    // Requires the battery to sweep position 2 over the FULL pool (both <1 and >=1) —
    // the old cap starved position 2 to the 3 anchor values (all >= 1) → all-diverge →
    // inconclusive. arg0/arg1 are ignored by the function.
    const res = await runPureLogicHarness(withPair(`(a, b, n) => (n < 1 ? 0 : n + 1)`, `(a, b, n) => (n < 1 ? 0 : n)`))
    expect(res.status).toBe("reproduced")
  })

  it("lifts the buggy fn from a body code fence + the fix from suggestedReplacement", async () => {
    const res = await runPureLogicHarness({
      body: "The loop bound is inclusive:\n```js\nfunction f(n){return n<=0 ? 0 : n+1;}\n```\n",
      suggestedReplacement: `function f(n){return n<=0 ? 0 : n;}`,
    })
    expect(res.status).toBe("reproduced")
  })

  it("strips TS type annotations before lifting (the strict-TS-repo common case)", async () => {
    // Cited code carries param + return types + an inner var type + a non-null assert;
    // none of that is valid in the plain-JS guest, so it MUST be stripped or the guest
    // SyntaxErrors → inconclusive. (Reviewer-found MAJOR recall hole.)
    const res = await runPureLogicHarness(
      withPair(
        `export function clamp(i: number, max: number): number { const j: number = i; return j <= max ? j + 1 : max! }`,
        `export function clamp(i: number, max: number): number { const j: number = i; return j <= max ? j : max }`,
      ),
    )
    expect(res.status).toBe("reproduced")
  })

  it("lifts the OUTERMOST function, not a nested helper/arrow", async () => {
    // The buggy off-by-one is in the OUTER function; a nested helper is identical on
    // both sides. A naive walk lifts the inner helper → misses the bug. (Reviewer-found
    // MAJOR selection hole.)
    const buggy = `function outer(n){ const dbl = (x) => x * 2; return n < 1 ? 0 : dbl(n) + 1; }`
    const fixed = `function outer(n){ const dbl = (x) => x * 2; return n < 1 ? 0 : dbl(n); }`
    const res = await runPureLogicHarness(withPair(buggy, fixed))
    expect(res.status).toBe("reproduced")
  })
})

describe("runPureLogicHarness — INCONCLUSIVE (never a false reproduce; the FP-safety)", () => {
  it("identical buggy + fixed → no-divergence-found (the fix was a no-op)", async () => {
    const res = await runPureLogicHarness(withPair(`x => x * 2`, `x => x * 2`))
    expect(res.status).toBe("inconclusive")
    expect(res.detail).toBe("no-divergence-found")
  })

  it("type-correct equivalent rewrite does NOT reproduce (no coercion over-fire)", async () => {
    // `x * 2` vs `x + x` are equal for numbers but DIFFER on strings ("ab"); a typed
    // `number` param means the battery feeds only numbers → no divergence → not reproduced.
    const res = await runPureLogicHarness(withPair(`(x: number) => x * 2`, `(x: number) => x + x`))
    expect(res.status).toBe("inconclusive")
    expect(res.detail).toBe("no-divergence-found")
  })

  it("an object-KEY reorder does NOT reproduce (canonical key-order, not a behavior change)", async () => {
    // `{x,y}` vs `{y,x}` is behavior-preserving but JSON.stringify is key-order-sensitive
    // → would diverge on every input (all-diverge). The canonical serializer sorts keys
    // so it keys identically → AGREE → not reproduced. (Reviewer-found all-diverge hole.)
    const res = await runPureLogicHarness(
      withPair(`(x: number, y: number) => ({ x: x, y: y })`, `(x: number, y: number) => ({ y: y, x: x })`),
    )
    expect(res.status).toBe("inconclusive")
    expect(res.detail).toBe("no-divergence-found")
  })

  it("an ARRAY reorder DOES reproduce (array order is significant)", async () => {
    // Unlike object keys, reordering an array changes behavior, so it must still diverge.
    const res = await runPureLogicHarness(
      withPair(`(a: number, b: number) => [a, b]`, `(a: number, b: number) => [b, a]`),
    )
    expect(res.status).toBe("reproduced")
  })
})

describe("runPureLogicHarness — SKIPPED (nothing runnable)", () => {
  it("no fixed function → no-fixed-fn", async () => {
    const res = await runPureLogicHarness({ failureExample: `x => x + 1` })
    expect(res.status).toBe("skipped")
    expect(res.detail).toBe("no-fixed-fn")
  })

  it("no buggy function → no-buggy-fn", async () => {
    const res = await runPureLogicHarness({ suggestedReplacement: `x => x + 1` })
    expect(res.status).toBe("skipped")
    expect(res.detail).toBe("no-buggy-fn")
  })

  it("arity mismatch between buggy and fixed → arity-mismatch", async () => {
    const res = await runPureLogicHarness(withPair(`(a, b) => a + b`, `(a) => a`))
    expect(res.status).toBe("skipped")
    expect(res.detail).toContain("arity-mismatch")
  })

  it("zero-arity function (no input to vary) → arity-out-of-range", async () => {
    const res = await runPureLogicHarness(withPair(`() => 1`, `() => 2`))
    expect(res.status).toBe("skipped")
    expect(res.detail).toContain("arity-out-of-range")
  })

  it("non-parseable / non-function cited code → no-buggy-fn", async () => {
    const res = await runPureLogicHarness(withPair(`this is not code {{{`, `x => x`))
    expect(res.status).toBe("skipped")
    expect(res.detail).toBe("no-buggy-fn")
  })
})

describe("runPureLogicHarness — clock-independent (the Cloudflare frozen-clock property)", () => {
  afterEach(() => vi.restoreAllMocks())

  it("still REPRODUCES an off-by-one when Date.now() is FROZEN (no timing dependence)", async () => {
    // On Cloudflare Workers Date.now() is frozen during synchronous compute. ReDoS
    // breaks here (its signal IS the timeout); pure-logic does not — the decision is a
    // pure output comparison, so a frozen clock changes NOTHING about the verdict.
    const FROZEN = 1_000_000
    vi.spyOn(Date, "now").mockReturnValue(FROZEN)
    const res = await runPureLogicHarness(withPair(`(n) => n < 1 ? 0 : n + 1`, `(n) => n < 1 ? 0 : n`))
    expect(res.status).toBe("reproduced")
  })

  it("a buggy infinite loop is bounded by the cycle counter → inconclusive, never a hang", async () => {
    // A pathological buggy function that never terminates is BYTECODE, so the opcode-
    // cycle interrupt aborts the whole guest (→ no clean tally → inconclusive). Frozen
    // clock so this can't pass via the wall-clock deadline — the counter must do it.
    const FROZEN = 2_000_000
    vi.spyOn(Date, "now").mockReturnValue(FROZEN)
    const res = await runPureLogicHarness(withPair(`(n) => { while (true) {} return n; }`, `(n) => n`))
    expect(res.status).toBe("inconclusive")
    expect(res.detail).toBe("guest-no-tally")
  })
})
