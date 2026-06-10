import { describe, expect, it } from "vitest"
import {
  buildSynthRetryMessage,
  classifySynthOutcome,
  SPECIALIST_TIMEOUT_MS,
  SYNTHESIZER_TIMEOUT_MS,
  SYNTHESIZER_RETRY_TIMEOUT_MS,
  ORCHESTRATOR_TIMEOUT_MS,
  RESERVED_HEADROOM_MS,
  SYNTH_RETRY_FINALIZE_RESERVE_MS,
  graphExpansionMode,
  resolveDynamicEvidencePromptBlock,
} from "@/src/lib/triage-pr-review-ensemble"
import {
  buildSpecialistInitialMessage,
  buildSynthesizerInitialMessage,
} from "@/src/prompts/pr-review-specialists"
import type { Env } from "@/src/shared/types/env"

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
