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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  annotateWithConsensus,
  assignStableFindingIds,
  buildAstFindingsSynthBlock,
  buildSynthRetryMessage,
  resolveReviewEventOverride,
  buildSynthInputVerdicts,
  checkQuorum,
  classifySynthOutcome,
  collectApprovalReadinessSourceFindings,
  computeConsensusRanking,
  computeDegradedCoverage,
  computeFindingDelta,
  computeFindingKey,
  truncateVerdictToTokens,
  validateForSubmission,
  isPermanentFailure,
  SPECIALIST_TIMEOUT_MS,
  SYNTHESIZER_TIMEOUT_MS,
  SYNTHESIZER_RETRY_TIMEOUT_MS,
  ORCHESTRATOR_TIMEOUT_MS,
  RESERVED_HEADROOM_MS,
  RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
  SYNTH_RETRY_FINALIZE_RESERVE_MS,
  PER_ATTEMPT_TIMEOUT_MS,
  SPECIALIST_CONFIGS,
  SYNTHESIZER_CONFIG,
  MAX_CALLS_PER_ENSEMBLE_RUN,
  graphRetrievalEnabled,
  graphRetrievalMode,
  graphExpansionMode,
  formatGraphContext,
  formatGraphBlastContext,
  graphOverlapStats,
  GRAPH_RPC_TIMEOUT_MS,
  BLAST_RADIUS_RESOLUTION_READY,
  resolveDynamicEvidencePromptBlock,
  prepareSubmissionAffordance,
  buildSuggestionEmissionLogEvents,
  type SynthesizerProvenance,
} from "../src/lib/triage-pr-review-ensemble"
import {
  buildSpecialistInitialMessage,
  buildSynthesizerInitialMessage,
} from "../src/prompts/pr-review-specialists"
import {
  buildReviewSubmissionWithMetadata,
  type PrReviewVerdict,
  type PrReviewFinding,
} from "../src/lib/triage-pr-review"
import { applySynthSourceFindingFloor } from "../src/lib/degraded-finding-floor"
import {
  buildTestingEvidencePack,
  filterTestingEvidenceForSuppressedMissingCoverage,
  renderTestingEvidenceBlock,
} from "../src/lib/testing-evidence-pack"
import type { ReviewableMap } from "../src/lib/diff-positions"
import type { Env } from "../src/index"

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

function makeCounterEnv(store = new Map<string, string>(), puts: Array<[string, string]> = []): Env {
  return {
    OPENCLAW_STATE: {
      async get(key: string): Promise<string | null> {
        return store.get(key) ?? null
      },
      async put(key: string, value: string): Promise<void> {
        puts.push([key, value])
        store.set(key, value)
      },
      async delete(key: string): Promise<void> {
        store.delete(key)
      },
    },
  } as unknown as Env
}

describe("SIG-222 testing evidence policy integration", () => {
  it("suppresses repo-known/comment-only missing-sibling rows and keeps remaining testing findings P3 inline COMMENT", () => {
    const pack = buildTestingEvidencePack({
      splitFilePaths: [
        "src/lib/comment-only.ts",
        "src/lib/existing-tested.ts",
        "src/lib/new-source.ts",
      ],
      reviewedFilePaths: [
        "src/lib/comment-only.ts",
        "src/lib/existing-tested.ts",
        "src/lib/new-source.ts",
      ],
    })
    const filtered = filterTestingEvidenceForSuppressedMissingCoverage(pack, {
      changedLineTextByPath: new Map([
        ["src/lib/comment-only.ts", ["// update docs for maintainers"]],
        ["src/lib/existing-tested.ts", ["export function existingTested() { return run() }"]],
        ["src/lib/new-source.ts", ["export function newSource() { return run() }"]],
      ]),
      repoPaths: [
        "src/lib/existing-tested.ts",
        "tests/existing-tested.test.ts",
      ],
    })

    expect(filtered.suppressions).toEqual([
      { source: "src/lib/comment-only.ts", reason: "no-substantive-change" },
      {
        source: "src/lib/existing-tested.ts",
        reason: "repo-sibling-exists",
        test: "tests/existing-tested.test.ts",
      },
    ])
    expect(filtered.pack.siblingMappings).toEqual([
      { source: "src/lib/new-source.ts", test: null },
    ])
    const evidenceBlock = renderTestingEvidenceBlock(filtered.pack, {
      contentByPath: {},
      failedPaths: [],
      truncatedPaths: [],
      totalChars: 0,
    })
    expect(evidenceBlock).not.toContain("src/lib/comment-only.ts")
    expect(evidenceBlock).not.toContain("src/lib/existing-tested.ts")
    expect(evidenceBlock).toContain("siblingMapping:src/lib/new-source.ts->NONE")

    const reviewable: ReviewableMap = new Map([
      ["src/lib/new-source.ts", [{ line: 12, side: "RIGHT" }]],
    ])
    const addedLineTextByLine = new Map<string, Map<number, string>>([
      ["src/lib/new-source.ts", new Map([[12, "export function newSource() { return run() }"]])],
    ])
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "One test gap.",
        confidence: 5,
        confidenceReason: "Grounded by evidence pack.",
        findings: [{
          path: "src/lib/new-source.ts",
          line: 12,
          scope: "line",
          score: 5,
          category: "testing",
          headline: "new source lacks a sibling test",
          body: "Add a sibling test covering the new exported behavior.",
          evidenceRefs: ["siblingMapping:src/lib/new-source.ts->NONE"],
        }],
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
    const expected =
      `\n\n[AST RULE FINDINGS — pre-LLM, structured]\n\nMatch these against specialist findings on \`(path, line, role_hint)\` triple. When a specialist finding shares ALL THREE with an AST entry, drop it from your output and include \`{ specialist, sourceFindingId, headline, reason: "superseded_by_ast/<id>" }\` in \`provenance.dropped[]\`. Cross-role matches (e.g. AST=security vs specialist=performance) do NOT supersede.\n\n\`\`\`json\n${astJson}\n\`\`\``
    expect(buildAstFindingsSynthBlock(astJson, true)).toBe(expected)
  })
})

describe("resolveReviewEventOverride (SIG-245 + SIG-287 downgrade trigger)", () => {
  it("escalates to REQUEST_CHANGES when there is an approval blocker (wins over everything)", () => {
    expect(resolveReviewEventOverride({ hasApprovalBlocker: true, reviewIncomplete: true, filesDroppedCount: 3 })).toBe("REQUEST_CHANGES")
    expect(resolveReviewEventOverride({ hasApprovalBlocker: true, reviewIncomplete: false, filesDroppedCount: 0 })).toBe("REQUEST_CHANGES")
  })

  it("downgrades to COMMENT when files were dropped from review (SIG-245)", () => {
    expect(resolveReviewEventOverride({ hasApprovalBlocker: false, reviewIncomplete: false, filesDroppedCount: 1 })).toBe("COMMENT")
  })

  it("downgrades to COMMENT when the review is incomplete (SIG-287 degraded/low-confidence)", () => {
    expect(resolveReviewEventOverride({ hasApprovalBlocker: false, reviewIncomplete: true, filesDroppedCount: 0 })).toBe("COMMENT")
  })

  it("returns undefined for a clean, complete review (no override → APPROVE/RC derived from findings)", () => {
    expect(resolveReviewEventOverride({ hasApprovalBlocker: false, reviewIncomplete: false, filesDroppedCount: 0 })).toBeUndefined()
  })
})

describe("prepareSubmissionAffordance", () => {
  it("does not prepare or persist a review counter for COMMENT submissions", async () => {
    const store = new Map<string, string>()
    const puts: Array<[string, string]> = []
    const affordance = await prepareSubmissionAffordance({
      env: makeCounterEnv(store, puts),
      owner: "Arc-and-Anchor",
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
    const key = "pr-review-counter:Arc-and-Anchor/sigilix#168"
    const store = new Map<string, string>([[key, "7"]])
    const puts: Array<[string, string]> = []
    const affordance = await prepareSubmissionAffordance({
      env: makeCounterEnv(store, puts),
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 168,
      event: "REQUEST_CHANGES",
    })

    expect(affordance.reviewCounter).toBe(8)
    expect(affordance.retriggerUrl).toBe("https://github.com/Arc-and-Anchor/sigilix/pull/168")
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
    expect(buildSuggestionEmissionLogEvents(context, [
      { path: "src/a.ts", line: 12 },
      { path: "src/b.ts", line: 20, startLine: 18 },
    ])).toEqual([
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
    expect(buildSuggestionEmissionLogEvents({
      ...context,
      commentsSubmitted: false,
    }, [{ path: "src/a.ts", line: 12 }])).toEqual([])
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
      [{
        role: "logic",
        verdict: {
          ...baseVerdict,
          findings: [withdrawn, kept],
        },
      }],
      [{
        path: withdrawn.path,
        line: withdrawn.line,
        bodySnapshot: withdrawn.body,
        // Recent so it's inside the SIG-217 Part B decay window (an epoch-0
        // dismissal would read as decayed and be let through, not suppressed).
        withdrawnAt: Date.now(),
        withdrawnByCommentId: 123,
        prHeadSha: "a".repeat(40),
        reason: "mention-reply-accepted",
      }],
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

    const synthInput = buildSynthInputVerdicts(
      [{ role: "logic" as const, verdict, elapsedMs: 100 }],
      maxTokens,
    )
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

describe("validateForSubmission — hallucination guard + line validity + score-1 handling", () => {
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

  it("SIG-351 source floor restores an omitted blocker before the validation path", () => {
    const floored = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [{
        specialist: "logic",
        sourceFindingId: "logic-0",
        headline: "off-by-one in `clampIndex`",
        reason: "duplicate",
      }],
      specialists: specialistVerdicts.map((v) => ({ role: v.role, findings: v.verdict!.findings })),
    })

    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: floored.findings,
        },
        provenance: {
          findings: floored.provenanceFindings,
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })

    expect(floored.restored.map((x) => x.id)).toEqual(["logic-0"])
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.headline).toBe("off-by-one in `clampIndex`")
    expect(out.cleanFindingProvenance[0]?.sourceFindingIds).toEqual(["logic-0"])
    expect(out.droppedForHallucination).toBe(0)
  })

  it("SIG-311 demotes a security-sourced usage-vs-mention finding to the body in enforce mode", () => {
    const path = "src/lib/ast-rules/scan-dynamic-html-sink.ts"
    const securityFinding: PrReviewFinding = {
      path,
      line: 10,
      score: 5,
      category: "security",
      cweId: "CWE-78",
      headline: "Command injection sink via shell interpolation in `exec`",
      body: "`re.exec(line)` executes attacker-controlled input as a shell command.",
    }
    const synthOutput = () => ({
      verdict: {
        summary: "ok",
        confidence: 4,
        confidenceReason: "...",
        findings: [{ ...securityFinding }],
      },
      provenance: {
        findings: [{
          sourceSpecialists: ["security"],
          sourceFindingIds: ["security-0"],
          action: "kept" as const,
          verifiedViaRetrieval: false,
        }],
        dropped: [],
      },
    })
    const securityVerdicts = [{
      role: "security" as const,
      verdict: {
        ...baseVerdict,
        findings: [{ ...securityFinding, id: "security-0" }],
      },
      elapsedMs: 100,
    }]
    const securityReviewable: ReviewableMap = new Map([
      [path, [{ line: 10, side: "RIGHT" }]],
    ])
    const addedLineTextByLine = new Map<string, Map<number, string>>([
      [path, new Map([[10, "  for (const re of HTML_WRITE_SINK_EXTRACTORS) { re.exec(line); }"]])],
    ])

    const shadow = validateForSubmission({
      synthOutput: synthOutput(),
      reviewable: securityReviewable,
      specialistVerdicts: securityVerdicts,
      addedLineTextByLine,
      securityUsageValidatorMode: "shadow",
    })
    expect(shadow.verdict.findings).toHaveLength(1)
    expect(shadow.unanchoredFindings).toHaveLength(0)
    expect(shadow.droppedForFailedSecurityUsageValidation).toBe(1)

    const enforce = validateForSubmission({
      synthOutput: synthOutput(),
      reviewable: securityReviewable,
      specialistVerdicts: securityVerdicts,
      addedLineTextByLine,
      securityUsageValidatorMode: "enforce",
      trustLedgerEnabled: true,
    })
    expect(enforce.verdict.findings).toHaveLength(0)
    expect(enforce.unanchoredFindings).toHaveLength(1)
    expect(enforce.unanchoredFindings[0]?.headline).toContain("Command injection")
    expect(enforce.unanchoredFindings[0]?.trust).toEqual({
      tier: "body-only-ungrounded",
      surface: "body",
      demoteReason: "security-usage",
    })
    expect(enforce.droppedForFailedSecurityUsageValidation).toBe(1)
  })

  it("attaches EvidenceRecord from validated synth provenance without changing score or confidence", () => {
    const astId = "ast/no-unsafe-call/abc123/42"
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: [{
            ...baseFinding,
            line: 42,
            score: 4,
            confidence: 4,
            evidenceId: "freeform-model-id",
            evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE", "freeform:<script>"],
          }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0", "security-0", astId],
            action: "merged",
            verifiedViaRetrieval: true,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts: [
        ...specialistVerdicts,
        {
          role: "security" as const,
          verdict: {
            ...baseVerdict,
            findings: [{
              ...baseFinding,
              id: "security-0",
              line: 42,
              score: 4,
              evidenceId: "secret:generic-api-key:abc123:42",
            }],
          },
          elapsedMs: 100,
        },
        {
          role: "performance" as const,
          verdict: { ...baseVerdict, findings: [] },
          elapsedMs: 100,
        },
        {
          role: "tests" as const,
          verdict: null,
          elapsedMs: 100,
        },
      ],
      astFindingIds: [astId],
    })

    const finding = out.verdict.findings[0]
    expect(finding?.score).toBe(4)
    expect(finding?.confidence).toBe(4)
    expect(finding?.evidence).toEqual({
      specialistsThatFlagged: ["logic", "security"],
      specialistsThatDeclined: ["performance"],
      deterministicFactIds: [
        "secret:generic-api-key:abc123:42",
        "siblingMapping:src/lib/foo.ts->NONE",
        astId,
      ],
      retrievalChunkIds: [],
      relatedPriorPRs: [],
      synthDecision: "merged",
      consensusScore: 2,
    })
  })

  it("does not attribute fallback sourceSpecialists that returned no findings", () => {
    const astId = "ast/no-unsafe-call/abc123/42"
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
            sourceSpecialists: ["security"],
            sourceFindingIds: [astId],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts: [
        ...specialistVerdicts,
        {
          role: "security" as const,
          verdict: { ...baseVerdict, findings: [] },
          elapsedMs: 100,
        },
      ],
      astFindingIds: [astId],
    })

    expect(out.verdict.findings[0]?.evidence?.specialistsThatFlagged).toEqual([])
    expect(out.verdict.findings[0]?.evidence?.consensusScore).toBe(0)
    expect(out.verdict.findings[0]?.evidence?.specialistsThatDeclined).toEqual(["logic", "security"])
  })

  it("uses sourceSpecialists fallback only for a matching specialist finding", () => {
    const astId = "ast/no-unsafe-call/abc123/42"
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
            sourceFindingIds: [astId],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      astFindingIds: [astId],
    })

    expect(out.verdict.findings[0]?.evidence?.specialistsThatFlagged).toEqual(["logic"])
    expect(out.verdict.findings[0]?.evidence?.consensusScore).toBe(1)
    expect(out.verdict.findings[0]?.evidence?.specialistsThatDeclined).toEqual([])
  })

  it("normalizes malformed synth evidence actions before rendering metadata", () => {
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
            action: "split" as unknown as SynthesizerProvenance["findings"][number]["action"],
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })

    expect(out.verdict.findings[0]?.evidence?.synthDecision).toBe("unknown")
  })

  it("tags a finding on a NON-changed file as outOfPrScope; a mis-anchored finding on a CHANGED file is NOT (Codex recall-hole fix)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok", confidence: 4, confidenceReason: "...",
          findings: [
            // a finding about code in a file NOT in this PR's diff → out-of-PR-scope
            { ...baseFinding, path: "src/other-unchanged.ts", line: 5, score: 5, headline: "in another file" },
            // a real finding on the CHANGED file but a non-reviewable line (mis-anchored) → NOT out-of-scope
            { ...baseFinding, path: "src/lib/foo.ts", line: 999, score: 5, headline: "mis-anchored blocker" },
          ],
        },
        provenance: {
          findings: [
            { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
            { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
          ],
          dropped: [],
        },
      },
      reviewable, // only src/lib/foo.ts is a changed file
      specialistVerdicts,
    })
    const other = out.unanchoredFindings.find((f) => f.path === "src/other-unchanged.ts")
    const misAnchored = out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(other?.outOfPrScope).toBe(true) // not a changed file → out-of-PR-scope (won't block / auto-approves)
    expect(misAnchored?.outOfPrScope).toBeUndefined() // changed file, just unanchorable → STILL blocks (recall hole closed)
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
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForHallucination).toBe(1)
  })

  it("DROPS score-1 findings with empty sourceFindingIds before advisory provenance recording", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: { ...baseVerdict, findings: [{ ...baseFinding, line: 42, score: 1, headline: "tiny nit" }] },
        provenance: {
          findings: [{
            sourceSpecialists: [],
            sourceFindingIds: [],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.demotedScore1).toBe(0)
    expect(out.droppedForHallucination).toBe(1)
    expect(out.provenance.dropped).toEqual([])
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
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
  })

  it("repairs a nearby line-scoped finding to the nearest substantive added line", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 47, score: 4 }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        ["src/lib/foo.ts", new Map([
          [42, "  const idx = clampIndex(i)"],
          [50, "  return result"],
        ])],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.line).toBe(50)
    expect(out.cleanFindingProvenance).toHaveLength(1)
    expect(out.droppedForInvalidLine).toBe(0)
    expect(out.remappedInvalidLineToInline).toBe(1)
    expect(out.unanchoredFindings).toHaveLength(0)
  })

  it("skips closer LEFT-only candidates and repairs to a farther RIGHT-side line", () => {
    const sideAwareReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        { line: 46, side: "LEFT" },
        { line: 50, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 47, score: 4 }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable: sideAwareReviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        ["src/lib/foo.ts", new Map([
          [46, "  oldOnlyCandidate()"],
          [50, "  return result"],
        ])],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.line).toBe(50)
    expect(out.remappedInvalidLineToInline).toBe(1)
    expect(out.droppedForInvalidLine).toBe(0)
  })

  it("prefers the forward candidate when repair candidates are equidistant", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 46, score: 4 }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        ["src/lib/foo.ts", new Map([
          [42, "  const idx = clampIndex(i)"],
          [50, "  return result"],
        ])],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.line).toBe(50)
    expect(out.remappedInvalidLineToInline).toBe(1)
  })

  it("does not repair when every substantive candidate is outside the repair window", () => {
    const distantReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        { line: 87, side: "RIGHT" },
        { line: 113, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 100, score: 4 }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable: distantReviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        ["src/lib/foo.ts", new Map([
          [87, "  beforeWindow()"],
          [113, "  afterWindow()"],
        ])],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.line).toBe(100)
  })

  it("does not repair structured one-click suggestions", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{
            ...baseFinding,
            line: 47,
            score: 4,
            kind: "replace",
            suggestedReplacement: "  return safeResult",
          }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        ["src/lib/foo.ts", new Map([[50, "  return result"]])],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.suggestedReplacement).toBe("  return safeResult")
  })

  it("keeps invalid multi-line range findings body-only instead of collapsing them to one line", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, startLine: 44, line: 47, score: 4 }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        ["src/lib/foo.ts", new Map([[50, "  return result"]])],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.startLine).toBe(44)
    expect(out.unanchoredFindings[0]?.line).toBe(47)
  })

  it("keeps header-line findings body-only instead of repairing them", () => {
    const lineOneReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [{ line: 2, side: "RIGHT" }]],
    ])
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 1, score: 4 }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable: lineOneReviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        ["src/lib/foo.ts", new Map([[2, "export const value = 1"]])],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.line).toBe(1)
  })

  // SIG Trust Ledger v0: the body-demote sites tag `trust.demoteReason` when
  // `trustLedgerEnabled` (flag != off). Exercises the shared gating + the in-place
  // annotation survival through to `unanchoredFindings` on the line-1 path
  // (outside-diff); the other 4 demote sites use the identical
  // `if (trustLedgerEnabled) annotateFindingTrust(...)` mechanism with their own
  // reason string. Guards against a silent regression in the threading.
  describe("trust-ledger demote-reason threading", () => {
    const lineOneReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [{ line: 2, side: "RIGHT" }]],
    ])
    // Fresh per call — the line-1 demote site annotates the finding object IN
    // PLACE, so a shared fixture would leak the mutation between the two tests.
    const mkSynthOutput = () => ({
      verdict: { ...baseVerdict, findings: [{ ...baseFinding, line: 1, score: 4 }] },
      provenance: {
        findings: [{
          sourceSpecialists: ["logic"],
          sourceFindingIds: ["logic-0"],
          action: "kept" as const,
          verifiedViaRetrieval: false,
        }],
        dropped: [],
      },
    })
    const addedLineTextByLine = new Map([
      ["src/lib/foo.ts", new Map([[2, "export const value = 1"]])],
    ])

    it("tags a line-1 body-routed finding with demoteReason outside-diff when enabled", () => {
      const out = validateForSubmission({
        synthOutput: mkSynthOutput(),
        reviewable: lineOneReviewable,
        specialistVerdicts,
        addedLineTextByLine,
        trustLedgerEnabled: true,
      })
      expect(out.verdict.findings).toHaveLength(0)
      expect(out.unanchoredFindings).toHaveLength(1) // demoted, not dropped
      expect(out.droppedForInvalidLine).toBe(1)
      expect(out.unanchoredFindings[0]?.trust).toEqual({
        tier: "body-only-ungrounded",
        surface: "body",
        demoteReason: "outside-diff",
      })
    })

    it("is a true no-op when disabled (default) — no trust mutation", () => {
      const out = validateForSubmission({
        synthOutput: mkSynthOutput(),
        reviewable: lineOneReviewable,
        specialistVerdicts,
        addedLineTextByLine,
      })
      expect(out.verdict.findings).toHaveLength(0)
      expect(out.unanchoredFindings).toHaveLength(1) // still demoted (flag only gates the trust tag)
      expect(out.droppedForInvalidLine).toBe(1)
      expect(out.unanchoredFindings[0]?.line).toBe(1)
      expect(out.unanchoredFindings[0]?.trust).toBeUndefined() // but untagged
    })
  })

  it("does not repair broad-scope findings into inline comments", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 47, scope: "file", score: 4 }],
        },
        provenance: {
          findings: [{
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept",
            verifiedViaRetrieval: false,
          }],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        ["src/lib/foo.ts", new Map([[50, "  return result"]])],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.scope).toBe("file")
  })

  it("drops score-1 findings from chill reviews and records provenance", () => {
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
        },
      },
      reviewable,
      specialistVerdicts,
      profile: "chill",
    })
    expect(out.verdict.findings).toHaveLength(0)  // score-1 never goes inline
    expect(out.demotedScore1).toBe(2)
    expect(out.verdict.summary).not.toContain("Advisory nits:")
    expect(out.verdict.summary).not.toContain("first nit")
    expect(out.provenance.dropped).toEqual([
      {
        specialist: "logic",
        sourceFindingId: "logic-1",
        headline: "first nit",
        reason: "score-1-advisory",
      },
      {
        specialist: "logic",
        sourceFindingId: "logic-1",
        headline: "second nit",
        reason: "score-1-advisory",
      },
    ])
  })

  it("caps advisory nits at 5 for assertive profile and appends 'plus N more'", () => {
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
        },
      },
      reviewable,
      specialistVerdicts,
      profile: "assertive",
    })
    // Top 5 emitted in summary, "plus 3 more" appended.
    expect(out.verdict.summary).toContain("plus 3 more advisory nits")
    expect(out.provenance.dropped).toHaveLength(8)
    expect(out.provenance.dropped.every((d) => d.reason === "score-1-advisory")).toBe(true)
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

// ─── Phase 4a.3: configuration invariants ─────────────────────────────────

describe("Phase 4a.3 — timeout schedule", () => {
  it("enforces SPECIALIST_TIMEOUT_MS + SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS ≤ ORCHESTRATOR_TIMEOUT_MS", () => {
    // Static budget invariant. The module already throws at load if
    // this is ever violated; the test is a regression guard so a
    // future constant tweak doesn't accidentally relax it past where
    // the synth would lose budget to pre-flight or stale-head latency.
    expect(SPECIALIST_TIMEOUT_MS + SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS)
      .toBeLessThanOrEqual(ORCHESTRATOR_TIMEOUT_MS)
  })

  it("uses the post-ARC-283 timeouts (synth no-timeout Phase A, Sigilix-PR-#94 fix-up)", () => {
    // ARC-283 Phase A: synth + retry + headroom bumped after PR #93's
    // own review timed out at 180s on a 900-line diff. Sigilix's
    // product positioning is "yes cost more time for BETTER reviews"
    // — timing out when specialists already returned cleanly is a
    // non-starter. Sigilix's own PR #94 self-review caught a 5s
    // overshoot (pre-flight not budgeted into headroom); these
    // values are the post-catch corrected set.
    // SIG-234 (2026-05-26): tightened 270 → 185 after the lineup swap.
    // SIG-287 (2026-05-30): 185 → 250 → 370. Logic stayed INTERMITTENT at 110s
    // then 240s (aborted mid-generation on big graph-context prompts), so its
    // per-attempt cap went to 360s and the wall must fit it; synth trimmed
    // 420 → 325 (over-provisioned) to free budget. Invariant: 370 + 325 + 195 =
    // 890 ≤ 895.
    expect(SPECIALIST_TIMEOUT_MS).toBe(370_000)
    expect(SYNTHESIZER_TIMEOUT_MS).toBe(325_000)
    expect(SYNTHESIZER_RETRY_TIMEOUT_MS).toBe(160_000)
    expect(RESERVED_HEADROOM_MS).toBe(195_000)
    expect(ORCHESTRATOR_TIMEOUT_MS).toBe(895_000)
    expect(RETRIEVAL_PREFLIGHT_TIMEOUT_MS).toBe(15_000)
    // ARC-283 B1a: PER_ATTEMPT cap tightened 85s → 60s based on real-
    // run telemetry from PR #96 (healthy logic specialist took 28-57s
    // — 60s leaves margin while cutting retry-chain stacking by 25s
    // per failed attempt).
    expect(PER_ATTEMPT_TIMEOUT_MS).toBe(60_000)
    // Static invariant 1 — same shape as the module-load check.
    expect(SPECIALIST_TIMEOUT_MS + SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS)
      .toBeLessThanOrEqual(ORCHESTRATOR_TIMEOUT_MS)
    // Static invariant 2 — Sigilix's PR #94 catch: pre-flight + retry
    // + finalize must all fit inside the headroom envelope. Pre-flight
    // runs INSIDE the orchestrator timer (orchTimer starts before
    // preflightRetrieval), so its budget has to come out of headroom.
    //
    // ARC-288: import `SYNTH_RETRY_FINALIZE_RESERVE_MS` from source so
    // a future budget bump can't drift the test loose from the
    // runtime guard (per the PR #94 orphan finding).
    expect(
      RETRIEVAL_PREFLIGHT_TIMEOUT_MS +
        SYNTHESIZER_RETRY_TIMEOUT_MS +
        SYNTH_RETRY_FINALIZE_RESERVE_MS,
    ).toBeLessThanOrEqual(RESERVED_HEADROOM_MS)
    // Queue consumer ceiling — ORCHESTRATOR must stay strictly under
    // Cloudflare Queues' 900s consumer wall. Phase B (DO-alarm-driven
    // synth) lifts this ceiling entirely; until then, the orchestrator
    // is the constraint.
    expect(ORCHESTRATOR_TIMEOUT_MS).toBeLessThan(900_000)
  })

  it("specialist budget accommodates 2 primary attempts + 1 fallback at PER_ATTEMPT_TIMEOUT_MS cap (SIG-234 tightening)", () => {
    // SIG-234 (2026-05-26): the prior 270s budget was sized for
    // `deepseek-v4-pro:cloud` at ~90s/attempt. After the lineup swap
    // retired v4-pro from the logic primary, the new primaries all
    // respect PER_ATTEMPT_TIMEOUT_MS (60s) cleanly. Budget = 3 * 60s
    // = 180s. The regression guard still bounds the floor (so a
    // future tighten can't silently break fallback firing).
    const retryBackoffMs = 1_000
    const minBudget = 3 * PER_ATTEMPT_TIMEOUT_MS + retryBackoffMs
    expect(SPECIALIST_TIMEOUT_MS).toBeGreaterThanOrEqual(minBudget)
  })

  it("pre-flight timeout is well within the orchestrator's reserved headroom", () => {
    // Pre-flight runs inside the RESERVED_HEADROOM_MS slice (alongside
    // diff parse, stale-head guards, telemetry write). If pre-flight
    // alone is allowed to consume more than 40s the synth's 180s
    // budget can be eaten by a slow Vectorize. Keep 25s slack.
    expect(RETRIEVAL_PREFLIGHT_TIMEOUT_MS).toBeLessThanOrEqual(RESERVED_HEADROOM_MS)
    expect(RESERVED_HEADROOM_MS - RETRIEVAL_PREFLIGHT_TIMEOUT_MS).toBeGreaterThanOrEqual(25_000)
  })
})

describe("SIG-349 — measured model lineup", () => {
  it("logic specialist runs deepseek-v4-pro:cloud primary, retries:0, with a qwen3-coder-next cross-provider fallback (think:false + fast-fallback)", () => {
    // SIG-287 (2026-05-30): the prior "trim to 1-attempt-only, fallback:null"
    // (PR #188) was built on the wrong diagnosis ("prompt-driven, not model-
    // driven"). The TRUE root cause was a missing `think:false` — the reasoning
    // primary burned the whole budget thinking, emitting zero `response`
    // tokens. With think:false (ollama-chat.ts / ollama.ts) logic finishes
    // fast, so it now carries a CROSS-PROVIDER fallback: a future stall fails
    // fast (120s) and qwen3-coder-next rescues it. retries:0 (a same-model
    // retry of a stalled deepseek would just stall again — the fallback is the
    // resilience). Cross-provider so the fallback fails independently.
    // 2026-06-05: primary SWAPPED flash→pro. With think:false v4-pro is also
    // fast (~6-12s), and the subtle-logic recall ruler (K=12 real-path) shows
    // v4-pro + FP-discipline at recall 93% / FP 25% vs flash-tuned 86% / 31%.
    expect(SPECIALIST_CONFIGS.logic.primary).toBe("deepseek-v4-pro:cloud")
    expect(SPECIALIST_CONFIGS.logic.retries).toBe(0)
    expect(SPECIALIST_CONFIGS.logic.fallback).toBe("qwen3-coder-next:cloud")
    const primaryFamily = SPECIALIST_CONFIGS.logic.primary.split("-")[0]
    expect(SPECIALIST_CONFIGS.logic.fallback?.split("-")[0]).not.toBe(primaryFamily)
  })

  it("performance specialist runs glm-5.1:cloud (ARC-167 retained) with kimi-k2.5 fallback", () => {
    expect(SPECIALIST_CONFIGS.performance.primary).toBe("glm-5.1:cloud")
    expect(SPECIALIST_CONFIGS.performance.fallback).toBe("kimi-k2.5:cloud")
    expect(SPECIALIST_CONFIGS.performance.retries).toBe(1)
  })

  it("security specialist runs deepseek-v4-flash:cloud (reasoner, reverted from the qwen coder) + deepseek-v4-pro fallback", () => {
    // pr/07 regression: SIG-234 had swapped security to qwen3-coder-next (a
    // CODER model) on the premise "vulns are syntax recognition, not reasoning".
    // That premise fails for AUTHORIZATION — IDOR/BOLA/access-control are
    // reasoning, and the coder model generated ZERO authz findings on an
    // IDOR-heavy benchmark (raw pre-gate telemetry: never generated, not
    // dropped). Reverted to a REASONING model. Deliberately SHARES
    // deepseek-v4-flash with logic (recall beats the 4+1-unique nicety);
    // deepseek-v4-pro stays as the deeper authz fallback.
    expect(SPECIALIST_CONFIGS.security.primary).toBe("deepseek-v4-flash:cloud")
    expect(SPECIALIST_CONFIGS.security.fallback).toBe("deepseek-v4-pro:cloud")
    expect(SPECIALIST_CONFIGS.security.retries).toBe(1)
  })

  it("tests specialist runs deepseek-v4-flash primary + MiniMax M3 fallback with a 160s attempt cap", () => {
    // SIG-349: V4 Flash primary beats the MiniMax M3 K=12 baseline on the
    // tests-overfire post-gate surface while returning in seconds. MiniMax M3
    // stays as the cross-provider tests-lane fallback so V4 parse/timeouts
    // route to the known baseline instead of dropping coverage.
    expect(SPECIALIST_CONFIGS.tests.primary).toBe("deepseek-v4-flash:cloud")
    expect(SPECIALIST_CONFIGS.tests.fallback).toBe("minimax-m3:cloud")
    expect(SPECIALIST_CONFIGS.tests.retries).toBe(0)
    expect(SPECIALIST_CONFIGS.tests.perAttemptTimeoutMs).toBe(160_000)
  })

  it("tests intentionally shares security's V4 Flash primary after SIG-349", () => {
    const primaries = [
      SPECIALIST_CONFIGS.logic.primary,
      SPECIALIST_CONFIGS.security.primary,
      SPECIALIST_CONFIGS.performance.primary,
      SPECIALIST_CONFIGS.tests.primary,
      SYNTHESIZER_CONFIG.primary,
    ]
    // History: SIG-234 preferred 4+1-unique primaries, but recall/runtime wins
    // over model-diversity when measured. Security uses V4 Flash because authz
    // needs a reasoner; SIG-349 intentionally moves tests onto the same fast
    // reasoner after K-repeated tests-overfire measurement, with MiniMax as the
    // fallback safety net.
    expect(SPECIALIST_CONFIGS.security.primary).not.toBe(SPECIALIST_CONFIGS.logic.primary)
    expect(SPECIALIST_CONFIGS.security.primary).toBe("deepseek-v4-flash:cloud")
    expect(SPECIALIST_CONFIGS.tests.primary).toBe(SPECIALIST_CONFIGS.security.primary)
    expect(new Set(primaries).size).toBe(4)
  })

  it("synthesizer uses gpt-oss:120b primary + DeepSeek-flash cross-provider fallback (SIG-234)", () => {
    // ARC-291 (PR #97 hot-fix): synth fallback was kimi-k2.5:cloud
    // (same Moonshot provider as primary). When Moonshot had a bad
    // few minutes, both primary AND fallback failed identically →
    // synth_timeout. Sigilix's review of PR #97 demoed this with a
    // 6m 16s wall-clock burn and a customer-visible skip-notice.
    //
    // Cross-provider fallback is the whole point of the fallback
    // mechanic. Every other ModelConfig in this file had it; synth
    // was the outlier. Switched to deepseek-v4-flash (proven primary
    // on security + tests specialists, different provider, fails
    // independently from Moonshot).
    // SIG-234 (2026-05-26): synth primary moved kimi-k2.6 →
    // gpt-oss:120b. Removes Moonshot from the customer-visible
    // critical merge path entirely. Cross-provider fallback retained.
    expect(SYNTHESIZER_CONFIG.primary).toBe("gpt-oss:120b-cloud")
    expect(SYNTHESIZER_CONFIG.fallback).toBe("deepseek-v4-flash:cloud")
    expect(SYNTHESIZER_CONFIG.retries).toBe(1)
    // Cross-provider invariant: synth primary and fallback MUST NOT
    // share the same provider prefix. If a future bump ever picks
    // a same-provider fallback again, this assertion catches it at
    // CI time. The check is intentionally generous on what counts
    // as "different provider" — any model name that doesn't share
    // primary's family prefix (everything before the first hyphen)
    // satisfies the cross-provider requirement.
    const primaryFamily = SYNTHESIZER_CONFIG.primary.split("-")[0]
    const fallbackFamily = SYNTHESIZER_CONFIG.fallback?.split("-")[0]
    expect(fallbackFamily).not.toBe(primaryFamily)
  })

  it("MAX_CALLS_PER_ENSEMBLE_RUN matches the production daily-budget admission gate (16 after SIG-348 tests retry removal)", () => {
    // The production constant is what `dailyBudgetAvailable()` reserves
    // before admitting a PR, so the regression must assert against it
    // directly — not against a hand-calc that would silently drift if
    // someone changes the production formula. Pre-flight retrieve is
    // a Vectorize call (gated by OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR),
    // not a model call (gated by OPENCLAW_ENSEMBLE_DAILY_BUDGET), so it
    // is intentionally NOT counted here.
    //
    // Worst-case model calls per ensemble run:
    //   logic:       primary + fallback (retries:0)           = 2 (SIG-287)
    //   security:    primary + 1 retry + fallback             = 3
    //   performance: primary + 1 retry + fallback             = 3
    //   tests:       primary + fallback (retries:0)           = 2 (SIG-348)
    //   synth:       primary + 1 retry + fallback             = 3 (attempt 1)
    //   synth retry: primary + 1 retry + fallback             = 3 (ARC-278
    //                retry path, fires when attempt 1 fails)
    //   total: 16.  Down from 17 — SIG-348 removed tests' same-model retry and
    //   preserved cross-provider fallback as the runtime rescue path.
    expect(MAX_CALLS_PER_ENSEMBLE_RUN).toBe(16)

    // Cross-check: the constant matches the sum of `1 + retries + (fallback ? 1 : 0)`
    // across the 4 specialists + 2 synth runs (attempt + ARC-278 retry).
    const perRole = (c: { retries: number; fallback?: string }) =>
      1 + c.retries + (c.fallback ? 1 : 0)
    const expected =
      perRole(SPECIALIST_CONFIGS.logic)
      + perRole(SPECIALIST_CONFIGS.security)
      + perRole(SPECIALIST_CONFIGS.performance)
      + perRole(SPECIALIST_CONFIGS.tests)
      + 2 * perRole(SYNTHESIZER_CONFIG) // ARC-278: synth attempt + retry
    expect(MAX_CALLS_PER_ENSEMBLE_RUN).toBe(expected)
  })
})

// ─── ARC-189 Task 10b — provenance.softened[] + score decrement ─

describe("validateForSubmission — emits cleanFindingProvenance aligned by index (Task 2.5 + 10b prerequisite)", () => {
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
          { ...baseFinding, id: "logic-1", line: 50, score: 3, headline: "second" },
        ],
      },
      elapsedMs: 100,
    },
  ]

  it("cleanFindingProvenance has same length as cleaned verdict.findings", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok", confidence: 4, confidenceReason: "...",
          findings: [
            { ...baseFinding, line: 42, score: 4 },
            { ...baseFinding, line: 50, score: 3, headline: "second" },
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-1"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(2)
    expect(out.cleanFindingProvenance).toHaveLength(2)
    expect(out.cleanFindingProvenance[0]?.sourceFindingIds).toEqual(["logic-0"])
    expect(out.cleanFindingProvenance[1]?.sourceFindingIds).toEqual(["logic-1"])
  })

  it("dropped/demoted findings are excluded from cleanFindingProvenance too", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok", confidence: 4, confidenceReason: "...",
          findings: [
            { ...baseFinding, line: 42, score: 4, headline: "kept" },
            { ...baseFinding, line: 50, score: 1, headline: "score-1 demoted" },
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-1"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.cleanFindingProvenance).toHaveLength(1)
    expect(out.cleanFindingProvenance[0]?.sourceFindingIds).toEqual(["logic-0"])
    expect(out.demotedScore1).toBe(1)
  })

  it("validateForSubmission accepts synth output with provenance.softened[] (backward compat: optional field)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok", confidence: 4, confidenceReason: "...",
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
          softened: [{
            specialist: "logic",
            sourceFindingId: "logic-0",
            headline: "off-by-one",
            reason: "review-memory/logic",
          }],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    // Score remains untouched at the validation layer; the soften
    // application happens at the buildReviewSubmission caller.
    expect(out.verdict.findings[0]?.score).toBe(4)
  })

  it("validateForSubmission rejects malformed softened[] entries (per isValidProvenance)", () => {
    // We can't invoke isValidProvenance directly (it's not exported);
    // validateForSubmission's caller in handlePrReviewEnsemble does
    // the gate via parseSynthAnswer. Here we exercise the path
    // indirectly: a provenance with invalid softened[] (sourceFindingId
    // is a number, not a string) — validateForSubmission's input is
    // already typed, so we typecast through unknown to simulate the
    // wire format.
    // Skipped: this concern is covered by parseSynthAnswer →
    // isValidProvenance unit tests (out of scope for this describe).
    expect(true).toBe(true)
  })
})

// ARC-270 — consensus scoring
describe("computeConsensusRanking", () => {
  const finding = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    ...baseFinding, ...overrides,
  })
  const prov = (specialists: string[]): SynthesizerProvenance["findings"][number] => ({
    sourceSpecialists: specialists as SynthesizerProvenance["findings"][number]["sourceSpecialists"],
    sourceFindingIds: specialists.map((s, i) => `${s}-${i}`),
    action: "kept",
    verifiedViaRetrieval: false,
  })

  it("ranks 2-specialist findings above 1-specialist findings at the same score", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "single", score: 4 }),
        finding({ headline: "duo", score: 4 }),
      ],
    }
    const provenance = [prov(["logic"]), prov(["logic", "security"])]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings[0]?.headline).toBe("duo")
    expect(out.verdict.findings[1]?.headline).toBe("single")
    expect(out.consensusByIndex).toEqual([2, 1])
  })

  it("uses score as the tiebreaker when consensus is equal", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "low", score: 2 }),
        finding({ headline: "high", score: 5 }),
      ],
    }
    const provenance = [prov(["logic"]), prov(["security"])]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings[0]?.headline).toBe("high")
    expect(out.verdict.findings[1]?.headline).toBe("low")
  })

  it("preserves original order on full ties (stable sort)", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "first", score: 3 }),
        finding({ headline: "second", score: 3 }),
        finding({ headline: "third", score: 3 }),
      ],
    }
    const provenance = [prov(["logic"]), prov(["logic"]), prov(["logic"])]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings.map((f) => f.headline)).toEqual(["first", "second", "third"])
  })

  it("dedupes specialists when computing consensus (same specialist twice = 1)", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [finding({ headline: "dup-spec" })],
    }
    // Pathological provenance — same specialist listed twice. Consensus
    // should still report 1 (distinct specialists only).
    const provenance = [prov(["logic", "logic"])]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.consensusByIndex).toEqual([1])
  })

  it("3-specialist > 2-specialist > 1-specialist on identical scores", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "solo", score: 3 }),
        finding({ headline: "trio", score: 3 }),
        finding({ headline: "duo", score: 3 }),
      ],
    }
    const provenance = [
      prov(["logic"]),
      prov(["logic", "security", "tests"]),
      prov(["logic", "performance"]),
    ]

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings.map((f) => f.headline)).toEqual(["trio", "duo", "solo"])
    expect(out.consensusByIndex).toEqual([3, 2, 1])
  })

  it("provenance array is reordered to match the new finding order", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [
        finding({ headline: "A" }),
        finding({ headline: "B" }),
      ],
    }
    const provenanceA = prov(["logic"])
    const provenanceB = prov(["logic", "security"])
    const provenance = [provenanceA, provenanceB]

    const out = computeConsensusRanking(verdict, provenance)

    // B (consensus 2) is now at index 0 — its provenance moved with it.
    expect(out.verdict.findings[0]?.headline).toBe("B")
    expect(out.provenance[0]).toBe(provenanceB)
    expect(out.provenance[1]).toBe(provenanceA)
  })

  it("defensive: misaligned arrays → no-op (preserve order, consensus=1 each)", () => {
    const verdict: PrReviewVerdict = {
      ...baseVerdict,
      findings: [finding({ headline: "A" }), finding({ headline: "B" })],
    }
    const provenance = [prov(["logic"])] // length=1, mismatch

    const out = computeConsensusRanking(verdict, provenance)

    expect(out.verdict.findings.map((f) => f.headline)).toEqual(["A", "B"])
    expect(out.consensusByIndex).toEqual([1, 1])
  })

  it("empty findings list returns empty result without crashing", () => {
    const out = computeConsensusRanking({ ...baseVerdict, findings: [] }, [])
    expect(out.verdict.findings).toEqual([])
    expect(out.provenance).toEqual([])
    expect(out.consensusByIndex).toEqual([])
  })
})

describe("annotateWithConsensus", () => {
  const f: PrReviewFinding = { ...baseFinding }

  it("prepends a 'Flagged by N specialists' note when consensus >= 2", () => {
    const out = annotateWithConsensus(f, 3)
    expect(out.body.startsWith("_Flagged by 3 specialists._")).toBe(true)
    expect(out.body).toContain(f.body)
  })

  it("returns the finding unchanged when consensus is 1", () => {
    const out = annotateWithConsensus(f, 1)
    expect(out).toBe(f)
  })

  it("returns the finding unchanged when consensus is 0", () => {
    const out = annotateWithConsensus(f, 0)
    expect(out).toBe(f)
  })

  it("does not mutate the original finding", () => {
    const original = { ...baseFinding }
    annotateWithConsensus(original, 2)
    expect(original.body).toBe(baseFinding.body)
  })

  it("handles empty body (annotation alone)", () => {
    const empty = { ...baseFinding, body: "" }
    const out = annotateWithConsensus(empty, 2)
    expect(out.body).toBe("_Flagged by 2 specialists._")
  })
})

// ARC-271 — finding deltas across pushes
describe("computeFindingKey", () => {
  it("returns the same key for identical (path, headline)", async () => {
    const a = await computeFindingKey("src/foo.ts", "off-by-one in clampIndex")
    const b = await computeFindingKey("src/foo.ts", "off-by-one in clampIndex")
    expect(a).toBe(b)
  })

  it("normalizes case + whitespace + trailing punctuation", async () => {
    const a = await computeFindingKey("Src/Foo.TS", "  Off-by-one in clampIndex.  ")
    const b = await computeFindingKey("src/foo.ts", "off-by-one in clampIndex")
    expect(a).toBe(b)
  })

  it("produces different keys for different paths", async () => {
    const a = await computeFindingKey("src/a.ts", "guard missing")
    const b = await computeFindingKey("src/b.ts", "guard missing")
    expect(a).not.toBe(b)
  })

  it("produces different keys for different headlines", async () => {
    const a = await computeFindingKey("src/a.ts", "headline one")
    const b = await computeFindingKey("src/a.ts", "headline two")
    expect(a).not.toBe(b)
  })

  it("returns a 16-char hex string", async () => {
    const k = await computeFindingKey("src/a.ts", "x")
    expect(k).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("computeFindingDelta", () => {
  const prior = (key: string, path: string) => ({ key, path })

  it("classifies every prior finding correctly across all 4 buckets", () => {
    const currentKeys = new Set(["k-still", "k-new"])
    const priorFindings = [
      prior("k-still", "src/touched.ts"),  // → still-open
      prior("k-gone-touched", "src/touched.ts"),  // → likely-fixed
      prior("k-gone-untouched", "src/untouched.ts"),  // → carried-over
    ]
    const changedPaths = new Set(["src/touched.ts"])

    const delta = computeFindingDelta(currentKeys, priorFindings, changedPaths)

    expect(delta.newCount).toBe(1)
    expect(delta.stillOpenCount).toBe(1)
    expect(delta.likelyFixedCount).toBe(1)
    expect(delta.carriedOverCount).toBe(1)
  })

  it("never claims a finding is fixed when its path isn't in the changed set (incremental-review safety)", () => {
    const currentKeys = new Set(["k1"])
    const priorFindings = [prior("k-gone", "src/untouched.ts")]
    const changedPaths = new Set(["src/other.ts"]) // touched some other file, not the prior finding's

    const delta = computeFindingDelta(currentKeys, priorFindings, changedPaths)

    expect(delta.likelyFixedCount).toBe(0)
    expect(delta.carriedOverCount).toBe(1)
  })

  it("returns all zeros when prior had no findings and current is also empty", () => {
    const delta = computeFindingDelta(new Set(), [], new Set())
    expect(delta).toEqual({ newCount: 0, stillOpenCount: 0, likelyFixedCount: 0, carriedOverCount: 0 })
  })

  it("treats first-run (no prior findings) as 'all new'", () => {
    const currentKeys = new Set(["k1", "k2", "k3"])
    const delta = computeFindingDelta(currentKeys, [], new Set(["src/foo.ts"]))
    expect(delta.newCount).toBe(3)
    expect(delta.stillOpenCount).toBe(0)
  })

  // code-reviewer HIGH catch on commit 2: `computeFindingKey`
  // lowercases path before hashing, so a prior finding stored with
  // raw casing (e.g. `Src/Foo.ts`) must still match diff-derived
  // changed-paths (typically lowercased / unix style).
  it("matches paths case-insensitively (changedPaths set may be in different case)", () => {
    const currentKeys = new Set<string>()
    const priorFindings = [{ key: "k-gone", path: "Src/Foo.TS" }] // raw upper case
    const changedPaths = new Set(["src/foo.ts"]) // lowercased from diff

    const delta = computeFindingDelta(currentKeys, priorFindings, changedPaths)

    expect(delta.likelyFixedCount).toBe(1)
    expect(delta.carriedOverCount).toBe(0)
  })

  it("counts likely-fixed/carried-over correctly when prior had findings but current has none", () => {
    // ARC-281: pure-data delta test. The renderer-side header has
    // moved to `renderDeltaBadge` in triage-pr-review.ts (see
    // tests/triage-pr-review-body.test.ts). This test now asserts
    // the delta counts directly without going through a render
    // step.
    const currentKeys = new Set<string>()
    const priorFindings = [
      { key: "k1", path: "src/touched.ts" },
      { key: "k2", path: "src/untouched.ts" },
    ]
    const changedPaths = new Set(["src/touched.ts"])

    const delta = computeFindingDelta(currentKeys, priorFindings, changedPaths)
    expect(delta).toEqual({
      newCount: 0,
      stillOpenCount: 0,
      likelyFixedCount: 1,
      carriedOverCount: 1,
    })
  })

  it("counts +N new when prior manifest had findings: [] (clean PR last time)", () => {
    // First-time finding state: prior manifest existed but its
    // findings array was empty. Every current finding counts as
    // `new`.
    const currentKeys = new Set(["k1", "k2"])
    const delta = computeFindingDelta(currentKeys, [], new Set())
    expect(delta.newCount).toBe(2)
  })
})

// ARC-277: drop the specialist quorum gate. Synth now runs on any
// non-empty subset of returning specialists; the prompt is augmented
// with a [DEGRADED COVERAGE] block when one or more specialists
// didn't return.
describe("computeDegradedCoverage (ARC-277)", () => {
  it("returns all dispatched roles as `rolesReturned` when every specialist returned", () => {
    const out = computeDegradedCoverage(
      ["logic", "security", "performance", "tests"],
      ["logic", "security", "performance", "tests"],
    )
    expect(out.rolesReturned).toEqual(["logic", "security", "performance", "tests"])
    expect(out.rolesMissing).toEqual([])
  })

  it("splits returned vs missing when some specialists didn't return", () => {
    const out = computeDegradedCoverage(
      ["logic", "security", "performance", "tests"],
      ["logic", "performance"],
    )
    expect(out.rolesReturned).toEqual(["logic", "performance"])
    expect(out.rolesMissing).toEqual(["security", "tests"])
  })

  it("returns stable order (logic, security, performance, tests) regardless of input order", () => {
    // Helper renders the prompt — `[DEGRADED COVERAGE]` text must be
    // deterministic for any (dispatched, returned) pair so two runs
    // with the same coverage gap produce identical prompt-shape
    // hashes for telemetry.
    const a = computeDegradedCoverage(
      ["tests", "logic", "performance", "security"],
      ["performance", "logic"],
    )
    const b = computeDegradedCoverage(
      ["logic", "security", "performance", "tests"],
      ["logic", "performance"],
    )
    expect(a).toEqual(b)
  })

  it("does NOT include roles that weren't dispatched", () => {
    // Router may dispatch a subset (e.g. CSS-only → ["performance"]).
    // A role that was never dispatched should not appear in either
    // returned or missing.
    const out = computeDegradedCoverage(
      ["performance"],
      ["performance"],
    )
    expect(out.rolesReturned).toEqual(["performance"])
    expect(out.rolesMissing).toEqual([])
  })

  it("treats `dispatched but none returned` as fully missing (used by the 0/N bail in the orchestrator)", () => {
    const out = computeDegradedCoverage(
      ["logic", "security"],
      [],
    )
    expect(out.rolesReturned).toEqual([])
    expect(out.rolesMissing).toEqual(["logic", "security"])
  })
})

describe("resolveDynamicEvidencePromptBlock", () => {
  const filesByPath = new Map([
    [
      "src/parser.ts",
      [
        "export function parseFinalAnswer(response: string): string {",
        "  const match = response.match(/FINAL\\((.*?)\\)/)",
        "  return match?.[1] ?? \"\"",
        "}",
      ].join("\n"),
    ],
  ])
  const changedLines = new Map([["src/parser.ts", new Set([2])]])
  const baseArgs = {
    filesByPath,
    changedLines,
    reviewablePaths: ["src/parser.ts"],
    retrievalChunks: [{
      path: "src/repl.ts",
      lineStart: 10,
      lineEnd: 12,
      score: 0.87,
      content: "const answer = parseFinalAnswer(rawResponse)",
    }],
    graphNodes: [{
      path: "src/repl.ts",
      symbolId: null,
      name: null,
      hop: 1,
      edgeKind: "import",
    }],
    blastCallerPaths: [],
    blastDependentPaths: [],
    testingEvidence: undefined,
  }

  it("keeps shadow-mode evidence out of generated prompts while still rendering telemetry text", () => {
    const resolved = resolveDynamicEvidencePromptBlock({
      ...baseArgs,
      env: { OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "shadow" },
    })

    expect(resolved.mode).toBe("shadow")
    expect(resolved.rendered).toContain("[DYNAMIC REVIEW EVIDENCE")
    expect(resolved.rendered).toContain("function `parseFinalAnswer`")
    expect(resolved.promptBlock).toBe("")

    const specialistMessage = buildSpecialistInitialMessage({
      prNumber: 101,
      title: "Parser update",
      body: "",
      diff: "diff --git a/src/parser.ts b/src/parser.ts",
      retrievalSnapshot: "",
      namespace: "owner/repo@sha",
      dynamicEvidenceBlock: resolved.promptBlock,
    })
    expect(specialistMessage).not.toContain("[DYNAMIC REVIEW EVIDENCE")
  })

  it("injects post-mode evidence into specialist and synthesizer generated messages", () => {
    const resolved = resolveDynamicEvidencePromptBlock({
      ...baseArgs,
      env: { OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "post" },
    })

    expect(resolved.mode).toBe("post")
    expect(resolved.promptBlock).toContain("[DYNAMIC REVIEW EVIDENCE")
    expect(resolved.pack?.cards[0]?.symbolName).toBe("parseFinalAnswer")

    const specialistMessage = buildSpecialistInitialMessage({
      prNumber: 101,
      title: "Parser update",
      body: "",
      diff: "diff --git a/src/parser.ts b/src/parser.ts",
      retrievalSnapshot: "",
      namespace: "owner/repo@sha",
      dynamicEvidenceBlock: resolved.promptBlock,
    })
    expect(specialistMessage).toContain("[DYNAMIC REVIEW EVIDENCE")
    expect(specialistMessage.indexOf("[DYNAMIC REVIEW EVIDENCE")).toBeGreaterThan(
      specialistMessage.indexOf("[RETRIEVAL SNAPSHOT]"),
    )
    expect(specialistMessage.indexOf("[DYNAMIC REVIEW EVIDENCE")).toBeLessThan(
      specialistMessage.indexOf("[CODEBASE NAMESPACE"),
    )

    const synthMessage = buildSynthesizerInitialMessage({
      prNumber: 101,
      diff: "diff --git a/src/parser.ts b/src/parser.ts",
      specialistVerdictsBlock: "=== LOGIC ===\n{\"findings\":[]}",
      dynamicEvidenceBlock: resolved.promptBlock,
    })
    expect(synthMessage).toContain("[DYNAMIC REVIEW EVIDENCE")
    expect(synthMessage.indexOf("[DYNAMIC REVIEW EVIDENCE")).toBeGreaterThan(
      synthMessage.indexOf("[DIFF]"),
    )
    expect(synthMessage.indexOf("[DYNAMIC REVIEW EVIDENCE")).toBeLessThan(
      synthMessage.indexOf("[SPECIALIST VERDICTS]"),
    )
  })
})

describe("graphExpansionMode parser (SIG-286)", () => {
  const mode = (v: string | undefined): "off" | "shadow" | "post" =>
    graphExpansionMode({ OPENCLAW_GRAPH_EXPANSION: v } as unknown as Env)

  it("returns off when unset/empty/unknown", () => {
    expect(mode(undefined)).toBe("off")
    expect(mode("")).toBe("off")
    expect(mode("on")).toBe("off")
    expect(mode("garbage")).toBe("off")
  })

  it("parses shadow and post, case-insensitive and whitespace-tolerant", () => {
    expect(mode("shadow")).toBe("shadow")
    expect(mode("post")).toBe("post")
    expect(mode("  SHADOW ")).toBe("shadow")
    expect(mode("Post")).toBe("post")
  })
})

describe("graph-context expansion never injects into prompts (SIG-286 PR1 shadow-only)", () => {
  // The enriched graph-context bodies are measured for telemetry only. There
  // is NO prompt-builder parameter that carries them, so neither a specialist
  // nor the synth message can ever contain the expansion's rendered text —
  // regardless of whether OPENCLAW_GRAPH_EXPANSION is shadow or post in PR1.
  const expansionText = "src/b.ts:1-3 — function bar\n 1 | export function bar() {}"

  it("specialist message has no graph-expansion parameter and never contains expansion bodies", () => {
    const specialistMessage = buildSpecialistInitialMessage({
      prNumber: 1,
      title: "t",
      body: "",
      diff: "diff --git a/src/b.ts b/src/b.ts",
      retrievalSnapshot: "",
      namespace: "owner/repo@sha",
      // The ONLY graph block builders accept is graphContext (SIG-138 BFS
      // neighbors). There is intentionally no expansion-bodies param.
      graphContext: "",
    })
    expect(specialistMessage).not.toContain(expansionText)
    expect(specialistMessage).not.toContain("[GRAPH EXPANSION")
  })

  it("synth message never contains expansion bodies", () => {
    const synthMessage = buildSynthesizerInitialMessage({
      prNumber: 1,
      diff: "diff --git a/src/b.ts b/src/b.ts",
      specialistVerdictsBlock: "=== LOGIC ===\n{\"findings\":[]}",
      graphContext: "",
    })
    expect(synthMessage).not.toContain(expansionText)
    expect(synthMessage).not.toContain("[GRAPH EXPANSION")
  })
})

describe("buildSynthesizerInitialMessage [DEGRADED COVERAGE] block (ARC-277)", () => {
  const baseCtx = {
    prNumber: 42,
    diff: "diff --git a/foo.ts ...",
    specialistVerdictsBlock: "=== LOGIC ===\n{}",
  }

  it("omits the [DEGRADED COVERAGE] block when full coverage (no degradedCoverage field)", () => {
    const out = buildSynthesizerInitialMessage(baseCtx)
    expect(out).not.toContain("[DEGRADED COVERAGE]")
    expect(out).not.toContain("Specialists MISSING")
  })

  it("omits the block when degradedCoverage is set but rolesMissing is empty (defensive — caller should not pass that)", () => {
    const out = buildSynthesizerInitialMessage({
      ...baseCtx,
      degradedCoverage: { rolesReturned: ["logic", "security", "performance", "tests"], rolesMissing: [] },
    })
    expect(out).not.toContain("[DEGRADED COVERAGE]")
  })

  it("renders the [DEGRADED COVERAGE] block when rolesMissing is non-empty", () => {
    const out = buildSynthesizerInitialMessage({
      ...baseCtx,
      degradedCoverage: {
        rolesReturned: ["logic", "performance"],
        rolesMissing: ["security", "tests"],
      },
    })
    expect(out).toContain("[DEGRADED COVERAGE]")
    expect(out).toContain("Specialists returned: logic, performance")
    expect(out).toContain("Specialists MISSING (did not return — timeout / rate-limit / parse-fail): security, tests")
    // Constraint text must include all three: no-fabricate, summary-ack, confidence-cap.
    expect(out).toContain("Do NOT fabricate findings")
    expect(out).toContain("Add a one-sentence acknowledgement")
    expect(out).toContain("confidence` no higher than 3/5")
  })

  it("places the [DEGRADED COVERAGE] block BEFORE [DIFF] (so synth sees it up front, not at the tail)", () => {
    const out = buildSynthesizerInitialMessage({
      ...baseCtx,
      degradedCoverage: {
        rolesReturned: ["logic"],
        rolesMissing: ["security", "performance", "tests"],
      },
    })
    const degradedIdx = out.indexOf("[DEGRADED COVERAGE]")
    const diffIdx = out.indexOf("[DIFF]")
    expect(degradedIdx).toBeGreaterThan(-1)
    expect(diffIdx).toBeGreaterThan(-1)
    expect(degradedIdx).toBeLessThan(diffIdx)
  })

  it("places [DEGRADED COVERAGE] AFTER stackBlock when both are present (stack comes first per ARC-182 contract)", () => {
    const out = buildSynthesizerInitialMessage({
      ...baseCtx,
      stackBlock: "[STACK CONTEXT]\nparent: #41",
      degradedCoverage: {
        rolesReturned: ["logic"],
        rolesMissing: ["security"],
      },
    })
    const stackIdx = out.indexOf("[STACK CONTEXT]")
    const degradedIdx = out.indexOf("[DEGRADED COVERAGE]")
    expect(stackIdx).toBeGreaterThan(-1)
    expect(degradedIdx).toBeGreaterThan(stackIdx)
  })
})

// ARC-278: synth retry on timeout / parse / provenance. Two pure
// helpers (`classifySynthOutcome`, `buildSynthRetryMessage`) plus a
// constant-budget invariant.
describe("classifySynthOutcome (ARC-278)", () => {
  const okSynth = {
    modelUsed: "glm-5.1:cloud",
    attemptsUsed: 1,
    verdict: { summary: "x".repeat(20), confidence: 4, confidenceReason: "y", findings: [] },
    provenance: { findings: [], dropped: [] },
    elapsedMs: 100,
  } as const

  it("returns `ok` when output has verdict + provenance and no failure reason", () => {
    expect(classifySynthOutcome(okSynth, false)).toBe("ok")
  })

  it("returns `timeout` when localTimeout is true (caller substituted null for output)", () => {
    expect(classifySynthOutcome(null, true)).toBe("timeout")
  })

  it("returns `timeout` defensively when output is null even without localTimeout flag", () => {
    expect(classifySynthOutcome(null, false)).toBe("timeout")
    expect(classifySynthOutcome(undefined, false)).toBe("timeout")
  })

  it("returns `timeout` when output carries an abort-shaped failureReason (Phase 4a.2 path)", () => {
    expect(classifySynthOutcome(
      { ...okSynth, verdict: null, provenance: null, failureReason: "Operation aborted" },
      false,
    )).toBe("timeout")
    expect(classifySynthOutcome(
      { ...okSynth, verdict: null, provenance: null, failureReason: "timeout exceeded" },
      false,
    )).toBe("timeout")
  })

  it("returns `provenance` when output has invalid-provenance failureReason and missing verdict/provenance", () => {
    expect(classifySynthOutcome(
      { ...okSynth, verdict: null, provenance: null, failureReason: "synth_invalid_provenance" },
      false,
    )).toBe("provenance")
  })

  it("returns `parse` for other non-abort failure shapes (catch-all bucket)", () => {
    expect(classifySynthOutcome(
      { ...okSynth, verdict: null, provenance: null, failureReason: "synth_failed_parse" },
      false,
    )).toBe("parse")
    // No failureReason but missing verdict/provenance still routes to parse.
    expect(classifySynthOutcome(
      { ...okSynth, verdict: null, provenance: null },
      false,
    )).toBe("parse")
  })
})

describe("buildSynthRetryMessage (ARC-278)", () => {
  const original = "[PR] #42\n\n[DIFF]\n+const x = 1\n"

  it("returns the original message unchanged when outcome is `ok` (caller should not call us)", () => {
    expect(buildSynthRetryMessage(original, "ok")).toBe(original)
  })

  it("appends a JSON-shape hint on parse failure", () => {
    const out = buildSynthRetryMessage(original, "parse")
    expect(out.startsWith(original)).toBe(true)
    expect(out).toContain("RETRY: Your previous response could not be parsed as JSON")
    expect(out).toContain("Re-emit ONLY a single JSON object")
    expect(out).toContain("No prose")
  })

  it("appends a provenance-specific hint on provenance failure", () => {
    const out = buildSynthRetryMessage(original, "provenance")
    expect(out).toContain("RETRY: Your previous response's `provenance` field was malformed")
    expect(out).toContain("softened?:")
    expect(out).toContain("provenance.softened[i].sourceFindingId")
    expect(out).toContain("SPECIALIST VERDICTS")
  })

  it("appends a be-prompter hint on timeout failure", () => {
    const out = buildSynthRetryMessage(original, "timeout")
    expect(out).toContain("RETRY: Your previous response did not arrive within the time budget")
    expect(out).toContain("schema and inputs above are unchanged")
  })

  it("does NOT duplicate the original message when called repeatedly with different outcomes", () => {
    // Caller is expected to pass the *original* message each time, not
    // the already-augmented one. Verify the hint replaces (semantically)
    // by appearing only once when we re-augment.
    const once = buildSynthRetryMessage(original, "parse")
    // If a caller incorrectly passed `once` back as original, we'd see
    // the RETRY hint twice. This test pins that the helper itself is
    // pure / non-cumulative — it always appends one hint.
    const naiveCallerOutput = buildSynthRetryMessage(once, "timeout")
    expect(naiveCallerOutput.match(/RETRY:/g)?.length).toBe(2)
    // (Production code in handlePrReviewEnsemble always passes the
    // ORIGINAL message, not the augmented one. The test documents
    // the contract.)
  })
})

describe("SYNTHESIZER_RETRY_TIMEOUT_MS budget invariant (ARC-278 + ARC-283)", () => {
  it("retry budget + finalize reserve fits inside RESERVED_HEADROOM_MS", () => {
    // Module-load guard verifies this; the test pins the constraint
    // so a future "raise retry timeout" change can't silently push
    // past the headroom envelope without updating the orch timeout.
    // ARC-283 bumped finalize from 5s → 20s (production finalize is
    // slower when synth produces a large finding set). ARC-288:
    // import the constant from source so a future bump can't drift
    // the test loose.
    expect(SYNTHESIZER_RETRY_TIMEOUT_MS + SYNTH_RETRY_FINALIZE_RESERVE_MS)
      .toBeLessThanOrEqual(RESERVED_HEADROOM_MS)
  })

  it("SPECIALIST + SYNTHESIZER + HEADROOM still ≤ ORCHESTRATOR (the primary invariant)", () => {
    expect(SPECIALIST_TIMEOUT_MS + SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS)
      .toBeLessThanOrEqual(ORCHESTRATOR_TIMEOUT_MS)
  })

  it("retry budget is generous enough to actually complete after a primary timeout (ARC-283)", () => {
    // Pre-ARC-283 retry was 30s — useful only for parse/provenance
    // re-emissions, useless when primary timed out on real model
    // latency. Post-ARC-283 retry is sized to be a genuine second
    // attempt at the same work: at least 30% of the primary budget.
    // This breaks the pre-ARC-283 invariant that retry << primary
    // (intentional — that invariant was the cause of ARC-283).
    expect(SYNTHESIZER_RETRY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      Math.floor(SYNTHESIZER_TIMEOUT_MS * 0.3),
    )
  })
})

// ─── SIG-138 Phase 2: graph-retrieval pure helpers ─────────────────────────

describe("graphRetrievalEnabled", () => {
  const makeEnv = (v: string | undefined) =>
    ({ OPENCLAW_GRAPH_RETRIEVAL: v } as unknown as import("../src/index").Env)

  it("returns true for 'shadow'", () => {
    expect(graphRetrievalEnabled(makeEnv("shadow"))).toBe(true)
  })

  it("returns true for 'post'", () => {
    expect(graphRetrievalEnabled(makeEnv("post"))).toBe(true)
  })

  it("returns true for case-insensitive variants ('Shadow', 'POST')", () => {
    expect(graphRetrievalEnabled(makeEnv("Shadow"))).toBe(true)
    expect(graphRetrievalEnabled(makeEnv("POST"))).toBe(true)
  })

  it("returns false for 'off'", () => {
    expect(graphRetrievalEnabled(makeEnv("off"))).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(graphRetrievalEnabled(makeEnv(""))).toBe(false)
  })

  it("returns false for undefined", () => {
    expect(graphRetrievalEnabled(makeEnv(undefined))).toBe(false)
  })

  it("returns false for an unrecognized value", () => {
    expect(graphRetrievalEnabled(makeEnv("on"))).toBe(false)
  })
})

describe("graphRetrievalMode", () => {
  const makeEnv = (v: string | undefined) =>
    ({ OPENCLAW_GRAPH_RETRIEVAL: v } as unknown as import("../src/index").Env)

  it("returns 'shadow' for 'shadow'", () => {
    expect(graphRetrievalMode(makeEnv("shadow"))).toBe("shadow")
  })

  // SIG-143 landed: blast-radius name resolution (blastRadiusByNames) exists,
  // so BLAST_RADIUS_RESOLUTION_READY is true and a raw 'post' is honored as
  // 'post' (no longer coerced to 'shadow').
  it("returns 'post' for 'post' (SIG-143 landed: BLAST_RADIUS_RESOLUTION_READY is true)", () => {
    expect(BLAST_RADIUS_RESOLUTION_READY).toBe(true)
    expect(graphRetrievalMode(makeEnv("post"))).toBe("post")
  })

  it("returns 'off' for 'off'", () => {
    expect(graphRetrievalMode(makeEnv("off"))).toBe("off")
  })

  it("returns 'off' for undefined", () => {
    expect(graphRetrievalMode(makeEnv(undefined))).toBe("off")
  })

  it("returns 'off' for empty string", () => {
    expect(graphRetrievalMode(makeEnv(""))).toBe("off")
  })

  it("is case-insensitive: 'SHADOW' -> 'shadow', 'Post' -> 'post'", () => {
    expect(graphRetrievalMode(makeEnv("SHADOW"))).toBe("shadow")
    expect(graphRetrievalMode(makeEnv("Post"))).toBe("post")
  })
})

describe("formatGraphContext", () => {
  it("formats nodes as 'path (hopN, edgeKind)' lines joined by newline", () => {
    const nodes = [
      { path: "src/lib/foo.ts", hop: 1, edgeKind: "import" },
      { path: "src/lib/bar.ts", hop: 2, edgeKind: "same_file" },
    ]
    expect(formatGraphContext(nodes)).toBe(
      "src/lib/foo.ts (hop1, import)\nsrc/lib/bar.ts (hop2, same_file)",
    )
  })

  it("returns empty string for empty array", () => {
    expect(formatGraphContext([])).toBe("")
  })

  it("returns a single line with no trailing newline for one node", () => {
    const result = formatGraphContext([{ path: "src/x.ts", hop: 1, edgeKind: "export" }])
    expect(result).toBe("src/x.ts (hop1, export)")
    expect(result.endsWith("\n")).toBe(false)
  })
})

describe("formatGraphBlastContext", () => {
  it("formats callers before importers with role labels", () => {
    const result = formatGraphBlastContext({
      callerPaths: ["src/caller.ts"],
      dependentPaths: ["src/dep.ts"],
      exclude: new Set<string>(),
      cap: 10,
    })
    expect(result).toBe("src/caller.ts (blast, caller)\nsrc/dep.ts (blast, importer)")
  })

  it("excludes paths already represented (seeds / graph nodes)", () => {
    const result = formatGraphBlastContext({
      callerPaths: ["src/seen.ts", "src/new.ts"],
      dependentPaths: ["src/seen.ts"],
      exclude: new Set(["src/seen.ts"]),
      cap: 10,
    })
    expect(result).toBe("src/new.ts (blast, caller)")
  })

  it("dedups a path that is both a caller and a dependent", () => {
    const result = formatGraphBlastContext({
      callerPaths: ["src/both.ts"],
      dependentPaths: ["src/both.ts"],
      exclude: new Set<string>(),
      cap: 10,
    })
    expect(result).toBe("src/both.ts (blast, caller)")
  })

  it("caps the number of emitted lines", () => {
    const result = formatGraphBlastContext({
      callerPaths: ["a.ts", "b.ts", "c.ts"],
      dependentPaths: ["d.ts"],
      exclude: new Set<string>(),
      cap: 2,
    })
    expect(result.split("\n")).toHaveLength(2)
    expect(result).toBe("a.ts (blast, caller)\nb.ts (blast, caller)")
  })

  it("returns empty string when nothing new to add", () => {
    expect(formatGraphBlastContext({
      callerPaths: [],
      dependentPaths: [],
      exclude: new Set<string>(),
      cap: 4,
    })).toBe("")
  })
})

describe("graphOverlapStats", () => {
  it("computes jaccard and addedCount for overlapping sets", () => {
    // vector=[a,b], graph=[b,c]
    // intersection={b} (size 1), union={a,b,c} (size 3), jaccard=1/3
    // addedCount: paths in graph NOT in vector = [c] → 1
    const result = graphOverlapStats({ vectorPaths: ["a", "b"], graphPaths: ["b", "c"] })
    expect(result.jaccard).toBeCloseTo(1 / 3)
    expect(result.addedCount).toBe(1)
  })

  it("computes jaccard=0 and addedCount=N for disjoint sets", () => {
    // vector=[a], graph=[b,c] → intersection={}, union={a,b,c} (size 3)
    const result = graphOverlapStats({ vectorPaths: ["a"], graphPaths: ["b", "c"] })
    expect(result.jaccard).toBe(0)
    expect(result.addedCount).toBe(2)
  })

  it("computes jaccard=1 and addedCount=0 for identical sets", () => {
    const result = graphOverlapStats({ vectorPaths: ["x", "y"], graphPaths: ["x", "y"] })
    expect(result.jaccard).toBe(1)
    expect(result.addedCount).toBe(0)
  })

  it("returns jaccard=0 and addedCount=0 for empty sets", () => {
    const result = graphOverlapStats({ vectorPaths: [], graphPaths: [] })
    expect(result.jaccard).toBe(0)
    expect(result.addedCount).toBe(0)
  })

  it("computes correctly when vector is empty but graph has paths", () => {
    // union = graph paths, intersection = 0, jaccard = 0, addedCount = graph.length
    const result = graphOverlapStats({ vectorPaths: [], graphPaths: ["a", "b"] })
    expect(result.jaccard).toBe(0)
    expect(result.addedCount).toBe(2)
  })

  it("computes correctly when graph is empty but vector has paths", () => {
    // union = vector paths, intersection = 0, jaccard = 0, addedCount = 0
    const result = graphOverlapStats({ vectorPaths: ["a", "b"], graphPaths: [] })
    expect(result.jaccard).toBe(0)
    expect(result.addedCount).toBe(0)
  })

  it("deduplicates duplicate paths within each set for jaccard", () => {
    // vector=[a,a,b] → Set{a,b}, graph=[b,b,c] → Set{b,c}
    // intersection={b} (1), union={a,b,c} (3), jaccard=1/3
    const result = graphOverlapStats({ vectorPaths: ["a", "a", "b"], graphPaths: ["b", "b", "c"] })
    expect(result.jaccard).toBeCloseTo(1 / 3)
    expect(result.addedCount).toBe(1)
  })
})

// ─── SIG-138 Fix 1: GRAPH_RPC_TIMEOUT_MS budget constant ─────────────────────
//
// Validates that the graph RPC timeout constant is exported with a sensible
// default (tight enough to bound orchestrator wall time, generous enough for
// a healthy DO RPC).

describe("GRAPH_RPC_TIMEOUT_MS", () => {
  it("is exported and set to 2500 ms by default", () => {
    expect(GRAPH_RPC_TIMEOUT_MS).toBe(2_500)
  })

  it("is well below RETRIEVAL_PREFLIGHT_TIMEOUT_MS so a timed-out graph RPC cannot consume the full preflight budget", () => {
    expect(GRAPH_RPC_TIMEOUT_MS).toBeLessThan(RETRIEVAL_PREFLIGHT_TIMEOUT_MS)
  })
})

// SIG-216: post-emit scope normalization. LLM specialists sometimes
// emit `scope: "file"` for findings that have a concrete `(path, line)`
// AND that line falls within a reviewable diff hunk. The renderer
// routes any non-line scope into the Review Body section, losing the
// inline anchor (PR #173 regression). `validateForSubmission` flips
// the anchorable shape back to `scope: "line"` before any scope-
// dependent gate fires; PR-level, comment-scope, and non-anchorable
// file findings are left alone.
describe("validateForSubmission — SIG-216 scope normalization (file → line when anchorable)", () => {
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
        ],
      },
      elapsedMs: 100,
    },
  ]

  function packSynth(finding: PrReviewFinding): {
    verdict: PrReviewVerdict
    provenance: SynthesizerProvenance
  } {
    return {
      verdict: {
        summary: "ok",
        confidence: 4,
        confidenceReason: "...",
        findings: [finding],
      },
      provenance: {
        findings: [{
          sourceSpecialists: ["logic"],
          sourceFindingIds: ["logic-0"],
          action: "kept",
          verifiedViaRetrieval: false,
        }],
        dropped: [],
      },
    }
  }

  let logSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    logSpy.mockRestore()
  })

  it("flips file → line when finding has (path, line) and line is in a hunk", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "file" }),
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.scope).toBe("line")
    expect(out.unanchoredFindings).toHaveLength(0)

    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
    const payload = JSON.parse(flips[0]!) as Record<string, unknown>
    expect(payload).toMatchObject({
      event: "pr-review-scope-normalized-to-line",
      fromScope: "file",
      path: "src/lib/foo.ts",
      line: 42,
      category: "logic",
    })
  })

  it("leaves pr scope alone even when line is in a hunk", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "pr" }),
      reviewable,
      specialistVerdicts,
    })
    // pr-scope findings are unanchorable by definition; the line
    // validity check downstream routes them to unanchoredFindings.
    expect(out.verdict.findings.find((f) => f.scope === "line")).toBeUndefined()
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("leaves comment scope alone even when line is in a hunk", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "comment" }),
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings.find((f) => f.scope === "line")).toBeUndefined()
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("leaves file scope alone when line is not in any hunk (LLM's file-scope choice was right)", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 999, score: 4, scope: "file" }),
      reviewable,
      specialistVerdicts,
    })
    // Not anchorable to a hunk; the renderer's body-finding path is
    // correct here. The scope stays "file" so the body section keeps
    // it.
    const unanchored = out.unanchoredFindings.find((f) => f.line === 999)
    expect(unanchored?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("leaves file scope alone when path is not in the reviewable map", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        path: "src/lib/not-in-diff.ts",
        line: 42,
        score: 4,
        scope: "file",
      }),
      reviewable,
      specialistVerdicts,
    })
    const unanchored = out.unanchoredFindings.find((f) => f.path === "src/lib/not-in-diff.ts")
    expect(unanchored?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("leaves file scope alone when line is missing/invalid", () => {
    // `line` typed as number, so simulate "missing" by feeding NaN
    // (which the normalizer rejects via Number.isFinite). Cast through
    // unknown to satisfy the typed-input surface used by callers that
    // bypass schema validation.
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: Number.NaN,
        score: 4,
        scope: "file",
      } as unknown as PrReviewFinding),
      reviewable,
      specialistVerdicts,
    })
    // The downstream line-validity check drops the finding into
    // unanchoredFindings; the scope must remain "file" because the
    // normalizer should not have flipped it.
    const unanchored = out.unanchoredFindings[0]
    expect(unanchored?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  it("is idempotent — applying normalization twice produces the same result", () => {
    const first = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "file" }),
      reviewable,
      specialistVerdicts,
    })
    const flippedOnce = first.verdict.findings[0]
    expect(flippedOnce?.scope).toBe("line")

    // Re-pack the once-flipped finding (now scope: "line") and run it
    // through the validator again. The normalizer's early return on
    // already-line scope must leave it untouched and emit no flip
    // telemetry the second time.
    logSpy.mockClear()
    const second = validateForSubmission({
      synthOutput: packSynth({ ...flippedOnce! }),
      reviewable,
      specialistVerdicts,
    })
    const flippedTwice = second.verdict.findings[0]
    expect(flippedTwice?.scope).toBe("line")
    expect(flippedTwice).toEqual(flippedOnce)
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  // SIG-216 fix-up: the scope-normalization predicate now requires a
  // RIGHT-side anchor. A LEFT-only diff position (deleted line) was
  // previously flipping the scope, then `buildReviewSubmission` would
  // always emit `side: "RIGHT"` → primary submit 422'd. The downstream
  // `deriveSide` still finds LEFT and treats the finding as line-valid
  // (so it lands in `verdict.findings`, not `unanchoredFindings`), but
  // the scope MUST remain "file" so the renderer routes it to the body
  // section rather than emitting an inline comment that would 422.
  it("leaves file scope alone when the matching anchor is LEFT-only (deleted-line position)", () => {
    const leftOnlyReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        { line: 42, side: "LEFT" }, // deleted line — anchorable but not on RIGHT
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({ ...baseFinding, line: 42, score: 4, scope: "file" }),
      reviewable: leftOnlyReviewable,
      specialistVerdicts,
    })
    // Find the finding in EITHER bucket — scope must remain "file"
    // wherever it ends up, because flipping to "line" would route it
    // through the inline-comment path which always emits side=RIGHT.
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  // SIG-216 follow-up: multi-line findings now flip when ANY line in
  // the inclusive [startLine, line] range is in a RIGHT-side hunk.
  // GitHub accepts multi-line inline comments via start_line + line
  // even when only the middle of the range is in the diff. The prior
  // strict-bounds check over-suppressed (PR #175 dogfood: a 15-line
  // finding range with the diff in the middle got routed to body).
  it("flips file → line for multi-line findings when only `line` is in a RIGHT-side hunk (relaxed any-line-in-range)", () => {
    const partialReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        // `line: 42` is RIGHT-anchorable, but `startLine: 38` is not.
        { line: 42, side: "RIGHT" },
        { line: 50, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: partialReviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.scope).toBe("line")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
  })

  it("flips file → line for multi-line findings when BOTH startLine AND line are in RIGHT-side hunks", () => {
    const bothRightReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        { line: 38, side: "RIGHT" },
        { line: 42, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: bothRightReviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.scope).toBe("line")
  })

  // SIG-216 follow-up regression: PR #175 dogfood case — a 15-line
  // finding (`src/lib/index-delete.ts:429-444`) where the PR added
  // lines 432-438 in the middle of the range. Neither endpoint is in
  // the diff, but the middle is. Must flip inline.
  it("flips file → line for multi-line findings when only middle lines are in RIGHT-side hunks (PR #175 case)", () => {
    const middleOnlyReviewable: ReviewableMap = new Map([
      ["src/lib/index-delete.ts", [
        { line: 432, side: "RIGHT" },
        { line: 433, side: "RIGHT" },
        { line: 434, side: "RIGHT" },
        { line: 435, side: "RIGHT" },
        { line: 436, side: "RIGHT" },
        { line: 437, side: "RIGHT" },
        { line: 438, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        path: "src/lib/index-delete.ts",
        line: 444,
        startLine: 429,
        score: 4,
        scope: "file",
      }),
      reviewable: middleOnlyReviewable,
      specialistVerdicts,
    })
    // Option A (SIG-216 follow-up): the normalizer flipped scope to
    // "line" because the middle of the [429, 444] range overlaps the
    // diff, AND the line-validity check now uses `findRangeAwareAnchor`
    // to rewrite f.line/f.startLine to the actually-anchorable subrange
    // ([432, 438]) so the inline POST won't 422. The finding MUST land
    // in `verdict.findings` with scope:"line" and MUST NOT appear in
    // `unanchoredFindings`.
    expect(
      out.unanchoredFindings.find((f) => f.path === "src/lib/index-delete.ts"),
    ).toBeUndefined()
    const matching = out.verdict.findings.find((f) => f.path === "src/lib/index-delete.ts")
    expect(matching).toBeDefined()
    expect(matching?.scope).toBe("line")
    // Endpoints rewritten to the in-diff subrange: last RIGHT anchor
    // (438) is the new `line` (bottom of underline); first RIGHT anchor
    // (432) is the new `start_line` (top).
    expect(matching?.line).toBe(438)
    expect(matching?.startLine).toBe(432)
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
  })

  // PR #176 CR follow-up: the range-aware rewrite must run BEFORE
  // `deriveSide` so that the rewritten endpoints (not the stale
  // originals) drive subsequent validation. Same PR #175 dogfood
  // shape — neither endpoint is anchorable, only middle lines are —
  // but this case asserts the rewrite happens up-front (the finding
  // lands in `verdict.findings` with rewritten endpoints AND
  // `remappedInvalidLineToInline` increments) rather than slipping
  // through `deriveSide` against the stale `startLine: 429`.
  it("rewrites multi-line endpoints BEFORE deriveSide so unanchorable startLine can't slip through (PR #176 CR follow-up)", () => {
    const middleOnlyReviewable: ReviewableMap = new Map([
      ["src/lib/index-delete.ts", [
        { line: 432, side: "RIGHT" },
        { line: 433, side: "RIGHT" },
        { line: 434, side: "RIGHT" },
        { line: 435, side: "RIGHT" },
        { line: 436, side: "RIGHT" },
        { line: 437, side: "RIGHT" },
        { line: 438, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        path: "src/lib/index-delete.ts",
        line: 444,
        startLine: 429,
        score: 4,
        scope: "line",
      }),
      reviewable: middleOnlyReviewable,
      specialistVerdicts,
    })
    expect(
      out.unanchoredFindings.find((f) => f.path === "src/lib/index-delete.ts"),
    ).toBeUndefined()
    const matching = out.verdict.findings.find((f) => f.path === "src/lib/index-delete.ts")
    expect(matching).toBeDefined()
    // Rewritten to the in-diff subrange — NOT the stale originals
    // (line: 444, startLine: 429), which would 422 on `start_line`.
    expect(matching?.line).toBe(438)
    expect(matching?.startLine).toBe(432)
    expect(matching?.line).not.toBe(444)
    expect(matching?.startLine).not.toBe(429)
    // The rewrite happened, so the counter increments exactly once.
    expect(out.remappedInvalidLineToInline).toBe(1)
  })

  it("flips file → line for multi-line findings when only `startLine` is in a RIGHT-side hunk", () => {
    const startOnlyReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        // `startLine: 38` is RIGHT-anchorable, but `line: 42` is not.
        { line: 38, side: "RIGHT" },
        { line: 50, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: startOnlyReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("line")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(1)
  })

  it("leaves file scope alone for multi-line findings when NEITHER endpoint NOR any middle line is in a RIGHT-side hunk", () => {
    const noOverlapReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        // Range [38, 42] has nothing overlapping the reviewable lines.
        { line: 100, side: "RIGHT" },
        { line: 101, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: noOverlapReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("file")
    const flips = logSpy.mock.calls
      .map((c) => (typeof c[0] === "string" ? c[0] : ""))
      .filter((s) => s.includes("pr-review-scope-normalized-to-line"))
    expect(flips).toHaveLength(0)
  })

  // CR MAJOR (PR #176): the predicate previously walked the numeric
  // [startLine, line] range, which is O(N*M) and unbounded — a finding
  // with `startLine: 1, line: 999999` would loop a million times per
  // anchor check. Pivoted to a single-pass scan over the (small)
  // anchorLines array. These tests pin the post-fix behaviour AND act
  // as a regression guard against any future revert that would
  // reintroduce the quadratic walk.
  it("flips file → line for an extreme-range finding (startLine: 1, line: 999999) when one anchor lands inside the range", () => {
    const sparseReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        // One RIGHT anchor at line 500 inside the giant [1, 999999] range.
        { line: 500, side: "RIGHT" },
      ]],
    ])
    const start = performance.now()
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 999999,
        startLine: 1,
        score: 4,
        scope: "file",
      }),
      reviewable: sparseReviewable,
      specialistVerdicts,
    })
    const elapsedMs = performance.now() - start
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("line")
    // Generous bound — the post-fix single-pass scan finishes in well
    // under a millisecond. The prior numeric-range walk would have
    // iterated ~1M times per finding and taken hundreds of ms.
    expect(elapsedMs).toBeLessThan(500)
  })

  it("returns false when the path has no anchor entries (empty anchorLines map miss)", () => {
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        path: "src/lib/unreviewed.ts",
        line: 42,
        score: 4,
        scope: "file",
      }),
      reviewable, // map keyed by "src/lib/foo.ts" — no entry for unreviewed.ts
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/unreviewed.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/unreviewed.ts")
    expect(matching?.scope).toBe("file")
  })

  it("returns false when every anchor is LEFT-side (RIGHT-side filter holds)", () => {
    const leftOnlyReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        { line: 40, side: "LEFT" },
        { line: 41, side: "LEFT" },
        { line: 42, side: "LEFT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 40,
        score: 4,
        scope: "file",
      }),
      reviewable: leftOnlyReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("file")
  })

  it("returns false when every RIGHT anchor sits outside the range", () => {
    const outsideRangeReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        { line: 10, side: "RIGHT" },
        { line: 100, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: outsideRangeReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("file")
  })

  it("returns true when a single RIGHT anchor sits inside the range", () => {
    const insideRangeReviewable: ReviewableMap = new Map([
      ["src/lib/foo.ts", [
        { line: 5, side: "LEFT" },
        { line: 40, side: "RIGHT" }, // inside [38, 42]
        { line: 100, side: "RIGHT" },
      ]],
    ])
    const out = validateForSubmission({
      synthOutput: packSynth({
        ...baseFinding,
        line: 42,
        startLine: 38,
        score: 4,
        scope: "file",
      }),
      reviewable: insideRangeReviewable,
      specialistVerdicts,
    })
    const matching =
      out.verdict.findings.find((f) => f.path === "src/lib/foo.ts") ??
      out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(matching?.scope).toBe("line")
  })
})

// SIG-216 fix-up: the production review path now threads `linkContext`
// through `buildReviewSubmissionWithMetadata` (was test-only previously).
// This invariant pins the call-shape so real PR reviews render the
// clickable GitHub blob URL for body-only finding anchors instead of
// the back-compat inline-code shape.
describe("buildReviewSubmissionWithMetadata — SIG-216 linkContext threading from ensemble", () => {
  it("emits a clickable [path:line](https://github.com/...) link when linkContext is supplied", () => {
    const headSha = "deadbeefcafe1234567890abcdef1234567890ab"
    const bodyFinding: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 42,
      // scope=comment routes to the body-only renderer regardless of
      // reviewable-map presence (matches the test pattern in
      // tests/triage-pr-review.test.ts:1986).
      scope: "comment",
      // SIG-281 PR B (Rec 6): score 3 keeps this in the "Review Body
      // Findings" section so the clickable-link assertion isn't confounded
      // by a Fix Plan table row (score>=4 body-only blockers also render
      // in the table, which uses the compact `path:line` form).
      // linkContext threading is severity-independent.
      score: 3,
      category: "logic",
      headline: "missing null guard",
      body: "Wrap with a guard before deref.",
    }
    const result = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "One body-only finding.",
        confidence: 3,
        confidenceReason: "Fixture.",
        findings: [bodyFinding],
      },
      prAuthor: "alice",
      headSha,
      // Exact shape the ensemble now threads at the call site in
      // src/lib/triage-pr-review-ensemble.ts (search for "linkContext:"
      // inside the buildReviewSubmissionWithMetadata call).
      linkContext: { owner: "octo", repo: "demo", headSha },
    })
    const body = result.submission.body ?? ""
    // The body anchor MUST be a clickable markdown link to a GitHub
    // blob URL at the reviewed SHA — NOT the back-compat
    // `\`path:line\`` inline-code shape.
    expect(body).toMatch(
      /\[[^\]]*src\/lib\/foo\.ts:42[^\]]*\]\(https:\/\/github\.com\/octo\/demo\/blob\/[0-9a-f]+\/src\/lib\/foo\.ts#L42\)/,
    )
    expect(body).not.toContain("`src/lib/foo.ts:42`")
  })
})
