// SIG-160 PR3 — withdrawal-store helpers + KV round-trip.

import { describe, expect, it, vi, beforeEach } from "vitest"

import {
  tokenize,
  jaccardSimilarity,
  stripBodyForMatching,
  findingMatchesWithdrawal,
  filterWithdrawnFindings,
  writeWithdrawal,
  loadWithdrawals,
  type WithdrawalRecord,
} from "../src/lib/review-withdrawal-store"
import type { Env } from "../src/index"

// ── KV stub ───────────────────────────────────────────────────────

interface RecordedPut {
  key: string
  value: string
  opts?: { expirationTtl?: number }
}

function makeKvStub() {
  const store = new Map<string, string>()
  // CodeRabbit M3 (review on PR #142): capture `put` opts so tests can
  // assert TTL regressions — a future drop of `expirationTtl` would
  // otherwise silently let withdrawal records live forever.
  const puts: RecordedPut[] = []
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      puts.push({ key, value, opts })
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
    async list({ prefix }: { prefix: string }): Promise<{ keys: { name: string }[] }> {
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }))
      return { keys }
    },
  }
  return { kv, store, puts }
}

function makeEnv(kv: ReturnType<typeof makeKvStub>["kv"]): Env {
  return { OPENCLAW_STATE: kv } as unknown as Env
}

// ── Pure helpers ──────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases, splits on non-word, drops short tokens + pure digits", () => {
    expect([...tokenize("Add a missing null check on req.body!")].sort())
      .toEqual(["add", "body", "check", "missing", "null", "req"])
  })

  it("dedupes repeated tokens via Set semantics", () => {
    expect(tokenize("foo foo bar foo").size).toBe(2)
  })

  it("returns empty set on whitespace-only input", () => {
    expect(tokenize("   ").size).toBe(0)
  })
})

describe("jaccardSimilarity", () => {
  it("returns 1 for identical text", () => {
    expect(jaccardSimilarity("the quick brown fox", "the quick brown fox")).toBe(1)
  })

  it("returns 0 for fully-disjoint token sets", () => {
    expect(jaccardSimilarity("apple banana cherry", "delta echo foxtrot")).toBe(0)
  })

  it("returns intersection/union for partial overlap", () => {
    // tokens: A={the, quick, brown, fox}, B={the, quick, brown, dog}
    // ∩ = 3 (the, quick, brown); ∪ = 5 (the, quick, brown, fox, dog) → 3/5 = 0.6
    expect(jaccardSimilarity("the quick brown fox", "the quick brown dog")).toBeCloseTo(0.6)
  })

  it("returns 0 (not NaN) when both inputs tokenize to empty", () => {
    expect(jaccardSimilarity("", "")).toBe(0)
    expect(jaccardSimilarity("   ", "  ?  ")).toBe(0)
  })
})

describe("stripBodyForMatching", () => {
  it("strips HTML comment markers + suggestion blocks + code fences + URLs", () => {
    const body = "<!-- sigilix:pr-review-finding -->\n**testing:** lacks coverage\n\n```suggestion\nfoo()\n```\n\nSee [the docs](https://example.com/x)."
    const stripped = stripBodyForMatching(body)
    expect(stripped).not.toContain("<!--")
    expect(stripped).not.toContain("```")
    expect(stripped).not.toContain("https://example.com")
    expect(stripped).toContain("lacks coverage")
    expect(stripped).toContain("See the docs.")
  })

  it("caps at 800 chars", () => {
    const long = "word ".repeat(500)
    expect(stripBodyForMatching(long).length).toBe(800)
  })
})

// ── Match logic ───────────────────────────────────────────────────

describe("findingMatchesWithdrawal", () => {
  const withdrawal: WithdrawalRecord = {
    path: "src/lib/foo.ts",
    line: 100,
    bodySnapshot: "the new scheduled handler lacks test coverage for its gating success and error paths",
    withdrawnAt: 1700000000000,
    withdrawnByCommentId: 12345,
    prHeadSha: "abc1234",
    reason: "mention-reply-accepted",
  }

  it("matches when path + line + body all align (Jaccard >= threshold)", () => {
    const finding = {
      path: "src/lib/foo.ts",
      line: 100,
      body: "the scheduled handler lacks test coverage for gating success and error paths",
    }
    expect(findingMatchesWithdrawal(finding, withdrawal)).toBe(true)
  })

  it("matches when line walked-forward by a few (within LINE_TOLERANCE=5)", () => {
    const finding = {
      path: "src/lib/foo.ts",
      line: 103,
      body: "the scheduled handler lacks test coverage for gating success and error paths",
    }
    expect(findingMatchesWithdrawal(finding, withdrawal)).toBe(true)
  })

  it("does NOT match when line is too far off", () => {
    const finding = {
      path: "src/lib/foo.ts",
      line: 200,
      body: "the scheduled handler lacks test coverage for gating success and error paths",
    }
    expect(findingMatchesWithdrawal(finding, withdrawal)).toBe(false)
  })

  it("does NOT match when path differs", () => {
    const finding = {
      path: "src/lib/bar.ts",
      line: 100,
      body: "the scheduled handler lacks test coverage for gating success and error paths",
    }
    expect(findingMatchesWithdrawal(finding, withdrawal)).toBe(false)
  })

  it("does NOT match when body is semantically unrelated", () => {
    const finding = {
      path: "src/lib/foo.ts",
      line: 100,
      body: "the function returns the wrong type when input is null",
    }
    expect(findingMatchesWithdrawal(finding, withdrawal)).toBe(false)
  })
})

describe("filterWithdrawnFindings", () => {
  const withdrawals: WithdrawalRecord[] = [
    {
      path: "src/index.ts",
      line: 960,
      bodySnapshot: "scheduled handler lacks coverage for gating success and error paths",
      withdrawnAt: 0, withdrawnByCommentId: 1, prHeadSha: "x", reason: "mention-reply-accepted",
    },
  ]

  it("drops findings that match a withdrawal", () => {
    const findings = [
      { path: "src/index.ts", line: 962, body: "the scheduled handler lacks coverage for its gating success and error paths" },
      { path: "src/index.ts", line: 200, body: "unrelated logic concern about the cron tick guard" },
    ]
    const { kept, suppressed } = filterWithdrawnFindings(findings, withdrawals)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.line).toBe(200)
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]?.line).toBe(962)
  })

  it("no-op when withdrawals list is empty", () => {
    const findings = [{ path: "src/index.ts", line: 100, body: "anything" }]
    const { kept, suppressed } = filterWithdrawnFindings(findings, [])
    expect(kept).toHaveLength(1)
    expect(suppressed).toHaveLength(0)
  })

  it("no-op when no finding matches any withdrawal", () => {
    const findings = [{ path: "src/other.ts", line: 50, body: "totally different concern about types" }]
    const { kept, suppressed } = filterWithdrawnFindings(findings, withdrawals)
    expect(kept).toHaveLength(1)
    expect(suppressed).toHaveLength(0)
  })
})

// ── KV round-trip ─────────────────────────────────────────────────

describe("writeWithdrawal / loadWithdrawals round-trip", () => {
  let kv: ReturnType<typeof makeKvStub>["kv"]
  let store: ReturnType<typeof makeKvStub>["store"]
  let puts: ReturnType<typeof makeKvStub>["puts"]

  beforeEach(() => {
    const k = makeKvStub()
    kv = k.kv
    store = k.store
    puts = k.puts
  })

  it("writes under the keyed prefix and is recoverable via load", async () => {
    const env = makeEnv(kv)
    const ok = await writeWithdrawal({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 138,
      path: "src/index.ts",
      line: 980,
      bodySnapshot: "the scheduled handler is pure orchestrator glue and the pieces are tested elsewhere",
      withdrawnByCommentId: 999111,
      prHeadSha: "586fd6a",
    })
    expect(ok).toBe(true)
    expect(store.has("withdrawal:Sigilix:sigilix:138:999111")).toBe(true)
    // CodeRabbit M3 (review on PR #142): pin the 30-day TTL contract so
    // a future regression that drops `expirationTtl` is caught here.
    expect(puts[0]?.opts?.expirationTtl).toBe(60 * 60 * 24 * 30)

    const loaded = await loadWithdrawals(env, "Sigilix", "sigilix", 138)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.path).toBe("src/index.ts")
    expect(loaded[0]?.line).toBe(980)
    expect(loaded[0]?.withdrawnByCommentId).toBe(999111)
    expect(loaded[0]?.prHeadSha).toBe("586fd6a")
  })

  it("isolates by PR number — load returns only the requested PR's records", async () => {
    const env = makeEnv(kv)
    await writeWithdrawal({
      env, owner: "Sigilix", repo: "sigilix", prNumber: 138,
      path: "src/a.ts", line: 1, bodySnapshot: "first concern",
      withdrawnByCommentId: 1, prHeadSha: "x",
    })
    await writeWithdrawal({
      env, owner: "Sigilix", repo: "sigilix", prNumber: 139,
      path: "src/b.ts", line: 2, bodySnapshot: "second concern",
      withdrawnByCommentId: 2, prHeadSha: "y",
    })
    const pr138 = await loadWithdrawals(env, "Sigilix", "sigilix", 138)
    expect(pr138).toHaveLength(1)
    expect(pr138[0]?.path).toBe("src/a.ts")
  })

  it("writeWithdrawal returns false when KV.put throws (best-effort, never throws)", async () => {
    const throwingEnv = {
      OPENCLAW_STATE: {
        ...kv,
        put: async () => { throw new Error("KV unreachable") },
      },
    } as unknown as Env
    const ok = await writeWithdrawal({
      env: throwingEnv,
      owner: "o", repo: "r", prNumber: 1,
      path: "p", line: 1, bodySnapshot: "b",
      withdrawnByCommentId: 1, prHeadSha: "s",
    })
    expect(ok).toBe(false)
  })

  it("loadWithdrawals returns [] when KV.list throws (best-effort)", async () => {
    const throwingEnv = {
      OPENCLAW_STATE: {
        ...kv,
        list: async () => { throw new Error("KV unreachable") },
      },
    } as unknown as Env
    const out = await loadWithdrawals(throwingEnv, "o", "r", 1)
    expect(out).toEqual([])
  })

  it("loadWithdrawals skips malformed records but returns valid ones", async () => {
    const env = makeEnv(kv)
    // Inject a malformed record alongside a valid one
    await kv.put("withdrawal:o:r:1:1", JSON.stringify({ not: "a withdrawal" }))
    await kv.put("withdrawal:o:r:1:2", "not even valid json {{{")
    await writeWithdrawal({
      env, owner: "o", repo: "r", prNumber: 1,
      path: "src/x.ts", line: 10, bodySnapshot: "valid",
      withdrawnByCommentId: 3, prHeadSha: "s",
    })
    const out = await loadWithdrawals(env, "o", "r", 1)
    expect(out).toHaveLength(1)
    expect(out[0]?.withdrawnByCommentId).toBe(3)
  })
})

// suppress unused-var lint
void vi
