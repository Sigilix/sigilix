// SIG-170 — Per-finding upsert primitive tests.
//
// Covers:
//   - Fingerprint stability + collision avoidance.
//   - KV-hit fast path → PATCH (not POST).
//   - KV-miss + marker-scan recovery → PATCH + KV backfill.
//   - Full miss → POST + KV write.
//   - Withdrawal short-circuit → no GitHub call at all.
//   - End-to-end: two pushes with the same finding → ONE bot comment.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  computeUnanchoredFingerprint,
  normaliseBodyForFingerprint,
  buildSigilixUnanchoredMarker,
  findFingerprintInCommentBody,
  extractSigilixMarker,
} from "@/src/lib/review-memory/marker"
import {
  renderUnanchoredCommentBody,
  upsertUnanchoredComment,
  type UnanchoredUpsertFinding,
} from "@/src/lib/unanchored-comment-upsert"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"
import type { WithdrawalRecord } from "@/src/lib/review-withdrawal-store"

// ─── Fixtures + stubs ──────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
  warnSpy.mockRestore()
})

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  reads: string[]
  writes: Array<{ key: string; value: string }>
}
function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const reads: string[] = []
  const writes: Array<{ key: string; value: string }> = []
  const kv = {
    async get(key: string): Promise<string | null> {
      reads.push(key)
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      writes.push({ key, value })
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, reads, writes }
}

interface ClientStub {
  client: GitHubClient
  createCalls: Array<{ owner: string; repo: string; pr: number; body: string }>
  updateCalls: Array<{ owner: string; repo: string; id: number; body: string }>
  pages: Map<number, Array<{ id: number; body: string }>>
  nextCommentId: number
}
function makeClientStub(): ClientStub {
  const stub: ClientStub = {
    createCalls: [],
    updateCalls: [],
    pages: new Map(),
    nextCommentId: 1000,
    // Initialized below.
    client: undefined as unknown as GitHubClient,
  }
  stub.client = {
    async createIssueComment(owner: string, repo: string, pr: number, body: string): Promise<{ id: number }> {
      stub.createCalls.push({ owner, repo, pr, body })
      const id = stub.nextCommentId++
      const page = stub.pages.get(1) ?? []
      page.push({ id, body })
      stub.pages.set(1, page)
      return { id }
    },
    async updateIssueComment(owner: string, repo: string, id: number, body: string): Promise<void> {
      stub.updateCalls.push({ owner, repo, id, body })
      // Reflect the update in the stub's "PR comments" pages so a
      // later scan would still find the same fingerprint.
      for (const items of stub.pages.values()) {
        const existing = items.find((c) => c.id === id)
        if (existing) existing.body = body
      }
    },
    async listIssueCommentsPage(
      _owner: string,
      _repo: string,
      _pr: number,
      page: number,
    ): Promise<Array<{ id: number; body: string }>> {
      return stub.pages.get(page) ?? []
    },
  } as unknown as GitHubClient
  return stub
}

const OWNER = "Sigilix"
const REPO = "sigilix"
const PR = 42

const BASE_FINDING: UnanchoredUpsertFinding = {
  path: "src/lib/foo.ts",
  line: 17,
  body: "This function silently swallows the error rather than propagating it to the caller.",
  category: "logic",
  severity: "warning",
  ruleId: "no-silent-catch",
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return { OPENCLAW_STATE: kv } as unknown as Env
}

// ─── normaliseBodyForFingerprint ──────────────────────────────────

describe("normaliseBodyForFingerprint", () => {
  it("lowercases, collapses whitespace, strips trailing punctuation", () => {
    expect(normaliseBodyForFingerprint("  Hello  WORLD.\n")).toBe("hello world")
    expect(normaliseBodyForFingerprint("Tabs\tand\nnewlines!!!")).toBe("tabs and newlines")
  })

  it("collapses internal punctuation but only strips at the tail", () => {
    expect(normaliseBodyForFingerprint("a, b, c.")).toBe("a, b, c")
  })
})

// ─── Fingerprint stability + collision avoidance ──────────────────

describe("computeUnanchoredFingerprint", () => {
  it("is stable across re-runs with the same inputs", async () => {
    const a = await computeUnanchoredFingerprint({
      ruleId: "x",
      category: "logic",
      path: "src/a.ts",
      body: "Body of the finding.",
    })
    const b = await computeUnanchoredFingerprint({
      ruleId: "x",
      category: "logic",
      path: "src/a.ts",
      body: "Body of the finding.",
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it("changes when category changes (collision avoidance)", async () => {
    const base = { ruleId: "x", path: "src/a.ts", body: "Body" } as const
    const logic = await computeUnanchoredFingerprint({ ...base, category: "logic" })
    const security = await computeUnanchoredFingerprint({ ...base, category: "security" })
    expect(logic).not.toBe(security)
  })

  it("changes when path changes", async () => {
    const base = { ruleId: "x", category: "logic" as const, body: "Body" }
    const a = await computeUnanchoredFingerprint({ ...base, path: "src/a.ts" })
    const b = await computeUnanchoredFingerprint({ ...base, path: "src/b.ts" })
    expect(a).not.toBe(b)
  })

  it("changes when ruleId changes; null + 'none' collide intentionally", async () => {
    const base = { category: "logic" as const, path: "src/a.ts", body: "Body" }
    const ruleX = await computeUnanchoredFingerprint({ ...base, ruleId: "x" })
    const ruleY = await computeUnanchoredFingerprint({ ...base, ruleId: "y" })
    const nullRule = await computeUnanchoredFingerprint({ ...base, ruleId: null })
    const noneSentinel = await computeUnanchoredFingerprint({ ...base, ruleId: "none" })
    expect(ruleX).not.toBe(ruleY)
    // Mirrors the existing inline-marker convention (`buildSigilixMarker`
    // also collapses null → "none").
    expect(nullRule).toBe(noneSentinel)
  })

  it("stable when prompt tweaks only change whitespace / case / trailing punctuation", async () => {
    const base = {
      ruleId: "x",
      category: "logic" as const,
      path: "src/a.ts",
    }
    const a = await computeUnanchoredFingerprint({
      ...base,
      body: "This silently swallows the error.",
    })
    const b = await computeUnanchoredFingerprint({
      ...base,
      body: "  This   silently swallows the error  ",
    })
    const c = await computeUnanchoredFingerprint({
      ...base,
      body: "this silently swallows the error!",
    })
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it("DOES change when the underlying claim changes", async () => {
    const base = {
      ruleId: "x",
      category: "logic" as const,
      path: "src/a.ts",
    }
    const a = await computeUnanchoredFingerprint({ ...base, body: "Claim A" })
    const b = await computeUnanchoredFingerprint({ ...base, body: "Claim B" })
    expect(a).not.toBe(b)
  })

  it("does NOT include raw line — fingerprint stable when line moves", async () => {
    // The whole point of unanchored is that the line moved/disappeared.
    // The fingerprint signature deliberately omits line; the
    // UnanchoredUpsertFinding's `line` field exists for withdrawal
    // matching only.
    const a = await computeUnanchoredFingerprint({
      ruleId: "x",
      category: "logic",
      path: "src/a.ts",
      body: "Body",
    })
    const b = await computeUnanchoredFingerprint({
      ruleId: "x",
      category: "logic",
      path: "src/a.ts",
      body: "Body",
    })
    expect(a).toBe(b)
  })
})

// ─── Marker round-trip ─────────────────────────────────────────────

describe("buildSigilixUnanchoredMarker + extractSigilixMarker", () => {
  it("emits a marker whose fid + cat + sev + loc round-trip through the parser", async () => {
    const { marker, fingerprint } = await buildSigilixUnanchoredMarker({
      ruleId: "x",
      category: "security",
      severity: "error",
      path: "src/a.ts",
      body: "Body",
    })
    const parsed = extractSigilixMarker(marker)
    expect(parsed).not.toBeNull()
    expect(parsed!.fid).toBe(fingerprint)
    expect(parsed!.cat).toBe("security")
    expect(parsed!.sev).toBe("error")
    expect(parsed!.loc).toBe("unanchored")
  })

  it("legacy 4-segment markers (no :loc:) still parse — back-compat with pre-SIG-170 comments", () => {
    const legacy = `<!-- sigilix:fid:0123456789abcdef:cat:logic:sev:warning:path:abcdef012345 -->`
    const parsed = extractSigilixMarker(legacy)
    expect(parsed).not.toBeNull()
    expect(parsed!.loc).toBeUndefined()
  })

  it("findFingerprintInCommentBody extracts the fid from a wrapped body", async () => {
    const { marker, fingerprint } = await buildSigilixUnanchoredMarker({
      ruleId: null,
      category: "logic",
      severity: "info",
      path: "src/a.ts",
      body: "Body",
    })
    const wrapped = `Some finding body text.\n\n${marker}`
    expect(findFingerprintInCommentBody(wrapped)).toBe(fingerprint)
  })

  it("findFingerprintInCommentBody returns null when no marker present", () => {
    expect(findFingerprintInCommentBody("just prose, no marker")).toBeNull()
  })
})

// ─── Upsert flow ──────────────────────────────────────────────────

describe("upsertUnanchoredComment — withdrawal short-circuit", () => {
  it("emits no GitHub call when the finding matches a withdrawal", async () => {
    const { kv } = makeKvStub()
    const client = makeClientStub()
    const env = makeEnv(kv)
    const withdrawal: WithdrawalRecord = {
      path: BASE_FINDING.path,
      line: BASE_FINDING.line,
      bodySnapshot: BASE_FINDING.body,
      withdrawnAt: Date.now(),
      withdrawnByCommentId: 9001,
      prHeadSha: "deadbeef",
      reason: "mention-reply-accepted",
    }
    const result = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [withdrawal],
    })
    expect(result.outcome).toBe("withdrawn_skipped")
    expect(result.commentId).toBeUndefined()
    expect(client.createCalls).toHaveLength(0)
    expect(client.updateCalls).toHaveLength(0)
    // Telemetry surfaced.
    const events = logSpy.mock.calls.map((c) => JSON.parse(c[0] as string).event)
    expect(events).toContain("unanchored-comment-upsert-withdrawn-skipped")
  })
})

describe("upsertUnanchoredComment — KV hit → PATCH (not POST)", () => {
  it("PATCHes the cached comment id without scanning or POSTing", async () => {
    const kvStub = makeKvStub()
    const client = makeClientStub()
    const env = makeEnv(kvStub.kv)
    const fingerprint = await computeUnanchoredFingerprint({
      ruleId: BASE_FINDING.ruleId ?? null,
      category: BASE_FINDING.category,
      path: BASE_FINDING.path,
      body: BASE_FINDING.body,
    })
    const key = `unanchored-comment:${OWNER}:${REPO}:${PR}:${fingerprint}`
    kvStub.store.set(key, "555")

    const result = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [],
    })

    expect(result.outcome).toBe("hit_marker_via_kv")
    expect(result.commentId).toBe(555)
    expect(client.updateCalls).toHaveLength(1)
    expect(client.updateCalls[0]?.id).toBe(555)
    expect(client.createCalls).toHaveLength(0)
    // KV TTL refresh — write the same id back so the entry doesn't
    // expire mid-PR.
    expect(kvStub.writes.some((w) => w.key === key && w.value === "555")).toBe(true)
  })
})

describe("upsertUnanchoredComment — KV miss + marker found in scan → PATCH + backfill KV", () => {
  it("scans PR comments, PATCHes the matching id, and writes KV", async () => {
    const kvStub = makeKvStub()
    const client = makeClientStub()
    const env = makeEnv(kvStub.kv)
    const fingerprint = await computeUnanchoredFingerprint({
      ruleId: BASE_FINDING.ruleId ?? null,
      category: BASE_FINDING.category,
      path: BASE_FINDING.path,
      body: BASE_FINDING.body,
    })
    const { marker } = await buildSigilixUnanchoredMarker({
      ruleId: BASE_FINDING.ruleId ?? null,
      category: BASE_FINDING.category,
      severity: BASE_FINDING.severity,
      path: BASE_FINDING.path,
      body: BASE_FINDING.body,
    })
    // Prime the PR with an existing Sigilix comment carrying the
    // fingerprint marker — simulates a prior push whose KV entry
    // expired or never landed.
    client.pages.set(1, [{ id: 7777, body: `Prior body.\n\n${marker}` }])

    const result = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [],
    })

    expect(result.outcome).toBe("hit_marker_via_scan")
    expect(result.commentId).toBe(7777)
    expect(client.updateCalls).toHaveLength(1)
    expect(client.updateCalls[0]?.id).toBe(7777)
    expect(client.createCalls).toHaveLength(0)
    // KV backfilled so the next run takes the fast path.
    const key = `unanchored-comment:${OWNER}:${REPO}:${PR}:${fingerprint}`
    expect(kvStub.store.get(key)).toBe("7777")
  })

  it("paginates past full pages — finds a marker on page 2", async () => {
    const kvStub = makeKvStub()
    const client = makeClientStub()
    const env = makeEnv(kvStub.kv)
    const { marker } = await buildSigilixUnanchoredMarker({
      ruleId: BASE_FINDING.ruleId ?? null,
      category: BASE_FINDING.category,
      severity: BASE_FINDING.severity,
      path: BASE_FINDING.path,
      body: BASE_FINDING.body,
    })
    // Page 1 = 100 unrelated comments; page 2 holds the match.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 100 + i,
      body: `Unrelated comment ${i}`,
    }))
    client.pages.set(1, page1)
    client.pages.set(2, [{ id: 4242, body: `Body\n\n${marker}` }])

    const result = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [],
    })
    expect(result.outcome).toBe("hit_marker_via_scan")
    expect(result.commentId).toBe(4242)
  })
})

describe("upsertUnanchoredComment — full miss → POST + write KV", () => {
  it("creates a new comment when neither KV nor a marker exist", async () => {
    const kvStub = makeKvStub()
    const client = makeClientStub()
    const env = makeEnv(kvStub.kv)
    const fingerprint = await computeUnanchoredFingerprint({
      ruleId: BASE_FINDING.ruleId ?? null,
      category: BASE_FINDING.category,
      path: BASE_FINDING.path,
      body: BASE_FINDING.body,
    })

    const result = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [],
    })

    expect(result.outcome).toBe("miss_created")
    expect(client.createCalls).toHaveLength(1)
    expect(client.updateCalls).toHaveLength(0)
    // Posted body carries the marker.
    expect(client.createCalls[0]?.body).toContain(`fid:${fingerprint}`)
    expect(client.createCalls[0]?.body).toContain("loc:unanchored")
    // KV written so the next run hits the fast path.
    const key = `unanchored-comment:${OWNER}:${REPO}:${PR}:${fingerprint}`
    expect(kvStub.store.get(key)).toBe(String(result.commentId))
  })
})

describe("upsertUnanchoredComment — two pushes, one comment", () => {
  it("the second push edits the first push's comment in place (the acceptance criteria)", async () => {
    const kvStub = makeKvStub()
    const client = makeClientStub()
    const env = makeEnv(kvStub.kv)

    // Push 1 — fingerprint cold; POST.
    const first = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [],
    })
    expect(first.outcome).toBe("miss_created")
    expect(client.createCalls).toHaveLength(1)

    // Push 2 — same finding, same fingerprint; KV hit → PATCH.
    const second = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [],
    })
    expect(second.outcome).toBe("hit_marker_via_kv")
    expect(second.commentId).toBe(first.commentId)

    // Net effect: ONE create + ONE update; the live comment count for
    // this fingerprint is 1.
    expect(client.createCalls).toHaveLength(1)
    expect(client.updateCalls).toHaveLength(1)
    const allCommentsAcrossPages = Array.from(client.pages.values()).flat()
    const liveForFingerprint = allCommentsAcrossPages.filter((c) => c.body.includes(`fid:${first.fingerprint}`))
    expect(liveForFingerprint).toHaveLength(1)
  })

  it("recovers from a cold KV — push 2 finds push 1's marker via scan and PATCHes", async () => {
    const kvStub = makeKvStub()
    const client = makeClientStub()
    const env = makeEnv(kvStub.kv)

    // Push 1 — POST.
    const first = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [],
    })
    expect(first.outcome).toBe("miss_created")
    // Simulate the KV entry being lost (TTL expired, KV outage, etc.).
    kvStub.store.clear()

    // Push 2 — KV miss but marker still present in the PR's comments.
    const second = await upsertUnanchoredComment({
      env,
      client: client.client,
      owner: OWNER,
      repo: REPO,
      prNumber: PR,
      finding: BASE_FINDING,
      withdrawals: [],
    })
    expect(second.outcome).toBe("hit_marker_via_scan")
    expect(second.commentId).toBe(first.commentId)
    expect(client.createCalls).toHaveLength(1)
    expect(client.updateCalls).toHaveLength(1)
  })
})

describe("renderUnanchoredCommentBody", () => {
  it("appends the marker on its own line with a blank line separator", () => {
    const out = renderUnanchoredCommentBody({
      body: "Body text.",
      marker: "<!-- sigilix:fid:abc:cat:logic:sev:info:path:abc:loc:unanchored -->",
    })
    expect(out.endsWith(":loc:unanchored -->")).toBe(true)
    expect(out).toContain("Body text.\n\n<!-- ")
  })
})
