// ARC-194 — incremental review: KV serdes + diff selection.

import { describe, it, expect, vi } from "vitest"

import {
  readLastReviewedSha,
  writeLastReviewedSha,
  selectDiff,
} from "@/lib/incremental-review"
import type { Env } from "@/shared/types/env"

// Minimal KV stub — only the get/put surface we exercise. Cast through
// `unknown` to avoid pulling in the full Workers types.
function fakeKV(initial: Record<string, string> = {}) {
  const store = { ...initial }
  const stub = {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string, _opts?: unknown) => {
      store[k] = v
    }),
    delete: vi.fn(async (k: string) => {
      delete store[k]
    }),
  }
  return { stub, store }
}

const fakeEnv = (kv: ReturnType<typeof fakeKV>["stub"]): Env =>
  ({ OPENCLAW_STATE: kv } as unknown as Env)

describe("readLastReviewedSha", () => {
  it("returns null for unknown PR", async () => {
    const { stub } = fakeKV()
    const result = await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)
    expect(result).toBeNull()
  })

  it("returns the parsed record on hit", async () => {
    const { stub } = fakeKV({
      "pr-last-reviewed:owner/repo#42": JSON.stringify({
        reviewedSha: "abc1234",
        reviewedAt: 1700000000000,
      }),
    })
    const result = await readLastReviewedSha(fakeEnv(stub), "owner", "repo", 42)
    expect(result).toEqual({ reviewedSha: "abc1234", reviewedAt: 1700000000000 })
  })

  it("returns null on malformed JSON", async () => {
    const { stub } = fakeKV({ "pr-last-reviewed:o/r#1": "{not json" })
    expect(await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)).toBeNull()
  })

  it("returns null when reviewedSha is missing/wrong type", async () => {
    const { stub } = fakeKV({
      "pr-last-reviewed:o/r#1": JSON.stringify({ reviewedAt: 123 }),
    })
    expect(await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)).toBeNull()
  })

  it("returns null when reviewedAt is missing/wrong type", async () => {
    const { stub } = fakeKV({
      "pr-last-reviewed:o/r#1": JSON.stringify({ reviewedSha: "abc" }),
    })
    expect(await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)).toBeNull()
  })

  it("returns null when KV throws", async () => {
    const stub = {
      get: vi.fn(async () => { throw new Error("KV down") }),
      put: vi.fn(),
      delete: vi.fn(),
    }
    expect(await readLastReviewedSha(fakeEnv(stub), "o", "r", 1)).toBeNull()
  })
})

describe("writeLastReviewedSha", () => {
  it("writes a JSON-encoded record with the right key", async () => {
    const { stub, store } = fakeKV()
    await writeLastReviewedSha(fakeEnv(stub), "owner", "repo", 42, "abc1234")
    const stored = store["pr-last-reviewed:owner/repo#42"]
    expect(stored).toBeDefined()
    if (!stored) return  // narrows for TS
    const parsed = JSON.parse(stored)
    expect(parsed.reviewedSha).toBe("abc1234")
    expect(typeof parsed.reviewedAt).toBe("number")
  })

  it("passes the 30-day TTL", async () => {
    const { stub } = fakeKV()
    await writeLastReviewedSha(fakeEnv(stub), "o", "r", 1, "abc")
    expect(stub.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 30 * 24 * 60 * 60 }),
    )
  })

  it("swallows KV errors silently (best-effort write)", async () => {
    const stub = {
      get: vi.fn(),
      put: vi.fn(async () => { throw new Error("KV down") }),
      delete: vi.fn(),
    }
    // Should not throw.
    await expect(
      writeLastReviewedSha(fakeEnv(stub), "o", "r", 1, "abc"),
    ).resolves.toBeUndefined()
  })
})

describe("selectDiff — first review", () => {
  it("returns full diff with mode=first-review when no previous SHA", () => {
    const result = selectDiff({
      fullDiff: "full",
      compareDiff: null,
      previousSha: null,
      currentHeadSha: "abc",
    })
    expect(result).toEqual({ diff: "full", mode: "first-review" })
  })
})

describe("selectDiff — SIG-10 cumulative diff contract", () => {
  // SIG-10 forces the diff to always be cumulative (PR.base..headSha).
  // The incremental compare-diff path was removed because on
  // multi-commit PRs the push-delta diff produced false-positive
  // "undefined export"-class findings against symbols introduced in an
  // earlier commit. These tests pin the contract: regardless of what
  // `compareDiff` is supplied, the returned `diff` is the full diff.

  it("returns full diff (not compare) when previous SHA differs from head", () => {
    const result = selectDiff({
      fullDiff: "x".repeat(1000),
      compareDiff: "x".repeat(100),
      previousSha: "old",
      currentHeadSha: "new",
    })
    expect(result.mode).toBe("full")
    expect(result.previousSha).toBe("old")
    expect(result.diff.length).toBe(1000)
    expect(result.reason).toBe("cumulative_diff_required")
  })

  it("returns full diff when compareDiff is null (fetch failed)", () => {
    const result = selectDiff({
      fullDiff: "full",
      compareDiff: null,
      previousSha: "old",
      currentHeadSha: "new",
    })
    expect(result.mode).toBe("full")
    expect(result.diff).toBe("full")
    expect(result.reason).toBe("cumulative_diff_required")
  })

  it("returns full diff even when previous SHA equals current head", () => {
    // The 2nd-review-with-no-new-pushes case. Previously this returned
    // the full diff with reason `same_sha`; SIG-10 lumps it into the
    // single `cumulative_diff_required` rationale.
    const result = selectDiff({
      fullDiff: "full",
      compareDiff: "compare",
      previousSha: "abc",
      currentHeadSha: "abc",
    })
    expect(result.mode).toBe("full")
    expect(result.diff).toBe("full")
    expect(result.reason).toBe("cumulative_diff_required")
  })

  it("multi-commit PR: 2nd-commit review still sees earlier-commit content", () => {
    // SIG-10 behavioral pin. Imagine a 2-commit PR:
    //   commit 1: adds `export const foo = 1` in src/foo.ts
    //   commit 2: adds `import { foo } from "./foo"` in src/bar.ts
    // After commit 1 was reviewed, the per-push delta for commit 2
    // (lastReviewedSha..head) would only contain bar.ts — the
    // `export const foo` line is NOT in that diff. A specialist would
    // then flag the `import { foo }` as "undefined export" because
    // grep'ing the diff text doesn't find `foo`'s declaration.
    //
    // With SIG-10's cumulative contract, the diff fed to specialists
    // is the full PR diff (base..head) and contains BOTH commits, so
    // the `foo` export is visible alongside the `bar.ts` import.
    const commit1Diff =
      "diff --git a/src/foo.ts b/src/foo.ts\n" +
      "+export const foo = 1\n"
    const commit2Diff =
      "diff --git a/src/bar.ts b/src/bar.ts\n" +
      '+import { foo } from "./foo"\n'
    const fullPrDiff = commit1Diff + commit2Diff

    const result = selectDiff({
      fullDiff: fullPrDiff,
      compareDiff: commit2Diff,                 // per-push delta only
      previousSha: "commit1sha",
      currentHeadSha: "commit2sha",
    })

    expect(result.diff).toBe(fullPrDiff)
    expect(result.diff).toContain("export const foo = 1")
    expect(result.diff).toContain('import { foo } from "./foo"')
    expect(result.mode).toBe("full")
    expect(result.reason).toBe("cumulative_diff_required")
  })
})
