// SIG-44 — multi-corpus write-path plumbing: PR-upsert consumer (verdict
// derivation from the review manifest) and the GitHub Search API backfill
// method.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { handleCorpusPrUpsert } from "@/src/lib/multi-corpus-jobs"
import { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

const EMBED_DIMS = 768
const fakeVec = () => Array(EMBED_DIMS).fill(0.1)

function kvStub(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v)
    },
    delete: async (k: string) => {
      store.delete(k)
    },
  }
}

function manifestJson(
  prNumber: number,
  findings: { key: string; path: string; headline: string; score: number; consensus: number }[],
) {
  return JSON.stringify({
    v: 1,
    prNumber,
    baseSha: "b".repeat(7),
    headSha: "h".repeat(7),
    mergeBaseSha: null,
    fileListHash: "sha256:x",
    promptVersion: "v1",
    modelId: "m1",
    target: { kind: "review", reviewId: 1 },
    reviewedAt: 1,
    findings,
  })
}

describe("handleCorpusPrUpsert — verdict derivation → upsert", () => {
  it("attaches changes_required when the manifest has a score>=4 finding", async () => {
    const upserts: { namespace: string; id: string; metadata: Record<string, unknown> }[] = []
    const env = {
      OPENCLAW_STATE: kvStub({
        "pr-review-manifest:acme/widgets#234": manifestJson(234, [
          { key: "k", path: "src/a.ts", headline: "bug", score: 5, consensus: 2 },
        ]),
      }),
      AI: { run: async () => ({ data: [fakeVec()] }) },
      OPENCLAW_CODE_INDEX: {
        upsert: async (r: typeof upserts) => {
          upserts.push(...r)
          return {}
        },
      },
    } as unknown as Env

    await handleCorpusPrUpsert(env, {
      owner: "acme",
      repo: "widgets",
      prNumber: 234,
      title: "Fix",
      body: "x",
    })
    expect(upserts).toHaveLength(1)
    expect(upserts[0]!.namespace).toBe("pr:acme/widgets")
    expect(upserts[0]!.metadata.verdict).toBe("changes_required")
  })

  it("omits the verdict when no review manifest exists", async () => {
    const upserts: { metadata: Record<string, unknown> }[] = []
    const env = {
      OPENCLAW_STATE: kvStub({}),
      AI: { run: async () => ({ data: [fakeVec()] }) },
      OPENCLAW_CODE_INDEX: {
        upsert: async (r: typeof upserts) => {
          upserts.push(...r)
          return {}
        },
      },
    } as unknown as Env

    await handleCorpusPrUpsert(env, {
      owner: "acme",
      repo: "widgets",
      prNumber: 9,
      title: "T",
      body: "",
    })
    expect(upserts[0]!.metadata.verdict).toBe("") // upsertPrDoc stores "" for absent verdict
  })
})

describe("GitHubClient.searchMergedPullRequests", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it("builds the is:pr is:merged query and pages results", async () => {
    const calls: string[] = []
    const pages: Record<number, { number: number; title: string; body: string }[]> = {
      1: Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, body: "b" })),
      2: [{ number: 101, title: "last", body: "b" }],
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url)
        const page = Number(new URL(url).searchParams.get("page"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: pages[page] ?? [] }),
        } as unknown as Response
      }),
    )

    const client = new GitHubClient({ token: "t" })
    const out = await client.searchMergedPullRequests("acme", "widgets", "2026-03-03")
    expect(out).toHaveLength(101)
    expect(out[100]!.title).toBe("last")
    // Query encodes the search qualifiers.
    const q = decodeURIComponent(new URL(calls[0]!).searchParams.get("q") ?? "")
    expect(q).toBe("repo:acme/widgets is:pr is:merged merged:>=2026-03-03")
    expect(calls).toHaveLength(2) // stopped when page 2 returned < perPage
  })

  it("skips items without a numeric PR number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({
              items: [{ title: "no number" }, { number: 7, title: "ok", body: "" }],
            }),
          }) as unknown as Response,
      ),
    )
    const client = new GitHubClient({ token: "t" })
    const out = await client.searchMergedPullRequests("a", "b", "2026-01-01")
    expect(out.map((p) => p.number)).toEqual([7])
  })
})
