// SIG-160 PR3 — withdrawal-store helpers + KV round-trip.

import { describe, expect, it, vi, beforeEach } from "vitest"

import {
  tokenize,
  jaccardSimilarity,
  stripBodyForMatching,
  findingMatchesWithdrawal,
  filterWithdrawnFindings,
  filterWithdrawnFindingsDetailed,
  computeContentFingerprint,
  writeWithdrawal,
  loadWithdrawals,
  type WithdrawalRecord,
} from "@/src/lib/review-withdrawal-store"
import type { Env } from "@/src/shared/types/env"

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
      puts.push({ key, value, ...(opts !== undefined ? { opts } : {}) })
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
    async list({ prefix }: { prefix: string }): Promise<{ keys: { name: string }[] }> {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }))
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
    expect([...tokenize("Add a missing null check on req.body!")].sort()).toEqual([
      "add",
      "body",
      "check",
      "missing",
      "null",
      "req",
    ])
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
    const body =
      "<!-- sigilix:pr-review-finding -->\n**testing:** lacks coverage\n\n```suggestion\nfoo()\n```\n\nSee [the docs](https://example.com/x)."
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
      // Recent dismissal so it's inside the decay window (the wrapper uses
      // Date.now() internally — an epoch-0 timestamp would read as decayed).
      withdrawnAt: Date.now(),
      withdrawnByCommentId: 1,
      prHeadSha: "x",
      reason: "mention-reply-accepted",
    },
  ]

  it("drops findings that match a withdrawal", () => {
    const findings = [
      {
        path: "src/index.ts",
        line: 962,
        body: "the scheduled handler lacks coverage for its gating success and error paths",
      },
      {
        path: "src/index.ts",
        line: 200,
        body: "unrelated logic concern about the cron tick guard",
      },
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
      env,
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 138,
      path: "src/a.ts",
      line: 1,
      bodySnapshot: "first concern",
      withdrawnByCommentId: 1,
      prHeadSha: "x",
    })
    await writeWithdrawal({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 139,
      path: "src/b.ts",
      line: 2,
      bodySnapshot: "second concern",
      withdrawnByCommentId: 2,
      prHeadSha: "y",
    })
    const pr138 = await loadWithdrawals(env, "Sigilix", "sigilix", 138)
    expect(pr138).toHaveLength(1)
    expect(pr138[0]?.path).toBe("src/a.ts")
  })

  it("writeWithdrawal returns false when KV.put throws (best-effort, never throws)", async () => {
    const throwingEnv = {
      OPENCLAW_STATE: {
        ...kv,
        put: async () => {
          throw new Error("KV unreachable")
        },
      },
    } as unknown as Env
    const ok = await writeWithdrawal({
      env: throwingEnv,
      owner: "o",
      repo: "r",
      prNumber: 1,
      path: "p",
      line: 1,
      bodySnapshot: "b",
      withdrawnByCommentId: 1,
      prHeadSha: "s",
    })
    expect(ok).toBe(false)
  })

  it("loadWithdrawals returns [] when KV.list throws (best-effort)", async () => {
    const throwingEnv = {
      OPENCLAW_STATE: {
        ...kv,
        list: async () => {
          throw new Error("KV unreachable")
        },
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
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      path: "src/x.ts",
      line: 10,
      bodySnapshot: "valid",
      withdrawnByCommentId: 3,
      prHeadSha: "s",
    })
    const out = await loadWithdrawals(env, "o", "r", 1)
    expect(out).toHaveLength(1)
    expect(out[0]?.withdrawnByCommentId).toBe(3)
  })
})

// SIG-173 — optional dismissReason field round-trips through write+load.

describe("WithdrawalRecord dismissReason field (SIG-173)", () => {
  it("persists dismissReason and recovers it via loadWithdrawals", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await writeWithdrawal({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      path: "src/x.ts",
      line: 1,
      bodySnapshot: "concern",
      withdrawnByCommentId: 1,
      prHeadSha: "s",
      dismissReason: "too-minor",
    })
    const out = await loadWithdrawals(env, "o", "r", 1)
    expect(out).toHaveLength(1)
    expect(out[0]?.dismissReason).toBe("too-minor")
  })

  it("omits dismissReason from the wire when the writer doesn't supply one (back-compat)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    await writeWithdrawal({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      path: "src/x.ts",
      line: 1,
      bodySnapshot: "concern",
      withdrawnByCommentId: 1,
      prHeadSha: "s",
    })
    const raw = store.get("withdrawal:o:r:1:1")
    expect(raw).toBeTruthy()
    // The serialized JSON should NOT contain the field at all (avoids
    // leaking an `undefined` over the wire / shadow-test artifacts).
    expect(raw).not.toContain("dismissReason")

    const out = await loadWithdrawals(env, "o", "r", 1)
    expect(out).toHaveLength(1)
    expect(out[0]?.dismissReason).toBeUndefined()
  })

  it("loads legacy records that pre-date the dismissReason field (forward compat)", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    // Hand-write a pre-SIG-173 shape: no dismissReason field at all.
    await kv.put(
      "withdrawal:o:r:1:42",
      JSON.stringify({
        path: "src/x.ts",
        line: 1,
        bodySnapshot: "concern",
        withdrawnAt: 1700000000000,
        withdrawnByCommentId: 42,
        prHeadSha: "s",
        reason: "mention-reply-accepted",
      }),
    )
    const out = await loadWithdrawals(env, "o", "r", 1)
    expect(out).toHaveLength(1)
    expect(out[0]?.withdrawnByCommentId).toBe(42)
    expect(out[0]?.dismissReason).toBeUndefined()
  })

  it("ignores unknown / invalid dismissReason values on the wire", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await kv.put(
      "withdrawal:o:r:1:43",
      JSON.stringify({
        path: "src/x.ts",
        line: 1,
        bodySnapshot: "concern",
        withdrawnAt: 1700000000000,
        withdrawnByCommentId: 43,
        prHeadSha: "s",
        reason: "mention-reply-accepted",
        dismissReason: "not-a-real-label",
      }),
    )
    const out = await loadWithdrawals(env, "o", "r", 1)
    expect(out).toHaveLength(1)
    // Unknown label is dropped so it can't poison softening weight calcs.
    expect(out[0]?.dismissReason).toBeUndefined()
  })
})

// ── SIG-217: content-fingerprint dismissal-aware re-fire suppression ──

describe("computeContentFingerprint", () => {
  it("is stable for identical (category, path, body-prefix)", async () => {
    const a = await computeContentFingerprint("security", "src/index.ts", "Possible secret leaked in this handler.")
    const b = await computeContentFingerprint("security", "src/index.ts", "Possible secret leaked in this handler.")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it("differs when category, path, or the first 80 body chars change", async () => {
    const base = await computeContentFingerprint("security", "src/index.ts", "Possible secret leaked here.")
    expect(await computeContentFingerprint("logic", "src/index.ts", "Possible secret leaked here.")).not.toBe(base)
    expect(await computeContentFingerprint("security", "src/other.ts", "Possible secret leaked here.")).not.toBe(base)
    expect(
      await computeContentFingerprint("security", "src/index.ts", "A totally different concern entirely."),
    ).not.toBe(base)
  })

  it("ignores body drift beyond the first 80 chars (stable prefix)", async () => {
    const prefix = "x".repeat(80)
    const a = await computeContentFingerprint("logic", "a.ts", prefix + " tail-A")
    const b = await computeContentFingerprint("logic", "a.ts", prefix + " tail-B-different")
    expect(a).toBe(b)
  })
})

describe("findingMatchesWithdrawal — SIG-217 fingerprint short-circuit", () => {
  const withdrawal: WithdrawalRecord = {
    path: "src/index.ts",
    line: 667,
    bodySnapshot: "the original conceded body",
    withdrawnAt: 1,
    withdrawnByCommentId: 1,
    prHeadSha: "abc",
    reason: "mention-reply-accepted",
    contentFingerprint: "f".repeat(64),
  }

  it("matches on fingerprint even when line drifts past tolerance AND body is disjoint", () => {
    // Different line (well past ±5) and a body that shares no tokens — the
    // Jaccard path would REJECT this. Fingerprint match must still suppress.
    expect(
      findingMatchesWithdrawal(
        {
          path: "src/index.ts",
          line: 712,
          body: "completely unrelated wording",
          contentFingerprint: "f".repeat(64),
        },
        withdrawal,
      ),
    ).toBe(true)
  })

  it("falls back to Jaccard when fingerprints are absent on either side", () => {
    const { contentFingerprint: _contentFingerprint, ...noFp } = withdrawal
    expect(
      findingMatchesWithdrawal({ path: "src/index.ts", line: 667, body: "the original conceded body" }, noFp),
    ).toBe(true)
    // Disjoint body + no fingerprint → no match.
    expect(findingMatchesWithdrawal({ path: "src/index.ts", line: 667, body: "zzz qqq vvv unrelated" }, noFp)).toBe(
      false,
    )
  })

  it("does NOT match when fingerprints differ and Jaccard/line fail", () => {
    expect(
      findingMatchesWithdrawal(
        { path: "src/index.ts", line: 712, body: "unrelated", contentFingerprint: "a".repeat(64) },
        withdrawal,
      ),
    ).toBe(false)
  })
})

describe("filterWithdrawnFindingsDetailed — re-fire + escalation telemetry flags", () => {
  // The SIG-217 trigger fixture: a finding dismissed on push N, re-fired on
  // push N+1 with a NEW model-emitted id, drifted line, and ESCALATED score —
  // but identical content fingerprint.
  const fp = "c".repeat(64)
  const withdrawal: WithdrawalRecord = {
    path: "src/index.ts",
    line: 667,
    bodySnapshot: "stripped original",
    withdrawnAt: 1,
    withdrawnByCommentId: 1,
    prHeadSha: "sha-n",
    reason: "mention-reply-accepted",
    contentFingerprint: fp,
    dismissedScore: 2,
  }

  // withdrawnAt is 1; pass now=1 so age=0 keeps every match INSIDE the decay
  // window (decay behavior is exercised separately below).
  const NOW = 1

  it("suppresses the re-fire via fingerprint and flags it (no escalation when score unchanged)", () => {
    const { kept, suppressed } = filterWithdrawnFindingsDetailed(
      [{ path: "src/index.ts", line: 670, body: "re-worded", contentFingerprint: fp, score: 2 }],
      [withdrawal],
      NOW,
    )
    expect(kept).toHaveLength(0)
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]!.viaFingerprint).toBe(true)
    expect(suppressed[0]!.severityEscalated).toBe(false)
  })

  it("flags severityEscalated when the re-fire returns at a higher score", () => {
    const { suppressed } = filterWithdrawnFindingsDetailed(
      [{ path: "src/index.ts", line: 670, body: "re-worded", contentFingerprint: fp, score: 5 }],
      [withdrawal],
      NOW,
    )
    expect(suppressed[0]!.viaFingerprint).toBe(true)
    expect(suppressed[0]!.severityEscalated).toBe(true) // 5 > dismissed 2
  })

  it("does NOT flag escalation for a Jaccard-only (non-fingerprint) match", () => {
    const { contentFingerprint: _contentFingerprint, ...noFp } = withdrawal
    const { suppressed } = filterWithdrawnFindingsDetailed(
      [{ path: "src/index.ts", line: 667, body: "stripped original", score: 5 }],
      [noFp],
      NOW,
    )
    expect(suppressed[0]!.viaFingerprint).toBe(false)
    expect(suppressed[0]!.severityEscalated).toBe(false)
  })
})

describe("writeWithdrawal + loadWithdrawal — SIG-217 fingerprint round-trip", () => {
  it("persists and reloads contentFingerprint + dismissedScore, then matches a re-fire", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const fp = await computeContentFingerprint("security", "src/index.ts", "JSDoc list flagged as a secret token.")
    await writeWithdrawal({
      env,
      owner: "o",
      repo: "r",
      prNumber: 1,
      path: "src/index.ts",
      line: 667,
      bodySnapshot: "JSDoc list flagged as a secret token.",
      withdrawnByCommentId: 42,
      prHeadSha: "sha-1",
      contentFingerprint: fp,
      score: 0,
    })
    const loaded = await loadWithdrawals(env, "o", "r", 1)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.contentFingerprint).toBe(fp)
    expect(loaded[0]!.dismissedScore).toBe(0)
    // Re-fire on the next push: new id, drifted line, escalated to P0 — same fp.
    const { kept, suppressed } = filterWithdrawnFindingsDetailed(
      [
        {
          path: "src/index.ts",
          line: 669,
          body: "now reported as a P0 secret!!",
          contentFingerprint: fp,
          score: 5,
        },
      ],
      loaded,
    )
    expect(kept).toHaveLength(0)
    expect(suppressed[0]!.severityEscalated).toBe(true)
  })
})

describe("filterWithdrawnFindingsDetailed — SIG-217 Part B decay window", () => {
  // Mirror of the source constant (private to the module).
  const DECAY_MS = 14 * 24 * 60 * 60 * 1000
  const fp = "d".repeat(64)
  const withdrawal: WithdrawalRecord = {
    path: "src/a.ts",
    line: 10,
    bodySnapshot: "dismissed body",
    withdrawnAt: 1_000_000_000_000, // fixed epoch ms for deterministic age math
    withdrawnByCommentId: 1,
    prHeadSha: "sha",
    reason: "mention-reply-accepted",
    contentFingerprint: fp,
    dismissedScore: 3,
  }
  const finding = { path: "src/a.ts", line: 10, body: "re-fired", contentFingerprint: fp, score: 3 }

  it("still SUPPRESSES just inside the window (age == DECAY_MS)", () => {
    const now = withdrawal.withdrawnAt + DECAY_MS // boundary is inclusive of suppression
    const { kept, suppressed, decayExpired } = filterWithdrawnFindingsDetailed([finding], [withdrawal], now)
    expect(kept).toHaveLength(0)
    expect(suppressed).toHaveLength(1)
    expect(decayExpired).toHaveLength(0)
  })

  it("LETS THROUGH and flags decayExpired just past the window", () => {
    const now = withdrawal.withdrawnAt + DECAY_MS + 1
    const { kept, suppressed, decayExpired } = filterWithdrawnFindingsDetailed([finding], [withdrawal], now)
    expect(kept).toHaveLength(1) // no longer muted
    expect(suppressed).toHaveLength(0)
    expect(decayExpired).toHaveLength(1)
    expect(decayExpired[0]!.viaFingerprint).toBe(true)
  })

  it("a fresh dismissal is unaffected (suppressed, not decayed)", () => {
    const now = withdrawal.withdrawnAt + 1000 // 1s later
    const { kept, decayExpired } = filterWithdrawnFindingsDetailed([finding], [withdrawal], now)
    expect(kept).toHaveLength(0)
    expect(decayExpired).toHaveLength(0)
  })
})

// suppress unused-var lint
void vi
