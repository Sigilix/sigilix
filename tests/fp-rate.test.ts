// SIG-114 — unit tests for the offline per-specialist FP-rate core.
//
// Covers the join (full-credit multi-specialist, score gate, guard-skip,
// dedup, unmatched bucketing), the rate computation (min-n gate, Wilson,
// target check, synth aggregate), windowing, and CSV rendering.

import { describe, expect, it } from "vitest"
import { computeFid } from "../src/lib/review-memory/marker"
import {
  attributeDismissals,
  buildFindingIndex,
  dedupeDismissals,
  type AttributionResult,
} from "../src/lib/fp-rate/attribute"
import { computeFpRates } from "../src/lib/fp-rate/compute"
import { formatCsv, FP_RATE_CSV_HEADER } from "../src/lib/fp-rate/format"
import { filterReviewsToWindow } from "../src/lib/fp-rate/window"
import { createdMsFromKey, mapSignalRecord, mapTelemetryToReview, REVERSE_TS_BASE } from "../src/lib/fp-rate/ingest"
import { bucketForReason } from "../src/lib/fp-rate/types"
import type {
  FpRateDismissal,
  FpRateReview,
  RawSynthFinding,
  SpecialistRole,
} from "../src/lib/fp-rate/types"

const DAY = 24 * 60 * 60 * 1000

function finding(
  path: string,
  line: number,
  headline: string,
  score: number,
  roles: SpecialistRole[],
): RawSynthFinding {
  return { path, line, headline, score, sourceSpecialists: roles }
}

function review(
  prNumber: number,
  synthFindings: RawSynthFinding[] | null,
  opts: Partial<FpRateReview> = {},
): FpRateReview {
  return {
    owner: "o",
    repo: "r",
    prNumber,
    createdMs: opts.createdMs ?? 1_000_000,
    fellBackReason: opts.fellBackReason ?? null,
    synthFindings,
  }
}

async function fidOf(f: RawSynthFinding): Promise<string> {
  return computeFid({ ruleId: null, path: f.path, line: f.line, headline: f.headline })
}

function dismissal(fid: string, opts: Partial<FpRateDismissal> = {}): FpRateDismissal {
  return {
    fid,
    prNumber: opts.prNumber ?? 1,
    commentId: opts.commentId ?? Math.floor(fid.charCodeAt(0)),
    dismissReason: opts.dismissReason,
    tsMs: opts.tsMs ?? 1_000_000,
  }
}

describe("bucketForReason", () => {
  it("buckets hard / soft / unlabeled", () => {
    expect(bucketForReason("not-a-bug")).toBe("hard")
    expect(bucketForReason("wrong-context")).toBe("hard")
    expect(bucketForReason("bad-anchor")).toBe("soft")
    expect(bucketForReason("already-covered")).toBe("soft")
    expect(bucketForReason("too-minor")).toBe("soft")
    expect(bucketForReason("unlabeled")).toBe("unlabeled")
    expect(bucketForReason(undefined)).toBe("unlabeled")
  })
})

describe("buildFindingIndex", () => {
  it("excludes sub-gate scores, guard-skipped, and null-synth reviews; dedupes same-PR reruns", async () => {
    const fHigh = finding("a.ts", 10, "real bug", 5, ["logic"])
    const fLow = finding("a.ts", 20, "minor", 3, ["logic"]) // below score gate
    const reviews: FpRateReview[] = [
      review(1, [fHigh, fLow]),
      review(1, [fHigh]), // rerun of the SAME PR -> deduped to one
      review(3, [finding("b.ts", 5, "x", 5, ["security"])], {
        fellBackReason: "merged_before_fanout",
      }),
      review(4, null), // synth failed / produced nothing
    ]
    const index = await buildFindingIndex(reviews)
    expect(index.size).toBe(1)
    expect([...index.values()][0]!.roles).toEqual(["logic"])
  })

  it("dedupes + filters role list to known specialists", async () => {
    const f = finding("a.ts", 1, "h", 4, ["logic", "logic", "security", "bogus" as SpecialistRole])
    const index = await buildFindingIndex([review(1, [f])])
    expect([...index.values()][0]!.roles).toEqual(["logic", "security"])
  })

  it("unions roles when the same fid is RE-POSTED in the SAME PR with different specialists", async () => {
    const fA = finding("a.ts", 10, "bug", 5, ["tests"])
    const fB = finding("a.ts", 10, "bug", 5, ["tests", "security"]) // same fid, same PR rerun
    const index = await buildFindingIndex([review(7, [fA]), review(7, [fB])]) // both PR 7
    expect(index.size).toBe(1)
    expect(new Set([...index.values()][0]!.roles)).toEqual(new Set(["tests", "security"]))
  })

  it("treats the same fid in DIFFERENT PRs as distinct findings (no cross-PR collision)", async () => {
    const f = finding("a.ts", 10, "bug", 5, ["logic"]) // identical content -> same fid
    const index = await buildFindingIndex([review(1, [f]), review(2, [f], { prNumber: 2 })])
    expect(index.size).toBe(2) // one per PR
  })
})

describe("attributeDismissals — full-credit multi-specialist", () => {
  it("credits BOTH specialists in numerator and denominator", async () => {
    const f = finding("a.ts", 10, "bug", 5, ["logic", "security"])
    const d = dismissal(await fidOf(f), { dismissReason: "not-a-bug" })
    const attr = await attributeDismissals([review(1, [f])], [d], 1_000_000)

    expect(attr.denominator.logic).toHaveLength(1)
    expect(attr.denominator.security).toHaveLength(1)
    expect(attr.denominator.performance).toHaveLength(0)
    expect(attr.synthDenominator).toHaveLength(1)

    expect(attr.numerator.logic.hard).toBe(1)
    expect(attr.numerator.security.hard).toBe(1)
    expect(attr.numerator.performance.hard).toBe(0)
    expect(attr.synthNumerator.hard).toBe(1)
  })

  it("buckets soft + unlabeled reasons and leaves hard untouched", async () => {
    const f = finding("a.ts", 10, "bug", 4, ["tests"])
    const attr = await attributeDismissals(
      [review(1, [f])],
      [dismissal(await fidOf(f), { dismissReason: "too-minor" })],
      1_000_000,
    )
    expect(attr.numerator.tests).toEqual({ hard: 0, soft: 1, unlabeled: 0 })
  })
})

describe("attributeDismissals — composite PR:fid key", () => {
  it("attributes a dismissal only to its OWN PR, never another PR with the same fid", async () => {
    const f1 = finding("a.ts", 10, "bug", 5, ["logic"]) // PR1
    const f2 = finding("a.ts", 10, "bug", 5, ["security"]) // PR2 — same fid, different role
    const attr = await attributeDismissals(
      [review(1, [f1]), review(2, [f2], { prNumber: 2 })],
      [dismissal(await fidOf(f1), { prNumber: 1, commentId: 9, dismissReason: "not-a-bug" })],
      1_000_000,
    )
    expect(attr.numerator.logic.hard).toBe(1) // PR1's logic credited
    expect(attr.numerator.security.hard).toBe(0) // PR2's security NOT credited
    expect(attr.synthDenominator).toHaveLength(2) // both PRs' findings count
  })
})

describe("attributeDismissals — numerator dedups by fid", () => {
  it("counts a finding dismissed by two comments as ONE FP (not two)", async () => {
    const f = finding("a.ts", 10, "bug", 5, ["logic"])
    const fid = await fidOf(f)
    const attr = await attributeDismissals(
      [review(1, [f])],
      [
        dismissal(fid, { commentId: 1, dismissReason: "not-a-bug" }),
        dismissal(fid, { commentId: 2, dismissReason: "not-a-bug" }), // same finding, 2nd comment
      ],
      1_000_000,
    )
    expect(attr.numerator.logic.hard).toBe(1) // ONE FP, not 2
    expect(attr.denominator.logic).toHaveLength(1)
    // numerator never exceeds denominator -> Wilson is safe
    expect(attr.numerator.logic.hard).toBeLessThanOrEqual(attr.denominator.logic.length)
  })

  it("picks the most severe bucket when one finding has mixed reasons", async () => {
    const f = finding("a.ts", 10, "bug", 5, ["security"])
    const fid = await fidOf(f)
    const attr = await attributeDismissals(
      [review(1, [f])],
      [
        dismissal(fid, { commentId: 1, dismissReason: "too-minor" }), // soft
        dismissal(fid, { commentId: 2, dismissReason: "not-a-bug" }), // hard wins
      ],
      1_000_000,
    )
    expect(attr.numerator.security).toEqual({ hard: 1, soft: 0, unlabeled: 0 })
  })
})

describe("attributeDismissals — unmatched bucketing", () => {
  it("classifies unmatched dismissals as expired vs not-found by ttl", async () => {
    const now = 200 * DAY
    const attr = await attributeDismissals(
      [],
      [
        dismissal("deadbeefdeadbeef", { commentId: 1, tsMs: now - 5 * DAY }), // within 90d ttl -> not-found
        dismissal("cafecafecafecafe", { commentId: 2, tsMs: now - 100 * DAY }), // older than 90d ttl -> expired
      ],
      now,
    )
    expect(attr.unattributed.notFound).toBe(1)
    expect(attr.unattributed.possiblyExpired).toBe(1)
  })
})

describe("attributeDismissals — engine health", () => {
  it("counts fanout vs guard-skipped and zero-finding reviews", async () => {
    const f = finding("a.ts", 1, "h", 5, ["logic"])
    const reviews = [
      review(1, [f]),
      review(2, []), // ran, posted nothing
      review(3, [finding("b.ts", 2, "x", 5, ["logic"])], {
        fellBackReason: "stale_head_before_fanout",
      }),
      review(4, null),
    ]
    const attr = await attributeDismissals(reviews, [], 1_000_000)
    expect(attr.reviewsScanned).toBe(4)
    expect(attr.reviewsRealFanout).toBe(2) // reviews 1 and 2
    expect(attr.reviewsZeroPostedFindings).toBe(1) // review 2
  })
})

describe("dedupeDismissals", () => {
  it("keeps one per commentId (dual keyspace)", () => {
    const a = dismissal("ff", { commentId: 7 })
    const b = dismissal("ff", { commentId: 7 }) // same comment, legacy + repo:id keys
    const c = dismissal("ee", { commentId: 8 })
    expect(dedupeDismissals([a, b, c])).toHaveLength(2)
  })
})

describe("filterReviewsToWindow", () => {
  it("keeps [now-window, now-maturity]", () => {
    const now = 100 * DAY
    const reviews = [
      review(1, [], { createdMs: now - 2 * DAY }), // too recent (maturity 14)
      review(2, [], { createdMs: now - 20 * DAY }), // in window
      review(3, [], { createdMs: now - 40 * DAY }), // too old (window 30)
    ]
    const kept = filterReviewsToWindow(reviews, now, 30, 14)
    expect(kept.map((r) => r.prNumber)).toEqual([2])
  })

  it("throws on invalid window parameters", () => {
    const r = [review(1, [])]
    expect(() => filterReviewsToWindow(r, 100 * DAY, 0, 0)).toThrow() // windowDays <= 0
    expect(() => filterReviewsToWindow(r, 100 * DAY, 7, 14)).toThrow() // maturity >= window
    expect(() => filterReviewsToWindow(r, Number.NaN, 30, 14)).toThrow() // nowMs not finite
  })
})

describe("computeFpRates", () => {
  function attrWith(
    postedByRole: Partial<Record<SpecialistRole, number>>,
    numByRole: Partial<Record<SpecialistRole, { hard: number; soft: number; unlabeled: number }>>,
    synthPosted: number,
    synthNum: { hard: number; soft: number; unlabeled: number },
  ): AttributionResult {
    const ref = (i: number) => ({ fid: String(i), prNumber: 1, score: 5, roles: [], createdMs: 0 })
    const denominator = { logic: [], security: [], performance: [], tests: [] } as AttributionResult["denominator"]
    const numerator = {
      logic: { hard: 0, soft: 0, unlabeled: 0 },
      security: { hard: 0, soft: 0, unlabeled: 0 },
      performance: { hard: 0, soft: 0, unlabeled: 0 },
      tests: { hard: 0, soft: 0, unlabeled: 0 },
    } as AttributionResult["numerator"]
    for (const role of Object.keys(postedByRole) as SpecialistRole[]) {
      denominator[role] = Array.from({ length: postedByRole[role]! }, (_, i) => ref(i))
    }
    for (const role of Object.keys(numByRole) as SpecialistRole[]) numerator[role] = numByRole[role]!
    return {
      denominator,
      numerator,
      synthDenominator: Array.from({ length: synthPosted }, (_, i) => ref(i)),
      synthNumerator: synthNum,
      unattributed: { possiblyExpired: 0, notFound: 0 },
      reviewsScanned: 0,
      reviewsRealFanout: 0,
      reviewsZeroPostedFindings: 0,
    }
  }

  it("gates on min-n: below threshold reports insufficient (null meets-target)", () => {
    const attr = attrWith({ logic: 5 }, { logic: { hard: 0, soft: 0, unlabeled: 0 } }, 5, {
      hard: 0,
      soft: 0,
      unlabeled: 0,
    })
    const report = computeFpRates(attr, { minN: 30 })
    const logic = report.rows.find((r) => r.role === "logic")!
    expect(logic.sufficientN).toBe(false)
    expect(logic.observedMeetsTarget).toBeNull()
    expect(logic.hardFpRate).toBe(0)
  })

  it("computes rate + Wilson + meets-target when n is sufficient", () => {
    // 40 posted, 2 hard FP = 5% <= 10% specialist target; 0 unlabeled so
    // worst-case == observed.
    const attr = attrWith({ logic: 40 }, { logic: { hard: 2, soft: 1, unlabeled: 0 } }, 40, {
      hard: 2,
      soft: 1,
      unlabeled: 0,
    })
    const report = computeFpRates(attr, { minN: 30 })
    const logic = report.rows.find((r) => r.role === "logic")!
    expect(logic.sufficientN).toBe(true)
    expect(logic.hardFpRate).toBeCloseTo(0.05, 5)
    expect(logic.observedMeetsTarget).toBe(true)
    expect(logic.wilsonLower).toBeGreaterThanOrEqual(0)
    expect(logic.wilsonUpper).toBeLessThanOrEqual(1)
    expect(logic.wilsonUpper).toBeGreaterThan(logic.hardFpRate!)
  })

  it("meets-target is WORST-CASE: unlabeled dismissals counted as potentially hard", () => {
    // 40 posted, 0 labeled hard, 5 unlabeled -> worst 5/40 = 12.5% > 10% -> NOT met
    const attr = attrWith({ logic: 40 }, { logic: { hard: 0, soft: 0, unlabeled: 5 } }, 40, {
      hard: 0,
      soft: 0,
      unlabeled: 5,
    })
    const logic = computeFpRates(attr, { minN: 30 }).rows.find((r) => r.role === "logic")!
    expect(logic.hardFpRate).toBe(0) // observed labeled-hard is 0
    expect(logic.observedMeetsTarget).toBe(false) // but worst case breaches
  })

  it("meets-target true when worst-case (hard+unlabeled) still clears target", () => {
    // 40 posted, 0 hard, 2 unlabeled -> worst 2/40 = 5% <= 10% -> met
    const attr = attrWith({ tests: 40 }, { tests: { hard: 0, soft: 0, unlabeled: 2 } }, 40, {
      hard: 0,
      soft: 0,
      unlabeled: 2,
    })
    const tests = computeFpRates(attr, { minN: 30 }).rows.find((r) => r.role === "tests")!
    expect(tests.observedMeetsTarget).toBe(true)
  })

  it("flags miss when observed rate exceeds target; synth uses the tighter 5% target", () => {
    const attr = attrWith({ logic: 40 }, { logic: { hard: 8, soft: 0, unlabeled: 0 } }, 40, {
      hard: 3,
      soft: 0,
      unlabeled: 0,
    })
    const report = computeFpRates(attr, { minN: 30 })
    const logic = report.rows.find((r) => r.role === "logic")!
    const synth = report.rows.find((r) => r.role === "synth")!
    expect(logic.observedMeetsTarget).toBe(false) // 20% > 10%
    expect(synth.target).toBe(0.05)
    expect(synth.observedMeetsTarget).toBe(false) // 7.5% > 5%
    expect(report.rows.map((r) => r.role)).toContain("synth")
  })
})

describe("ingest — mapTelemetryToReview (real prod shapes)", () => {
  it("maps a zero-finding 'post' review (the live #224 shape) to a real, empty review", () => {
    // Shape observed in prod: synthesizer.verdict present with 0 findings,
    // provenance {findings:[],dropped,softened}, specialists all 0, no fallback.
    const raw = {
      schemaVersion: 3,
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 224,
      headSha: "abc1234",
      mode: "post",
      degradedCoverage: null,
      specialistVerdicts: [
        { role: "logic", verdict: { findings: [] }, timedOut: false },
        { role: "security", verdict: { findings: [] }, timedOut: false },
      ],
      synthesizer: { verdict: { findings: [] }, provenance: { findings: [], dropped: [], softened: [] } },
    }
    const review = mapTelemetryToReview(raw, 1_000_000)!
    expect(review.prNumber).toBe(224)
    expect(review.fellBackReason).toBeNull()
    expect(review.synthFindings).toEqual([]) // ran, posted nothing (NOT null)
  })

  it("extracts per-finding sourceSpecialists from the parallel provenance index", () => {
    const raw = {
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 300,
      synthesizer: {
        verdict: {
          findings: [
            { path: "a.ts", line: 10, headline: "bug", score: 5 },
            { path: "b.ts", line: 2, headline: "perf", score: 4 },
          ],
        },
        provenance: {
          findings: [
            { sourceSpecialists: ["logic", "security"], sourceFindingIds: ["logic-0"], action: "merged" },
            { sourceSpecialists: ["performance"], sourceFindingIds: ["performance-1"], action: "kept" },
          ],
        },
      },
    }
    const review = mapTelemetryToReview(raw, 1_000_000)!
    expect(review.synthFindings).toHaveLength(2)
    expect(review.synthFindings![0]).toMatchObject({ path: "a.ts", line: 10, score: 5, sourceSpecialists: ["logic", "security"] })
    expect(review.synthFindings![1]!.sourceSpecialists).toEqual(["performance"])
  })

  it("maps a guard-skipped record (synth null) to synthFindings=null", () => {
    const raw = { owner: "Sigilix", repo: "sigilix", prNumber: 184, fellBackReason: "merged_before_fanout", synthesizer: null }
    const review = mapTelemetryToReview(raw, 1_000_000)!
    expect(review.synthFindings).toBeNull()
    expect(review.fellBackReason).toBe("merged_before_fanout")
  })

  it("rejects structurally unusable records (incl. NaN/non-positive prNumber)", () => {
    expect(mapTelemetryToReview(null, 1)).toBeNull()
    expect(mapTelemetryToReview({ owner: "o", repo: "r" }, 1)).toBeNull() // no prNumber
    expect(mapTelemetryToReview({ owner: "o", repo: "r", prNumber: "abc" }, 1)).toBeNull() // NaN
    expect(mapTelemetryToReview({ owner: "o", repo: "r", prNumber: 0 }, 1)).toBeNull() // non-positive
  })

  it("coerces non-finite score/line to 0 so a NaN-scored finding fails the score gate", () => {
    const raw = {
      owner: "o",
      repo: "r",
      prNumber: 1,
      synthesizer: {
        verdict: { findings: [{ path: "a.ts", line: "x", headline: "h", score: "not-a-number" }] },
        provenance: { findings: [{ sourceSpecialists: ["logic"] }] },
      },
    }
    const review = mapTelemetryToReview(raw, 1)!
    expect(review.synthFindings![0]).toMatchObject({ score: 0, line: 0 })
  })

  it("derives roles from sourceFindingIds when sourceSpecialists is empty/missing", () => {
    const raw = {
      owner: "o",
      repo: "r",
      prNumber: 1,
      synthesizer: {
        verdict: { findings: [{ path: "a.ts", line: 1, headline: "h", score: 5 }] },
        provenance: { findings: [{ sourceSpecialists: [], sourceFindingIds: ["security-0", "logic-2"] }] },
      },
    }
    const review = mapTelemetryToReview(raw, 1)!
    expect(new Set(review.synthFindings![0]!.sourceSpecialists)).toEqual(new Set(["security", "logic"]))
  })
})

describe("ingest — createdMsFromKey + mapSignalRecord", () => {
  it("recovers createdMs from a reverse-ts key", () => {
    const created = REVERSE_TS_BASE - 8219927415283
    const key = `ensemble-review-telemetry:8219927415283:Sigilix/sigilix#224`
    expect(createdMsFromKey(key, "ensemble-review-telemetry:")).toBe(created)
    expect(createdMsFromKey("ensemble-review-telemetry:notanumber#x", "ensemble-review-telemetry:")).toBeNull()
  })

  it("extracts dismissed-textual signals (the live shape) and skips others", () => {
    const rec = {
      schemaVersion: 1,
      category: "security",
      signals: [
        { ts: "2026-05-29T06:57:29.330Z", prNumber: 218, commentId: 3322657991, fid: "7fabc47db9c373d5", kind: "dismissed-textual" },
        { ts: "2026-05-20T00:00:00.000Z", prNumber: 200, commentId: 999, kind: "dismissed-textual" }, // no fid -> skip
        { ts: "x", prNumber: 1, commentId: 1, fid: "deadbeef", kind: "other" }, // wrong kind -> skip
        { ts: "2026-05-20T00:00:00.000Z", prNumber: 218, fid: "abcd1234", kind: "dismissed-textual" }, // no commentId -> skip
      ],
    }
    const out = mapSignalRecord(rec)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ fid: "7fabc47db9c373d5", prNumber: 218, commentId: 3322657991 })
    expect(out[0]!.tsMs).toBe(Date.parse("2026-05-29T06:57:29.330Z"))
  })
})

describe("formatCsv", () => {
  it("emits header + one row per specialist + synth", () => {
    const attr: AttributionResult = {
      denominator: { logic: [], security: [], performance: [], tests: [] },
      numerator: {
        logic: { hard: 0, soft: 0, unlabeled: 0 },
        security: { hard: 0, soft: 0, unlabeled: 0 },
        performance: { hard: 0, soft: 0, unlabeled: 0 },
        tests: { hard: 0, soft: 0, unlabeled: 0 },
      },
      synthDenominator: [],
      synthNumerator: { hard: 0, soft: 0, unlabeled: 0 },
      unattributed: { possiblyExpired: 0, notFound: 0 },
      reviewsScanned: 0,
      reviewsRealFanout: 0,
      reviewsZeroPostedFindings: 0,
    }
    const csv = formatCsv(computeFpRates(attr))
    const lines = csv.split("\n")
    expect(lines[0]).toBe(FP_RATE_CSV_HEADER)
    expect(lines).toHaveLength(6) // header + 4 specialists + synth
    expect(lines.some((l) => l.startsWith("synth,"))).toBe(true)
    expect(lines.some((l) => l.includes("insufficient-n"))).toBe(true)
  })
})
