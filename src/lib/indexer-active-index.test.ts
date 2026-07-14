import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"

import type { Env } from "@/src/shared/types/env"
import type { RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { activeIndexAllowsFreshSkip, computeRepoActiveStageRunId, stageActiveIndexSlice } from "./indexer-active-index"

const MIGRATION = readFileSync(
  new URL("../../migrations/0025_create_repo_active_index_stage.sql", import.meta.url),
  "utf8",
)

function envWithDb(db?: D1Database): Env {
  return { SIGILIX_PLATFORM_DB: db } as unknown as Env
}

function activeManifest(): RepoIndexManifestV1 {
  return {
    v: 1,
    repo: "sigilix",
    owner: "Sigilix",
    headSha: "a".repeat(40),
    runId: "a".repeat(16),
    fileCount: 1,
    chunkCount: 1,
    shardCount: 1,
    indexedAt: "2026-07-13T00:00:00.000Z",
    modelId: "model",
    embeddingDim: 1,
    chunkerVersion: 1,
    windowLines: 30,
    overlapLines: 10,
    githubRepoId: 808247824,
    activeIndex: {
      version: 1,
      githubRepoId: 808247824,
      builtMode: "on",
      byPath: { "src/index.ts": ["b".repeat(48)] },
    },
  }
}

describe("indexer active-index rollout policy", () => {
  it("isolates shadow and strict staging for the same source index run", async () => {
    const db = makeD1()
    await db.exec(MIGRATION)
    const common = {
      env: envWithDb(db),
      isDefaultBranch: true,
      githubRepoId: 808247824,
      installationId: 99,
      runId: "a".repeat(16),
      totalFiles: 1,
      lo: 0,
      hi: 1,
      idsByPath: { "src/index.ts": ["b".repeat(48)] },
      finalize: true,
    }

    const shadow = await stageActiveIndexSlice({ ...common, mode: "shadow" })
    const strict = await stageActiveIndexSlice({ ...common, mode: "on" })

    expect(shadow.activeIndex?.builtMode).toBe("shadow")
    expect(strict.activeIndex?.builtMode).toBe("on")
    expect(await computeRepoActiveStageRunId(common.runId, "shadow", common.installationId)).not.toBe(
      await computeRepoActiveStageRunId(common.runId, "on", common.installationId),
    )
    expect(await computeRepoActiveStageRunId(common.runId, "on", common.installationId)).not.toBe(
      await computeRepoActiveStageRunId(common.runId, "on", common.installationId + 1),
    )
  })

  it("keeps a missing D1 binding best-effort in shadow and strict in on mode", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const common = {
      env: envWithDb(),
      isDefaultBranch: true,
      githubRepoId: 808247824,
      installationId: 99,
      runId: "a".repeat(16),
      totalFiles: 0,
      lo: 0,
      hi: 0,
      idsByPath: {},
      finalize: true,
    }

    await expect(stageActiveIndexSlice({ ...common, mode: "shadow" })).resolves.toEqual({})
    await expect(stageActiveIndexSlice({ ...common, mode: "on" })).rejects.toThrow(/platform_db/i)
    expect(warn).toHaveBeenCalledOnce()
  })

  it("omits a divergent replay in shadow but rejects it in on mode", async () => {
    const db = makeD1()
    await db.exec(MIGRATION)
    const common = {
      env: envWithDb(db),
      isDefaultBranch: true,
      githubRepoId: 808247824,
      installationId: 99,
      runId: "a".repeat(16),
      totalFiles: 1,
      lo: 0,
      hi: 1,
      finalize: true,
    }

    const shadowCanonical = await stageActiveIndexSlice({
      ...common,
      mode: "shadow",
      idsByPath: { "src/index.ts": ["b".repeat(48)] },
    })
    await expect(
      stageActiveIndexSlice({
        ...common,
        mode: "shadow",
        idsByPath: { "src/index.ts": ["c".repeat(48)] },
      }),
    ).resolves.toMatchObject({ activeIndex: shadowCanonical.activeIndex, runSealed: true })
    const strictCanonical = await stageActiveIndexSlice({
      ...common,
      mode: "on",
      idsByPath: { "src/index.ts": ["b".repeat(48)] },
    })
    await expect(
      stageActiveIndexSlice({
        ...common,
        mode: "on",
        idsByPath: { "src/index.ts": ["c".repeat(48)] },
      }),
    ).resolves.toMatchObject({ activeIndex: strictCanonical.activeIndex, runSealed: true })
  })

  it("stops a stale non-final shard when a divergent replay finds the run sealed", async () => {
    const db = makeD1()
    await db.exec(MIGRATION)
    const common = {
      env: envWithDb(db),
      mode: "on" as const,
      isDefaultBranch: true,
      githubRepoId: 808247824,
      installationId: 99,
      runId: "a".repeat(16),
      totalFiles: 2,
    }
    const first = await stageActiveIndexSlice({
      ...common,
      lo: 0,
      hi: 1,
      idsByPath: { "src/a.ts": ["b".repeat(48)] },
      finalize: false,
    })
    await stageActiveIndexSlice({
      ...common,
      lo: 1,
      hi: 2,
      idsByPath: { "src/b.ts": ["c".repeat(48)] },
      ...(first.bookmark ? { bookmark: first.bookmark } : {}),
      finalize: true,
    })

    await expect(
      stageActiveIndexSlice({
        ...common,
        lo: 0,
        hi: 1,
        idsByPath: { "src/a.ts": ["d".repeat(48)] },
        finalize: false,
      }),
    ).resolves.toMatchObject({ runSealed: true })
  })

  it("refuses freshness when the tenant manifest is missing or differs from the legacy copy", async () => {
    const db = makeD1()
    const manifest = activeManifest()
    let tenantRaw: string | null = null
    const env = {
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_STATE: { get: vi.fn(async () => tenantRaw) },
    } as unknown as Env
    const base = {
      env,
      isDefaultBranch: true,
      githubRepoId: 808247824,
      manifest,
    }

    await expect(activeIndexAllowsFreshSkip({ ...base, mode: "shadow" })).resolves.toBe(false)
    tenantRaw = JSON.stringify({
      ...manifest,
      activeIndex: {
        ...manifest.activeIndex!,
        byPath: { "src/index.ts": ["c".repeat(48)] },
      },
    })
    await expect(activeIndexAllowsFreshSkip({ ...base, mode: "on" })).resolves.toBe(false)
    tenantRaw = JSON.stringify(manifest)
    await expect(activeIndexAllowsFreshSkip({ ...base, mode: "on" })).resolves.toBe(true)

    const get = vi.fn(async () => null)
    const legacy = { ...manifest }
    delete legacy.githubRepoId
    delete legacy.activeIndex
    await expect(
      activeIndexAllowsFreshSkip({
        ...base,
        env: { OPENCLAW_STATE: { get } } as unknown as Env,
        mode: "shadow",
        manifest: legacy,
      }),
    ).resolves.toBe(true)
    expect(get).not.toHaveBeenCalled()
  })
})
