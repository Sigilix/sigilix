// SIG-477 PR-1 — execution-sandbox eligibility-gate tests.
//
// `isReproducibleEligible` is the MEASUREMENT INSTRUMENT: it decides whether a
// finding's cited code is SAFE + STANDALONE enough that a future sandbox could
// reproduce it. The load-bearing properties under test:
//   - UNDER-STRICT-SAFE: every gate fails OPEN to ineligible; the helper NEVER
//     throws (an unparseable / missing snippet returns ineligible, not a crash).
//   - the SECURITY BOUNDARY: cited code touching network / fs / db / env / globals
//     / child_process / DOM / 3rd-party imports is REFUSED (the executable set).
//   - the NON-FABRICATION bar: a request-tainted fragment is refused (this is WHY
//     the taint-flow vuln classes are excluded — their sink is request-tainted).
//   - the ALLOWLIST: only ReDoS / pure-function-logic / hmac-byte-divergence are
//     executable; the taint-flow classes (sql/ssrf/path/cmd/...) are NOT.

import { describe, expect, it } from "vitest"
import {
  isReproducibleEligible,
  executableClassForFinding,
  parseReproduceMode,
  EXECUTABLE_CLASSES,
} from "@/src/lib/verification/reproduce-eligibility"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

// minimal finding stub — only the fields the gate reads. Grounded by default (a
// real manifest evidenceId) so Gate 1a passes unless a test overrides it.
function finding(over: { [K in keyof PrReviewFinding]?: PrReviewFinding[K] | undefined } = {}): PrReviewFinding {
  return {
    path: "src/lib/parse.ts",
    line: 42,
    score: 4,
    category: "logic",
    headline: "off-by-one in slice bound",
    body: "An off-by-one fence-post error.",
    evidenceId: "ast:no-constant-binary-condition:ast/x/h/42",
    ...over,
  } as PrReviewFinding
}

const NO_AST: ReadonlyArray<{ path: string; line: number; astFindingId: string }> = []

describe("parseReproduceMode", () => {
  it("accepts shadow/on, defaults everything else to off", () => {
    expect(parseReproduceMode("shadow")).toBe("shadow")
    expect(parseReproduceMode("on")).toBe("on")
    expect(parseReproduceMode("off")).toBe("off")
    expect(parseReproduceMode(undefined)).toBe("off")
    expect(parseReproduceMode("ON")).toBe("on") // trimmed + lowercased
    expect(parseReproduceMode("enforce")).toBe("off")
    expect(parseReproduceMode("  shadow  ")).toBe("shadow")
  })
})

describe("executableClassForFinding — allowlist (taint-flow classes excluded)", () => {
  it("matches ReDoS / catastrophic backtracking", () => {
    expect(executableClassForFinding({ headline: "ReDoS in the email regex", body: "" })).toBe("redos")
    expect(executableClassForFinding({ headline: "x", body: "catastrophic backtracking on input" })).toBe("redos")
  })
  it("matches pure-function-logic (off-by-one / fence-post / parser coercion)", () => {
    expect(executableClassForFinding({ headline: "off-by-one in the loop bound", body: "" })).toBe(
      "pure-function-logic",
    )
    expect(executableClassForFinding({ headline: "fence post error", body: "" })).toBe("pure-function-logic")
    expect(executableClassForFinding({ headline: "parser coercion drops the sign", body: "" })).toBe(
      "pure-function-logic",
    )
  })
  it("matches the BROADENED pure-function-logic phrasings (SIG-477 PR-4)", () => {
    const m = (headline: string) => executableClassForFinding({ headline, body: "" })
    expect(m("boundary condition skips the last element")).toBe("pure-function-logic")
    expect(m("the loop runs one extra iteration")).toBe("pure-function-logic")
    expect(m("the bound is inclusive but should be exclusive on the range")).toBe("pure-function-logic")
    expect(m("`<=` should be `<` in the slice bound")).toBe("pure-function-logic")
    expect(m("loop range off by the exclusive end")).toBe("pure-function-logic")
    expect(m("type coercion changes the comparison")).toBe("pure-function-logic")
  })
  it("does NOT over-match unrelated 'boundary'/'inclusive' prose", () => {
    // The broadened keywords still require the bug-shaped phrasing — generic words
    // alone must not class a finding (they'd only be filtered by the gates anyway,
    // but keep the class signal meaningful).
    expect(executableClassForFinding({ headline: "added a boundary to the UI card", body: "" })).toBeNull()
    expect(executableClassForFinding({ headline: "the docs are inclusive of all cases", body: "" })).toBeNull()
  })
  it("SIG-477: a `logic`-category finding the keywords miss falls back to pure-function-logic", () => {
    // The probe-#67 shape: a real boundary off-by-one the model worded by its SYMPTOM
    // ("can return len" / "out of bounds"), which no keyword names — the logic category
    // is the fallback signal so reconstruction + the harness still get a shot.
    expect(
      executableClassForFinding({
        headline: "`clampIndex` can return `len`, which is out of bounds for an array of length `len`",
        body: "",
        category: "logic",
      }),
    ).toBe("pure-function-logic")
    expect(
      executableClassForFinding({ headline: "the helper reads one past the end", body: "", category: "logic" }),
    ).toBe("pure-function-logic")
  })
  it("SIG-477: the category fallback applies ONLY to `logic` — other categories without a keyword stay null", () => {
    const symptom = "`clampIndex` can return `len`, which is out of bounds"
    for (const category of ["security", "performance", "error-handling", "style", "docs", "testing"] as const) {
      expect(executableClassForFinding({ headline: symptom, body: "", category })).toBeNull()
    }
    // and with no category at all (the unit-call shape) it also stays null.
    expect(executableClassForFinding({ headline: symptom, body: "" })).toBeNull()
  })
  it("SIG-477: the category fallback never mis-routes a keyword class (ReDoS/HMAC win first)", () => {
    // A logic-category finding that names ReDoS must class as ReDoS, NOT pure-function-
    // logic — the keyword checks run before the fallback. A performance-category ReDoS
    // (keyword path, independent of category) still classes correctly.
    expect(
      executableClassForFinding({ headline: "ReDoS via catastrophic backtracking", body: "", category: "logic" }),
    ).toBe("redos")
    expect(executableClassForFinding({ headline: "ReDoS in the matcher", body: "", category: "performance" })).toBe(
      "redos",
    )
  })
  it("matches hmac-byte-divergence", () => {
    expect(
      executableClassForFinding({ headline: "HMAC computed over the reserialized body", body: "byte mismatch" }),
    ).toBe("hmac-byte-divergence")
  })
  it("does NOT match the taint-flow classes", () => {
    expect(executableClassForFinding({ headline: "SQL injection via req.query", body: "" })).toBeNull()
    expect(executableClassForFinding({ headline: "SSRF in the fetch URL", body: "" })).toBeNull()
    expect(executableClassForFinding({ headline: "path traversal in the file read", body: "" })).toBeNull()
    expect(executableClassForFinding({ headline: "command injection in exec", body: "" })).toBeNull()
    expect(executableClassForFinding({ headline: "prototype pollution merge", body: "" })).toBeNull()
  })
  it("the allowlist set is exactly the three executable classes", () => {
    expect([...EXECUTABLE_CLASSES].sort()).toEqual(["hmac-byte-divergence", "pure-function-logic", "redos"])
  })
})

describe("isReproducibleEligible — ELIGIBLE cases", () => {
  it("a grounded, pure exported off-by-one function is eligible", () => {
    const f = finding({
      headline: "off-by-one in clampIndex",
      body: "Boundary slips by one.",
      failureExample: "export function clampIndex(i, max) { return i <= max ? i : max }",
    })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(true)
    expect(r.klass).toBe("pure-function-logic")
    expect(r.reason).toBe("eligible")
  })

  it("SIG-477: a grounded logic-category boundary bug worded by symptom (no keyword) is eligible via the fallback", () => {
    // The probe-#67 end-to-end shape: grounded, logic category, a pure liftable closure,
    // but the headline names only the SYMPTOM. Reverting the category fallback flips this
    // to `class-not-in-allowlist` — so this asserts the real path the fix unblocks.
    const f = finding({
      category: "logic",
      headline: "`clampIndex` can return `len`, which is out of bounds for an array of length `len`",
      body: "It returns `len`, one past the last valid index.",
      failureExample: "export function clampIndex(i, len) { return Math.min(i, len) }",
    })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(true)
    expect(r.klass).toBe("pure-function-logic")
    // the carve-out: the SAME finding in a non-logic category gets no fallback → ineligible.
    expect(isReproducibleEligible(finding({ ...f, category: "docs" }), NO_AST).reason).toBe("class-not-in-allowlist")
  })

  it("SIG-477: an UNGROUNDED logic-category symptom finding is refused at Gate 1a (grounding is the sole modelfp filter)", () => {
    // The category fallback widens the grounded-logic population reaching the harness, and
    // grounding is the SOLE filter against the modelfp class (correct code + behavior-
    // changing wrong fix). Pin that precondition: with NO grounding, the symptom-worded
    // logic finding must fail-closed at Gate 1a BEFORE the class fallback is even reached.
    const f = finding({
      category: "logic",
      headline: "`clampIndex` can return `len`, which is out of bounds",
      body: "Returns one past the last valid index.",
      evidenceId: "NONE",
      trust: undefined,
      failureExample: "export function clampIndex(i, len) { return Math.min(i, len) }",
    })
    expect(isReproducibleEligible(f, NO_AST).reason).toBe("not-grounded")
  })

  it("a grounded ReDoS regex literal is eligible", () => {
    const f = finding({
      category: "security",
      headline: "ReDoS in the validation regex",
      body: "Catastrophic backtracking.",
      failureExample: "const re = /^(a+)+$/",
    })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(true)
    expect(r.klass).toBe("redos")
  })

  it("eligibility reads the body's fenced code block when no structured field is set", () => {
    const f = finding({
      headline: "off-by-one in range",
      body: "The bound is wrong:\n```ts\nfunction inRange(i) { return i <= 10 }\n```\nshould be `<`.",
      failureExample: undefined,
    })
    expect(isReproducibleEligible(f, NO_AST).eligible).toBe(true)
  })
})

describe("isReproducibleEligible — INELIGIBLE (Gate 1: grounding + allowlist)", () => {
  it("an UNGROUNDED finding is ineligible (no manifest evidence, no trust tier)", () => {
    const f = finding({ evidenceId: "NONE", trust: undefined, failureExample: "function f(i){return i<=10}" })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe("not-grounded")
  })

  it("a grounded-by-tier finding passes Gate 1a", () => {
    const f = finding({
      evidenceId: "NONE",
      trust: { tier: "grounded-model" },
      failureExample: "export function clampIndex(i, max) { return i <= max ? i : max }",
    })
    expect(isReproducibleEligible(f, NO_AST).eligible).toBe(true)
  })

  it("a taint-flow class (SQL injection) is NOT in the allowlist → ineligible", () => {
    const f = finding({
      category: "security",
      headline: "SQL injection in the user query",
      body: "Concatenated query.",
      failureExample: "const q = `SELECT * FROM u WHERE id = ${id}`",
    })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe("class-not-in-allowlist")
  })
})

describe("isReproducibleEligible — INELIGIBLE (Gate 2: dependency-closure purity)", () => {
  it("cited code touching fetch (network) is refused", () => {
    const f = finding({
      failureExample: "async function load(i) { const r = await fetch('/x'); return r.json()[i] }",
    })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(false)
    expect(r.reason).toMatch(/^impure-closure:/)
  })

  it("cited code touching fs is refused", () => {
    const f = finding({ failureExample: "function read(i) { return fs.readFileSync('x')[i] }" })
    expect(isReproducibleEligible(f, NO_AST).reason).toMatch(/^impure-closure:/)
  })

  it("cited code touching a db client (.query()) is refused", () => {
    const f = finding({ failureExample: "async function n(i){ const rows = await db.query('x'); return rows[i] }" })
    expect(isReproducibleEligible(f, NO_AST).reason).toMatch(/^impure-closure:/)
  })

  it("cited code touching process.env is refused", () => {
    const f = finding({ failureExample: "function k(i){ const s = process.env.SECRET; return s.length <= i }" })
    expect(isReproducibleEligible(f, NO_AST).reason).toMatch(/^impure-closure:/)
  })

  it("cited code with a 3rd-party import is refused", () => {
    const f = finding({ failureExample: "import _ from 'lodash'\nfunction f(i){ return _.clamp(i, 0, 10) }" })
    expect(isReproducibleEligible(f, NO_AST).reason).toMatch(/^impure-closure:/)
  })

  it("cited code touching child_process is refused", () => {
    const f = finding({ failureExample: "function r(i){ return execSync('ls').length <= i }" })
    expect(isReproducibleEligible(f, NO_AST).reason).toMatch(/^impure-closure:/)
  })

  it("a co-located OUR AST taint-flow fact on the finding's file refuses (the AST half of Gate 2)", () => {
    const f = finding({ failureExample: "export function clampIndex(i, max) { return i <= max ? i : max }" })
    // An SSRF detector fired on the same file → the reachable closure is I/O-adjacent.
    const r = isReproducibleEligible(f, [{ path: "src/lib/parse.ts", line: 50, astFindingId: "ast/no-ssrf/h/50" }])
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe("impure-closure:ast:no-ssrf")
  })

  it("a co-located AST fact on a DIFFERENT file does NOT refuse", () => {
    const f = finding({ failureExample: "export function clampIndex(i, max) { return i <= max ? i : max }" })
    const r = isReproducibleEligible(f, [{ path: "src/other.ts", line: 50, astFindingId: "ast/no-ssrf/h/50" }])
    expect(r.eligible).toBe(true)
  })
})

describe("isReproducibleEligible — Gate 2 hardening: arbitrary-exec + non-determinism (SIG-477 review)", () => {
  // These wrongly passed as eligible before the review fix. None execute in PR-1 (dark),
  // but a false-ELIGIBLE inflates the GO/NO-GO eligibleFraction → measurement must refuse them.
  const refused = (code: string) => isReproducibleEligible(finding({ failureExample: code }), NO_AST)
  it("eval() is refused (arbitrary code exec)", () => {
    expect(refused("function f(i){ return eval('1+'+i) }").eligible).toBe(false)
  })
  it("new Function() is refused (arbitrary code exec)", () => {
    expect(refused("function f(i){ const g = new Function('return '+i); return g() }").eligible).toBe(false)
  })
  it("the aliased-require bypass (const m = require; m('fs')) is refused", () => {
    expect(refused("function f(i){ const m = require; return m('fs').readFileSync('x')[i] }").eligible).toBe(false)
  })
  it("Math.random() is refused (non-deterministic → no stable two-sided test)", () => {
    expect(refused("function f(i){ return Math.random() < i }").eligible).toBe(false)
  })
  it("Date.now() / new Date() is refused (clock, non-deterministic)", () => {
    expect(refused("function f(i){ return Date.now() % i }").eligible).toBe(false)
    expect(refused("function f(i){ return new Date().getTime() % i }").eligible).toBe(false)
  })
  it("crypto.* and setTimeout are refused (impure / async)", () => {
    expect(refused("function f(i){ return crypto.randomBytes(i).length }").eligible).toBe(false)
    expect(refused("function f(i){ setTimeout(()=>{}, i); return i }").eligible).toBe(false)
  })
  it("REGRESSION: pure Math.floor/Math.max stays ELIGIBLE (only Math.random is impure)", () => {
    const r = refused("export function clampIndex(i, max) { return Math.min(Math.floor(i), max) }")
    expect(r.eligible).toBe(true)
  })
})

describe("isReproducibleEligible — INELIGIBLE (Gate 3: non-fabricated two-sided test)", () => {
  it("a request-tainted fragment is refused (would force fabricating the payload)", () => {
    const f = finding({
      headline: "off-by-one slicing req params",
      failureExample: "function h(req) { return req.params.id.slice(0, req.query.n) }",
    })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe("request-tainted-fragment")
  })

  it("a non-liftable, non-closure fragment is refused", () => {
    // a bare assignment with no function/regex/return — nothing to call.
    const f = finding({ failureExample: "const x = 5" })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe("not-liftable-closure")
  })

  it("a finding with NO cited code is ineligible (nothing to lift)", () => {
    const f = finding({ failureExample: undefined, fixExample: undefined, body: "no code here, just prose" })
    const r = isReproducibleEligible(f, NO_AST)
    expect(r.eligible).toBe(false)
    expect(r.reason).toBe("no-cited-code")
  })
})

describe("isReproducibleEligible — FAIL-OPEN (never throws)", () => {
  it("an unparseable cited snippet returns ineligible, NOT a throw", () => {
    const f = finding({ failureExample: "function ( { this is not valid javascript @@@ " })
    let r: ReturnType<typeof isReproducibleEligible>
    expect(() => {
      r = isReproducibleEligible(f, NO_AST)
    }).not.toThrow()
    expect(r!.eligible).toBe(false)
    // unparseable → not a liftable closure (parse failure makes it un-liftable).
    expect(r!.reason).toBe("not-liftable-closure")
  })

  it("a missing/garbage finding shape returns ineligible, NOT a throw", () => {
    const garbage = { score: 4 } as unknown as PrReviewFinding
    let r: ReturnType<typeof isReproducibleEligible>
    expect(() => {
      r = isReproducibleEligible(garbage, NO_AST)
    }).not.toThrow()
    expect(r!.eligible).toBe(false)
  })
})
