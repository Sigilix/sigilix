// VERIFIED proof — end-to-end datapath test.
//
// WHY: the per-finding VERIFIED trust pill renders ONLY for tier
// `runner-confirmed`, which in 7 days of prod has fired ZERO times — VERIFIED has
// never been observed rendering. The pieces are unit-tested in isolation (verify
// verdict; render given a hand-set tier), but NOTHING exercised the integration:
// a real receipt → `verifyFindingAgainstReceipt` = confirmed →
// `annotateFindingTrust("runner-confirmed")` → the rendered review actually
// containing the VERIFIED pill. This test closes that gap. If it PASSES, the
// mechanism works and VERIFIED is dark purely because the prod conditions (the
// runner receipt joining a real finding on a matching SHA) never occur. If it
// FAILS, we've been shipping a dead tier.

import { describe, it, expect } from "vitest"
import {
  buildReviewSubmissionWithMetadata,
  formatFindingComment,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "../src/lib/triage-pr-review"
import { buildReceiptIndex, verifyFindingAgainstReceipt } from "../src/lib/verification/verify-finding-receipt"
import { annotateFindingTrust } from "../src/lib/trust-ledger-thread"

// A genuine receipt-join-eligible finding: sev>=4 security, a resolvable
// evidenceId (`tool:ruleId:hash:line`), with a path+line the receipt scan hit.
function eligibleFinding(): PrReviewFinding {
  return {
    path: "src/auth/session.ts",
    line: 42,
    score: 4,
    category: "security",
    evidenceId: "semgrep:aws-access-key-id:9f2c1a:42",
    headline: "hard-coded AWS access key id in `getSessionToken`",
    body: "Move the credential to a secret store; rotate the exposed key.",
  }
}

describe("VERIFIED proof — full datapath: receipt → confirmed → runner-confirmed → rendered VERIFIED", () => {
  it("a runner receipt that corroborates the finding produces the VERIFIED pill end-to-end", () => {
    const finding = eligibleFinding()

    // 1. The runner receipt's HEAD scan independently flagged the same rule at
    //    the same path/line (this is what a real corroborating receipt looks like).
    const receiptIndex = buildReceiptIndex([
      { path: "src/auth/session.ts", ruleId: "aws-access-key-id", line: 42 },
    ])

    // 2. The receipt-join verdict — the integration prod never confirms.
    const verdict = verifyFindingAgainstReceipt(finding, receiptIndex)
    expect(verdict.verdict).toBe("confirmed")

    // 3. The ensemble annotates the confirmed finding (mirrors ensemble L6491-6492).
    expect(verdict.verdict === "confirmed").toBe(true)
    annotateFindingTrust(finding, { signals: ["runner-confirmed"] })
    expect(finding.trust?.tier).toBe("runner-confirmed")

    // 4. The rendered INLINE comment (score>=4 → blocker → inline) carries the
    //    cyan VERIFIED pill — the thing a user would actually see.
    const inline = formatFindingComment(finding, 5, undefined, undefined, true)
    expect(inline).toContain('alt="VERIFIED"')
    expect(inline).toContain("runner-verified")

    // 5. The review body's Trust Summary counts it as a verified proof.
    const review: PrReviewVerdict = {
      summary: "One execution-corroborated security finding.",
      confidence: 4,
      confidenceReason: "runner receipt corroborates the cited rule at the cited line",
      findings: [finding],
    }
    const body = buildReviewSubmissionWithMetadata({
      verdict: review, prAuthor: null, headSha: "abc1234", trustLedger: true,
    }).submission.body
    expect(body).toContain("**Proof**")
    expect(body.toLowerCase()).toContain("verified")
  })

  it("the SAME finding renders only MODEL when no receipt corroborates it (the prod reality)", () => {
    const finding = eligibleFinding()
    // empty receipt index → inconclusive → no runner-confirmed annotation.
    const verdict = verifyFindingAgainstReceipt(finding, buildReceiptIndex([]))
    expect(verdict.verdict).toBe("inconclusive")
    // with no trust annotation at all, the finding renders the muted MODEL pill,
    // never an unearned VERIFIED — exactly what we see in prod today.
    const inline = formatFindingComment(finding, 5, undefined, undefined, true)
    expect(inline).not.toContain('alt="VERIFIED"')
    expect(inline).toContain("trust-model")
  })
})
