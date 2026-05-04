// Phase 4a orchestrator pure-helper tests. Integration testing of the
// full handlePrReviewEnsemble pipeline is deferred to shadow-mode
// dogfooding — too much network mocking surface for unit tests, and
// Phase 4a ships off-by-default so production-traffic risk is zero
// until OPENCLAW_ENSEMBLE_REVIEW_MODE is flipped.

import { describe, expect, it } from "vitest"
import {
  assignStableFindingIds,
  checkQuorum,
  truncateVerdictToTokens,
  validateForSubmission,
  routeReview,
  isPermanentFailure,
} from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewVerdict, PrReviewFinding } from "../src/lib/triage-pr-review"
import type { Env } from "../src/index"
import type { ReviewableMap } from "../src/lib/diff-positions"

const baseFinding: PrReviewFinding = {
  path: "src/lib/foo.ts",
  line: 42,
  score: 4,
  category: "logic",
  headline: "off-by-one in `clampIndex`",
  body: "Wrap with `if (!user) return` before accessing `user.profile`.",
}

const baseVerdict: PrReviewVerdict = {
  summary: "One real bug.",
  confidence: 4,
  confidenceReason: "Clear off-by-one.",
  findings: [baseFinding],
}

describe("assignStableFindingIds", () => {
  it("assigns deterministic IDs scoped by role", () => {
    const out = assignStableFindingIds("logic", {
      ...baseVerdict,
      findings: [baseFinding, { ...baseFinding, line: 50 }, { ...baseFinding, line: 60 }],
    })
    expect(out.findings.map((f) => f.id)).toEqual(["logic-0", "logic-1", "logic-2"])
  })

  it("preserves all original finding fields", () => {
    const out = assignStableFindingIds("security", baseVerdict)
    expect(out.findings[0]).toMatchObject({
      ...baseFinding,
      id: "security-0",
    })
  })
})

describe("checkQuorum", () => {
  const v = (role: "logic" | "security" | "performance" | "tests") => ({
    role,
    verdict: { ...baseVerdict, findings: [{ ...baseFinding, id: `${role}-0` }] },
    elapsedMs: 100,
  })
  const allFour: Array<"logic" | "security" | "performance" | "tests"> = [
    "logic", "security", "performance", "tests",
  ]

  it("returns false on 0 successes (any dispatched count)", () => {
    expect(checkQuorum([], "shadow", allFour)).toBe(false)
    expect(checkQuorum([], "post", allFour)).toBe(false)
    expect(checkQuorum([], "shadow", ["performance"])).toBe(false)
  })

  it("with all 4 dispatched: returns false on only 1 success", () => {
    expect(checkQuorum([v("logic")], "shadow", allFour)).toBe(false)
    expect(checkQuorum([v("logic")], "post", allFour)).toBe(false)
  })

  it("shadow accepts any 2/4 when 4 dispatched", () => {
    expect(checkQuorum([v("performance"), v("tests")], "shadow", allFour)).toBe(true)
    expect(checkQuorum([v("logic"), v("security")], "shadow", allFour)).toBe(true)
  })

  it("post requires ≥1 of {logic, security} when router dispatched them", () => {
    expect(checkQuorum([v("performance"), v("tests")], "post", allFour)).toBe(false)
    expect(checkQuorum([v("logic"), v("performance")], "post", allFour)).toBe(true)
    expect(checkQuorum([v("security"), v("tests")], "post", allFour)).toBe(true)
    expect(checkQuorum([v("logic"), v("security"), v("performance")], "post", allFour)).toBe(true)
  })

  // Arc PR #35 catch: router-aware quorum
  it("router dispatched ONLY 1 specialist → that 1 success is enough (CSS-only case)", () => {
    // CSS-only → router returns ["performance"]. If perf succeeds,
    // ensemble proceeds; original `< 2` rule blocked this.
    expect(checkQuorum([v("performance")], "shadow", ["performance"])).toBe(true)
    expect(checkQuorum([v("performance")], "post", ["performance"])).toBe(true)
  })

  it("router dispatched 2 specialists → both must succeed in shadow", () => {
    expect(checkQuorum([v("logic")], "shadow", ["logic", "security"])).toBe(false)
    expect(checkQuorum([v("logic"), v("security")], "shadow", ["logic", "security"])).toBe(true)
  })

  it("router excluded logic+security (rare) → post mode skips that requirement", () => {
    // If router dispatched only ["performance"] (no logic/sec), post
    // mode shouldn't fail just because logic/sec aren't in succeeded.
    expect(checkQuorum([v("performance")], "post", ["performance"])).toBe(true)
  })

  it("router dispatched 1 specialist that failed → quorum fails", () => {
    expect(checkQuorum([], "shadow", ["performance"])).toBe(false)
  })
})

describe("truncateVerdictToTokens", () => {
  it("returns the verdict unchanged when under the cap", () => {
    const out = truncateVerdictToTokens(
      { ...baseVerdict, findings: [{ ...baseFinding, id: "logic-0" }] },
      1000,
    )
    expect(out.findings).toHaveLength(1)
  })

  it("drops lowest-score findings first to preserve severity", () => {
    // Each finding has a long body to force aggressive truncation.
    const longBody = "x".repeat(800)
    const findings = [
      { ...baseFinding, id: "logic-0", score: 1, body: longBody, headline: "nit" },
      { ...baseFinding, id: "logic-1", score: 5, body: longBody, headline: "critical" },
      { ...baseFinding, id: "logic-2", score: 3, body: longBody, headline: "maintain" },
      { ...baseFinding, id: "logic-3", score: 2, body: longBody, headline: "minor" },
    ]
    // Cap = 500 tokens → 2000 char budget. Each finding ~900 chars.
    // Should fit at most 1-2 findings; the highest-score one MUST survive.
    const out = truncateVerdictToTokens({ ...baseVerdict, findings }, 500)
    expect(out.findings.length).toBeLessThan(4)
    expect(out.findings[0]?.score).toBe(5) // highest-score always survives
    expect(out.findings.some((f) => f.score === 1)).toBe(false) // score-1 dropped first
  })
})

describe("validateForSubmission — hallucination guard + line validity + score-1 demotion", () => {
  const reviewable: ReviewableMap = new Map([
    ["src/lib/foo.ts", [
      { line: 42, side: "RIGHT" },
      { line: 50, side: "RIGHT" },
    ]],
  ])

  const specialistVerdicts = [
    {
      role: "logic" as const,
      verdict: {
        ...baseVerdict,
        findings: [
          { ...baseFinding, id: "logic-0", line: 42, score: 4 },
          { ...baseFinding, id: "logic-1", line: 50, score: 1, headline: "minor nit" },
        ],
      },
      elapsedMs: 100,
    },
  ]

  it("keeps a finding with valid provenance + reviewable line", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: [{ ...baseFinding, line: 42, score: 4 }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
          retrievalCallsUsed: 0,
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.droppedForHallucination).toBe(0)
    expect(out.droppedForInvalidLine).toBe(0)
    expect(out.demotedScore1).toBe(0)
  })

  it("DROPS findings whose provenance references a non-existent specialist finding (hallucination guard)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 42, score: 4, headline: "FAKE FINDING" }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-99"],  // doesn't exist!
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
          retrievalCallsUsed: 0,
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForHallucination).toBe(1)
  })

  it("DROPS findings with empty sourceFindingIds (hallucination)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: { ...baseVerdict, findings: [{ ...baseFinding, line: 42, score: 4 }] },
        provenance: {
          findings: [{
            sourceSpecialists: [],
            sourceFindingIds: [],  // empty!
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
          retrievalCallsUsed: 0,
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForHallucination).toBe(1)
  })

  it("DROPS findings whose (path, line) is not a reviewable position", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 999, score: 4 }],  // line 999 not in diff
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
          retrievalCallsUsed: 0,
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
  })

  it("DEMOTES score-1 findings to summary, never inline", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          summary: "ok",
          findings: [
            { ...baseFinding, line: 42, score: 1, headline: "first nit" },
            { ...baseFinding, line: 50, score: 1, headline: "second nit" },
          ],
        },
        provenance: {
          findings: [
            { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-1"], action: "kept", verifiedViaRetrieval: false },
            { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-1"], action: "kept", verifiedViaRetrieval: false },
          ],
          dropped: [],
          retrievalCallsUsed: 0,
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)  // score-1 never goes inline
    expect(out.demotedScore1).toBe(2)
    expect(out.verdict.summary).toContain("Advisory nits:")
    expect(out.verdict.summary).toContain("first nit")
  })

  it("caps advisory nits at 5, appends 'plus N more' (v3.1 spec)", () => {
    const findings = Array.from({ length: 8 }, (_, i) => ({
      ...baseFinding,
      line: 42,
      score: 1,
      headline: `nit ${i}`,
    }))
    const provenance = findings.map(() => ({
      sourceSpecialists: ["logic" as const],
      sourceFindingIds: ["logic-1"],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    }))
    const out = validateForSubmission({
      synthOutput: {
        verdict: { ...baseVerdict, summary: "ok", findings },
        provenance: {
          findings: provenance,
          dropped: [],
          retrievalCallsUsed: 0,
        },
      },
      reviewable,
      specialistVerdicts,
    })
    // Top 5 emitted in summary, "plus 3 more" appended.
    expect(out.verdict.summary).toContain("plus 3 more advisory nits")
  })

  it("matches provenance to verdict findings BY INDEX, not by headline", () => {
    // Two findings with similar headlines — index match must still
    // resolve correctly (Codex catch round 3).
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [
            { ...baseFinding, line: 42, score: 4, headline: "common headline" },
            { ...baseFinding, line: 50, score: 3, headline: "common headline" },
          ],
        },
        provenance: {
          findings: [
            { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
            { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-99"], action: "kept", verifiedViaRetrieval: false },  // index 1 = bad source
          ],
          dropped: [],
          retrievalCallsUsed: 0,
        },
      },
      reviewable,
      specialistVerdicts,
    })
    // First finding (index 0) keeps; second (index 1) drops despite identical headline.
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.line).toBe(42)
    expect(out.droppedForHallucination).toBe(1)
  })
})

describe("routeReview", () => {
  const baseEnv: Env = {
    OPENCLAW_STATE: { get: async () => null, put: async () => {} } as unknown as KVNamespace,
  } as unknown as Env

  it("returns phase3-singleshot-legacy when mode=off and agentic mode off", async () => {
    const decision = await routeReview({
      env: { ...baseEnv, OPENCLAW_ENSEMBLE_REVIEW_MODE: "off" },
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
    })
    expect(decision).toEqual({ primary: "phase3-singleshot-legacy" })
  })

  it("returns phase3-agentic when mode=off and agentic mode on", async () => {
    const decision = await routeReview({
      env: { ...baseEnv, OPENCLAW_ENSEMBLE_REVIEW_MODE: "off", OPENCLAW_AGENTIC_GITHUB_MODE: "on" },
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
    })
    expect(decision).toEqual({ primary: "phase3-agentic" })
  })

  it("returns ensemble-shadow + phase3-agentic secondary in shadow mode", async () => {
    const decision = await routeReview({
      env: {
        ...baseEnv,
        OPENCLAW_ENSEMBLE_REVIEW_MODE: "shadow",
        OPENCLAW_AGENTIC_GITHUB_MODE: "on",
      },
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
    })
    expect(decision).toEqual({ primary: "ensemble-shadow", secondary: "phase3-agentic" })
  })

  it("returns ensemble-post in post mode", async () => {
    const decision = await routeReview({
      env: { ...baseEnv, OPENCLAW_ENSEMBLE_REVIEW_MODE: "post" },
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
    })
    expect(decision).toEqual({ primary: "ensemble-post" })
  })

  it("falls through to Phase 3 when repo not in allowlist", async () => {
    const decision = await routeReview({
      env: {
        ...baseEnv,
        OPENCLAW_ENSEMBLE_REVIEW_MODE: "shadow",
        OPENCLAW_ENSEMBLE_REVIEW_ALLOWED_REPOS: "Arc-and-Anchor/other-repo",
        OPENCLAW_AGENTIC_GITHUB_MODE: "on",
      },
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
    })
    expect(decision).toEqual({ primary: "phase3-agentic" })
  })

  it("matches repo allowlist case-insensitively", async () => {
    const decision = await routeReview({
      env: {
        ...baseEnv,
        OPENCLAW_ENSEMBLE_REVIEW_MODE: "shadow",
        OPENCLAW_ENSEMBLE_REVIEW_ALLOWED_REPOS: "ARC-AND-ANCHOR/OPENCLAW-WORKER",
        OPENCLAW_AGENTIC_GITHUB_MODE: "on",
      },
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
    })
    expect(decision.primary).toBe("ensemble-shadow")
  })

  it("falls back to Phase 3 when daily budget exhausted", async () => {
    const env = {
      ...baseEnv,
      OPENCLAW_ENSEMBLE_REVIEW_MODE: "shadow",
      OPENCLAW_AGENTIC_GITHUB_MODE: "on",
      OPENCLAW_ENSEMBLE_DAILY_BUDGET: "5",
      OPENCLAW_STATE: {
        get: async () => "5",  // already at cap
        put: async () => {},
      } as unknown as KVNamespace,
    } as unknown as Env
    const decision = await routeReview({
      env,
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
    })
    expect(decision.primary).toBe("phase3-agentic")
  })
})

describe("isPermanentFailure", () => {
  // CR PR #37 catch — permanent failures should fast-fail; transient
  // ones should retry/fall back. Classifier is the policy split.

  const PARSE_LABEL = "specialist_did_not_parse"

  it("returns false for undefined / null reasons (treat as transient)", () => {
    expect(isPermanentFailure(undefined, PARSE_LABEL)).toBe(false)
  })

  it("returns true for the parse failure label", () => {
    expect(isPermanentFailure(PARSE_LABEL, PARSE_LABEL)).toBe(true)
    expect(isPermanentFailure("synth_failed_parse", "synth_failed_parse")).toBe(true)
  })

  it("returns true for missing_api_key and aborted (defensive)", () => {
    expect(isPermanentFailure("missing_api_key", PARSE_LABEL)).toBe(true)
    expect(isPermanentFailure("aborted", PARSE_LABEL)).toBe(true)
  })

  it.each([
    "Ollama HTTP 404: model not found",
    "Ollama HTTP 401: unauthorized",
    "Ollama HTTP 403: forbidden",
    "Ollama HTTP 400: bad request",
    "Ollama HTTP 422: invalid format",
    "HTTP 451",  // unavailable for legal reasons — still permanent
  ])("returns true for permanent 4xx (%s)", (reason) => {
    expect(isPermanentFailure(reason, PARSE_LABEL)).toBe(true)
  })

  it("returns FALSE for HTTP 429 — rate-limited is transient (retry helps)", () => {
    expect(isPermanentFailure("Ollama HTTP 429: rate limit exceeded", PARSE_LABEL)).toBe(false)
  })

  it.each([
    "Ollama HTTP 500: internal server error",
    "Ollama HTTP 502: bad gateway",
    "Ollama HTTP 503: server overloaded, please retry shortly",
    "Ollama HTTP 504: gateway timeout",
  ])("returns false for HTTP 5xx (%s) — transient by definition", (reason) => {
    expect(isPermanentFailure(reason, PARSE_LABEL)).toBe(false)
  })

  it("returns false for non-HTTP errors (network/timeout) — assume transient", () => {
    expect(isPermanentFailure("fetch failed", PARSE_LABEL)).toBe(false)
    expect(isPermanentFailure("AbortError: request timed out", PARSE_LABEL)).toBe(false)
    expect(isPermanentFailure("ECONNREFUSED", PARSE_LABEL)).toBe(false)
  })

  it("matches HTTP status case-insensitively", () => {
    expect(isPermanentFailure("ollama http 404: nope", PARSE_LABEL)).toBe(true)
  })
})
