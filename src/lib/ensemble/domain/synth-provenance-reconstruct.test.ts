// SIG-392 — synth provenance reconstruction (gemma large-payload recovery).

import { describe, expect, it } from "vitest"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import {
  reconstructSynthProvenance,
  type ProvenanceSource,
} from "@/src/lib/ensemble/domain/synth-provenance-reconstruct"

function vf(over: Partial<PrReviewFinding>): PrReviewFinding {
  return { path: "server/payments.ts", line: 42, score: 4, category: "logic", headline: "h", body: "b", ...over }
}
const src = (id: string, path: string, line: number, headline: string): ProvenanceSource => ({
  id,
  path,
  line,
  headline,
})

describe("reconstructSynthProvenance", () => {
  it("matches a verdict finding to its real source id (content match) and preserves BY-INDEX order", () => {
    const verdict = [
      vf({ path: "server/payments.ts", line: 178, headline: "SQL injection in webhook handler via event.invoiceId" }),
      vf({ path: "server/refunds.ts", line: 11, headline: "computeRefundCents multiplies dollars by 100" }),
    ]
    const sources = [
      src("logic-0", "server/payments.ts", 179, "SQL injection: webhook interpolates event.invoiceId into the UPDATE"),
      src("logic-1", "server/refunds.ts", 11, "Refund amount treated as dollars times 100 — float precision"),
      src("security-2", "server/payments.ts", 30, "Missing authz on charge endpoint"),
    ]
    const { provenance, matched, unmatched } = reconstructSynthProvenance(verdict, sources)
    expect(provenance.findings).toHaveLength(2)
    // index 0 ↔ verdict[0]
    expect(provenance.findings[0]!.sourceFindingIds).toEqual(["logic-0"])
    expect(provenance.findings[0]!.sourceSpecialists).toEqual(["logic"])
    expect(provenance.findings[1]!.sourceFindingIds).toEqual(["logic-1"])
    expect(matched).toBe(2)
    expect(unmatched).toBe(0)
    expect(provenance.dropped).toEqual([])
  })

  it("gives an unmatched (untraceable) finding empty sourceFindingIds — the guard then drops it", () => {
    const verdict = [vf({ path: "server/x.ts", line: 5, headline: "totally novel claim no specialist made" })]
    const sources = [src("logic-0", "server/payments.ts", 179, "SQL injection in webhook")]
    const { provenance, matched, unmatched } = reconstructSynthProvenance(verdict, sources)
    expect(provenance.findings[0]!.sourceFindingIds).toEqual([])
    expect(matched).toBe(0)
    expect(unmatched).toBe(1)
  })

  it("collects multiple source ids + roles co-located at the anchor (path+line), ascending", () => {
    const verdict = [vf({ path: "p.ts", line: 50, headline: "webhook signature verification is broken" })]
    const sources = [
      src("security-3", "p.ts", 50, "webhook signature verification always passes (timing)"),
      src("logic-1", "p.ts", 52, "webhook signature check is broken and bypassable"),
      src("tests-0", "p.ts", 51, "webhook signature verification has no test"),
      src("logic-9", "other.ts", 50, "unrelated finding elsewhere"),
    ]
    const { provenance } = reconstructSynthProvenance(verdict, sources)
    const row = provenance.findings[0]!
    expect(row.sourceFindingIds).toEqual(["logic-1", "security-3", "tests-0"])
    expect(row.sourceSpecialists).toEqual(["logic", "security", "tests"])
  })

  it("does NOT match across files or beyond the line slack", () => {
    const verdict = [vf({ path: "a.ts", line: 100, headline: "off by one in pagination offset" })]
    const sources = [
      src("logic-0", "b.ts", 100, "off by one in pagination offset"), // wrong file
      src("logic-1", "a.ts", 120, "off by one in pagination offset"), // line too far (>5)
    ]
    expect(reconstructSynthProvenance(verdict, sources).provenance.findings[0]!.sourceFindingIds).toEqual([])
  })
})
