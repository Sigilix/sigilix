// The once-ever guard on the PR-corpus backfill.
//
// Every test here maps to a real way the backfill re-fires today — adding a repo to
// an existing install, a webhook redelivery after our 503, a queue retry. Each
// re-run is a full Workers AI re-embed of up to 300 PRs, which is the same shape as
// the incident that cost ~$85 in six days.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"

import {
  claimCorpusPrBackfill,
  markCorpusPrBackfillComplete,
  releaseCorpusPrBackfillClaim,
} from "@/src/lib/multi-corpus-backfill-guard"
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "@/src/shared/adapters/model"

function makeKv() {
  const store = new Map<string, string>()
  return {
    store,
    env: {
      OPENCLAW_STATE: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => {
          store.set(k, v)
        },
        delete: async (k: string) => {
          store.delete(k)
        },
      } as unknown as KVNamespace,
    },
  }
}

const REPO = { owner: "acme", repo: "site" }
const T0 = 1_000_000

describe("claimCorpusPrBackfill", () => {
  let kv: ReturnType<typeof makeKv>
  beforeEach(() => {
    kv = makeKv()
  })

  it("first attempt claims", async () => {
    expect(await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })).toEqual({ ok: true })
  })

  it("a SECOND install event does not re-run — the live bug", async () => {
    // installation_repositories.added re-enqueues the backfill for every repo.
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })
    await markCorpusPrBackfillComplete(kv.env, { ...REPO, nowMs: T0 + 1, startedAtMs: T0, found: 300, upserted: 300 })

    const second = await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 + 5000 })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toBe("already-completed")
  })

  it("a webhook REDELIVERY mid-flight does not double-run", async () => {
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })
    const redelivery = await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 + 60_000 })
    expect(redelivery.ok).toBe(false)
    if (redelivery.ok) return
    expect(redelivery.reason).toBe("in-flight")
  })

  it("a crashed run SELF-HEALS after the stale window instead of blocking forever", async () => {
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 }) // claimed, then died
    // Still blocked inside the window...
    expect((await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 + 29 * 60_000 })).ok).toBe(false)
    // ...and re-claimable after it.
    expect((await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 + 31 * 60_000 })).ok).toBe(true)
  })

  it("is per-repo — one repo's backfill never blocks another's", async () => {
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })
    expect((await claimCorpusPrBackfill(kv.env, { owner: "acme", repo: "other", nowMs: T0 })).ok).toBe(true)
  })

  it("is case-insensitive on owner/repo (GitHub casing varies between payloads)", async () => {
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })
    const cased = await claimCorpusPrBackfill(kv.env, { owner: "ACME", repo: "Site", nowMs: T0 + 60_000 })
    expect(cased.ok).toBe(false)
  })

  it("force re-claims a completed backfill (deliberate re-index)", async () => {
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })
    await markCorpusPrBackfillComplete(kv.env, { ...REPO, nowMs: T0 + 1, startedAtMs: T0, found: 1, upserted: 1 })
    expect((await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 + 2, force: true })).ok).toBe(true)
  })

  it("an embedding-model change invalidates the guard — old vectors aren't interchangeable", async () => {
    kv.store.set(
      "corpus-pr-backfill:acme/site",
      JSON.stringify({ startedAtMs: T0, completedAtMs: T0 + 1, modelId: "some/other-model", embeddingDim: 384 }),
    )
    expect((await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 + 5000 })).ok).toBe(true)
  })

  it("records the CURRENT model + dimension on the claim", async () => {
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })
    const rec = JSON.parse(kv.store.get("corpus-pr-backfill:acme/site")!)
    expect(rec).toMatchObject({ startedAtMs: T0, modelId: EMBEDDING_MODEL, embeddingDim: EMBEDDING_DIMENSIONS })
    expect(rec.completedAtMs).toBeUndefined() // not complete until the work finishes
  })

  it("writes NO expiry — a TTL lapsing is exactly how a run-once job runs twice", async () => {
    let sawOptions: unknown = "unset"
    const env = {
      OPENCLAW_STATE: {
        get: async () => null,
        put: async (_k: string, _v: string, options?: unknown) => {
          sawOptions = options
        },
      } as unknown as KVNamespace,
    }
    await claimCorpusPrBackfill(env, { ...REPO, nowMs: T0 })
    expect(sawOptions).toBeUndefined()
  })

  it("THROWS on a KV read error — failing open here is an unbounded cost path", async () => {
    // If we can't read the guard we can't safely spend. Failing open would let every
    // delivery run a full backfill during a persistent KV fault, with nothing to stop
    // it; silently skipping would take the corpus dark with no signal. Throwing hands
    // it to the queue, which retries with backoff and eventually surfaces it.
    const env = {
      OPENCLAW_STATE: {
        get: async () => {
          throw new Error("kv down")
        },
        put: async () => {},
      } as unknown as KVNamespace,
    }
    await expect(claimCorpusPrBackfill(env, { ...REPO, nowMs: T0 })).rejects.toThrow(/guard unreadable/)
  })

  it("a KV write failure still lets the work proceed", async () => {
    const env = {
      OPENCLAW_STATE: {
        get: async () => null,
        put: async () => {
          throw new Error("kv down")
        },
      } as unknown as KVNamespace,
    }
    expect((await claimCorpusPrBackfill(env, { ...REPO, nowMs: T0 })).ok).toBe(true)
  })

  it("tolerates a corrupt guard record rather than blocking", async () => {
    kv.store.set("corpus-pr-backfill:acme/site", "{not json")
    expect((await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })).ok).toBe(true)
  })
})

describe("releaseCorpusPrBackfillClaim", () => {
  it("deletes the claim so a retry behaves like a first attempt", async () => {
    const kv = makeKv()
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })
    expect(kv.store.has("corpus-pr-backfill:acme/site")).toBe(true)
    await releaseCorpusPrBackfillClaim(kv.env, REPO)
    expect(kv.store.has("corpus-pr-backfill:acme/site")).toBe(false)
    // ...and the very next attempt can claim again, in-window.
    expect((await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 + 1000 })).ok).toBe(true)
  })

  it("never throws when KV is down", async () => {
    const env = {
      OPENCLAW_STATE: {
        delete: async () => {
          throw new Error("kv down")
        },
      } as unknown as KVNamespace,
    }
    await expect(releaseCorpusPrBackfillClaim(env, REPO)).resolves.toBeUndefined()
  })
})

describe("markCorpusPrBackfillComplete", () => {
  it("records a FULLY-successful outcome and flips the guard to completed", async () => {
    // Only a complete pass earns this. The handler enforces upserted === found before
    // calling it; an earlier version of this test used 42/40 and thereby blessed the
    // bug where a partial embed run was marked complete forever.
    const kv = makeKv()
    await claimCorpusPrBackfill(kv.env, { ...REPO, nowMs: T0 })
    await markCorpusPrBackfillComplete(kv.env, { ...REPO, nowMs: T0 + 99, startedAtMs: T0, found: 42, upserted: 42 })
    expect(JSON.parse(kv.store.get("corpus-pr-backfill:acme/site")!)).toMatchObject({
      startedAtMs: T0,
      completedAtMs: T0 + 99,
      found: 42,
      upserted: 42,
    })
  })

  it("never throws when KV is down (completion is best-effort)", async () => {
    const env = {
      OPENCLAW_STATE: {
        get: async () => null,
        put: async () => {
          throw new Error("kv down")
        },
      } as unknown as KVNamespace,
    }
    await expect(
      markCorpusPrBackfillComplete(env, { ...REPO, nowMs: T0, startedAtMs: T0, found: 1, upserted: 1 }),
    ).resolves.toBeUndefined()
  })
})

// Handler-level wiring. Without these, deleting the guard call from
// handleCorpusPrBackfill leaves every unit test above green — which is exactly the
// state this file exists to prevent.
describe("handleCorpusPrBackfill wiring", () => {
  const read = () => readFileSync(new URL("./multi-corpus-jobs.ts", import.meta.url), "utf8")

  it("claims BEFORE any GitHub call or embed", () => {
    const src = read()
    const claimAt = src.indexOf("claimCorpusPrBackfill(")
    const tokenAt = src.indexOf("getInstallationToken(", src.indexOf("handleCorpusPrBackfill"))
    expect(claimAt).toBeGreaterThan(-1)
    expect(tokenAt).toBeGreaterThan(claimAt) // guard first, network second
  })

  it("returns early when the claim is denied", () => {
    expect(read()).toMatch(/if \(!claim\.ok\)[\s\S]{0,400}return/)
  })

  it("RELEASES the claim when the work throws — the permanent-loss bug", () => {
    // Without this, a transient GitHub failure burns all 3 queue retries against an
    // in-flight claim and the backfill never runs again.
    const src = read()
    expect(src).toMatch(
      /catch[\s\S]{0,300}releaseCorpusPrBackfillClaim\(env, \{ owner: job\.owner, repo: job\.repo \}\)/,
    )
    expect(src).toMatch(/releaseCorpusPrBackfillClaim[\s\S]{0,200}throw error/)
  })

  it("RELEASES + throws when any upsert failed — a partial run must never be marked complete", () => {
    // upsertPrDoc swallows Workers AI / Vectorize errors and returns false, so an AI
    // outage yields found:300 / upserted:0 with no throw. Marking that complete would
    // leave the corpus permanently empty.
    const src = read()
    expect(src).toMatch(/if \(upserted < prs\.length\)[\s\S]{0,400}releaseCorpusPrBackfillClaim/)
    expect(src).toMatch(/if \(upserted < prs\.length\)[\s\S]{0,600}throw new Error/)
  })

  it("marks complete only after the upsert loop", () => {
    const src = read()
    const loopAt = src.indexOf("for (const pr of prs)")
    const markAt = src.indexOf("markCorpusPrBackfillComplete(")
    expect(markAt).toBeGreaterThan(loopAt)
  })

  it("stamps completion with a FRESH clock, not the dispatch timestamp", () => {
    // Reusing `nowMs` made every record claim the run took 0ms — the exact field
    // you'd read while debugging a cost incident.
    expect(read()).toMatch(/markCorpusPrBackfillComplete\(env, \{[\s\S]{0,300}nowMs: Date\.now\(\)/)
  })

  it("threads `force` end-to-end so the escape hatch actually exists", () => {
    expect(read()).toContain("force: job.force")
    expect(readFileSync(new URL("../shared/types/job.ts", import.meta.url), "utf8")).toMatch(
      /corpus-pr-backfill[\s\S]{0,400}force\?: boolean/,
    )
    expect(readFileSync(new URL("../index-dispatch.ts", import.meta.url), "utf8")).toMatch(
      /handleCorpusPrBackfill\([\s\S]{0,300}force: job\.force/,
    )
  })
})
