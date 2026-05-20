// SIG-118: coverage-diff ingestion — pure-helper + gate-extension unit
// tests. The fetch orchestration (`ingestCoverage`) is exercised against
// a fake client for the best-effort failure modes; the parsing /
// resolution / intersection / rendering helpers are exercised directly.

import { describe, it, expect } from "vitest"
import {
  parseLcov,
  normalizeSfPath,
  resolveToChangedFile,
  intersectAddedUncovered,
  renderCoverageGapBlock,
  ingestCoverage,
  type CoverageGap,
} from "../src/lib/coverage-ingest"
import {
  evaluateTestFinding,
  parseCoverageGapRef,
} from "../src/lib/validate-test-finding"
import { evaluateTestingFindingCitation } from "../src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"
import type { TestingEvidencePack } from "../src/lib/testing-evidence-pack"

// ─── parseLcov ──────────────────────────────────────────────────────

describe("parseLcov", () => {
  it("collects ONLY DA lines with hits === 0 (uncovered)", () => {
    const lcov = [
      "SF:src/a.ts",
      "DA:1,1",
      "DA:2,0",
      "DA:3,0",
      "DA:4,5",
      "end_of_record",
    ].join("\n")
    const out = parseLcov(lcov)
    expect(out.get("src/a.ts")).toEqual([2, 3])
  })

  it("does NOT count a line with no DA entry as uncovered", () => {
    // Line 5 is never instrumented (no DA) — must not appear.
    const lcov = ["SF:src/a.ts", "DA:1,0", "end_of_record"].join("\n")
    expect(parseLcov(lcov).get("src/a.ts")).toEqual([1])
  })

  it("handles multiple files and resets per end_of_record", () => {
    const lcov = [
      "TN:",
      "SF:src/a.ts",
      "DA:10,0",
      "end_of_record",
      "SF:src/b.ts",
      "DA:20,0",
      "DA:21,1",
      "end_of_record",
    ].join("\n")
    const out = parseLcov(lcov)
    expect(out.get("src/a.ts")).toEqual([10])
    expect(out.get("src/b.ts")).toEqual([20])
  })

  it("ignores BRDA/FN/FNDA and malformed DA lines", () => {
    const lcov = [
      "SF:src/a.ts",
      "FN:1,foo",
      "FNDA:0,foo",
      "BRDA:1,0,0,-",
      "DA:bogus",
      "DA:2,0",
      "end_of_record",
    ].join("\n")
    expect(parseLcov(lcov).get("src/a.ts")).toEqual([2])
  })

  it("merges + dedupes uncovered lines across records for the same file", () => {
    const lcov = [
      "SF:src/a.ts",
      "DA:5,0",
      "end_of_record",
      "SF:src/a.ts",
      "DA:3,0",
      "DA:5,0",
      "end_of_record",
    ].join("\n")
    expect(parseLcov(lcov).get("src/a.ts")).toEqual([3, 5])
  })

  it("returns empty for empty / non-string input", () => {
    expect(parseLcov("").size).toBe(0)
    expect(parseLcov(undefined as unknown as string).size).toBe(0)
  })
})

// ─── normalizeSfPath ────────────────────────────────────────────────

describe("normalizeSfPath", () => {
  it("strips the GitHub Actions runner workspace prefix", () => {
    expect(normalizeSfPath("/home/runner/work/myrepo/myrepo/src/a.ts")).toBe("src/a.ts")
  })

  it("strips a file:// scheme", () => {
    expect(normalizeSfPath("file:///home/runner/work/r/r/src/a.ts")).toBe("src/a.ts")
  })

  it("strips a leading ./", () => {
    expect(normalizeSfPath("./src/a.ts")).toBe("src/a.ts")
  })

  it("normalizes backslashes", () => {
    expect(normalizeSfPath("src\\a.ts")).toBe("src/a.ts")
  })

  it("returns the slash-normalized remainder when no known prefix matches", () => {
    expect(normalizeSfPath("packages/web/src/a.ts")).toBe("packages/web/src/a.ts")
  })
})

// ─── resolveToChangedFile ───────────────────────────────────────────

describe("resolveToChangedFile", () => {
  const changed = new Set(["src/a.ts", "packages/web/src/b.ts", "packages/api/src/b.ts"])

  it("matches exactly", () => {
    expect(resolveToChangedFile("src/a.ts", changed)).toBe("src/a.ts")
  })

  it("matches a unique segment-aligned suffix", () => {
    expect(resolveToChangedFile("web/src/b.ts", changed)).toBe("packages/web/src/b.ts")
  })

  it("returns null on an ambiguous suffix match (>1)", () => {
    // `src/b.ts` is a suffix of BOTH packages/web/... and packages/api/...
    expect(resolveToChangedFile("src/b.ts", changed)).toBeNull()
  })

  it("returns null on path traversal", () => {
    expect(resolveToChangedFile("../../etc/passwd", changed)).toBeNull()
  })

  it("returns null on an absolute-shaped path", () => {
    expect(resolveToChangedFile("/abs/a.ts", changed)).toBeNull()
  })

  it("does not match a non-segment-aligned suffix", () => {
    // `a.ts` is a string-suffix of `src/a.ts` but not segment-aligned
    // unless prefixed with `/`. `oo/a.ts` should not match `foo/a.ts`.
    expect(resolveToChangedFile("rc/a.ts", changed)).toBeNull()
  })
})

// ─── intersectAddedUncovered ────────────────────────────────────────

describe("intersectAddedUncovered", () => {
  it("keeps only uncovered lines that are also added in the PR", () => {
    const uncovered = new Map<string, number[]>([["src/a.ts", [1, 2, 3, 99]]])
    const changedLines = new Map<string, Set<number>>([["src/a.ts", new Set([2, 3, 50])]])
    const gaps = intersectAddedUncovered(uncovered, changedLines)
    expect(gaps).toEqual([{ path: "src/a.ts", lines: [2, 3] }])
  })

  it("drops files with no intersection", () => {
    const uncovered = new Map<string, number[]>([["src/a.ts", [99]]])
    const changedLines = new Map<string, Set<number>>([["src/a.ts", new Set([1, 2])]])
    expect(intersectAddedUncovered(uncovered, changedLines)).toEqual([])
  })

  it("drops LCOV files that do not resolve to a changed file", () => {
    const uncovered = new Map<string, number[]>([["src/never-changed.ts", [1]]])
    const changedLines = new Map<string, Set<number>>([["src/a.ts", new Set([1])]])
    expect(intersectAddedUncovered(uncovered, changedLines)).toEqual([])
  })

  it("resolves a runner-prefixed SF path before intersecting", () => {
    const uncovered = new Map<string, number[]>([
      ["/home/runner/work/r/r/src/a.ts", [2]],
    ])
    const changedLines = new Map<string, Set<number>>([["src/a.ts", new Set([2])]])
    expect(intersectAddedUncovered(uncovered, changedLines)).toEqual([
      { path: "src/a.ts", lines: [2] },
    ])
  })

  it("merges two SF records resolving to the same changed file", () => {
    const uncovered = new Map<string, number[]>([
      ["src/a.ts", [2]],
      ["./src/a.ts", [3]],
    ])
    const changedLines = new Map<string, Set<number>>([["src/a.ts", new Set([2, 3])]])
    expect(intersectAddedUncovered(uncovered, changedLines)).toEqual([
      { path: "src/a.ts", lines: [2, 3] },
    ])
  })
})

// ─── renderCoverageGapBlock ─────────────────────────────────────────

describe("renderCoverageGapBlock", () => {
  it("omits when there are no gaps", () => {
    expect(renderCoverageGapBlock([])).toBe("")
  })

  it("renders the block header, the path/lines line, and the citable refs", () => {
    const gaps: CoverageGap[] = [{ path: "src/a.ts", lines: [2, 3] }]
    const block = renderCoverageGapBlock(gaps)
    expect(block).toContain("[COVERAGE GAPS — pre-LLM, LCOV]")
    expect(block).toContain("- `src/a.ts`: 2, 3")
    expect(block).toContain("cite as `coverageGap:src/a.ts:2`")
    expect(block).toContain("cite as `coverageGap:src/a.ts:3`")
  })
})

// ─── parseCoverageGapRef ────────────────────────────────────────────

describe("parseCoverageGapRef", () => {
  it("parses path + line from the last colon", () => {
    expect(parseCoverageGapRef("coverageGap:src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 })
  })

  it("keeps paths that themselves contain colons intact (line from LAST colon)", () => {
    expect(parseCoverageGapRef("coverageGap:C:/repo/a.ts:7")).toEqual({ path: "C:/repo/a.ts", line: 7 })
  })

  it("returns null for a non-coverageGap ref", () => {
    expect(parseCoverageGapRef("siblingMapping:a->b")).toBeNull()
  })

  it("returns null when there is no second colon", () => {
    expect(parseCoverageGapRef("coverageGap:src/a.ts")).toBeNull()
  })

  it("returns null for a non-positive-integer line", () => {
    expect(parseCoverageGapRef("coverageGap:src/a.ts:0")).toBeNull()
    expect(parseCoverageGapRef("coverageGap:src/a.ts:x")).toBeNull()
  })
})

// ─── gate extensions ────────────────────────────────────────────────

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/a.ts",
    line: 2,
    score: 5,
    category: "testing",
    headline: "Uncovered line",
    body: "Line is uncovered by tests.",
    ...overrides,
  } as PrReviewFinding
}

function pack(overrides: Partial<TestingEvidencePack> = {}): TestingEvidencePack {
  return {
    sourceFilesChanged: ["src/a.ts"],
    testFilesChanged: [],
    testFilesInPromptDiff: [],
    testFilesNotInPromptDiff: [],
    siblingMappings: [],
    inspectedTestFiles: [],
    ...overrides,
  } as TestingEvidencePack
}

describe("evaluateTestingFindingCitation — coverageGap class (SIG-113)", () => {
  it("KEEPS when the coverageGap ref is in the real set AND path matches", () => {
    const gaps = new Set(["src/a.ts:2"])
    const f = finding({ evidenceRefs: ["coverageGap:src/a.ts:2"] })
    expect(evaluateTestingFindingCitation(f, pack(), gaps).keep).toBe(true)
  })

  it("DROPS when the coverageGap ref is not in the real set", () => {
    const gaps = new Set(["src/a.ts:99"])
    const f = finding({ evidenceRefs: ["coverageGap:src/a.ts:2"] })
    const r = evaluateTestingFindingCitation(f, pack(), gaps)
    expect(r.keep).toBe(false)
  })

  it("DROPS when the coverageGap ref path does not match finding.path", () => {
    const gaps = new Set(["src/other.ts:2"])
    const f = finding({ path: "src/a.ts", evidenceRefs: ["coverageGap:src/other.ts:2"] })
    expect(evaluateTestingFindingCitation(f, pack(), gaps).keep).toBe(false)
  })

  it("ignores coverageGap refs when no gap set is threaded (back-compat)", () => {
    const f = finding({ evidenceRefs: ["coverageGap:src/a.ts:2"] })
    // No coverageGaps arg → empty set → ref is not a citation → drop.
    expect(evaluateTestingFindingCitation(f, pack()).keep).toBe(false)
  })
})

describe("evaluateTestFinding — coverageGap class (SIG-111)", () => {
  it("KEEPS when the coverageGap ref is real AND path matches", () => {
    const gaps = new Set(["src/a.ts:2"])
    const f = finding({ evidenceRefs: ["coverageGap:src/a.ts:2"] })
    expect(evaluateTestFinding(f, pack(), gaps)).toEqual({ keep: true })
  })

  it("REJECTS (uncited-missing-coverage) when the coverageGap ref is unreal", () => {
    const gaps = new Set(["src/a.ts:99"])
    const f = finding({ evidenceRefs: ["coverageGap:src/a.ts:2"] })
    expect(evaluateTestFinding(f, pack(), gaps)).toEqual({
      keep: false,
      reason: "uncited-missing-coverage",
    })
  })

  it("REJECTS when the coverageGap ref path does not match finding.path", () => {
    const gaps = new Set(["src/other.ts:2"])
    const f = finding({ path: "src/a.ts", evidenceRefs: ["coverageGap:src/other.ts:2"] })
    expect(evaluateTestFinding(f, pack(), gaps)).toEqual({
      keep: false,
      reason: "uncited-missing-coverage",
    })
  })

  it("passes a sub-sev-4 finding untouched regardless of coverageGap", () => {
    const f = finding({ score: 2, evidenceRefs: ["coverageGap:src/a.ts:2"] })
    expect(evaluateTestFinding(f, pack(), new Set())).toEqual({ keep: true })
  })
})

// ─── ingestCoverage best-effort failure modes ───────────────────────

type FakeClient = {
  listRunsForSha: (...args: unknown[]) => Promise<unknown>
  listArtifacts: (...args: unknown[]) => Promise<unknown>
  downloadArtifactZip: (...args: unknown[]) => Promise<Uint8Array>
}

const baseConfig = {
  source: "github-actions-artifact" as const,
  artifactName: "coverage-lcov",
  entry: "lcov.info",
}

function ingestArgs(client: FakeClient) {
  return {
    client: client as unknown as Parameters<typeof ingestCoverage>[0]["client"],
    owner: "o",
    repo: "r",
    headSha: "abc1234",
    diff: "",
    config: baseConfig,
  }
}

describe("ingestCoverage — best-effort failure modes", () => {
  it("returns null when source is off (without any fetch)", async () => {
    let called = false
    const client: FakeClient = {
      listRunsForSha: async () => { called = true; return [] },
      listArtifacts: async () => [],
      downloadArtifactZip: async () => new Uint8Array(),
    }
    const r = await ingestCoverage({
      ...ingestArgs(client),
      config: { ...baseConfig, source: "off" },
    })
    expect(r).toBeNull()
    expect(called).toBe(false)
  })

  it("returns null when no successful run matches the head SHA", async () => {
    const client: FakeClient = {
      // Wrong head_sha — must be skipped.
      listRunsForSha: async () => [
        { id: 1, head_sha: "different", status: "completed", conclusion: "success", created_at: "2026-01-01" },
      ],
      listArtifacts: async () => [],
      downloadArtifactZip: async () => new Uint8Array(),
    }
    expect(await ingestCoverage(ingestArgs(client))).toBeNull()
  })

  it("returns null when the only matching artifact is expired", async () => {
    const client: FakeClient = {
      listRunsForSha: async () => [
        { id: 1, head_sha: "abc1234", status: "completed", conclusion: "success", created_at: "2026-01-01" },
      ],
      listArtifacts: async () => [
        { id: 9, name: "coverage-lcov", size_in_bytes: 100, expired: true },
      ],
      downloadArtifactZip: async () => { throw new Error("should not download") },
    }
    expect(await ingestCoverage(ingestArgs(client))).toBeNull()
  })

  it("returns null when the artifact exceeds the compressed cap", async () => {
    const client: FakeClient = {
      listRunsForSha: async () => [
        { id: 1, head_sha: "abc1234", status: "completed", conclusion: "success", created_at: "2026-01-01" },
      ],
      listArtifacts: async () => [
        { id: 9, name: "coverage-lcov", size_in_bytes: 6 * 1024 * 1024, expired: false },
      ],
      downloadArtifactZip: async () => { throw new Error("should not download") },
    }
    expect(await ingestCoverage(ingestArgs(client))).toBeNull()
  })

  it("returns null (never throws) when a fetch step throws", async () => {
    const client: FakeClient = {
      listRunsForSha: async () => { throw new Error("boom") },
      listArtifacts: async () => [],
      downloadArtifactZip: async () => new Uint8Array(),
    }
    await expect(ingestCoverage(ingestArgs(client))).resolves.toBeNull()
  })

  it("parses + intersects a real LCOV artifact end-to-end", async () => {
    // Build a real ZIP via fflate so the unzip path is exercised.
    const { zipSync, strToU8 } = await import("fflate")
    const lcov = ["SF:src/a.ts", "DA:1,1", "DA:2,0", "DA:3,0", "end_of_record"].join("\n")
    const zip = zipSync({ "lcov.info": strToU8(lcov) })
    const client: FakeClient = {
      listRunsForSha: async () => [
        { id: 7, head_sha: "abc1234", status: "completed", conclusion: "success", created_at: "2026-01-01" },
      ],
      listArtifacts: async () => [
        { id: 9, name: "coverage-lcov", size_in_bytes: zip.byteLength, expired: false },
      ],
      downloadArtifactZip: async () => zip,
    }
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,3 @@",
      " line1",
      "+line2",
      "+line3",
    ].join("\n")
    const r = await ingestCoverage({ ...ingestArgs(client), diff })
    expect(r).not.toBeNull()
    expect(r?.meta).toEqual({ runId: 7, artifactName: "coverage-lcov", entry: "lcov.info" })
    // Lines 2 and 3 are added AND uncovered.
    expect(r?.coverageGaps).toEqual([{ path: "src/a.ts", lines: [2, 3] }])
  })
})
