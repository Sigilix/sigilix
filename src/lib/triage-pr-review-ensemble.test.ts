// Phase 4a orchestrator pure-helper tests. Integration testing of the
// full handlePrReviewEnsemble pipeline is deferred to shadow-mode
// dogfooding — too much network mocking surface for unit tests, and
// Phase 4a ships off-by-default so production-traffic risk is zero
// until OPENCLAW_ENSEMBLE_REVIEW_MODE is flipped.
//
// CR PR #104 round-3 (SIG-88): narrow integration tests for the
// merged-on-approve short-circuit paths live in a sibling file
// (`tests/triage-pr-review-ensemble-merge-shortcut.test.ts`) so the
// `vi.mock` calls there don't bleed into these pure-helper tests.

import { describe, expect, it } from "vitest"
import {
  assignStableFindingIds,
  buildAstFindingsSynthBlock,
  resolveReviewEventOverride,
  buildSynthInputVerdicts,
  checkQuorum,
  collectApprovalReadinessSourceFindings,
  truncateVerdictToTokens,
  prepareSubmissionAffordance,
  buildSuggestionEmissionLogEvents,
} from "@/src/lib/triage-pr-review-ensemble"
import { buildReviewSubmissionWithMetadata } from "@/src/lib/triage-pr-review"
import {
  buildTestingEvidencePack,
  filterTestingEvidenceForSuppressedMissingCoverage,
  renderTestingEvidenceBlock,
} from "@/src/lib/testing-evidence-pack"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import { baseFinding, baseVerdict, makeCounterEnv } from "@/src/lib/triage-pr-review-ensemble.test-helpers"

describe("SIG-222 testing evidence policy integration", () => {
  it("suppresses repo-known/comment-only missing-sibling rows and keeps remaining testing findings P3 inline COMMENT", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/comment-only.ts", "src/lib/existing-tested.ts", "src/lib/new-source.ts"],
      reviewedFilePaths: ["src/lib/comment-only.ts", "src/lib/existing-tested.ts", "src/lib/new-source.ts"],
    })
    const filtered = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([
        ["src/lib/comment-only.ts", ["// update docs for maintainers"]],
        ["src/lib/existing-tested.ts", ["export function existingTested() { return run() }"]],
        ["src/lib/new-source.ts", ["export function newSource() { return run() }"]],
      ]),
      repoPaths: ["src/lib/existing-tested.ts", "tests/existing-tested.test.ts"],
    })

    expect(filtered.suppressions).toEqual([
      { source: "src/lib/comment-only.ts", reason: "no-substantive-change" },
      {
        source: "src/lib/existing-tested.ts",
        reason: "repo-sibling-exists",
        test: "tests/existing-tested.test.ts",
      },
    ])
    expect(filtered.pack.siblingMappings).toEqual([{ source: "src/lib/new-source.ts", test: null }])
    const evidenceBlock = renderTestingEvidenceBlock(filtered.pack, {
      contentByPath: {},
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 0,
    })
    expect(evidenceBlock).not.toContain("src/lib/comment-only.ts")
    expect(evidenceBlock).not.toContain("src/lib/existing-tested.ts")
    expect(evidenceBlock).toContain("siblingMapping:src/lib/new-source.ts->NONE")

    const reviewable: ReviewableMap = new Map([["src/lib/new-source.ts", [{ line: 12, side: "RIGHT" }]]])
    const addedLineTextByLine = new Map<string, Map<number, string>>([
      ["src/lib/new-source.ts", new Map([[12, "export function newSource() { return run() }"]])],
    ])
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "One test gap.",
        confidence: 5,
        confidenceReason: "Grounded by evidence pack.",
        findings: [
          {
            path: "src/lib/new-source.ts",
            line: 12,
            scope: "line",
            score: 5,
            category: "testing",
            headline: "new source lacks a sibling test",
            body: "Add a sibling test covering the new exported behavior.",
            evidenceRefs: ["siblingMapping:src/lib/new-source.ts->NONE"],
          },
        ],
      },
      prAuthor: null,
      headSha: "abc",
      reviewable,
      addedLineTextByLine,
    })

    expect(out.submission.event).toBe("COMMENT")
    expect(out.submission.comments).toHaveLength(1)
    expect(out.submission.comments?.[0]?.body).toContain("<!-- sigilix:severity:2 -->")
  })
})

describe("buildAstFindingsSynthBlock (SIG-245 AST-supersession recall fix)", () => {
  const astJson = '[{"id":"spawn-shell-true","path":"src/services/exec.ts","line":5}]'

  it("autoInline ON: instructs supersession-and-drop (AST version WILL be posted)", () => {
    const block = buildAstFindingsSynthBlock(astJson, true)
    expect(block).toContain("drop it from your output")
    expect(block).toContain("superseded_by_ast")
    expect(block).toContain(astJson)
  })

  it("autoInline OFF: instructs KEEP, never drop (AST version is NOT posted → don't lose the finding)", () => {
    const block = buildAstFindingsSynthBlock(astJson, false)
    expect(block).toContain("KEEP the specialist finding")
    expect(block).toContain("Do NOT drop AST-matched findings")
    expect(block).not.toContain("drop it from your output")
    expect(block).not.toContain("superseded_by_ast")
    expect(block).toContain(astJson)
  })

  it("returns empty string when there are no AST findings (block omitted)", () => {
    expect(buildAstFindingsSynthBlock("", true)).toBe("")
    expect(buildAstFindingsSynthBlock("", false)).toBe("")
  })

  it("autoInline ON: composition is byte-identical to the legacy inline block (prod-unchanged guarantee)", () => {
    const expected = `\n\n[AST RULE FINDINGS — pre-LLM, structured]\n\nMatch these against specialist findings on \`(path, line, role_hint)\` triple. When a specialist finding shares ALL THREE with an AST entry, drop it from your output and include \`{ specialist, sourceFindingId, headline, reason: "superseded_by_ast/<id>" }\` in \`provenance.dropped[]\`. Cross-role matches (e.g. AST=security vs specialist=performance) do NOT supersede.\n\n\`\`\`json\n${astJson}\n\`\`\``
    expect(buildAstFindingsSynthBlock(astJson, true)).toBe(expected)
  })
})

describe("resolveReviewEventOverride (SIG-245 + SIG-287 downgrade trigger)", () => {
  it("escalates to REQUEST_CHANGES when there is an approval blocker (wins over everything)", () => {
    expect(
      resolveReviewEventOverride({
        hasApprovalBlocker: true,
        reviewIncomplete: true,
        filesDroppedCount: 3,
      }),
    ).toBe("REQUEST_CHANGES")
    expect(
      resolveReviewEventOverride({
        hasApprovalBlocker: true,
        reviewIncomplete: false,
        filesDroppedCount: 0,
      }),
    ).toBe("REQUEST_CHANGES")
  })

  it("downgrades to COMMENT when files were dropped from review (SIG-245)", () => {
    expect(
      resolveReviewEventOverride({
        hasApprovalBlocker: false,
        reviewIncomplete: false,
        filesDroppedCount: 1,
      }),
    ).toBe("COMMENT")
  })

  it("downgrades to COMMENT when the review is incomplete (SIG-287 degraded/low-confidence)", () => {
    expect(
      resolveReviewEventOverride({
        hasApprovalBlocker: false,
        reviewIncomplete: true,
        filesDroppedCount: 0,
      }),
    ).toBe("COMMENT")
  })

  it("returns undefined for a clean, complete review (no override → APPROVE/RC derived from findings)", () => {
    expect(
      resolveReviewEventOverride({
        hasApprovalBlocker: false,
        reviewIncomplete: false,
        filesDroppedCount: 0,
      }),
    ).toBeUndefined()
  })
})

describe("prepareSubmissionAffordance", () => {
  it("does not prepare or persist a review counter for COMMENT submissions", async () => {
    const store = new Map<string, string>()
    const puts: Array<[string, string]> = []
    const affordance = await prepareSubmissionAffordance({
      env: makeCounterEnv(store, puts),
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 168,
      event: "COMMENT",
    })

    expect(affordance.reviewCounter).toBeUndefined()
    expect(affordance.retriggerUrl).toBeUndefined()
    await affordance.persistReviewCounter()
    expect(puts).toHaveLength(0)
  })

  it("renders REQUEST_CHANGES counters only after the posted review is confirmed", async () => {
    const key = "pr-review-counter:Sigilix/sigilix#168"
    const store = new Map<string, string>([[key, "7"]])
    const puts: Array<[string, string]> = []
    const affordance = await prepareSubmissionAffordance({
      env: makeCounterEnv(store, puts),
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 168,
      event: "REQUEST_CHANGES",
    })

    expect(affordance.reviewCounter).toBe(8)
    expect(affordance.retriggerUrl).toBe("https://github.com/Sigilix/sigilix/pull/168")
    expect(store.get(key)).toBe("7")
    expect(puts).toHaveLength(0)

    await affordance.persistReviewCounter()
    await affordance.persistReviewCounter()

    expect(store.get(key)).toBe("8")
    expect(puts).toEqual([[key, "8"]])
  })
})

describe("buildSuggestionEmissionLogEvents (SIG-103)", () => {
  const context = {
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 377,
    headSha: "148dacc1050aafd118764a8320a74ae14673100e",
    commentsSubmitted: true,
  }

  it("renders the post-submit suggestion telemetry shape", () => {
    expect(
      buildSuggestionEmissionLogEvents(context, [
        { path: "src/a.ts", line: 12 },
        { path: "src/b.ts", line: 20, startLine: 18 },
      ]),
    ).toEqual([
      {
        event: "pr-review-suggestion-emitted",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 377,
        headSha: "148dacc",
        path: "src/a.ts",
        line: 12,
      },
      {
        event: "pr-review-suggestion-emitted",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 377,
        headSha: "148dacc",
        path: "src/b.ts",
        line: 20,
        startLine: 18,
      },
    ])
  })

  it("does not emit telemetry when review comments were suppressed", () => {
    expect(
      buildSuggestionEmissionLogEvents(
        {
          ...context,
          commentsSubmitted: false,
        },
        [{ path: "src/a.ts", line: 12 }],
      ),
    ).toEqual([])
  })
})

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

describe("collectApprovalReadinessSourceFindings", () => {
  it("excludes source findings that match active withdrawal records", () => {
    const withdrawn = { ...baseFinding, id: "logic-0" }
    const kept = {
      ...baseFinding,
      id: "logic-1",
      line: 80,
      body: "A distinct high-confidence finding that was never withdrawn.",
    }
    const out = collectApprovalReadinessSourceFindings(
      [
        {
          role: "logic",
          verdict: {
            ...baseVerdict,
            findings: [withdrawn, kept],
          },
        },
      ],
      [
        {
          path: withdrawn.path,
          line: withdrawn.line,
          bodySnapshot: withdrawn.body,
          // Recent so it's inside the SIG-217 Part B decay window (an epoch-0
          // dismissal would read as decayed and be let through, not suppressed).
          withdrawnAt: Date.now(),
          withdrawnByCommentId: 123,
          prHeadSha: "a".repeat(40),
          reason: "mention-reply-accepted",
        },
      ],
    )

    expect(out.map((source) => source.id)).toEqual(["logic-1"])
  })

  it("collects readiness sources from the same truncated verdicts sent to synth", () => {
    const truncatedFinding = {
      ...baseFinding,
      id: "logic-0",
      score: 4,
      body: "x".repeat(1800),
    }
    const keptFinding = {
      ...baseFinding,
      id: "logic-1",
      score: 5,
      headline: "critical auth bypass",
      body: "Missing authorization guard.",
    }
    const verdict = {
      summary: "Two findings.",
      confidence: 5,
      confidenceReason: "Clear regression.",
      findings: [truncatedFinding, keptFinding],
    }
    const keptOnlyVerdict = { ...verdict, findings: [keptFinding] }
    const maxTokens = Math.ceil(JSON.stringify(keptOnlyVerdict).length / 4) + 2

    const synthInput = buildSynthInputVerdicts([{ role: "logic" as const, verdict, elapsedMs: 100 }], maxTokens)
    const sources = collectApprovalReadinessSourceFindings(synthInput, [])

    expect(synthInput[0]?.verdict.findings.map((f) => f.id)).toEqual(["logic-1"])
    expect(sources.map((source) => source.id)).toEqual(["logic-1"])
  })
})

describe("checkQuorum", () => {
  const v = (role: "logic" | "security" | "performance" | "tests") => ({
    role,
    verdict: { ...baseVerdict, findings: [{ ...baseFinding, id: `${role}-0` }] },
    elapsedMs: 100,
  })
  const allFour: Array<"logic" | "security" | "performance" | "tests"> = ["logic", "security", "performance", "tests"]

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
    const out = truncateVerdictToTokens({ ...baseVerdict, findings: [{ ...baseFinding, id: "logic-0" }] }, 1000)
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
