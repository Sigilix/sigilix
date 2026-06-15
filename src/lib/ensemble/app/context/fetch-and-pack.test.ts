// SIG-414 — call-site coverage for `packAndRoute`'s risk-ordering + byte-identity.
//
// The pure `riskOrderFiles` helper is unit-tested in `diff-packing.test.ts`, but
// that leaves the WIRING uncovered: reverting `packAndRoute`'s
//   `packFilesIntoBatches(riskOrderFiles(filesAfterFilter, isHighRiskPath))`
// back to `packFilesIntoBatches(filesAfterFilter)` keeps every other test green.
// These two cases drive `packAndRoute` directly (no network, no model) and assert
// the seam:
//   1. risk-ordering — a high-risk file that appears AFTER a normal file in diff
//      order leads `reviewedFiles` (the revert-detecting assertion); and
//   2. byte-identity — a single-batch, no-filter PR keeps `result.diff === fullDiff`.
//
// Driven model-free: dispatcher mode defaults to undefined (the whole SIG-226 block
// is a no-op single string compare), `shouldLoadAiInstructions: false` skips the
// only GitHubClient read on this path, and an empty `sigilixConfig` means no
// pathFilters / deterministicChecks. The lone IO left — the scoped-rules manifest
// KV read — is satisfied by a stub returning null (→ empty manifest).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  packAndRoute,
  type PackAndRouteArgs,
  type PackAndRouteTelemetry,
} from "@/src/lib/ensemble/app/context/fetch-and-pack"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import { EMPTY_CONFIG, resolveCostControlsConfig } from "@/src/lib/sigilix-config"
import type { Env } from "@/src/shared/types/env"
import type { PullRequestMeta } from "@/src/shared/types/github"

// Mirror the GitHubClient mock pattern from `src/lib/index-push-producer.test.ts`:
// keep the module's real exports but swap the class for a stub. On the path under
// test (`shouldLoadAiInstructions: false`, dispatcher off) no client method is
// actually called — the stub just satisfies the type + proves no network is hit.
vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  class GitHubClientMock {}
  return { ...actual, GitHubClient: GitHubClientMock }
})

// A KV stub for the scoped-rules manifest read — the only IO `packAndRoute` makes
// on this path. `get` → null means "no manifest", so `scopedRulesBlock` is empty.
function makeEnv(initial: Record<string, string> = {}): Env {
  const store = { ...initial }
  const kv = {
    async get(key: string): Promise<string | null> {
      return store[key] ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store[key] = value
    },
    async delete(key: string): Promise<void> {
      delete store[key]
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { OPENCLAW_STATE: kv } as unknown as Env
}

const META: PullRequestMeta = {
  number: 1,
  title: "test pr",
  body: null,
  user: { login: "octocat" },
  head: { sha: "a".repeat(40), ref: "feature" },
  base: { sha: "b".repeat(40), ref: "main" },
}

// Minimal one-file diff block in the unified format `splitDiffByFile` parses
// (a `diff --git` header + `+++ b/<path>` so the block's path is `<path>`).
function fileBlock(path: string, addedLine: string): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -0,0 +1 @@", `+${addedLine}`].join(
    "\n",
  )
}

function makeArgs(over: Partial<PackAndRouteArgs> & { fullDiff: string }): PackAndRouteArgs {
  const telemetry: PackAndRouteTelemetry = { routerDecision: null }
  return {
    env: makeEnv(),
    // The mocked GitHubClient stub — never dialed on this path.
    client: {} as PackAndRouteArgs["client"],
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 1,
    headSha: "a".repeat(40),
    // parseEnsembleConfig({}) → flags.dynamicDispatcherMode is undefined (dispatcher
    // block is a no-op) and flags.ingestAiInstructions is undefined.
    ensembleConfig: parseEnsembleConfig({}),
    orchCtrl: new AbortController(),
    meta: META,
    sigilixConfig: EMPTY_CONFIG,
    shouldLoadAiInstructions: false,
    costControls: resolveCostControlsConfig(EMPTY_CONFIG),
    telemetry,
    ...over,
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("packAndRoute — SIG-414 risk-ordering (call-site wiring)", () => {
  it("leads reviewedFiles with the high-risk file even when it appears LAST in diff order", async () => {
    // `src/util.ts` is a normal file; `src/auth-session.ts` is high-risk
    // (matches the auth/session hints in `isHighRiskPath`). In diff order the
    // high-risk file is SECOND — risk-ordering must promote it to batch[0][0].
    // Both blocks are tiny, so they pack into a single batch: the surviving
    // signal is the ORDER, which is exactly what reverting the call site to
    // `packFilesIntoBatches(filesAfterFilter)` would break.
    const normal = fileBlock("src/util.ts", "export const x = 1")
    const highRisk = fileBlock("src/auth-session.ts", "export const token = readSession()")
    const fullDiff = `${normal}\n${highRisk}`

    const result = await packAndRoute(makeArgs({ fullDiff }))

    // Sanity: single batch holding BOTH files (so the assertion is about order,
    // not which batch a file landed in).
    expect(result.reviewedFiles).toHaveLength(2)
    expect(result.reviewedFiles.map((f) => f.path)).toEqual(["src/auth-session.ts", "src/util.ts"])
    // The revert-detector: high-risk file leads.
    expect(result.reviewedFiles[0]?.path).toBe("src/auth-session.ts")
  })
})

describe("packAndRoute — byte-identity", () => {
  it("returns the original unreordered diff verbatim for a single-batch, no-filter, multi-file PR", async () => {
    // Two normal (non-high-risk) files: risk-ordering is a no-op, every file
    // fits one batch, nothing is filtered or dropped — so `packAndRoute` must
    // hand back `fullDiff` byte-for-byte (the common-case guarantee).
    const a = fileBlock("src/util.ts", "export const a = 1")
    const b = fileBlock("src/helpers.ts", "export const b = 2")
    const fullDiff = `${a}\n${b}`

    const result = await packAndRoute(makeArgs({ fullDiff }))

    expect(result.reviewedFiles.map((f) => f.path)).toEqual(["src/util.ts", "src/helpers.ts"])
    expect(result.filesNotReviewed).toEqual([])
    expect(result.droppedTooLarge).toEqual([])
    expect(result.wasTruncated).toBe(false)
    expect(result.diff).toBe(fullDiff)
  })

  it("incremental review DEFAULT-OFF: does not fetch file metadata and keeps output byte-identical", async () => {
    const a = fileBlock("src/util.ts", "export const a = 1")
    const b = fileBlock("src/helpers.ts", "export const b = 2")
    const fullDiff = `${a}\n${b}`
    const listPullRequestFiles = vi.fn(async () => {
      throw new Error("should not be called while incremental review is off")
    })

    const result = await packAndRoute(
      makeArgs({
        fullDiff,
        client: { listPullRequestFiles } as unknown as PackAndRouteArgs["client"],
      }),
    )

    expect(listPullRequestFiles).not.toHaveBeenCalled()
    expect(result.reviewedFiles.map((f) => f.path)).toEqual(["src/util.ts", "src/helpers.ts"])
    expect(result.filesNotReviewed).toEqual([])
    expect(result.diff).toBe(fullDiff)
    expect(result.incrementalCoverage).toBeUndefined()
  })
})

describe("packAndRoute — SIG-439 incremental coverage selection", () => {
  it("ON: reviews changed files plus never-reviewed files, skipping unchanged reviewed blobs", async () => {
    const changed = fileBlock("src/changed.ts", "export const changed = true")
    const unchanged = fileBlock("src/unchanged.ts", "export const unchanged = true")
    const never = fileBlock("src/never-reviewed.ts", "export const never = true")
    const fullDiff = `${changed}\n${unchanged}\n${never}`
    const priorCoverage = {
      schemaVersion: 1,
      files: {
        "src/changed.ts": {
          reviewedAtBlobSha: "old-blob",
          reviewedAtHeadSha: "old-head",
          reviewedAt: "2026-06-15T00:00:00.000Z",
        },
        "src/unchanged.ts": {
          reviewedAtBlobSha: "same-blob",
          reviewedAtHeadSha: "old-head",
          reviewedAt: "2026-06-15T00:00:00.000Z",
        },
      },
    }
    const listPullRequestFiles = vi.fn(async () => [
      {
        filename: "src/changed.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        sha: "new-blob",
      },
      {
        filename: "src/unchanged.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        sha: "same-blob",
      },
      {
        filename: "src/never-reviewed.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        sha: "never-blob",
      },
    ])

    const result = await packAndRoute(
      makeArgs({
        env: makeEnv({
          "pr-review-coverage:Sigilix/sigilix#1": JSON.stringify(priorCoverage),
        }),
        client: { listPullRequestFiles } as unknown as PackAndRouteArgs["client"],
        ensembleConfig: parseEnsembleConfig({ OPENCLAW_INCREMENTAL_REVIEW_MODE: "on" }),
        fullDiff,
      }),
    )

    expect(listPullRequestFiles).toHaveBeenCalledOnce()
    expect(result.reviewedFiles.map((f) => f.path)).toEqual(["src/changed.ts", "src/never-reviewed.ts"])
    expect(result.filesNotReviewed).toEqual([])
    expect(result.diff).toBe(`${changed}\n${never}`)
    expect(result.incrementalCoverage?.selection).toMatchObject({
      changedPaths: ["src/changed.ts"],
      neverReviewedPaths: ["src/never-reviewed.ts"],
      skippedUnchangedPaths: ["src/unchanged.ts"],
    })
    expect(result.incrementalCoverage?.coverageEntries.map((entry) => entry.path)).toEqual([
      "src/changed.ts",
      "src/never-reviewed.ts",
    ])
    expect(result.incrementalCoverage?.summary).toMatchObject({
      reviewedCount: 3,
      totalCount: 3,
      unreviewedPaths: [],
    })
  })
})

describe("packAndRoute — SIG-418 spilloverBatches (effective post-governor boundary)", () => {
  // A file whose body exceeds one ~12K-token (~48K-char) batch, so packing splits
  // the PR into ≥2 batches. `reviewedFiles` = batch[0]; the rest are the EFFECTIVE
  // spillover the dark multi-batch shadow loop measures.
  function bigFileBlock(path: string, approxChars: number): string {
    const filler = "x".repeat(approxChars)
    return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -0,0 +1 @@", `+${filler}`].join(
      "\n",
    )
  }

  it("single-batch PR → spilloverBatches is empty (nothing deferred)", async () => {
    const a = fileBlock("src/util.ts", "export const a = 1")
    const b = fileBlock("src/helpers.ts", "export const b = 2")
    const result = await packAndRoute(makeArgs({ fullDiff: `${a}\n${b}` }))
    expect(result.filesNotReviewed).toEqual([])
    expect(result.spilloverBatches).toEqual([])
  })

  it("multi-batch PR → spilloverBatches holds exactly the deferred files (effective boundary)", async () => {
    // Three files each ~40K chars → each ~10K tokens, so each lands in its own
    // batch (cap 12K). batch[0] = first file (reviewed); the other two spill over.
    const f1 = bigFileBlock("src/a.ts", 40_000)
    const f2 = bigFileBlock("src/b.ts", 40_000)
    const f3 = bigFileBlock("src/c.ts", 40_000)
    const result = await packAndRoute(makeArgs({ fullDiff: `${f1}\n${f2}\n${f3}` }))

    // The posted path reviewed only batch[0].
    expect(result.reviewedFiles).toHaveLength(1)
    const reviewedPath = result.reviewedFiles[0]!.path
    // The spillover batches cover EXACTLY the files NOT in the reviewed batch —
    // the same boundary the posted single-batch path deferred.
    const spilloverPaths = result.spilloverBatches.flat().map((f) => f.path)
    expect(new Set(spilloverPaths)).toEqual(new Set(result.filesNotReviewed))
    expect(spilloverPaths).not.toContain(reviewedPath)
    expect(spilloverPaths).toHaveLength(2)
    // Each oversized file is its own batch (revert-detector: empty spilloverBatches
    // or batch[0] re-inclusion would fail here).
    expect(result.spilloverBatches.length).toBe(2)
  })
})

// SIG-417 — the cost-projection telemetry + dark-governor seam, driven through
// `packAndRoute` model-free (same harness as above). A realistic lineup so
// MODEL_PRICING applies; the governor env vars flow via `parseEnsembleConfig`.
const LINEUP = {
  specialistModels: ["openai/o3", "deepseek/deepseek-v4-flash", "z-ai/glm-5.1", "deepseek/deepseek-v4-pro"],
  synthModel: "nvidia/nemotron-3-ultra-550b-a55b",
}

describe("packAndRoute — SIG-417 cost projection + dark governor", () => {
  // `packAndRoute` mutates the telemetry by reference; capture the passed-in
  // object so we can assert the `costProjection` it writes.
  function argsWithTelemetry(over: Partial<PackAndRouteArgs> & { fullDiff: string }): {
    args: PackAndRouteArgs
    telemetry: PackAndRouteTelemetry
  } {
    const telemetry: PackAndRouteTelemetry = { routerDecision: null }
    return { args: makeArgs({ ...over, telemetry }), telemetry }
  }

  it("DEFAULT-OFF: review byte-identical, no trim, projection telemetry still recorded", async () => {
    const a = fileBlock("src/util.ts", "export const a = 1")
    const b = fileBlock("src/helpers.ts", "export const b = 2")
    const fullDiff = `${a}\n${b}`

    // parseEnsembleConfig({}) → costGovernor.enabled = false (the default).
    const { args, telemetry } = argsWithTelemetry({ fullDiff, costProjectionLineup: LINEUP })
    const result = await packAndRoute(args)

    // Byte-identical reviewed set + diff (governor off → no mutation).
    expect(result.reviewedFiles.map((f) => f.path)).toEqual(["src/util.ts", "src/helpers.ts"])
    expect(result.filesNotReviewed).toEqual([])
    expect(result.costTrimmedPaths).toEqual([])
    expect(result.diff).toBe(fullDiff)
    // Projection telemetry is unconditional (observe-only) — recorded, not enforcing.
    expect(telemetry.costProjection?.governorEnabled).toBe(false)
    expect(telemetry.costProjection?.governorTrimmed).toBe(false)
    expect(telemetry.costProjection?.projectedUsd).toBeGreaterThan(0)
  })

  it("ENABLED + low ceiling: trims the lowest-risk TAIL to filesNotReviewed + costTrimmedPaths", async () => {
    // Three normal files (none high-risk) so risk order == diff order.
    const a = fileBlock("src/a.ts", "export const a = 1")
    const b = fileBlock("src/b.ts", "export const b = 2")
    const c = fileBlock("src/c.ts", "export const c = 3")
    const fullDiff = `${a}\n${b}\n${c}`

    const ensembleConfig = parseEnsembleConfig({
      OPENCLAW_COST_GOVERNOR_ENABLED: "on",
      // A tiny ceiling forces aggressive trimming down to the floor (1 file).
      OPENCLAW_COST_GOVERNOR_CEILING_USD: "0.0000001",
      OPENCLAW_COST_GOVERNOR_MIN_REVIEWED_FILES: "1",
    })
    const { args, telemetry } = argsWithTelemetry({ fullDiff, ensembleConfig, costProjectionLineup: LINEUP })
    const result = await packAndRoute(args)

    // Floor = 1 → exactly one file (the highest-risk = first) survives.
    expect(result.reviewedFiles).toHaveLength(1)
    expect(result.reviewedFiles[0]?.path).toBe("src/a.ts")
    // The trimmed tail flows into BOTH filesNotReviewed (1.2 spillover plumbing)
    // and costTrimmedPaths (the distinct cost-trim disclosure).
    expect(result.costTrimmedPaths.sort()).toEqual(["src/b.ts", "src/c.ts"])
    expect(result.filesNotReviewed.sort()).toEqual(["src/b.ts", "src/c.ts"])
    expect(telemetry.costProjection?.governorTrimmed).toBe(true)
    expect(telemetry.costProjection?.trimmedPaths.sort()).toEqual(["src/b.ts", "src/c.ts"])
    // SIG-418: the governor-trimmed files are SUBTRACTED from the dark shadow's
    // spillover — the governor dropped them intentionally for cost, so the shadow
    // must NOT spend re-reviewing them. Here EVERY spillover file was trimmed →
    // spilloverBatches is empty (revert-detector: without the subtraction, the
    // two trimmed files would be re-packed into spilloverBatches).
    expect(result.spilloverBatches).toEqual([])
  })

  it("ENABLED but NEVER trims a high-risk file (kept even under a tiny ceiling)", async () => {
    // One normal + one high-risk file. The ceiling is tiny, but the high-risk
    // file must survive — the governor trims the normal one instead.
    const normal = fileBlock("src/util.ts", "export const x = 1")
    const highRisk = fileBlock("src/auth-session.ts", "export const token = readSession()")
    const fullDiff = `${normal}\n${highRisk}`

    const ensembleConfig = parseEnsembleConfig({
      OPENCLAW_COST_GOVERNOR_ENABLED: "on",
      OPENCLAW_COST_GOVERNOR_CEILING_USD: "0.0000001",
      OPENCLAW_COST_GOVERNOR_MIN_REVIEWED_FILES: "1",
    })
    const { args } = argsWithTelemetry({ fullDiff, ensembleConfig, costProjectionLineup: LINEUP })
    const result = await packAndRoute(args)

    // The high-risk file is always kept; the normal file is trimmed.
    expect(result.reviewedFiles.map((f) => f.path)).toContain("src/auth-session.ts")
    expect(result.reviewedFiles.map((f) => f.path)).not.toContain("src/util.ts")
    expect(result.costTrimmedPaths).toEqual(["src/util.ts"])
  })

  it("ENABLED but NO ceiling set: never trims (ceiling absent → governor inert)", async () => {
    const a = fileBlock("src/a.ts", "export const a = 1")
    const b = fileBlock("src/b.ts", "export const b = 2")
    const fullDiff = `${a}\n${b}`

    const ensembleConfig = parseEnsembleConfig({ OPENCLAW_COST_GOVERNOR_ENABLED: "on" }) // no ceiling
    const { args, telemetry } = argsWithTelemetry({ fullDiff, ensembleConfig, costProjectionLineup: LINEUP })
    const result = await packAndRoute(args)

    expect(result.reviewedFiles).toHaveLength(2)
    expect(result.costTrimmedPaths).toEqual([])
    expect(telemetry.costProjection?.governorEnabled).toBe(true)
    expect(telemetry.costProjection?.governorTrimmed).toBe(false)
  })

  it("no lineup passed: projection skipped entirely (no costProjection telemetry, no trim)", async () => {
    const fullDiff = fileBlock("src/a.ts", "export const a = 1")
    const { args, telemetry } = argsWithTelemetry({ fullDiff }) // no costProjectionLineup
    const result = await packAndRoute(args)
    expect(result.costTrimmedPaths).toEqual([])
    expect(telemetry.costProjection).toBeUndefined()
  })
})
