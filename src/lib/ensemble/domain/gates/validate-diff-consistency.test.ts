// SIG-602 v1: diff-consistency gate tests.
//
// Layer 1: evaluateDiffConsistency pure unit tests — the three provable-
// contradiction checks (self-contradiction, claimed-missing-file-present,
// export-status-contradicted), each with its FP-safe KEEP cases, plus the
// mode parser and the never-throws contract.
//
// Layer 2: validateForSubmission integration — off / shadow / enforce wiring,
// the droppedForFailedDiffConsistencyValidation counter, and the
// onDiffConsistencyFindingDropped callback. Mirrors the style of
// validate-absence-grounding.test.ts.

import { describe, it, expect, vi } from "vitest"
import {
  evaluateDiffConsistency,
  parseDiffConsistencyValidatorMode,
  type DiffConsistencyContext,
} from "@/src/lib/ensemble/domain/gates/validate-diff-consistency"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

const PATH = "src/lib/orders.ts"

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: PATH,
    line: 17,
    score: 3,
    category: "logic",
    headline: "an ordinary nit",
    body: "nothing contradictory here.",
    ...overrides,
  }
}

function ctx(overrides: Partial<DiffConsistencyContext> = {}): DiffConsistencyContext {
  return {
    reviewablePaths: new Set<string>(),
    addedLineTextByLine: undefined,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────
describe("parseDiffConsistencyValidatorMode", () => {
  it("maps shadow/enforce case- and whitespace-insensitively; everything else → off", () => {
    expect(parseDiffConsistencyValidatorMode("shadow")).toBe("shadow")
    expect(parseDiffConsistencyValidatorMode("  ENFORCE ")).toBe("enforce")
    expect(parseDiffConsistencyValidatorMode("Shadow")).toBe("shadow")
    expect(parseDiffConsistencyValidatorMode(undefined)).toBe("off")
    expect(parseDiffConsistencyValidatorMode("")).toBe("off")
    expect(parseDiffConsistencyValidatorMode("on")).toBe("off")
  })
})

// ─────────────────────────────────────────────────────────────────────
describe("evaluateDiffConsistency — (1) self-contradiction", () => {
  it("fires: headline says a token is missing, body affirms the SAME token is present", () => {
    const f = finding({
      headline: "missing `guard` before the deref",
      body: "The `guard` is already present on the line above, so this is safe.",
    })
    expect(evaluateDiffConsistency(f, ctx())).toEqual({ keep: false, reason: "self-contradiction" })
  })

  it("KEEPS a nuanced finding whose body ALSO concedes an absence (present on happy path, missing on error branch)", () => {
    const f = finding({
      headline: "missing `guard` on the error branch",
      body: "The `guard` is present on the happy path but missing on the error branch.",
    })
    expect(evaluateDiffConsistency(f, ctx())).toEqual({ keep: true })
  })

  it("KEEPS when the body's presence claim is about a DIFFERENT token than the headline's absence", () => {
    const f = finding({
      headline: "missing `validateInput`",
      body: "The `logger` is already present, but that's unrelated.",
    })
    expect(evaluateDiffConsistency(f, ctx())).toEqual({ keep: true })
  })

  it("KEEPS a plain absence-claim with no presence affirmation in the body", () => {
    const f = finding({ headline: "missing `nullCheck`", body: "This should be added before the deref." })
    expect(evaluateDiffConsistency(f, ctx())).toEqual({ keep: true })
  })

  it("KEEPS when the headline makes no absence claim", () => {
    const f = finding({ headline: "`retryCount` is off by one", body: "The `retryCount` is present but wrong." })
    expect(evaluateDiffConsistency(f, ctx())).toEqual({ keep: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
describe("evaluateDiffConsistency — (2) claimed-missing-file-present", () => {
  const reviewablePaths = new Set(["src/lib/orders.ts", "src/lib/orders_test.go"])

  it("fires: a test file reported missing that IS in the PR (basename match)", () => {
    const f = finding({
      headline: "missing test file `orders_test.go`",
      body: "The new logic has no coverage.",
    })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths }))).toEqual({
      keep: false,
      reason: "claimed-missing-file-present",
    })
  })

  it("KEEPS a locational reference: 'missing null check in `orders.ts`' (file is the location, not the missing thing)", () => {
    const f = finding({
      headline: "missing null check in `orders.ts`",
      body: "A null value would throw here.",
    })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths }))).toEqual({ keep: true })
  })

  it("KEEPS when the named missing file is genuinely NOT in the PR", () => {
    const f = finding({
      headline: "missing test file `payments_test.go`",
      body: "No coverage for the new path.",
    })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths }))).toEqual({ keep: true })
  })

  it("KEEPS when the file token is present but there is no absence marker attached to it", () => {
    const f = finding({ headline: "consider splitting `orders_test.go`", body: "It's getting long." })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths }))).toEqual({ keep: true })
  })

  it("KEEPS when no reviewable paths are wired (no ground truth)", () => {
    const f = finding({ headline: "missing test file `orders_test.go`", body: "" })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths: new Set() }))).toEqual({ keep: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
describe("evaluateDiffConsistency — (3) export-status-contradicted (Go)", () => {
  const GO = "src/lib/orders.go"
  const added = (line: string) => new Map([[GO, new Map([[10, line]])]])

  it("fires: 'exported' claim on a lower-case Go identifier that is in the diff", () => {
    const f = finding({
      path: GO,
      headline: "the exported function `parseOrder` should be documented",
      body: "`parseOrder` is exported and needs a doc comment.",
    })
    expect(evaluateDiffConsistency(f, ctx({ addedLineTextByLine: added("func parseOrder() error {") }))).toEqual({
      keep: false,
      reason: "export-status-contradicted",
    })
  })

  it("fires: 'unexported' claim on an upper-case Go identifier", () => {
    const f = finding({
      path: GO,
      headline: "`ParseOrder` is unexported and unreachable from other packages",
      body: "It is not exported.",
    })
    expect(evaluateDiffConsistency(f, ctx({ addedLineTextByLine: added("func ParseOrder() error {") }))).toEqual({
      keep: false,
      reason: "export-status-contradicted",
    })
  })

  it("KEEPS a correct 'exported' claim on an upper-case identifier", () => {
    const f = finding({
      path: GO,
      headline: "the exported function `ParseOrder` should be documented",
      body: "`ParseOrder` is exported.",
    })
    expect(evaluateDiffConsistency(f, ctx({ addedLineTextByLine: added("func ParseOrder() error {") }))).toEqual({
      keep: true,
    })
  })

  it("KEEPS on a non-Go file even with the same wording", () => {
    const f = finding({
      path: PATH, // .ts — no Go capitalization rule
      headline: "the exported function `parseOrder` should be documented",
      body: "`parseOrder` is exported.",
    })
    expect(
      evaluateDiffConsistency(f, ctx({ addedLineTextByLine: new Map([[PATH, new Map([[10, "parseOrder"]])]]) })),
    ).toEqual({ keep: true })
  })

  it("KEEPS the overloaded word 'public' (only exported/unexported are unambiguous Go terms)", () => {
    const f = finding({
      path: GO,
      headline: "`parseOrder` is part of the public API",
      body: "This public function needs docs.",
    })
    expect(evaluateDiffConsistency(f, ctx({ addedLineTextByLine: added("func parseOrder() error {") }))).toEqual({
      keep: true,
    })
  })

  it("KEEPS when the identifier does not appear in the changed lines (can't confirm it's the symbol)", () => {
    const f = finding({
      path: GO,
      headline: "the exported function `parseOrder` should be documented",
      body: "",
    })
    expect(evaluateDiffConsistency(f, ctx({ addedLineTextByLine: added("func somethingElse() {") }))).toEqual({
      keep: true,
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Regressions for the false-positive vectors the code-review found. Each is a
// REAL finding shape that must be KEPT (recall-safety).
describe("evaluateDiffConsistency — false-positive regressions", () => {
  const reviewablePaths = new Set(["src/lib/orders.go", "src/lib/orders_test.go"])
  const GO = "src/lib/orders.go"

  // FP-1: "missing test FOR a present file" — the file is the referent, the test is the missing thing.
  it("FP-1: keeps 'missing test for `orders.go`' (present file, test is what's missing)", () => {
    const f = finding({ headline: "missing test for `orders.go`", body: "The new branch has no coverage." })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths }))).toEqual({ keep: true })
  })
  it("FP-1: keeps 'no coverage for `orders.go`'", () => {
    const f = finding({ headline: "no coverage for `orders.go`", body: "" })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths }))).toEqual({ keep: true })
  })

  // FP-2: bare "no" asserting the present file should be LEFT ALONE (opposite of missing).
  it("FP-2: keeps 'no changes to `orders.go` required'", () => {
    const f = finding({ headline: "no changes to `orders.go` required", body: "Looks correct as-is." })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths }))).toEqual({ keep: true })
  })
  it("FP-2: keeps 'there is no reason to touch `orders.go`'", () => {
    const f = finding({ headline: "keep it simple", body: "there is no reason to touch `orders.go` here." })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths }))).toEqual({ keep: true })
  })

  // FP-3: defined-but-not-called / included-but-not-set are REAL bugs, not contradictions.
  it("FP-3: keeps 'defined ... but is never called' (defined-but-not-invoked bug)", () => {
    const f = finding({
      headline: "missing `validateInput` call",
      body: "`validateInput` is defined above but is never called on the error path.",
    })
    expect(evaluateDiffConsistency(f, ctx())).toEqual({ keep: true })
  })
  it("FP-3: keeps 'included ... but is not set' (config-present-but-unset bug)", () => {
    const f = finding({
      headline: "missing `apiKey` at runtime",
      body: "`apiKey` is included in the schema but is not set at runtime.",
    })
    expect(evaluateDiffConsistency(f, ctx())).toEqual({ keep: true })
  })

  // FP-4: an export word must not bind to a DIFFERENT backticked identifier.
  it("FP-4: does not flag `parseOrder` when 'exported' describes a different symbol", () => {
    const f = finding({
      path: GO,
      headline: "the exported `Handler` wraps `parseOrder`",
      body: "`parseOrder` is an internal helper.",
    })
    const added = new Map([[GO, new Map([[10, "func parseOrder() error {"]])]])
    expect(evaluateDiffConsistency(f, ctx({ addedLineTextByLine: added }))).toEqual({ keep: true })
  })

  // FP-5: a basename shared across paths is ambiguous → keep.
  it("FP-5: keeps 'missing `orders.go`' when the basename collides across paths", () => {
    const f = finding({ headline: "missing `orders.go` at the repo root", body: "" })
    const colliding = new Set(["pkg/a/orders.go", "pkg/b/orders.go"])
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths: colliding }))).toEqual({ keep: true })
  })
})

// ─────────────────────────────────────────────────────────────────────
// SIG-602 offline-audit regressions: real, verified-correct test-coverage
// findings on a PR that adds source files and NO tests. The source files ARE
// in the diff, so the gate must NOT read "ships without tests" + a leading body
// filename as "the file is missing." (Found by auditing the gate on 67 real
// Sigilix findings before enforce.)
describe("evaluateDiffConsistency — SIG-602 audit regressions (no-tests-for-present-file)", () => {
  const paths = new Set(["server/auth.ts", "server/refunds.ts", "server/api.ts"])

  it("keeps: headline 'ships without tests' + body led by the present source file (cross-segment)", () => {
    const f = finding({
      path: "server/auth.ts",
      category: "testing",
      headline: "New auth middleware with a critical authentication branch ships without tests",
      body: "`server/auth.ts` is a new 28-line module handling the login branch; it has no accompanying test.",
    })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths: paths }))).toEqual({ keep: true })
  })

  it("keeps: same-segment 'without tests `source.ts`' (tests are the missing thing, not the file)", () => {
    const f = finding({
      path: "server/refunds.ts",
      category: "testing",
      headline: "Refund module ships without tests `server/refunds.ts`",
      body: "The dollars-to-cents conversion and DB write path are untested.",
    })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths: paths }))).toEqual({ keep: true })
  })

  it("keeps: 'no test coverage for `server/api.ts`'", () => {
    const f = finding({
      path: "server/api.ts",
      category: "testing",
      headline: "New Express middleware setup ships with no test coverage",
      body: "`server/api.ts` wires the middleware; add coverage for the new routes.",
    })
    expect(evaluateDiffConsistency(f, ctx({ reviewablePaths: paths }))).toEqual({ keep: true })
  })

  it("STILL demotes: a test FILE named as missing that is actually in the PR (Ruslan's original case)", () => {
    const f = finding({
      path: "server/auth.ts",
      category: "testing",
      headline: "missing test file `auth_test.ts`",
      body: "The new auth branch has no sibling spec.",
    })
    expect(
      evaluateDiffConsistency(f, ctx({ reviewablePaths: new Set(["server/auth.ts", "server/auth_test.ts"]) })),
    ).toEqual({ keep: false, reason: "claimed-missing-file-present" })
  })
})

// ─────────────────────────────────────────────────────────────────────
describe("evaluateDiffConsistency — robustness", () => {
  it("never throws on empty / weird findings", () => {
    expect(() => evaluateDiffConsistency(finding({ headline: "", body: "" }), ctx())).not.toThrow()
    // A regex-special backticked token + an odd (unclosed) backtick in the body
    // must not throw (escapeRegExp + the `?? ""` group guard).
    expect(() =>
      evaluateDiffConsistency(finding({ headline: "missing `a.b(c[d]` here", body: "one stray ` backtick" }), ctx()),
    ).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────
// Layer 2 — integration through the real validateForSubmission path.
type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

function makeReviewable(path = PATH): ReviewableMap {
  return new Map([[path, [{ line: 17, side: "RIGHT" as const, position: 1 }]]])
}
function makeSpecialistVerdicts(): SpecialistVerdictsArg {
  return [{ role: "logic", verdict: { findings: [{ id: "logic-0" }] } }] as unknown as SpecialistVerdictsArg
}
function prov(count = 1, sourceId = "logic-0"): SynthesizerProvenance {
  return {
    findings: Array.from({ length: count }, () => ({
      sourceSpecialists: ["logic"],
      sourceFindingIds: [sourceId],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    })),
    dropped: [],
    softened: [],
  }
}
const ADDED = new Map([[PATH, new Map([[17, "  return order.total"]])]])

function contradictedFinding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return finding({
    score: 3,
    category: "logic",
    headline: "missing `guard` before the deref",
    body: "The `guard` is already present on the line above, so this is safe.",
    ...overrides,
  })
}

function run(findings: PrReviewFinding[], mode?: "off" | "shadow" | "enforce", onDrop?: (...a: unknown[]) => void) {
  return validateForSubmission({
    synthOutput: {
      verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings },
      provenance: prov(findings.length),
    },
    reviewable: makeReviewable(),
    specialistVerdicts: makeSpecialistVerdicts(),
    addedLineTextByLine: ADDED,
    ...(mode ? { diffConsistencyValidatorMode: mode } : {}),
    ...(onDrop ? { onDiffConsistencyFindingDropped: onDrop } : {}),
  })
}

describe("validateForSubmission — SIG-602 diff-consistency gate", () => {
  it("OFF (default): the gate never runs — counter 0, callback not fired", () => {
    const onDrop = vi.fn()
    const result = run([contradictedFinding()], undefined, onDrop)
    expect(result.droppedForFailedDiffConsistencyValidation).toBe(0)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it("SHADOW: counts the would-demote + fires callback dropped:false but KEEPS the finding", () => {
    const onDrop = vi.fn()
    const result = run([contradictedFinding()], "shadow", onDrop)
    expect(result.droppedForFailedDiffConsistencyValidation).toBe(1)
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), { reason: "self-contradiction", dropped: false })
  })

  it("ENFORCE: counts + fires the callback for the contradicted finding", () => {
    const onDrop = vi.fn()
    const result = run([contradictedFinding()], "enforce", onDrop)
    expect(result.droppedForFailedDiffConsistencyValidation).toBe(1)
    expect(onDrop).toHaveBeenCalled()
  })

  it("ENFORCE: a non-contradicted finding is untouched — counter stays 0", () => {
    const onDrop = vi.fn()
    const result = run([finding({ headline: "`total` may overflow", body: "Consider a bigint." })], "enforce", onDrop)
    expect(result.droppedForFailedDiffConsistencyValidation).toBe(0)
    expect(onDrop).not.toHaveBeenCalled()
  })
})
