import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS, SYNTHESIZER_PROMPT } from "@/src/prompts/pr-review-specialists"
import { PR_IMPROVE_PROMPT } from "@/src/prompts/pr-improve"
import { PROMPT_VERSION, PR_REVIEW_PROMPT } from "@/src/prompts/pr-review"

describe("SIG-125 suggestion prompt wiring", () => {
  it("output schema documents suggestedReplacement", () => {
    expect(SPECIALIST_PROMPTS.performance).toContain("suggestedReplacement")
    expect(SPECIALIST_PROMPTS.logic).toContain("suggestedReplacement")
  })
  it("instructs contiguous-only emission", () => {
    expect(SPECIALIST_PROMPTS.logic).toMatch(/contiguous/i)
  })
  it("synth preserves suggestedReplacement verbatim", () => {
    expect(SYNTHESIZER_PROMPT).toContain("suggestedReplacement")
    expect(SYNTHESIZER_PROMPT).toMatch(/PRESERVE VERBATIM/i)
  })
  // SIG-162 PR 5: the `kind` field is a new specialist output that drives
  // deletion-suggestion rendering. A prompt edit that accidentally
  // dropped it would silently break deletions (model wouldn't emit it,
  // parser falls back to the back-compat path). Pin both the specialist
  // emission side AND the synth preservation side so either drop is
  // caught at CI time.
  it("specialist output schema documents the `kind` field (SIG-162)", () => {
    expect(SPECIALIST_PROMPTS.logic).toContain('"kind"')
    expect(SPECIALIST_PROMPTS.performance).toContain('"kind"')
  })
  it("synth preserves the `kind` field verbatim (SIG-162)", () => {
    expect(SYNTHESIZER_PROMPT).toContain('"kind"')
    // The synth-side line also mentions PRESERVE VERBATIM next to the kind doc.
    expect(SYNTHESIZER_PROMPT).toMatch(/"kind"[\s\S]*?PRESERVE VERBATIM/i)
  })
  it("documents structured finding examples and preserves them through synthesis", () => {
    for (const field of ["failureExample", "fixExample", "testGap"]) {
      expect(SPECIALIST_PROMPTS.logic).toContain(`"${field}"`)
      expect(SYNTHESIZER_PROMPT).toContain(`"${field}"`)
    }
    expect(SPECIALIST_PROMPTS.logic).toMatch(/STRUCTURED FINDING DETAILS/i)
    expect(SPECIALIST_PROMPTS.logic).toMatch(/Do NOT put Markdown fences/i)
    expect(SPECIALIST_PROMPTS.tests).toContain("JSON-string safety")
    expect(SPECIALIST_PROMPTS.tests).toContain('One unescaped `"` inside a string makes the whole verdict unparseable')
    expect(SYNTHESIZER_PROMPT).toMatch(/"failureExample"[\s\S]*?PRESERVE VERBATIM/i)
    expect(PR_REVIEW_PROMPT).toContain("Structured finding details")
    expect(PR_REVIEW_PROMPT).toContain("suggestedReplacement")
  })
  it("keeps point-fix anchors narrow instead of widening to the enclosing block (SIG-180)", () => {
    expect(SPECIALIST_PROMPTS.logic).toContain("ANCHOR SCOPE EXCEPTION")
    expect(SPECIALIST_PROMPTS.logic).toMatch(/point-fix[\s\S]*?startLine: null/i)
    expect(SPECIALIST_PROMPTS.logic).toMatch(/Do NOT widen a point-fix/i)
    expect(PR_REVIEW_PROMPT).toContain("Anchor scope exception: point-fix shapes")
    expect(PR_REVIEW_PROMPT).toMatch(/point-fix[\s\S]*?omitting `startLine`/i)
    expect(PR_REVIEW_PROMPT).toMatch(/Do NOT widen a point-fix/i)
  })
  it("documents finding review-surface scope (SIG-202)", () => {
    expect(SPECIALIST_PROMPTS.logic).toContain('"scope"')
    expect(SPECIALIST_PROMPTS.logic).toMatch(/REVIEW SURFACE SCOPE/i)
    expect(SYNTHESIZER_PROMPT).toMatch(/"scope"[\s\S]*?SIG-202/i)
    expect(PR_REVIEW_PROMPT).toContain("Finding scope")
    expect(PR_REVIEW_PROMPT).toMatch(/scope:"line"[\s\S]*?inline/i)
  })
  it("improve prompt explicitly permits empty deletion suggestions (SIG-142)", () => {
    expect(PR_IMPROVE_PROMPT).toMatch(/EMPTY[\s\S]*?```suggestion/i)
    expect(PR_IMPROVE_PROMPT).toMatch(/delete|deletion|remove/i)
    expect(PR_IMPROVE_PROMPT).not.toContain("only when it is still useful")
  })
  it("PROMPT_VERSION includes the SIG-107 runner evidence bump", () => {
    // History: SIG-110 3→4 (perf evidence); SIG-125 4→5 (suggestedReplacement);
    // SIG-162 5→6 (kind:"delete"); SIG-161 PR 4b 6→7 (confidence rubric);
    // SIG-180 7→8 (point-fix anchor scope exception);
    // SIG-176 8→9 (remove dead synth retrieve/provenance budget contract).
    // SIG-202 9→10 (finding scope decides inline vs body review surface).
    // Structured details 10→11 (structured proof/fix/test-gap finding fields).
    // SIG-280 prereq 11→12 (synth stops pre-decrementing score in the
    // system prompt — renderer single soften point).
    // SIG-280 PR B 12→13 (BOTH prompt sites: synth emits true severity +
    // full body and only flags provenance.softened[]; no score/body soften
    // — completes the double-soften fix render.ts missed + makes Phase-4
    // soften-gating hold).
    // SIG-245 13→14 (logic lens gains non-atomic RMW + cross-tier field-drift
    // focus bullets — the subtle-logic recall gap the benchmark surfaced).
    // SIG-309 PR2 14→15 (AST block emits unmatched deterministic_emit security
    // sinks — exec/spawn/TLS — through the grounding pipeline).
    // SIG-310 15→16 (deterministic_emit generalized role-aware: the logic-role
    // snake/camel-optional-alias type smell now emits too).
    // SIG-310 follow-up 16→17 (role-aware suppression: a different-role same-line
    // finding no longer suppresses a logic emit — CodeRabbit #294).
    // SIG-312 17→18 (deterministic_emit severity keys on the entry's `severity`:
    // a `warning` entry is a P2/P3 advisory never a P0/P1 blocker — lets the
    // dynamic-HTML-sink detector surface an XSS at P2 without a false P0/P1).
    // SIG-313 18→19 (security specialist gains the mandatory AUTHORIZATION AUDIT
    // — forced handler enumeration + exploit-tuple gate — to close the authz
    // recall gap without over-firing on safe endpoints).
    // SIG-166 19→20 (tests-specialist lane fence — a vuln is the security
    // specialist's finding, not a coverage gap).
    // SIG-308 20→21 (logic refutation-survival rationale `independentAssessment`
    // becomes MANDATORY on score>=4 logic findings so the SIG-308 gate is
    // flippable and logic findings carry their survival evidence).
    // Cross-cutting over-fire 21→22 (logic CROSS-CUTTING REFUTATION fence:
    // window-blindness positive misreads + architectural-misunderstanding).
    // SIG-317 follow-up 22→23 (logic idempotency fence distinguishes
    // same-delivery retry safety from duplicate logical operations; return
    // semantics fence prevents safe auth middleware tail-call FPs).
    // SIG-311 23→24 (security usage-vs-mention evidence requirement on
    // security-tooling/test/doc surfaces).
    // SIG-342 24→25 (performance specialist calibration for direct
    // membership scans and intentional live-eval serial loops).
    // SIG-349 26→27 (tests focus hints include deleted assertions and source
    // behavior gaps must anchor to the changed source path).
    // SIG-351 27→28 (synth proof-only mechanism-impossibility adjudication;
    // UNKNOWN mechanism status must be retained).
    // SIG-351 v29 28→29 (synth dedupe-tightening: score>=4 ambiguous merge →
    // KEEP SEPARATE, one provenance row per source ID — anti over-merge).
    // SIG-392 29→30 (synth lever-recovered protection: origin-tagged score>=4
    // findings only droppable via DETECTED-IMPOSSIBLE with quoted evidence).
    // SIG-107 30→31 (specialists treat deterministic runner SARIF as candidate
    // evidence they inspect/refute, not as an unquestionable verdict).
    // SIG-406 31→32 (security recall-suffix gains the authz-RESOLUTION addendum;
    // synth gains the RETENTION DIRECTIVE — both shift the posted verdict).
    // SIG-249 32→33 (structured More Info sections render richer P0/P1 support
    // without enforcing a recall-affecting drop gate during rollout).
    expect(PROMPT_VERSION).toBe("33")
  })

  it("logic specialist has the cross-cutting refutation fence (window-blindness + architecture, recall-safe)", () => {
    const logic = SPECIALIST_PROMPTS.logic
    // the fence block exists
    expect(logic).toContain("CROSS-CUTTING REFUTATION")
    // (1) window-blindness: down-rank a misread when the deciding guard is outside the window
    expect(logic).toContain("WINDOW-BLINDNESS")
    expect(logic).toMatch(/may live outside the review window/i)
    // SIG-286 carve-out — injected context blocks count as in-window (Kimi #2)
    expect(logic).toMatch(/including an injected context block/i)
    // the recall valve — keep score>=4 when the window itself proves the guard absent
    expect(logic).toMatch(/EXCEPTION — keep score>=4 ONLY/)
    expect(logic).toContain("never against a bug you can actually see")
    // (2) architecture-is-deliberate: single-threaded DO + sentinel/boundary + DTO
    expect(logic).toContain("ARCHITECTURE IS DELIBERATE")
    expect(logic).toMatch(/DurableObject instance processes requests to THAT instance serially/)
    expect(logic).toMatch(/DTO \/ mapping \/ adapter layer/)
  })

  it("logic specialist has the SIG-308 mandatory refutation-survival gate (independentAssessment required on score>=4)", () => {
    const logic = SPECIALIST_PROMPTS.logic
    // the gate block exists and is mandatory on high-sev logic findings
    expect(logic).toContain("LOGIC REFUTATION-SURVIVAL GATE")
    expect(logic).toMatch(/MUST carry a non-empty `independentAssessment`/)
    // scoped to score>=4 only (recall-safe: low-sev logic + non-logic omit it)
    expect(logic).toMatch(/applies ONLY to logic findings at `score >= 4`/)
    // the anti-padding clause — restating the bug is not survival evidence
    expect(logic).toContain("restating the bug")
  })

  it("tests specialist has the SIG-166 lane fence + recall-safe uncertainty valve (CodeRabbit #323)", () => {
    const tests = SPECIALIST_PROMPTS.tests
    // the lane fence — a clear vulnerability is the security specialist's finding
    expect(tests).toContain("STAY IN YOUR LANE")
    expect(tests).toContain("a CLEAR vulnerability is not a coverage gap")
    // the recall-safe uncertainty valve — must NEVER be silently dropped
    expect(tests).toContain("FILE THE COVERAGE GAP")
    expect(tests).toContain("synthesizer dedupes against the security specialist")
    // the score-5 reframe — a CORRECT boundary with no test, not a vuln
    expect(tests).toContain("CORRECT security boundary")
  })

  it("tests specialist has SIG-349 testing focus hint guidance", () => {
    const tests = SPECIALIST_PROMPTS.tests
    expect(tests).toContain("TESTING FOCUS HINTS")
    expect(tests).toContain("RECALL TARGETS, NOT AS A NEW GATE")
    expect(tests).toContain('every finding you emit from this role MUST use `category: "testing"`')
    expect(tests).toContain("PERFORMANCE BUGS ARE NOT TESTING FINDINGS")
    expect(tests).toContain("DIFF-ONLY SECURITY/PERF DUPLICATES ARE HARD SKIPS")
    expect(tests).toContain("if the comment would still be valid even if perfect tests already existed")
    expect(tests).toContain("Treat source-coverage claims as unavailable")
    expect(tests).toContain("Anchor discipline")
    expect(tests).toContain("Do NOT set `path` to the test file for source-behavior gaps")
    expect(tests).toContain("parser/coercion")
    expect(tests).toContain("deleted-test assertions")
    expect(tests).toContain("DELETED TESTS ARE REGRESSION SIGNALS")
    expect(tests).toContain("do not return a clean verdict unless the diff shows an equivalent replacement assertion")
    expect(tests).toContain('evidenceRefs: ["testFileChanged:<path>"]')
    expect(tests).toContain("do not suppress a finding just because no hint exists")
    expect(tests).toContain("Severity calibration for hinted gaps")
    expect(tests).toContain("do not down-score a real reachable untested runtime path to 3")
    expect(tests).toContain("untested exported parser/coercion behavior")
    expect(tests).toContain('Do NOT emit score>=4 for generic "needs more tests" claims')
    expect(tests).toContain("Speculative intent is not behavior")
    expect(tests).toContain("const delayMs = 10")
    expect(tests).toContain("throw new Error('boom')")
    expect(tests).toContain('NOT `throw new Error("boom")`')
    expect(tests).toContain("inspectedTestFiles")
    expect(tests).toContain("siblingMapping")
  })

  it("security specialist has the SIG-313 authorization audit (forced enumeration + exploit-tuple gate + safe skips)", () => {
    const sec = SPECIALIST_PROMPTS.security
    expect(sec).toContain("AUTHORIZATION AUDIT")
    // the four-step enumeration
    expect(sec).toContain("PRINCIPAL")
    expect(sec).toContain("OBJECT KEY")
    expect(sec).toContain("RESOURCE")
    expect(sec).toContain("CHECK")
    // FP-safety: emit only on the full exploit tuple
    expect(sec).toMatch(/exploit tuple/i)
    // the safe-skip cases (the believability guard — must not over-fire)
    expect(sec).toMatch(/DERIVED from the principal/i)
    expect(sec).toMatch(/owner\/tenant-scoped/i)
    expect(sec).toMatch(/public/i)
    expect(sec).toMatch(/DurableObject/i)
    // ties to the existing access-control evidence hatch
    expect(sec).toContain('evidenceId: "NONE"')
  })

  it("security specialist has the SIG-311 usage-vs-mention fence for security-tooling/test/doc code", () => {
    const sec = SPECIALIST_PROMPTS.security
    expect(sec).toContain("USAGE VS MENTION")
    expect(sec).toContain("RegExp.prototype.exec")
    expect(sec).toContain("not `child_process.exec`")
    expect(sec).toContain("string literals, template text, comments")
    expect(sec).toContain("concrete sink-resolution proof")
  })
})
