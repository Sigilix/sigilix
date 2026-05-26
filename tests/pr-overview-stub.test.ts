// SIG-84 — pr-overview stub helper tests.
//
// Covers the four resolution paths in `postPrOverviewStubIfNeeded`:
//   1. KV fast path (already-posted → kv-hit, no create, no list)
//   2. Marker scan fallback (KV miss + existing sigilix marker)
//   3. Reset path (KV miss + existing marker → updateIssueComment with
//      stub body so the overview handler can re-render)
//   4. Create path (KV miss + no marker → createIssueComment)
//
// Also covers `waitForPrOverviewStub` happy-path (flag present
// immediately), timeout path (flag never appears), and arrival-mid-poll
// path (flag appears after first poll).

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "fake-token")
// SIG-91 follow-up: findExistingOverviewCommentId now paginates via
// listIssueCommentsPage so it can short-circuit on first marker hit
// and cap at MAX_COMMENT_SCAN_PAGES. Default mock returns an empty
// page for any page request (= "no comments on PR").
const mockListIssueCommentsPage = vi.fn()
const mockCreateIssueComment = vi.fn()
const mockUpdateIssueComment = vi.fn()

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      listIssueCommentsPage: (...args: unknown[]) => mockListIssueCommentsPage(...args),
      createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
      updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
    })),
  }
})

import {
  buildPrOverviewStubBody,
  isStubBody,
  postPrOverviewStubIfNeeded,
  selectPrOverviewStubAsciiTemplate,
  selectPrOverviewStubQuip,
  STUB_BODY,
  STUB_ASCII_TEMPLATES,
  STUB_GITHUB_API_TIMEOUT_MS,
  STUB_QUIPS,
  stubFlagKey,
  stubInflightKey,
  waitForPrOverviewStub,
} from "../src/lib/pr-overview-stub"
import type { Env } from "../src/index"

function makeKvStub() {
  const store = new Map<string, string>()
  const getMock = vi.fn(async (key: string): Promise<string | null> => store.get(key) ?? null)
  const putMock = vi.fn(async (key: string, value: string): Promise<void> => {
    store.set(key, value)
  })
  const deleteMock = vi.fn(async (key: string): Promise<void> => {
    store.delete(key)
  })
  const kv = {
    get: getMock,
    put: putMock,
    delete: deleteMock,
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, getMock, putMock, deleteMock }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return {
    OPENCLAW_STATE: kv,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
}

const args = {
  owner: "acme",
  repo: "site",
  prNumber: 73,
  headSha: "h".repeat(40),
  installationId: 1,
}

function stubBodyFor(overrides: Partial<typeof args> = {}): string {
  const merged = { ...args, ...overrides }
  return buildPrOverviewStubBody({
    prNumber: merged.prNumber,
    headSha: merged.headSha,
  })
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockListIssueCommentsPage.mockClear()
  mockCreateIssueComment.mockClear()
  mockUpdateIssueComment.mockClear()
  // Default: every page returns empty (= no comments on the PR).
  mockListIssueCommentsPage.mockResolvedValue([])
  mockCreateIssueComment.mockResolvedValue({ id: 999 })
  mockUpdateIssueComment.mockResolvedValue({})
})

describe("postPrOverviewStubIfNeeded — KV fast path (Codex Q2)", () => {
  it("returns kv-hit when the flag already exists; does NOT post / list", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "555")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "kv-hit", commentId: 555 })
    expect(mockListIssueCommentsPage).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
  })

  it("falls through when the KV value is malformed (treat as miss)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "not-a-number")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV.get throws (treat as miss); still creates", async () => {
    const { kv, getMock } = makeKvStub()
    getMock.mockRejectedValueOnce(new Error("kv down"))

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  // ─── Sigilix #3 (PR #104 review): malformed KV value coverage ─────
  // The KV value MUST parse as a positive finite integer to be
  // honored as a "stub already posted" hit. These tests pin the
  // defensive parsing in `postPrOverviewStubIfNeeded`.

  it("falls through when KV returns null (no flag yet); marker-scan then create", async () => {
    const { kv } = makeKvStub() // store is empty → get(...) returns null

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockListIssueCommentsPage).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV returns an empty string (Number('') = 0 → not > 0)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV returns '0' (a comment id of 0 is not valid)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "0")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV returns a negative number", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "-12")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV returns Infinity / NaN markers (non-finite)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "Infinity")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("honors a valid stale comment id from KV WITHOUT validating existence (kv-hit is authoritative)", async () => {
    // The helper does NOT round-trip to GitHub to verify the comment
    // still exists — kv-hit is treated as authoritative (the review-
    // side wait only needs to know "a stub WAS posted"). If the
    // comment was deleted, the overview handler downstream will
    // detect that and recreate via its own marker-scan path; the
    // stub-post helper stays cheap.
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "777")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "kv-hit", commentId: 777 })
    expect(mockListIssueCommentsPage).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })
})

describe("postPrOverviewStubIfNeeded — marker scan fallback (Codex Q2)", () => {
  // SIG-96 (regression fix): when the marker scan finds a sticky with a
  // completed summary body (no `_Reviewing…_` placeholder), the helper
  // MUST NOT overwrite the body with the stub. The overview job still
  // runs and will PATCH atomically when it completes. Pre-fix every
  // subsequent push erased the prior summary for the ~30-90s rerender
  // window; reviewers landing mid-rerender saw nothing.
  it("SIG-96: PRESERVES an existing completed summary; writes KV flag; does NOT call updateIssueComment", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueCommentsPage.mockResolvedValueOnce([
      { id: 12345, body: "<!-- sigilix:pr-overview -->\n## Sigilix Overview\n\nA real summary from the prior head — file table + bullets + confidence." },
    ])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 12345 })
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    // SIG-96: the regression-causing update is NO LONGER called when the
    // existing body is a completed summary. The overview handler will
    // PATCH atomically when fresh render finishes.
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
    // KV flag is still written so the overview-side wait can fast-path
    // resolve the existing comment id.
    expect(store.get(stubFlagKey(args))).toBe("12345")
  })

  it("SIG-96: PRESERVES a completed summary on the legacy openclaw marker too (bilingual)", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueCommentsPage.mockResolvedValueOnce([
      { id: 4242, body: "<!-- openclaw:pr-overview -->\n## Sigilix Overview\n\nReal pre-rebrand summary — must survive the push." },
    ])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 4242 })
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
    expect(store.get(stubFlagKey(args))).toBe("4242")
  })

  // SIG-96: when the existing body IS the stub (rare race — cross-region
  // KV miss for current head's stub, or pre-rebrand legacy stub),
  // idempotent re-update fires so the SIG-91 timeout-cap + the
  // round-5 update-failure paths stay live. The new behavior gates
  // ONLY completed summaries, not stubs.
  it("SIG-96: still RESETS body when existing body IS the stub itself (idempotent re-write)", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueCommentsPage.mockResolvedValueOnce([
      { id: 555, body: STUB_BODY },
    ])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 555 })
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment.mock.calls[0]![2]).toBe(555)
    expect(mockUpdateIssueComment.mock.calls[0]![3]).toBe(stubBodyFor())
    expect(store.get(stubFlagKey(args))).toBe("555")
  })

  // Round-5 CR Major catch (preserved through SIG-96): when `update`
  // throws on the stub re-write branch (race-to-delete, perm revoke,
  // 5xx), we MUST NOT write the KV flag and MUST surface
  // `update-failed` so review-side falls through to the 2s wait.
  // Fixture uses a STUB body so the update branch fires.
  it("returns update-failed and does NOT write KV flag when updateIssueComment throws (round-5 CR Major)", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueCommentsPage.mockResolvedValueOnce([
      { id: 777, body: STUB_BODY },
    ])
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    mockUpdateIssueComment.mockRejectedValueOnce(new Error("403 perm denied"))

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "update-failed", commentId: 777 })
    expect(store.has(stubFlagKey(args))).toBe(false)
    const emittedUpdateFailed = warnSpy.mock.calls.some((call) => {
      const first = call[0]
      if (typeof first !== "string") return false
      try {
        const parsed = JSON.parse(first) as { event?: string }
        return parsed.event === "pr-overview-stub-update-failed"
      } catch {
        return false
      }
    })
    expect(emittedUpdateFailed).toBe(true)
    warnSpy.mockRestore()
  })
})

describe("postPrOverviewStubIfNeeded — create path", () => {
  it("creates a new stub comment with the deterministic placeholder body when no marker exists; writes KV flag", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueCommentsPage.mockResolvedValueOnce([])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "posted", commentId: 999 })
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment.mock.calls[0]![3]).toBe(stubBodyFor())
    expect(store.get(stubFlagKey(args))).toBe("999")
  })

  it("returns failed when create throws; does NOT write KV flag", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueCommentsPage.mockResolvedValueOnce([])
    mockCreateIssueComment.mockRejectedValueOnce(new Error("5xx"))

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("failed")
    expect(store.has(stubFlagKey(args))).toBe(false)
  })

  it("STUB_BODY starts with the sigilix-overview marker so the handler edits it in place", () => {
    expect(STUB_BODY.split("\n")[0]).toBe("<!-- sigilix:pr-overview -->")
    expect(STUB_BODY).toContain("Sigilix is reviewing this pull request...")
    expect(STUB_BODY).toContain("30-90 seconds")
    expect(STUB_BODY).toContain("```text")
  })

  it("SIG-165: quip selection is deterministic per PR number and head SHA", () => {
    expect(STUB_QUIPS.length).toBeGreaterThanOrEqual(12)
    const first = selectPrOverviewStubQuip(args)
    const second = selectPrOverviewStubQuip({ ...args })
    const body = stubBodyFor()

    expect(second).toBe(first)
    expect(body).toContain(first)
    expect(body).toBe(stubBodyFor())
    expect(body).not.toContain("_Reviewing")
  })

  it("SIG-206: ASCII template selection is deterministic and varies by PR head", () => {
    expect(STUB_ASCII_TEMPLATES.length).toBeGreaterThanOrEqual(8)
    const first = selectPrOverviewStubAsciiTemplate(args)
    const second = selectPrOverviewStubAsciiTemplate({ ...args })
    const templates = new Set(
      Array.from({ length: 512 }, (_, i) =>
        selectPrOverviewStubAsciiTemplate({
          ...args,
          headSha: `${String(i).padStart(3, "0")}${"a".repeat(37)}`,
        }),
      ),
    )

    expect(second).toBe(first)
    expect(templates).toEqual(new Set(STUB_ASCII_TEMPLATES))
  })

  it("SIG-206: keeps generated ASCII blocks rectangular for GitHub Markdown", () => {
    for (let i = 0; i < 24; i++) {
      const body = stubBodyFor({
        headSha: `${String(i).padStart(2, "0")}${"b".repeat(38)}`,
      })
      const codeBlock = /```text\n([\s\S]*?)\n```/.exec(body)?.[1]
      expect(codeBlock).toBeDefined()

      const lines = codeBlock!.split("\n")
      const width = lines[0]!.length

      expect(lines.length).toBeGreaterThanOrEqual(5)
      expect(lines.every((line) => line.length === width)).toBe(true)
    }
  })

  it("falls back to creating when the marker-scan throws (best-effort)", async () => {
    const { kv } = makeKvStub()
    mockListIssueCommentsPage.mockRejectedValueOnce(new Error("503"))

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("returns failed when GitHub App env is not configured", async () => {
    const { kv } = makeKvStub()
    const env = { OPENCLAW_STATE: kv } as unknown as Env

    const out = await postPrOverviewStubIfNeeded({ ...args, env })

    expect(out.kind).toBe("failed")
    if (out.kind !== "failed") return
    expect(out.reason).toBe("github-app-not-configured")
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })
})

describe("postPrOverviewStubIfNeeded — idempotency across deliveries", () => {
  it("two deliveries for the SAME (prNumber, headSha) produce exactly one comment", async () => {
    const { kv } = makeKvStub()
    mockListIssueCommentsPage.mockResolvedValueOnce([])

    const first = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })
    const second = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(first.kind).toBe("posted")
    expect(second.kind).toBe("kv-hit")
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
  })

  // SIG-96: on a new headSha that finds a prior COMPLETED summary on
  // the timeline, the helper resolves the existing comment id without
  // erasing the body. The overview job will PATCH in place once it
  // completes; in the meantime the reviewer sees the prior summary.
  it("SIG-96: a NEW headSha finds the prior COMPLETED summary and PRESERVES it (no reset-to-stub)", async () => {
    const { kv } = makeKvStub()
    // First push: creates comment id 100.
    mockListIssueCommentsPage.mockResolvedValueOnce([])
    mockCreateIssueComment.mockResolvedValueOnce({ id: 100 })
    await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    // Second push (new head SHA): KV miss for new key, marker scan
    // finds the prior COMPLETED summary (no `_Reviewing…_` placeholder),
    // SKIPS the reset, returns marker-scan-hit pointing at the existing
    // comment id.
    mockListIssueCommentsPage.mockResolvedValueOnce([
      { id: 100, body: "<!-- sigilix:pr-overview -->\n## Sigilix Overview\n\nPrior head's completed walkthrough." },
    ])
    const newHeadArgs = { ...args, headSha: "n".repeat(40) }

    const out = await postPrOverviewStubIfNeeded({ ...newHeadArgs, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 100 })
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1) // only the first push
    // SIG-96: the second push must NOT clobber the prior summary.
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
  })

  // SIG-96 companion: when the prior body IS the stub (e.g., a previous
  // push timed out before the overview handler rendered the summary),
  // the new push DOES re-write the stub. Idempotent + keeps the
  // SIG-91 timeout-cap path live.
  it("SIG-96: a NEW headSha finds a prior STUB body and re-writes the stub (idempotent)", async () => {
    const { kv } = makeKvStub()
    mockListIssueCommentsPage.mockResolvedValueOnce([])
    mockCreateIssueComment.mockResolvedValueOnce({ id: 200 })
    await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    mockListIssueCommentsPage.mockResolvedValueOnce([
      { id: 200, body: STUB_BODY },
    ])
    const newHeadArgs = { ...args, headSha: "n".repeat(40) }

    const out = await postPrOverviewStubIfNeeded({ ...newHeadArgs, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 200 })
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment.mock.calls[0]![3]).toBe(stubBodyFor({ headSha: newHeadArgs.headSha }))
  })
})

describe("waitForPrOverviewStub — review-side wait gate (Codex Q1)", () => {
  it("returns stub-present immediately when the KV flag is already set (~0ms)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "1234")

    const out = await waitForPrOverviewStub({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("stub-present")
    expect(out.waitedMs).toBe(0)
  })

  it("returns stub-present when the flag arrives mid-poll (Sigilix #6: injected Map state)", async () => {
    // Sigilix #6 fix (PR #104 review): replace mutable counter with
    // an explicit `Map`-backed KV mock + deterministic `sleep` shim
    // that flips the map between polls. The previous test used a
    // `calls >= 3` counter that coupled the test to the helper's
    // call cadence; this version models the real-world arrival
    // event: "after the second sleep, the stub has been written".
    const { kv, store } = makeKvStub()
    const key = stubFlagKey(args)

    let sleepCalls = 0
    const sleep = vi.fn(async () => {
      sleepCalls += 1
      // After the second sleep, the producer (webhook handler) has
      // written the stub. Mutate the injected state directly — no
      // counters, no off-by-one ambiguity.
      if (sleepCalls === 2) {
        store.set(key, "1234")
      }
    })
    // Monotonic clock: advances by pollMs each call. With pollMs=100
    // and the stub arriving after the 2nd sleep, total waited <= 300ms.
    let clock = 0
    const now = (): number => {
      const t = clock
      clock += 100
      return t
    }

    const out = await waitForPrOverviewStub({
      ...args, env: makeEnv(kv), now, sleep, maxMs: 2_000, pollMs: 100,
    })

    expect(out.kind).toBe("stub-present")
    if (out.kind === "stub-present") {
      // Bounded — stub arrived in <500ms, well inside the 2s ceiling.
      expect(out.waitedMs).toBeLessThan(500)
    }
    // Producer wrote the value exactly once, on the 2nd sleep.
    expect(store.get(key)).toBe("1234")
  })

  it("returns stub-absent when the wait ceiling elapses with no flag", async () => {
    const { kv } = makeKvStub()
    const sleep = vi.fn(async () => {})
    // First call = startMs (read 1 fast). Subsequent reads loop until now-start >= maxMs.
    const nowSeq = [0, 100, 200, 500, 1_000, 1_500, 2_100]
    let nowIdx = 0
    const now = (): number => nowSeq[Math.min(nowIdx++, nowSeq.length - 1)]!

    const out = await waitForPrOverviewStub({
      ...args, env: makeEnv(kv), now, sleep, maxMs: 2_000, pollMs: 100,
    })

    expect(out.kind).toBe("stub-absent")
    expect(out.waitedMs).toBeGreaterThanOrEqual(2_000)
  })

  it("returns stub-kv-error when KV throws on the first read; does NOT spin further", async () => {
    const { kv, getMock } = makeKvStub()
    getMock.mockRejectedValueOnce(new Error("kv 5xx"))
    const sleep = vi.fn(async () => {})

    const out = await waitForPrOverviewStub({
      ...args, env: makeEnv(kv), sleep, maxMs: 2_000, pollMs: 100,
    })

    expect(out.kind).toBe("stub-kv-error")
    expect(sleep).not.toHaveBeenCalled()
  })
})

// ─── SIG-91 follow-up: comment-scan short-circuit + cap ─────────────
//
// `findExistingOverviewCommentId` now paginates one page at a time so
// it can short-circuit on the first bilingual marker hit AND cap at
// MAX_COMMENT_SCAN_PAGES pages on pathological PRs (>500 comments).

describe("postPrOverviewStubIfNeeded — marker scan short-circuit + cap (Sigilix round-4)", () => {
  it("short-circuits on the first page when the marker is found (no further page fetches)", async () => {
    const { kv } = makeKvStub()
    // Page 1 is a FULL page (100 items) — without short-circuit the
    // helper would request page 2. With short-circuit it returns
    // after finding the marker on the first item.
    const fullFirstPage = [
      { id: 9001, body: "<!-- sigilix:pr-overview -->\nold walkthrough" },
      ...Array.from({ length: 99 }, (_, i) => ({
        id: 1000 + i,
        body: `some other comment ${i}`,
      })),
    ]
    mockListIssueCommentsPage.mockResolvedValueOnce(fullFirstPage)

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 9001 })
    // Exactly ONE page-fetch — no second-page round trip even though
    // the first page was full (100 items).
    expect(mockListIssueCommentsPage).toHaveBeenCalledOnce()
    expect(mockListIssueCommentsPage.mock.calls[0]![3]).toBe(1)
  })

  it("caps the scan at MAX_COMMENT_SCAN_PAGES pages on a pathological busy PR", async () => {
    const { kv } = makeKvStub()
    // Every page returns 100 unrelated comments (no marker anywhere).
    // The cap MUST stop the scan at MAX_COMMENT_SCAN_PAGES (= 5) so we
    // don't burn an unbounded number of GitHub API round trips.
    const unrelatedPage = Array.from({ length: 100 }, (_, i) => ({
      id: 5000 + i,
      body: `unrelated comment ${i}`,
    }))
    mockListIssueCommentsPage.mockResolvedValue(unrelatedPage)

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    // Treated as "no existing comment" — stub create path runs.
    expect(out.kind).toBe("posted")
    // Exactly 5 page-fetches (the cap); not 6, not 50.
    expect(mockListIssueCommentsPage).toHaveBeenCalledTimes(5)
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("stops paginating after the next page comes back empty (no marker)", async () => {
    const { kv } = makeKvStub()
    // SIG-216 CR fix-up: termination is now `items.length === 0`, not
    // `items.length < per_page`, so a partial first page is followed by
    // ONE additional empty-page fetch — bounded, predictable, and
    // decoupled from listIssueCommentsPage's per_page default.
    const partialPage = Array.from({ length: 50 }, (_, i) => ({
      id: 6000 + i,
      body: `comment ${i}`,
    }))
    mockListIssueCommentsPage
      .mockResolvedValueOnce(partialPage)
      .mockResolvedValueOnce([])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockListIssueCommentsPage).toHaveBeenCalledTimes(2)
    expect(mockListIssueCommentsPage.mock.calls[1]![3]).toBe(2)
  })

  it("terminates after the empty page when the first page is full (no marker)", async () => {
    const { kv } = makeKvStub()
    // SIG-216 CR fix-up regression-pin: a FULL first page followed by
    // an EMPTY second page must terminate the loop after the empty
    // fetch — proves we no longer rely on `items.length < 100` as
    // an end-of-pagination signal. Without this pin a future change
    // back to the per_page-coupled check would pass the suite.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: 7100 + i,
      body: `unrelated comment ${i}`,
    }))
    mockListIssueCommentsPage
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    // Exactly TWO calls — full page, then empty page (terminator).
    // Crucially NOT 5 (the MAX_COMMENT_SCAN_PAGES cap), which would
    // signal the empty-page short-circuit failed to fire.
    expect(mockListIssueCommentsPage).toHaveBeenCalledTimes(2)
    expect(mockListIssueCommentsPage.mock.calls[1]![3]).toBe(2)
  })

  it("finds a marker on a later page when earlier pages don't have it", async () => {
    const { kv } = makeKvStub()
    // Page 1: 100 unrelated comments. Page 2: marker on first item.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 7000 + i,
      body: `noise ${i}`,
    }))
    const page2 = [
      { id: 8001, body: "<!-- sigilix:pr-overview -->\nold walkthrough" },
    ]
    mockListIssueCommentsPage
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 8001 })
    expect(mockListIssueCommentsPage).toHaveBeenCalledTimes(2)
    expect(mockListIssueCommentsPage.mock.calls[1]![3]).toBe(2)
  })
})

// ─── SIG-91 follow-up: GitHub API timeouts ──────────────────────────
//
// The webhook handler awaits `postPrOverviewStubIfNeeded` synchronously.
// If a GitHub API call hangs (createIssueComment / updateIssueComment),
// the webhook would block indefinitely. These tests pin the 10s
// AbortSignal timeout behavior with fake timers.

describe("postPrOverviewStubIfNeeded — GitHub API timeouts (Sigilix round-4)", () => {
  it("returns {kind: 'timeout', phase: 'create'} when createIssueComment hangs past STUB_GITHUB_API_TIMEOUT_MS", async () => {
    vi.useFakeTimers()
    try {
      const { kv, store } = makeKvStub()
      // Create call hangs forever (resolved promise never fires).
      mockCreateIssueComment.mockImplementationOnce(() => new Promise(() => {}))

      const p = postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })
      // Advance past the 10s timer that races against the hung promise.
      await vi.advanceTimersByTimeAsync(STUB_GITHUB_API_TIMEOUT_MS + 100)
      const out = await p

      expect(out).toEqual({ kind: "timeout", phase: "create" })
      // KV flag MUST NOT be written on timeout — review-side wait
      // should fall through to its 2s fallback rather than be told
      // "stub exists" when we can't confirm GitHub accepted the body.
      expect(store.has(stubFlagKey(args))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("returns {kind: 'timeout', phase: 'update'} when updateIssueComment hangs past STUB_GITHUB_API_TIMEOUT_MS", async () => {
    vi.useFakeTimers()
    try {
      const { kv, store } = makeKvStub()
      // SIG-96: existing sticky body must be the stub itself for the
      // update branch to fire. A completed-summary body would short-
      // circuit through the new SIG-96 skip-path and never hit the
      // update call this test pins.
      mockListIssueCommentsPage.mockResolvedValueOnce([
        { id: 4321, body: STUB_BODY },
      ])
      mockUpdateIssueComment.mockImplementationOnce(() => new Promise(() => {}))

      const p = postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })
      await vi.advanceTimersByTimeAsync(STUB_GITHUB_API_TIMEOUT_MS + 100)
      const out = await p

      expect(out).toEqual({ kind: "timeout", phase: "update" })
      // KV flag NOT written on update timeout either — same rationale.
      expect(store.has(stubFlagKey(args))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does NOT trigger the timeout when the create completes well under STUB_GITHUB_API_TIMEOUT_MS", async () => {
    vi.useFakeTimers()
    try {
      const { kv, store } = makeKvStub()
      // Resolve under 1s — well inside the 10s budget.
      mockCreateIssueComment.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ id: 555 }), 500)),
      )

      const p = postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })
      await vi.advanceTimersByTimeAsync(600)
      const out = await p

      expect(out).toEqual({ kind: "posted", commentId: 555 })
      expect(store.get(stubFlagKey(args))).toBe("555")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("postPrOverviewStubIfNeeded — SIG-92 concurrent-delivery short-circuit", () => {
  it("returns kv-hit when an inflight tombstone is present and the leader's flag lands during the poll", async () => {
    vi.useFakeTimers()
    try {
      const { kv, store } = makeKvStub()
      // Simulate a concurrent leader: its tombstone is already in KV,
      // but the final flag hasn't landed yet.
      store.set(stubInflightKey(args), "leader-uuid-abc")

      const promise = postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

      // Advance one poll tick; flag isn't there yet → keep polling.
      await vi.advanceTimersByTimeAsync(300)
      // Leader finishes its create + writes the final flag.
      store.set(stubFlagKey(args), "12345")
      // Next poll tick — should observe the flag and return.
      await vi.advanceTimersByTimeAsync(300)

      const out = await promise
      expect(out).toEqual({ kind: "kv-hit", commentId: 12345 })
      // Loser must NOT have created its own comment.
      expect(mockCreateIssueComment).not.toHaveBeenCalled()
      expect(mockUpdateIssueComment).not.toHaveBeenCalled()
      // Loser must NOT have run a marker scan (short-circuited before).
      expect(mockListIssueCommentsPage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("falls through to create when the poll times out (~3s) without seeing the leader's flag", async () => {
    vi.useFakeTimers()
    try {
      const { kv, store } = makeKvStub()
      store.set(stubInflightKey(args), "leader-uuid-stuck")

      const promise = postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })
      // 5 attempts × 300ms = 1500ms ceiling (tightened post-PR-review
      // to stay under GitHub's ~10s webhook redelivery budget when
      // stacked on top of the 10s create-call timeout). Advance past it.
      await vi.advanceTimersByTimeAsync(2000)

      const out = await promise
      // Leader stalled / failed → loser falls through and creates.
      expect(out).toEqual({ kind: "posted", commentId: 999 })
      expect(mockCreateIssueComment).toHaveBeenCalledOnce()
      // Loser also wrote the final flag so any third delivery sees it.
      expect(store.get(stubFlagKey(args))).toBe("999")
    } finally {
      vi.useRealTimers()
    }
  })

  it("writes its own inflight tombstone before proceeding (no prior leader)", async () => {
    const { kv, store, putMock } = makeKvStub()
    // No prior inflight, no prior flag → normal create path.
    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "posted", commentId: 999 })
    // Tombstone written before create — a later delivery would see it.
    expect(store.has(stubInflightKey(args))).toBe(true)
    // The tombstone put was called with a TTL of 60s.
    const tombstonePut = putMock.mock.calls.find(
      (c) => c[0] === stubInflightKey(args),
    )
    expect(tombstonePut).toBeDefined()
    expect(tombstonePut?.[2]).toEqual(
      expect.objectContaining({ expirationTtl: 60 }),
    )
  })

  it("swallows a KV read failure on the inflight key and proceeds normally", async () => {
    // Custom KV stub that throws on the inflight key read only.
    const store = new Map<string, string>()
    const kv = {
      get: vi.fn(async (key: string): Promise<string | null> => {
        if (key.startsWith("pr-overview-stub-inflight:")) {
          throw new Error("KV down")
        }
        return store.get(key) ?? null
      }),
      put: vi.fn(async (key: string, value: string): Promise<void> => {
        store.set(key, value)
      }),
      delete: vi.fn(async (key: string): Promise<void> => {
        store.delete(key)
      }),
    } as unknown as Env["OPENCLAW_STATE"]

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })
    expect(out).toEqual({ kind: "posted", commentId: 999 })
  })
})

describe("isStubBody (SIG-96)", () => {
  it("returns true for the exact STUB_BODY string", () => {
    expect(isStubBody(STUB_BODY)).toBe(true)
  })

  it("returns true for stub body with surrounding whitespace (trim-tolerant)", () => {
    expect(isStubBody(`\n\n${STUB_BODY}\n\n`)).toBe(true)
  })

  it("returns true for the legacy openclaw stub variant", () => {
    expect(isStubBody("<!-- openclaw:pr-overview -->\n\n## Sigilix Overview\n\n_Reviewing…_")).toBe(true)
  })

  it("returns true for the ASCII fallback variant `_Reviewing..._`", () => {
    expect(isStubBody("<!-- sigilix:pr-overview -->\n\n## Sigilix Overview\n\n_Reviewing..._")).toBe(true)
  })

  it("returns true for the legacy openclaw + ASCII ellipsis combination", () => {
    expect(isStubBody("<!-- openclaw:pr-overview -->\n\n## Sigilix Overview\n\n_Reviewing..._")).toBe(true)
  })

  it("returns false for a real completed summary body", () => {
    const completed = [
      "<!-- sigilix:pr-overview -->",
      "",
      "## Sigilix Overview",
      "",
      "### Summary — latest push",
      "",
      "This push refactors the authentication layer to use JWT tokens.",
      "",
      "### Important files",
      "",
      "| File | Score | Notes |",
      "| --- | :---: | --- |",
      "| `src/auth.ts` | 4/5 | Core JWT signing/verifying logic |",
    ].join("\n")
    expect(isStubBody(completed)).toBe(false)
  })

  // CodeRabbit catch on PR #111 (Major): the previous substring match
  // would classify a real summary that quotes `_Reviewing…_` (e.g.,
  // a Sigilix-reviews-its-own-PR meta-block) as a stub, clobbering
  // exactly the summary SIG-96 was meant to preserve. Whole-body
  // match prevents this.
  it("CR catch: returns false when a completed summary embeds the stub placeholder verbatim", () => {
    const reviewingItself = [
      "<!-- sigilix:pr-overview -->",
      "",
      "## Sigilix Overview",
      "",
      "### Summary",
      "",
      "This PR introduces the `_Reviewing…_` stub fix. Pre-fix, every push reset the body to `_Reviewing…_`.",
    ].join("\n")
    expect(isStubBody(reviewingItself)).toBe(false)
  })

  it("returns false for null / undefined / non-string (semantics: 'this body is not the stub placeholder')", () => {
    expect(isStubBody(null)).toBe(false)
    expect(isStubBody(undefined)).toBe(false)
    // @ts-expect-error — runtime guard against non-string
    expect(isStubBody(42)).toBe(false)
  })

  it("returns false for an empty string", () => {
    expect(isStubBody("")).toBe(false)
  })

  it("returns false when the body mentions `Reviewing` outside the stub-pattern context", () => {
    const proseSummary = "<!-- sigilix:pr-overview -->\n\n## Sigilix Overview\n\nReviewing the auth changes uncovered three risks."
    expect(isStubBody(proseSummary)).toBe(false)
  })

  it("returns false when the body has the stub format PLUS appended content (partial-render race)", () => {
    // If the overview job rendered partial content before erroring,
    // we should NOT treat that as a stub — preserve whatever is there.
    const partialAppend = `${STUB_BODY}\n\n### Summary\n\nMid-render content.`
    expect(isStubBody(partialAppend)).toBe(false)
  })
})
