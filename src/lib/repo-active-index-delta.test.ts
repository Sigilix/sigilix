import { describe, expect, it } from "vitest"

import type { RepoActiveIndexSnapshotV1 } from "@/src/lib/repo-active-index"
import {
  applyRepoActiveIndexDelta,
  buildRepoActiveIndexDelta,
  decideIncrementalActiveIndex,
} from "@/src/lib/repo-active-index-delta"

const REPO_ID = 808_247_824
const CHANGED_OLD = "1".repeat(48)
const CHANGED_NEW = "2".repeat(48)
const DELETED_OLD = "3".repeat(48)
const UNCHANGED = "4".repeat(48)

function snapshot(builtMode: "shadow" | "on" = "on"): RepoActiveIndexSnapshotV1 {
  return {
    version: 1,
    githubRepoId: REPO_ID,
    builtMode,
    byPath: {
      "src/changed.ts": [CHANGED_OLD],
      "src/deleted.ts": [DELETED_OLD],
      "src/unchanged.ts": [UNCHANGED],
    },
  }
}

describe("applyRepoActiveIndexDelta", () => {
  it("replaces changed paths, removes deleted paths, and retains untouched paths", () => {
    const next = applyRepoActiveIndexDelta({
      prior: snapshot(),
      builtMode: "on",
      changedPaths: {
        upsert: ["src/changed.ts"],
        remove: ["src/deleted.ts"],
      },
      idsByPath: {
        "src/changed.ts": [CHANGED_NEW],
      },
    })

    expect(next).toEqual({
      version: 1,
      githubRepoId: REPO_ID,
      builtMode: "on",
      byPath: {
        "src/changed.ts": [CHANGED_NEW],
        "src/unchanged.ts": [UNCHANGED],
      },
    })
  })

  it("keeps a no-op snapshot closed over its prior membership", () => {
    const next = applyRepoActiveIndexDelta({
      prior: snapshot("shadow"),
      builtMode: "shadow",
      changedPaths: { upsert: [], remove: [] },
      idsByPath: {
        // Historical deletion ledgers are deliberately not an input to this
        // helper, so stale membership cannot leak into the active snapshot.
        "src/stale-ledger-only.ts": ["5".repeat(48)],
      },
    })

    expect(next.byPath).toEqual(snapshot("shadow").byPath)
    expect(next.byPath).not.toHaveProperty("src/stale-ledger-only.ts")
  })

  it("removes an upserted path when the current run produced no ids for it", () => {
    const next = applyRepoActiveIndexDelta({
      prior: snapshot(),
      builtMode: "on",
      changedPaths: { upsert: ["src/changed.ts"], remove: [] },
      idsByPath: {},
    })

    expect(next.byPath).not.toHaveProperty("src/changed.ts")
    expect(next.byPath["src/unchanged.ts"]).toEqual([UNCHANGED])
  })

  it("records the mode that built the new snapshot", () => {
    const next = applyRepoActiveIndexDelta({
      prior: snapshot("on"),
      builtMode: "shadow",
      changedPaths: { upsert: [], remove: [] },
      idsByPath: {},
    })

    expect(next.builtMode).toBe("shadow")
  })

  it("omits an invalid delta in shadow but keeps on mode strict", () => {
    const shadow = decideIncrementalActiveIndex({
      mode: "shadow",
      isDefaultBranch: true,
      liveGithubRepoId: REPO_ID,
      priorManifestGithubRepoId: REPO_ID,
      priorActiveIndex: snapshot("shadow"),
    })
    const on = decideIncrementalActiveIndex({
      mode: "on",
      isDefaultBranch: true,
      liveGithubRepoId: REPO_ID,
      priorManifestGithubRepoId: REPO_ID,
      priorActiveIndex: snapshot("on"),
    })
    const delta = {
      changedPaths: { upsert: ["src/changed.ts"], remove: [] },
      idsByPath: { "src/changed.ts": ["invalid-id"] },
    }

    expect(buildRepoActiveIndexDelta({ decision: shadow, ...delta })).toEqual({
      kind: "shadow-skip",
      reason: "delta-invalid",
    })
    expect(() => buildRepoActiveIndexDelta({ decision: on, ...delta })).toThrow(/invalid snapshot/)
  })
})

describe("decideIncrementalActiveIndex", () => {
  const base = {
    isDefaultBranch: true,
    liveGithubRepoId: REPO_ID,
    priorManifestGithubRepoId: REPO_ID,
    priorActiveIndex: snapshot(),
  } as const

  it("allows on mode only from an exact-id snapshot built in on mode", () => {
    expect(decideIncrementalActiveIndex({ ...base, mode: "on" })).toMatchObject({
      kind: "reuse",
      snapshot: { githubRepoId: REPO_ID, builtMode: "on" },
    })
    expect(decideIncrementalActiveIndex({ ...base, mode: "on", priorActiveIndex: snapshot("shadow") })).toEqual({
      kind: "full-fallback",
      reason: "wrong-provenance",
    })
  })

  it.each([
    ["missing prior snapshot", undefined, REPO_ID, REPO_ID, "missing-snapshot"],
    ["malformed prior snapshot", { version: 1 }, REPO_ID, REPO_ID, "malformed-snapshot"],
    ["missing live repo id", snapshot(), undefined, REPO_ID, "invalid-live-repo-id"],
    ["wrong manifest repo id", snapshot(), REPO_ID, REPO_ID + 1, "wrong-repo-id"],
    ["wrong snapshot repo id", { ...snapshot(), githubRepoId: REPO_ID + 1 }, REPO_ID, REPO_ID, "wrong-repo-id"],
  ])("forces a full fallback in on mode for %s", (_label, priorActiveIndex, liveId, manifestId, reason) => {
    expect(
      decideIncrementalActiveIndex({
        mode: "on",
        isDefaultBranch: true,
        liveGithubRepoId: liveId,
        priorManifestGithubRepoId: manifestId,
        priorActiveIndex,
      }),
    ).toEqual({ kind: "full-fallback", reason })
  })

  it("lets shadow reuse valid snapshots but full-backfills missing ones", () => {
    expect(
      decideIncrementalActiveIndex({ ...base, mode: "shadow", priorActiveIndex: snapshot("shadow") }),
    ).toMatchObject({ kind: "reuse" })
    expect(decideIncrementalActiveIndex({ ...base, mode: "shadow", priorActiveIndex: snapshot("on") })).toMatchObject({
      kind: "reuse",
    })
    expect(decideIncrementalActiveIndex({ ...base, mode: "shadow", priorActiveIndex: undefined })).toEqual({
      kind: "full-fallback",
      reason: "missing-snapshot",
    })
  })

  it("disables active snapshots for off mode and branch indexes", () => {
    expect(decideIncrementalActiveIndex({ ...base, mode: "off" })).toEqual({ kind: "disabled" })
    expect(decideIncrementalActiveIndex({ ...base, mode: "on", isDefaultBranch: false })).toEqual({
      kind: "disabled",
    })
  })
})
