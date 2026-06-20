// SIG-476 PR1 — in-worker deterministic confirmation tests.
//
// `confirmFindingAgainstInWorkerAst` says "confirmed" only when a sev>=4 security
// finding's class — derived from FINDING-OWN signals ONLY — is independently
// corroborated by a co-located AST fact of the SAME class that is NOT the finding's
// own evidence. The two load-bearing properties under test are NON-CIRCULARITY
// (the class is read from a stripped `{evidenceId, cweId}`, never the full finding)
// and the INDEPENDENCE GUARD (the corroborating fact ≠ the finding's own AST fact),
// plus the MOAT guard that this can only ever yield `deterministic-confirmed`,
// never `runner-confirmed`.

import { describe, expect, it } from "vitest"
import {
  confirmFindingAgainstInWorkerAst,
  ownAstFactRef,
  sameAstFact,
} from "@/src/lib/verification/confirm-finding-inworker"
import { resolveTier } from "@/src/lib/ensemble/domain/gates/trust-ledger-thread"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { InWorkerConfirmDecision } from "@/src/lib/verification/confirm-finding-inworker"

function finding(over: { [K in keyof PrReviewFinding]?: PrReviewFinding[K] | undefined } = {}): PrReviewFinding {
  return {
    path: "src/auth.ts",
    line: 42,
    score: 5,
    category: "security",
    headline: "eval of user input",
    body: "An `eval` on request data.",
    ...over,
  } as PrReviewFinding
}

// An OUR-engine AST security fact (the input `coLocatedAstFactIds` consumes).
function astFact(over: Partial<{ path: string; line: number; astFindingId: string }> = {}) {
  return {
    path: "src/auth.ts",
    line: 40,
    astFindingId: "ast/no-eval-call/diff5678/40",
    ...over,
  }
}

describe("confirmFindingAgainstInWorkerAst — verdicts", () => {
  it("(a) confirmed: class from cweId, independent co-located AST fact of that class in window", () => {
    // class = code-injection (CWE-94, finding-own); the AST fact is no-eval-call
    // (→ code-injection), at line 40 within the window of 42, and is NOT the
    // finding's own evidence (the finding has no `ast:` evidenceId).
    const f = finding({ evidenceId: "NONE", cweId: "CWE-94" })
    expect(confirmFindingAgainstInWorkerAst(f, [astFact()])).toBe("confirmed")
  })

  it("(b) no-check: severity below 4 / non-security", () => {
    expect(confirmFindingAgainstInWorkerAst(finding({ score: 3, cweId: "CWE-94" }), [astFact()])).toBe("no-check")
    expect(confirmFindingAgainstInWorkerAst(finding({ category: "logic", cweId: "CWE-94" }), [astFact()])).toBe(
      "no-check",
    )
  })

  it("(c) inconclusive: no co-located fact of the finding's class", () => {
    // finding class = sql-injection (CWE-89); the only co-located fact is
    // no-eval-call (code-injection) → class mismatch → no corroboration.
    const f = finding({ evidenceId: "NONE", cweId: "CWE-89" })
    expect(confirmFindingAgainstInWorkerAst(f, [astFact()])).toBe("inconclusive")
  })

  it("(c') inconclusive: class match but OUTSIDE the line window", () => {
    const f = finding({ evidenceId: "NONE", cweId: "CWE-94" })
    expect(confirmFindingAgainstInWorkerAst(f, [astFact({ line: 99 })])).toBe("inconclusive")
  })

  it("(d) inconclusive: findingClass null (class only derivable from the AST fact)", () => {
    // evidenceId is the `ast:` fact itself and there is NO cwe, so a STRIPPED
    // {evidenceId, cweId} could still read the ast: id — but the stripped class
    // would then equal the fact's class and the independence guard would drop the
    // sole fact. Here we make the class genuinely underivable from finding-own
    // signals: a worker-token (secret:) evidenceId + no cwe → findingClass null.
    const f = finding({ evidenceId: "secret:aws-access-key:abc123:42", cweId: undefined })
    expect(confirmFindingAgainstInWorkerAst(f, [astFact()])).toBe("inconclusive")
  })

  it("(e) INDEPENDENCE GUARD: the only class-matched co-located fact IS the finding's own evidence → inconclusive", () => {
    // The finding's OWN evidence is an `ast:` id whose embedded astFindingId is the
    // SAME fact the AST engine reports co-located. Deriving the class from the
    // stripped {evidenceId, cweId} yields code-injection (from the ast: rule), and
    // the single co-located fact is that SAME fact → would be GROUNDED, not
    // CONFIRMED. The guard must drop it → inconclusive.
    const ownFactId = "ast/no-eval-call/abc1234/42"
    const f = finding({ evidenceId: `ast:no-eval-call:${ownFactId}`, cweId: undefined })
    const own = astFact({ line: 42, astFindingId: ownFactId })
    expect(confirmFindingAgainstInWorkerAst(f, [own])).toBe("inconclusive")
  })

  it("(e') confirmed: own fact present AND a DISTINCT independent class-matched fact", () => {
    // Same own `ast:` evidence as (e), but now a SECOND, different no-eval-call
    // fact (distinct hash+line) co-locates — an independent witness survives the
    // guard → confirmed.
    const ownFactId = "ast/no-eval-call/abc1234/42"
    const f = finding({ evidenceId: `ast:no-eval-call:${ownFactId}`, cweId: undefined })
    const own = astFact({ line: 42, astFindingId: ownFactId })
    const independent = astFact({ line: 41, astFindingId: "ast/no-eval-call/zzz9999/41" })
    expect(confirmFindingAgainstInWorkerAst(f, [own, independent])).toBe("confirmed")
  })

  it("(f) fail-closed: contradictory deterministic class signals → inconclusive (never confirmed)", () => {
    // ast: rule says ssrf, cwe says sql-injection → canonicalClassForFinding
    // returns null (conflict) → findingClass null → inconclusive, even though a
    // co-located ssrf fact exists.
    const f = finding({ evidenceId: "ast:no-ssrf:ast/no-ssrf/h/42", cweId: "CWE-89" })
    const ssrfFact = astFact({ line: 42, astFindingId: "ast/no-ssrf/other/42" })
    expect(confirmFindingAgainstInWorkerAst(f, [ssrfFact])).toBe("inconclusive")
  })
})

describe("confirmFindingAgainstInWorkerAst — MOAT guard (never runner-confirmed)", () => {
  it("the helper only ever yields a deterministic-confirmed-class decision (by type)", () => {
    // Compile-time: the decision union excludes any runner-* verdict. Assert at
    // runtime that a confirmed verdict is exactly the `confirmed` token (which PR2
    // maps to `deterministic-confirmed`, NEVER `runner-confirmed`).
    const f = finding({ evidenceId: "NONE", cweId: "CWE-94" })
    const decision: InWorkerConfirmDecision = confirmFindingAgainstInWorkerAst(f, [astFact()])
    expect(decision).toBe("confirmed")
    // Exhaustive: the only verdicts are these three — no runner verdict exists.
    expect<readonly InWorkerConfirmDecision[]>(["confirmed", "inconclusive", "no-check"]).toContain(decision)
  })

  it("a deterministic-confirmed signal alone resolves to deterministic-confirmed, never runner-confirmed", () => {
    // The whole moat: a self-confirmed finding (no runner signal) is
    // deterministic-confirmed…
    expect(resolveTier(["deterministic-confirmed"])).toBe("deterministic-confirmed")
    expect(resolveTier(["deterministic-confirmed", "grounded-model", "worker-token-confirmed"])).toBe(
      "deterministic-confirmed",
    )
    // …but a CI runner receipt always outranks it.
    expect(resolveTier(["deterministic-confirmed", "runner-confirmed"])).toBe("runner-confirmed")
  })
})

describe("ownAstFactRef / sameAstFact — id-shape normalization (anti-circularity primitives)", () => {
  it("extracts the embedded astFindingId from an ast:<ruleId>:<astFindingId> evidenceId", () => {
    expect(ownAstFactRef("ast:no-eval-call:ast/no-eval-call/abc1234/42")).toEqual({
      ruleId: "no-eval-call",
      hash: "abc1234",
      line: "42",
    })
  })

  it("returns null for non-ast: / non-parseable evidence ids", () => {
    expect(ownAstFactRef("NONE")).toBeNull()
    expect(ownAstFactRef(undefined)).toBeNull()
    expect(ownAstFactRef("secret:aws-access-key:abc:42")).toBeNull()
    expect(ownAstFactRef("ast:no-eval-call:")).toBeNull() // no embedded fact
  })

  it("sameAstFact compares on the normalized ruleId/hash/line, not the raw string", () => {
    const ref = ownAstFactRef("ast:no-eval-call:ast/no-eval-call/abc1234/42")!
    // Same underlying fact (bare astFindingId form) → same.
    expect(sameAstFact("ast/no-eval-call/abc1234/42", ref)).toBe(true)
    // Different hash → different fact (independent witness).
    expect(sameAstFact("ast/no-eval-call/zzz9999/42", ref)).toBe(false)
    // Different line → different fact.
    expect(sameAstFact("ast/no-eval-call/abc1234/41", ref)).toBe(false)
    // Unparseable co-located id → not the same fact.
    expect(sameAstFact("not-an-ast-id", ref)).toBe(false)
  })
})
