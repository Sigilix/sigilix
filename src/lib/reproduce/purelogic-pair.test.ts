// Tests for the SHARED pure-logic pair core — the /v1/verify oracle (`comparePairInSandbox`)
// over the REAL QuickJS WASM sandbox (same as production). A `changed` verdict here
// genuinely observed the before + after functions return DIFFERENT values at a battery
// input (deterministically); `preserved` observed equal output everywhere on the battery;
// `skipped` couldn't be run soundly. (The finding-path adapter is pinned separately in
// harness-purelogic.test.ts; the FP-safety floor in e2e/reproduce-fp-eval.test.ts.)

import { describe, it, expect } from "vitest"
import { comparePairInSandbox } from "./purelogic-pair"

describe("comparePairInSandbox — CHANGED (behavioral divergence observed)", () => {
  it("an off-by-one fix diverges → changed, with a captured sample", async () => {
    const res = await comparePairInSandbox(`function f(n){return n}`, `function f(n){return n+1}`)
    expect(res.verdict).toBe("changed")
    expect(res.detail).toContain("logic-divergence")
    // Sample is captured on changed: input + both outputs, each a (capped) string.
    expect(res.sample).toBeDefined()
    expect(typeof res.sample?.input).toBe("string")
    expect(typeof res.sample?.beforeOut).toBe("string")
    expect(typeof res.sample?.afterOut).toBe("string")
    // before(n)=n vs after(n)=n+1 — the two sides must differ in the captured sample.
    expect(res.sample?.beforeOut).not.toBe(res.sample?.afterOut)
  })

  it("an inclusive-vs-exclusive loop bound diverges → changed", async () => {
    const res = await comparePairInSandbox(
      `function sumTo(n){let s=0;for(let i=0;i<=n;i++){s+=i;}return s;}`,
      `function sumTo(n){let s=0;for(let i=0;i<n;i++){s+=i;}return s;}`,
    )
    expect(res.verdict).toBe("changed")
    expect(res.sample).toBeDefined()
  })

  it("strips TS types before lifting (strict-TS-repo snippets still run)", async () => {
    const res = await comparePairInSandbox(
      `export function clamp(i: number, max: number): number { return i <= max ? i + 1 : max }`,
      `export function clamp(i: number, max: number): number { return i <= max ? i : max }`,
    )
    expect(res.verdict).toBe("changed")
  })
})

describe("comparePairInSandbox — PRESERVED (behavior identical on the battery)", () => {
  it("an identical-behavior refactor (x*2 vs x+x on a typed number) → preserved", async () => {
    const res = await comparePairInSandbox(`(x: number) => x * 2`, `(x: number) => x + x`)
    expect(res.verdict).toBe("preserved")
    expect(res.detail).toBe("no-divergence-found")
    expect(res.sample).toBeUndefined() // no sample on preserved
  })

  it("an object-KEY reorder is behavior-preserving → preserved (canonical key order)", async () => {
    const res = await comparePairInSandbox(
      `(x: number, y: number) => ({ x: x, y: y })`,
      `(x: number, y: number) => ({ y: y, x: x })`,
    )
    expect(res.verdict).toBe("preserved")
  })

  it("a literal no-op (identical before/after) → preserved", async () => {
    const res = await comparePairInSandbox(`x => x * 2`, `x => x * 2`)
    expect(res.verdict).toBe("preserved")
  })
})

describe("comparePairInSandbox — SKIPPED (couldn't be run soundly)", () => {
  it("non-liftable before snippet → skipped:no-buggy-fn", async () => {
    const res = await comparePairInSandbox(`this is not code {{{`, `x => x`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("no-buggy-fn")
  })

  it("non-liftable after snippet → skipped:no-fixed-fn", async () => {
    const res = await comparePairInSandbox(`x => x + 1`, `nonsense )(}`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("no-fixed-fn")
  })

  it("arity mismatch → skipped", async () => {
    const res = await comparePairInSandbox(`(a, b) => a + b`, `(a) => a`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toContain("arity-mismatch")
  })

  it("zero-arity (no input to vary) → skipped", async () => {
    const res = await comparePairInSandbox(`() => 1`, `() => 2`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toContain("arity-out-of-range")
  })

  it("a non-terminating before function is bounded by the cycle counter → skipped (never hangs)", async () => {
    const res = await comparePairInSandbox(`(n) => { while (true) {} return n; }`, `(n) => n`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("guest-no-tally")
  })

  it("a behavior-preserving array-ctor idiom rewrite → skipped (not a false changed)", async () => {
    const res = await comparePairInSandbox(
      `(n: number) => new Array(n).fill(0)`,
      `(n: number) => Array.from({ length: n }, () => 0)`,
    )
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("array-ctor-rewrite")
  })

  // ── ASYNC GUARD ───────────────────────────────────────────────────────────
  // An async fn returns a Promise; `canon(Promise)` is "{}" on BOTH sides, so without the
  // guard two DIFFERENT async behaviors would falsely "agree" → a spurious `preserved`. The
  // gate must turn every async/Promise-returning pair into `skipped`, NEVER preserved/changed.
  it("an async pure fn → skipped (NOT a false preserved via canon-equated promises)", async () => {
    const res = await comparePairInSandbox(`async x => x + 1`, `async x => x + 1`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("async-fn")
  })

  it("a genuinely-CHANGED async fn must NOT report preserved → skipped", async () => {
    const res = await comparePairInSandbox(`async x => x + 1`, `async x => x + 2`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("async-fn")
    // The load-bearing assertion: a real async behavior change is NEVER "preserved".
    expect(res.verdict).not.toBe("preserved")
  })

  it("an async function DECLARATION is also caught (source-side async flag) → skipped", async () => {
    const res = await comparePairInSandbox(`async function f(n){return n}`, `async function f(n){return n+1}`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("async-fn")
  })

  it("an ORDINARY fn that RETURNS a promise → skipped (runtime thenable, no async keyword)", async () => {
    const res = await comparePairInSandbox(`x => Promise.resolve(x + 1)`, `x => Promise.resolve(x + 2)`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("async-result")
  })

  it("an async function EXPRESSION (`const f = async function`) → skipped (source async flag)", async () => {
    const res = await comparePairInSandbox(
      `const f = async function(x){return x+1}`,
      `const f = async function(x){return x+2}`,
    )
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("async-fn")
    expect(res.verdict).not.toBe("preserved")
  })

  // ── GENERATOR GUARD ───────────────────────────────────────────────────────
  // A `function*` returns a GENERATOR OBJECT whose data is NOT in own enumerable keys, so
  // `canon` collapses it to "{}" on BOTH sides → two DIFFERENT generators would falsely
  // "agree" into a spurious `preserved`. The source-side `generator` flag must skip it.
  it("a genuinely-CHANGED sync generator must NOT report preserved → skipped:generator-fn", async () => {
    const res = await comparePairInSandbox(`function* g(n){yield n}`, `function* g(n){yield n+1}`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("generator-fn")
    // The load-bearing assertion: a real generator behavior change is NEVER "preserved".
    expect(res.verdict).not.toBe("preserved")
  })

  // ── OPAQUE GUARD (non-plain object at depth) ───────────────────────────────
  // `canon` only serializes a PLAIN data object/array faithfully; a Promise / generator
  // object / Map / Set / Date / RegExp / class instance has its data OUTSIDE own enumerable
  // keys, so two DIFFERENT opaque values would falsely "agree" via a "{}" collapse. `canon`
  // brands any non-plain object opaque AT ANY DEPTH → the host maps it to `skipped`.
  it("a Promise NESTED in a returned OBJECT → skipped:opaque-result (not a false preserved)", async () => {
    const res = await comparePairInSandbox(
      `x => ({ p: Promise.resolve(x + 1) })`,
      `x => ({ p: Promise.resolve(x + 2) })`,
    )
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("opaque-result")
    expect(res.verdict).not.toBe("preserved")
  })

  it("a Promise NESTED in a returned ARRAY → skipped:opaque-result (not a false preserved)", async () => {
    const res = await comparePairInSandbox(`x => [Promise.resolve(x + 1)]`, `x => [Promise.resolve(x + 2)]`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("opaque-result")
    expect(res.verdict).not.toBe("preserved")
  })

  it("a Map return whose behavior changed → skipped:opaque-result (non-plain object)", async () => {
    const res = await comparePairInSandbox(`x => new Map([[x, x]])`, `x => new Map([[x, x + 1]])`)
    expect(res.verdict).toBe("skipped")
    expect(res.detail).toBe("opaque-result")
    expect(res.verdict).not.toBe("preserved")
  })
})

// ── REGRESSION GUARD (the opaque branding must NOT over-skip plain data) ──────
// The whole value of the oracle is verifying pure functions that return PLAIN data. The
// opaque guard brands only NON-plain objects; plain objects, arrays, and primitives MUST
// still canon faithfully and still produce real `changed` / `preserved` verdicts.
describe("comparePairInSandbox — REGRESSION: plain data still verifies (not over-skipped)", () => {
  it("a fn returning a changed PLAIN OBJECT → changed (not opaque-skipped)", async () => {
    const res = await comparePairInSandbox(`x => ({ a: x })`, `x => ({ a: x + 1 })`)
    expect(res.verdict).toBe("changed")
    expect(res.detail).toContain("logic-divergence")
    expect(res.sample).toBeDefined()
  })

  it("identical PLAIN-OBJECT fns → preserved (faithful canon, not opaque-skipped)", async () => {
    const res = await comparePairInSandbox(`x => ({ a: x })`, `x => ({ a: x })`)
    expect(res.verdict).toBe("preserved")
    expect(res.detail).toBe("no-divergence-found")
  })

  it("a fn returning a changed ARRAY → changed (arrays canon faithfully)", async () => {
    const res = await comparePairInSandbox(`(x: number) => [x]`, `(x: number) => [x + 1]`)
    expect(res.verdict).toBe("changed")
  })

  it("identical ARRAY-returning fns → preserved", async () => {
    const res = await comparePairInSandbox(`(x: number) => [x, x]`, `(x: number) => [x, x]`)
    expect(res.verdict).toBe("preserved")
  })

  it("a NESTED plain object (object inside object) still canons faithfully → changed", async () => {
    const res = await comparePairInSandbox(`x => ({ a: { b: x } })`, `x => ({ a: { b: x + 1 } })`)
    expect(res.verdict).toBe("changed")
  })

  it("a fn returning a changed PRIMITIVE → changed (primitives unaffected)", async () => {
    const res = await comparePairInSandbox(`(x: number) => x > 0`, `(x: number) => x >= 0`)
    expect(res.verdict).toBe("changed")
  })
})

describe("comparePairInSandbox — never throws + reports elapsed", () => {
  it("reports a non-negative elapsedMs", async () => {
    const res = await comparePairInSandbox(`x => x`, `x => x + 1`)
    expect(typeof res.elapsedMs).toBe("number")
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
