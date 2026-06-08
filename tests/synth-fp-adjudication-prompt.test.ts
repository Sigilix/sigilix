// SIG-351: synth false-positive adjudication must be proof-only.
//
// The synth may filter self-contradicted specialist findings, but only when the
// source verdict/diff/context explicitly proves the mechanism impossible. Unknown
// mechanism status must stay in the review path so prompt pressure cannot trade
// recall for a cleaner FP rate.

import { describe, expect, it } from "vitest"
import { PROMPT_VERSION } from "../src/prompts/pr-review"
import { SYNTHESIZER_PROMPT } from "../src/prompts/pr-review-specialists"

describe("SIG-351 synthesizer proof-only FP adjudication prompt", () => {
  it("requires explicit quoted contradiction before dropping a high-severity source finding", () => {
    expect(SYNTHESIZER_PROMPT).toContain("MECHANISM IMPOSSIBILITY ADJUDICATION")
    expect(SYNTHESIZER_PROMPT).toContain("Only DETECTED-IMPOSSIBLE with quoted source verdict, diff, or context evidence may be dropped")
    expect(SYNTHESIZER_PROMPT).toContain('provenance.dropped[] with reason: "false positive on diff inspection"')
  })

  it("forces unknown mechanism status to retain rather than suppress", () => {
    expect(SYNTHESIZER_PROMPT).toContain("UNKNOWN mechanism status MUST be retained")
    expect(SYNTHESIZER_PROMPT).toContain("Do NOT resolve UNKNOWN to DROP")
  })

  it("keeps single-source blockers unless they are explicitly contradicted", () => {
    expect(SYNTHESIZER_PROMPT).toContain("single-source score>=4 findings are admissible")
    expect(SYNTHESIZER_PROMPT).toContain("Do NOT drop a score>=4 finding merely because only one specialist found it")
  })

  it("forbids collapsing distinct mechanisms just because they share a nearby anchor", () => {
    expect(SYNTHESIZER_PROMPT).toContain("Same file/function/line proximity is NOT enough to merge")
    expect(SYNTHESIZER_PROMPT).toContain("different fixes or describe different failure mechanisms")
    expect(SYNTHESIZER_PROMPT).toContain("\"missing inventory reservation\" and \"idempotency-token race\" are two bugs")
  })

  it("anchors the observed impossible-claim classes without making them heuristic drop rules", () => {
    expect(SYNTHESIZER_PROMPT).toContain("SSRF requires an outbound request primitive")
    expect(SYNTHESIZER_PROMPT).toContain("path traversal requires an attacker-controlled string reaching a filesystem path sink")
    expect(SYNTHESIZER_PROMPT).toContain("JSON.parse alone does not globally pollute prototypes")
  })

  it("trusts an explicit contradiction inside the source finding itself", () => {
    expect(SYNTHESIZER_PROMPT).toContain('headline "SSRF via Content-Type" but body says the PR only reads local bytes from an object binding')
    expect(SYNTHESIZER_PROMPT).toContain("Do not search for absent tokens yourself")
  })

  it("does not ask the model to do deterministic source-id ledger bookkeeping", () => {
    expect(SYNTHESIZER_PROMPT).not.toContain("SOURCE-ID LEDGER")
    expect(SYNTHESIZER_PROMPT).not.toContain("Every source finding with score>=4 must be accounted for")
  })

  it("bumps PROMPT_VERSION so stale reviews re-run with the adjudication contract", () => {
    expect(PROMPT_VERSION).toBe("28")
  })
})
