// SIG-285 v2 PR1 — receipt-join verification tests.
//
// The pure verdict: a sev>=4 security finding with a resolvable evidenceId is
// CONFIRMED when the SAME rule-class still fires at its path+(windowed)line in
// the runner receipt's HEAD SARIF, INCONCLUSIVE on any absence (NEVER refuted —
// absence is over-determined), NO-CHECK when not eligible.

import { describe, expect, it } from "vitest"
import {
  buildReceiptIndex,
  extractReceiptScanResults,
  isReceiptJoinEligible,
  ruleIdFromEvidenceId,
  verifyFindingAgainstReceipt,
  type ReceiptScanResult,
  type SarifPathNormalizer,
} from "@/src/lib/verification/verify-finding-receipt"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { SarifRun } from "@/src/features/sarif-evidence"

// A stub normalizer: an inline uri → lowercased path; else resolve `index`
// AGAINST the forwarded `artifacts` table (so the test genuinely fails if the
// extractor stops forwarding run.artifacts — CodeRabbit); else fail.
const stubNormalize: SarifPathNormalizer = (uri, opts) => {
  if (typeof uri === "string" && uri.length > 0) return { ok: true, path: uri.toLowerCase() }
  if (typeof opts.index === "number") {
    const resolved = opts.artifacts?.[opts.index]?.location?.uri
    if (typeof resolved === "string" && resolved.length > 0) return { ok: true, path: resolved.toLowerCase() }
  }
  return { ok: false, reason: "no uri or resolvable index" }
}

function run(results: SarifRun["results"], artifacts?: SarifRun["artifacts"]): SarifRun {
  return {
    tool: { driver: { name: "semgrep" } },
    results,
    ...(artifacts ? { artifacts } : {}),
  } as SarifRun
}

function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/auth.ts",
    line: 42,
    score: 5,
    category: "security",
    headline: "hardcoded credential",
    body: "An API key literal.",
    evidenceId: "secret:aws-access-key:abc123:42",
    ...over,
  } as PrReviewFinding
}

function index(results: ReceiptScanResult[]): Map<string, ReceiptScanResult[]> {
  return buildReceiptIndex(results)
}

describe("isReceiptJoinEligible", () => {
  it("eligible: sev>=4 security finding with a resolvable evidenceId", () => {
    expect(isReceiptJoinEligible(finding())).toBe(true)
  })
  it("NOT eligible: score < 4", () => {
    expect(isReceiptJoinEligible(finding({ score: 3 }))).toBe(false)
  })
  it("NOT eligible: non-security category", () => {
    expect(isReceiptJoinEligible(finding({ category: "logic" }))).toBe(false)
  })
  it("NOT eligible: no evidenceId / the authz NONE sentinel", () => {
    expect(isReceiptJoinEligible(finding({ evidenceId: undefined }))).toBe(false)
    expect(isReceiptJoinEligible(finding({ evidenceId: "NONE" }))).toBe(false)
    expect(isReceiptJoinEligible(finding({ evidenceId: "" }))).toBe(false)
  })
})

describe("ruleIdFromEvidenceId", () => {
  it("extracts the rule-id segment (tool:rule-id:hash:line)", () => {
    expect(ruleIdFromEvidenceId("secret:aws-access-key:abc123:42")).toBe("aws-access-key")
    expect(ruleIdFromEvidenceId("semgrep:python.lang.security.audit.x:h:7")).toBe("python.lang.security.audit.x")
  })
  it("returns null on an unrecognizable shape", () => {
    expect(ruleIdFromEvidenceId("noseparator")).toBeNull()
    expect(ruleIdFromEvidenceId("tool:")).toBeNull()
  })
})

describe("verifyFindingAgainstReceipt", () => {
  it("NO-CHECK for an ineligible finding (no scan touched)", () => {
    const r = verifyFindingAgainstReceipt(
      finding({ category: "logic" }),
      index([{ path: "src/auth.ts", ruleId: "aws-access-key", line: 42 }]),
    )
    expect(r.verdict).toBe("no-check")
  })

  it("CONFIRMED: same rule-class still fires at the path + exact line on HEAD", () => {
    const r = verifyFindingAgainstReceipt(
      finding(),
      index([{ path: "src/auth.ts", ruleId: "aws-access-key", line: 42 }]),
    )
    expect(r.verdict).toBe("confirmed")
    expect(r.check?.kind).toBe("receipt-join")
    expect(r.check?.status).toBe("pass")
  })

  it("CONFIRMED within the line window (merge/head drift absorbed)", () => {
    const r = verifyFindingAgainstReceipt(
      finding({ line: 42 }),
      index([
        { path: "src/auth.ts", ruleId: "aws-access-key", line: 49 }, // +7, within ±10
      ]),
    )
    expect(r.verdict).toBe("confirmed")
  })

  it("CONFIRMED on a path-only (line-less) result", () => {
    const r = verifyFindingAgainstReceipt(
      finding(),
      index([
        { path: "src/auth.ts", ruleId: "aws-access-key" }, // no line (IaC/dep)
      ]),
    )
    expect(r.verdict).toBe("confirmed")
  })

  it("CONFIRMED on a namespaced ruleId (either-contains-other)", () => {
    const r = verifyFindingAgainstReceipt(
      finding(),
      index([{ path: "src/auth.ts", ruleId: "semgrep.aws-access-key.v2", line: 42 }]),
    )
    expect(r.verdict).toBe("confirmed")
  })

  it("INCONCLUSIVE: no result at the path (absence is over-determined, NEVER refuted)", () => {
    const r = verifyFindingAgainstReceipt(finding(), index([]))
    expect(r.verdict).toBe("inconclusive")
    expect(r.verdict).not.toBe("refuted")
  })

  it("INCONCLUSIVE: matching rule but the line is OUTSIDE the window", () => {
    const r = verifyFindingAgainstReceipt(
      finding({ line: 42 }),
      index([
        { path: "src/auth.ts", ruleId: "aws-access-key", line: 80 }, // +38, outside ±10
      ]),
    )
    expect(r.verdict).toBe("inconclusive")
  })

  it("INCONCLUSIVE: a DIFFERENT rule fires at the same path/line (not the same check)", () => {
    const r = verifyFindingAgainstReceipt(
      finding(),
      index([{ path: "src/auth.ts", ruleId: "sql-injection", line: 42 }]),
    )
    expect(r.verdict).toBe("inconclusive")
  })

  it("INCONCLUSIVE: a result on a DIFFERENT path doesn't confirm", () => {
    const r = verifyFindingAgainstReceipt(
      finding(),
      index([{ path: "src/other.ts", ruleId: "aws-access-key", line: 42 }]),
    )
    expect(r.verdict).toBe("inconclusive")
  })

  it("NEVER emits `refuted` across any input (PR1 cannot demote)", () => {
    const inputs: ReceiptScanResult[][] = [[], [{ path: "src/auth.ts", ruleId: "x", line: 999 }]]
    for (const results of inputs) {
      const r = verifyFindingAgainstReceipt(finding(), index(results))
      expect(r.verdict).not.toBe("refuted")
    }
  })

  it("never throws on degenerate input", () => {
    expect(() =>
      verifyFindingAgainstReceipt(finding({ evidenceId: "weird", line: undefined }), index([])),
    ).not.toThrow()
  })
})

describe("extractReceiptScanResults", () => {
  it("maps result path/line/ruleId from an inline uri", () => {
    const out = extractReceiptScanResults(
      [
        run([
          {
            ruleId: "aws-key",
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "Src/Auth.ts" },
                  region: { startLine: 42 },
                },
              },
            ],
          },
        ]),
      ],
      stubNormalize,
    )
    expect(out).toEqual([{ path: "src/auth.ts", ruleId: "aws-key", line: 42 }])
  })

  it("drops rule-less results", () => {
    const out = extractReceiptScanResults(
      [
        run([
          {
            locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 1 } } }],
          },
        ]),
      ],
      stubNormalize,
    )
    expect(out).toEqual([])
  })

  it("emits one entry per location (multi-location result)", () => {
    const out = extractReceiptScanResults(
      [
        run([
          {
            ruleId: "r",
            locations: [
              { physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 1 } } },
              { physicalLocation: { artifactLocation: { uri: "b.ts" }, region: { startLine: 2 } } },
            ],
          },
        ]),
      ],
      stubNormalize,
    )
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.path)).toEqual(["a.ts", "b.ts"])
  })

  it("path-only (no startLine) yields an entry without a line", () => {
    const out = extractReceiptScanResults(
      [
        run([
          {
            ruleId: "dep",
            locations: [{ physicalLocation: { artifactLocation: { uri: "pkg.lock" } } }],
          },
        ]),
      ],
      stubNormalize,
    )
    expect(out).toEqual([{ path: "pkg.lock", ruleId: "dep" }])
  })

  it("resolves an index-based path via the run artifacts (no inline uri)", () => {
    const out = extractReceiptScanResults(
      [
        run(
          [
            {
              ruleId: "r",
              locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 5 } } }],
            },
          ],
          [{ location: { uri: "From-Index.ts" } }],
        ),
      ],
      stubNormalize,
    )
    expect(out).toEqual([{ path: "from-index.ts", ruleId: "r", line: 5 }]) // resolved THROUGH run.artifacts
  })

  it("skips a location the normalizer rejects (ok:false)", () => {
    const out = extractReceiptScanResults(
      [
        run([{ ruleId: "r", locations: [{ physicalLocation: { region: { startLine: 1 } } }] }]), // no uri, no index → fail
      ],
      stubNormalize,
    )
    expect(out).toEqual([])
  })

  it("handles empty / missing results + runs without throwing", () => {
    expect(extractReceiptScanResults([], stubNormalize)).toEqual([])
    expect(extractReceiptScanResults([run(undefined)], stubNormalize)).toEqual([])
  })
})

describe("buildReceiptIndex", () => {
  it("groups results by path; drops path-less entries", () => {
    const idx = buildReceiptIndex([
      { path: "a.ts", ruleId: "r1", line: 1 },
      { path: "a.ts", ruleId: "r2", line: 2 },
      { path: "", ruleId: "r3", line: 3 },
    ])
    expect(idx.get("a.ts")).toHaveLength(2)
    expect(idx.has("")).toBe(false)
  })
})
