import { describe, expect, it, vi } from "vitest"

import { readIncrementalReviewCoverage, writeIncrementalReviewCoverage } from "./incremental-coverage"
import type { Env } from "@/src/shared/types/env"

function fakeEnv(initial: Record<string, string> = {}): { env: Env; store: Record<string, string> } {
  const store = { ...initial }
  const kv = {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store[key] = value
    }),
    delete: vi.fn(async (key: string) => {
      delete store[key]
    }),
  } as unknown as Env["OPENCLAW_STATE"]
  return { env: { OPENCLAW_STATE: kv } as unknown as Env, store }
}

describe("incremental review coverage adapter", () => {
  it("reads a valid owner/repo coverage record", async () => {
    const record = {
      schemaVersion: 1,
      files: {
        "src/a.ts": {
          reviewedAtBlobSha: "blob-a",
          reviewedAtHeadSha: "head-a",
          reviewedAt: "2026-06-15T00:00:00.000Z",
        },
      },
    }
    const { env } = fakeEnv({
      "pr-review-coverage:Sigilix/sigilix#1": JSON.stringify(record),
    })

    await expect(readIncrementalReviewCoverage(env, "Sigilix", "sigilix", 1)).resolves.toEqual(record)
  })

  it("writes owner/repo and repo-id coverage records with a 30-day TTL", async () => {
    const { env, store } = fakeEnv()
    await writeIncrementalReviewCoverage(env, {
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 1,
      repoId: 123,
      headSha: "head-new",
      entries: [
        {
          path: "src/a.ts",
          blobSha: "blob-a",
        },
      ],
    })

    const legacy = JSON.parse(store["pr-review-coverage:Sigilix/sigilix#1"]!)
    const repoId = JSON.parse(store["pr-review-coverage:repo:123#1"]!)
    expect(legacy.files["src/a.ts"].reviewedAtBlobSha).toBe("blob-a")
    expect(repoId.files["src/a.ts"].reviewedAtHeadSha).toBe("head-new")
    expect(env.OPENCLAW_STATE.put).toHaveBeenCalledWith(
      "pr-review-coverage:Sigilix/sigilix#1",
      expect.any(String),
      expect.objectContaining({ expirationTtl: 30 * 24 * 60 * 60 }),
    )
  })
})
