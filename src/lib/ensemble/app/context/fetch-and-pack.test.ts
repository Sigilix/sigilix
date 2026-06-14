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
function makeEnv(): Env {
  const kv = {
    async get(): Promise<string | null> {
      return null
    },
    async put(): Promise<void> {},
    async delete(): Promise<void> {},
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
})
