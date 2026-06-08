// ARC-258 — tests for the dispatcher-level "Sigilix Review" check
// run lifecycle helper. Two entry points:
//   - `startInProgressCheckRun`: creates the in_progress check;
//     returns a handle, or `null` on creds-missing / 403 / failure.
//   - `completeCheckRun`: transitions a handle to completed with
//     `success` | `failure` | `skipped`. No-op when handle is null.
//
// All behavior is best-effort — these helpers must NOT throw out of
// the dispatcher even on permission misconfigurations.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockCreateCheckRun,
  mockUpdateCheckRun,
  mockListCheckRunsForRef,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockCreateCheckRun: vi.fn(),
  mockUpdateCheckRun: vi.fn(),
  mockListCheckRunsForRef: vi.fn(),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async createCheckRun(...args: unknown[]): Promise<unknown> {
      return mockCreateCheckRun(...args)
    }
    async updateCheckRun(...args: unknown[]): Promise<unknown> {
      return mockUpdateCheckRun(...args)
    }
    async listCheckRunsForRef(...args: unknown[]): Promise<unknown> {
      return mockListCheckRunsForRef(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import {
  CHECK_RUN_NAME,
  attachExistingCheckRun,
  closeOrphanedInProgressChecksByHeadSha,
  completeCheckRun,
  startInProgressCheckRun,
} from "../src/lib/pr-review-check-run"
import { GitHubHttpError, type CheckRunAnnotation } from "../src/lib/github"
import type { Env } from "../src/index"

function makeEnv(opts: { credentials?: boolean } = {}): Env {
  const haveCreds = opts.credentials ?? true
  return {
    OPENCLAW_STATE: {
      async get(): Promise<string | null> { return null },
      async put(): Promise<void> { /* no-op */ },
      async delete(): Promise<void> { /* no-op */ },
    },
    GITHUB_APP_ID: haveCreds ? "12345" : undefined,
    GITHUB_PRIVATE_KEY: haveCreds ? "fake-key" : undefined,
  } as unknown as Env
}

const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  headSha: "a".repeat(40),
  installationId: 99,
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockCreateCheckRun.mockReset()
  mockUpdateCheckRun.mockReset()
  mockListCheckRunsForRef.mockReset().mockResolvedValue([]) // default: no stale checks
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("startInProgressCheckRun", () => {
  it("creates the check run and returns a handle on the happy path", async () => {
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle).not.toBeNull()
    expect(handle!.id).toBe(7777)
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
    const [owner, repo, payload] = mockCreateCheckRun.mock.calls[0]!
    expect(owner).toBe("Arc-and-Anchor")
    expect(repo).toBe("sigilix")
    expect((payload as { name: string }).name).toBe(CHECK_RUN_NAME)
    expect((payload as { headSha: string }).headSha).toBe(baseArgs.headSha)
    expect((payload as { status: string }).status).toBe("in_progress")
  })

  it("returns null (no throw) when credentials are missing", async () => {
    const env = makeEnv({ credentials: false })
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle).toBeNull()
    expect(mockCreateCheckRun).not.toHaveBeenCalled()
  })

  it("returns null (no throw) when createCheckRun 403s — App missing `checks: write`", async () => {
    mockCreateCheckRun.mockRejectedValue(new Error("HTTP 403 Resource not accessible by integration"))
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle).toBeNull()
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
  })
})

// SIG-220: direct unit coverage for the new `attachExistingCheckRun`
// helper. The DO + dispatcher integration tests mock this function
// out, so its real error paths (missing creds, token-acquisition
// failure) would otherwise ride along untested. These exercises pin
// the contract: ALL failure modes return null (never throw), and the
// happy path returns a handle pointing at the threaded checkRunId.
describe("SIG-220: attachExistingCheckRun", () => {
  const attachBaseArgs = {
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    installationId: 99,
    checkRunId: 4242,
  }

  it("returns a handle carrying the threaded checkRunId on the happy path", async () => {
    const env = makeEnv()
    const handle = await attachExistingCheckRun({ env, ...attachBaseArgs })

    expect(handle).not.toBeNull()
    expect(handle!.id).toBe(4242)
    expect(handle!.owner).toBe("Arc-and-Anchor")
    expect(handle!.repo).toBe("sigilix")
    // Token acquisition is the only side effect — no createCheckRun
    // call, no listCheckRuns; we're attaching, not creating.
    expect(mockGetInstallationToken).toHaveBeenCalledTimes(1)
    expect(mockCreateCheckRun).not.toHaveBeenCalled()
    expect(mockListCheckRunsForRef).not.toHaveBeenCalled()
  })

  it("returns null (no throw) when credentials are missing — dispatcher fallback covers this", async () => {
    const env = makeEnv({ credentials: false })
    const handle = await attachExistingCheckRun({ env, ...attachBaseArgs })

    expect(handle).toBeNull()
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
  })

  it("returns null (no throw) when getInstallationToken rejects — best-effort contract", async () => {
    mockGetInstallationToken.mockRejectedValueOnce(new Error("HTTP 503 token endpoint down"))
    const env = makeEnv()
    const handle = await attachExistingCheckRun({ env, ...attachBaseArgs })

    expect(handle).toBeNull()
    expect(mockGetInstallationToken).toHaveBeenCalledTimes(1)
    expect(mockCreateCheckRun).not.toHaveBeenCalled()
  })

  it("returns null (no throw) on any other createCheckRun failure", async () => {
    mockCreateCheckRun.mockRejectedValue(new Error("HTTP 502 Bad Gateway"))
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle).toBeNull()
  })

  // Founder caught this on PR #80: two in-progress checks showed up
  // on the same head_sha after a rename-deploy ("Sigilix Review"
  // from old code + "Sigilix" from new code). Going forward we
  // self-clean: list existing Sigilix-named in-progress checks on
  // this head_sha and cancel them before creating the new one.
  // Handles both rename-switchovers AND queue-retry duplicates.
  it("cancels stale in-progress Sigilix checks on the same head_sha before creating a new one", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 111, name: "Sigilix Review", status: "in_progress" }, // legacy name
      { id: 222, name: "Sigilix", status: "queued" },              // current name, queued
      { id: 333, name: "Sigilix", status: "completed" },           // current name, completed → no cancel
      { id: 444, name: "Workers Builds: sigilix", status: "in_progress" }, // unrelated → no cancel
    ])
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 999 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    // 2 stale checks cancelled, 1 new check created.
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    const cancelledIds = mockUpdateCheckRun.mock.calls.map((c) => c[2])
    expect(cancelledIds.sort()).toEqual([111, 222])
    for (const call of mockUpdateCheckRun.mock.calls) {
      expect((call[3] as { status: string }).status).toBe("completed")
      expect((call[3] as { conclusion: string }).conclusion).toBe("cancelled")
    }
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
    expect(handle!.id).toBe(999)
  })

  it("skips cleanup early when no stale Sigilix checks are present (no PATCHes issued)", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 444, name: "Workers Builds: sigilix", status: "in_progress" },
      { id: 555, name: "Some other check", status: "in_progress" },
    ])
    mockCreateCheckRun.mockResolvedValue({ id: 999 })
    const env = makeEnv()
    await startInProgressCheckRun({ env, ...baseArgs })

    expect(mockUpdateCheckRun).not.toHaveBeenCalled()
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
  })

  it("proceeds with create even if the list call fails (best-effort cleanup)", async () => {
    mockListCheckRunsForRef.mockRejectedValue(new Error("HTTP 502"))
    mockCreateCheckRun.mockResolvedValue({ id: 999 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle!.id).toBe(999)
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
  })

  it("proceeds with create even if a per-check cancel PATCH fails (isolated retry would orphan, but cleanup is best-effort)", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 111, name: "Sigilix Review", status: "in_progress" },
    ])
    mockUpdateCheckRun.mockRejectedValue(new Error("HTTP 422 Validation Failed"))
    mockCreateCheckRun.mockResolvedValue({ id: 999 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    expect(handle!.id).toBe(999)
    expect(mockCreateCheckRun).toHaveBeenCalledTimes(1)
  })
})

// SIG-stuck-check (PR #402): the DO's cancel + watchdog-terminal paths
// close the in-progress check via `attachExistingCheckRun` ONLY when they
// hold a `checkRunId`. That id is absent whenever `handleEnqueue`'s
// synchronous create lost its 3s race and the consumer created the check
// instead — so the close was silently skipped and the check hung
// `in_progress` forever. `closeOrphanedInProgressChecksByHeadSha` is the
// id-less fallback: it builds an installation-scoped client (exactly like
// attachExistingCheckRun) and closes any Sigilix-named in_progress/queued
// check on the head SHA. These exercises pin the contract: it closes the
// orphan with status:completed + a terminal conclusion, honors the
// title/summary override, and is best-effort (creds-missing / token / list
// failures never throw).
describe("SIG-stuck-check: closeOrphanedInProgressChecksByHeadSha", () => {
  const orphanArgs = {
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    installationId: 99,
    headSha: "a".repeat(40),
  }

  it("closes a head's in-progress Sigilix check with status:completed + a terminal conclusion", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 111, name: "Sigilix", status: "in_progress" },
      { id: 222, name: "Sigilix Review", status: "queued" }, // legacy name, queued → also closed
      { id: 333, name: "Sigilix", status: "completed" },      // already done → untouched
      { id: 444, name: "Workers Builds: sigilix", status: "in_progress" }, // unrelated → untouched
    ])
    mockUpdateCheckRun.mockResolvedValue(undefined)
    const env = makeEnv()

    await closeOrphanedInProgressChecksByHeadSha({ env, ...orphanArgs })

    // The client was built from an installation token (the DO path).
    expect(mockGetInstallationToken).toHaveBeenCalledTimes(1)
    // Only the two Sigilix-named, not-yet-completed checks are closed.
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    const closedIds = mockUpdateCheckRun.mock.calls.map((c) => c[2])
    expect(closedIds.sort((a, b) => (a as number) - (b as number))).toEqual([111, 222])
    for (const call of mockUpdateCheckRun.mock.calls) {
      const payload = call[3] as { status: string; conclusion: string }
      expect(payload.status).toBe("completed")
      expect(payload.conclusion).toBe("cancelled") // GitHub-terminal conclusion
    }
    expect(mockListCheckRunsForRef).toHaveBeenCalledWith("Arc-and-Anchor", "sigilix", orphanArgs.headSha)
  })

  it("applies the title/summary/conclusion override on the closed orphan (watchdog → timed_out)", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 111, name: "Sigilix", status: "in_progress" },
    ])
    mockUpdateCheckRun.mockResolvedValue(undefined)
    const env = makeEnv()

    await closeOrphanedInProgressChecksByHeadSha({
      env, ...orphanArgs, title: "Timed out", summary: "Sigilix did not finish in time.",
      conclusion: "timed_out",
    })

    const payload = mockUpdateCheckRun.mock.calls[0]![3] as { conclusion: string; output: { title: string; summary: string } }
    expect(payload.output.title).toBe("Timed out")
    expect(payload.output.summary).toBe("Sigilix did not finish in time.")
    // conclusion must match the title — the believability nit code-reviewer flagged.
    expect(payload.conclusion).toBe("timed_out")
  })

  it("no-ops (no token, no PATCH) when nothing on the head is a stale Sigilix check", async () => {
    mockListCheckRunsForRef.mockResolvedValue([
      { id: 333, name: "Sigilix", status: "completed" },
      { id: 444, name: "Workers Builds: sigilix", status: "in_progress" },
    ])
    const env = makeEnv()

    await closeOrphanedInProgressChecksByHeadSha({ env, ...orphanArgs })
    expect(mockUpdateCheckRun).not.toHaveBeenCalled()
  })

  it("returns (no throw, no token) when credentials are missing", async () => {
    const env = makeEnv({ credentials: false })

    await expect(
      closeOrphanedInProgressChecksByHeadSha({ env, ...orphanArgs }),
    ).resolves.toBeUndefined()
    expect(mockGetInstallationToken).not.toHaveBeenCalled()
    expect(mockListCheckRunsForRef).not.toHaveBeenCalled()
    expect(mockUpdateCheckRun).not.toHaveBeenCalled()
  })

  it("returns (no throw) when getInstallationToken rejects — best-effort contract", async () => {
    mockGetInstallationToken.mockRejectedValueOnce(new Error("HTTP 503 token endpoint down"))
    const env = makeEnv()

    await expect(
      closeOrphanedInProgressChecksByHeadSha({ env, ...orphanArgs }),
    ).resolves.toBeUndefined()
    expect(mockListCheckRunsForRef).not.toHaveBeenCalled()
  })

  it("returns (no throw) when listing the head's check runs fails", async () => {
    mockListCheckRunsForRef.mockRejectedValue(new Error("HTTP 502"))
    const env = makeEnv()

    await expect(
      closeOrphanedInProgressChecksByHeadSha({ env, ...orphanArgs }),
    ).resolves.toBeUndefined()
    expect(mockUpdateCheckRun).not.toHaveBeenCalled()
  })
})

describe("completeCheckRun", () => {
  it("no-ops when handle is null (creation was skipped or failed)", async () => {
    await completeCheckRun({ handle: null, conclusion: "success" })
    expect(mockUpdateCheckRun).not.toHaveBeenCalled()
  })

  // SIG-216 follow-up (founder feedback on PR #176, 2026-05-25 +
  // Kimi K2.6 sign-off): success internal signal → wire `success`
  // (green check). Check run signals EXECUTION HEALTH, not findings
  // count. Industry convention (CodeRabbit, Greptile); review state
  // lives in the GitHub native review object.
  it("transitions to completed with `success` conclusion and customer-facing output copy", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({ handle, conclusion: "success" })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1)
    const [owner, repo, checkRunId, payload] = mockUpdateCheckRun.mock.calls[0]!
    expect(owner).toBe("Arc-and-Anchor")
    expect(repo).toBe("sigilix")
    expect(checkRunId).toBe(7777)
    const p = payload as { status: string; conclusion: string; output: { title: string; summary: string } }
    expect(p.status).toBe("completed")
    expect(p.conclusion).toBe("success")
    expect(p.output.title).toBe("Review posted")
  })

  // SIG-144: with the DEFAULT surface (`comments`, i.e. `surface`
  // unset), annotations stay dark — exactly the SIG-216 behavior.
  // Even when the ensemble threads `checkAnnotations` on reviewMeta,
  // only the single completion PATCH fires.
  it("does NOT post annotations when surface is unset/comments (SIG-216 default preserved)", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })
    const annotations = Array.from({ length: 51 }, (_, i) => ({
      path: "src/app.ts",
      start_line: i + 1,
      end_line: i + 1,
      annotation_level: "warning" as const,
      title: `[P2] finding ${i + 1}`,
      message: "Body-only finding",
    }))

    await completeCheckRun({
      handle,
      conclusion: "success",
      // surface omitted → defaults to "comments"
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 51,
        checkAnnotations: annotations,
      },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1)
    const completionPayload = mockUpdateCheckRun.mock.calls[0]![3] as { status: string; output: { annotations?: unknown[] } }
    expect(completionPayload.status).toBe("completed")
    expect(completionPayload.output.annotations).toBeUndefined()
  })

  // SIG-216 follow-up (PR #176): skipped internal signal → wire
  // `neutral` (legit ambiguous "bot couldn't review" state). Title
  // still differentiates so customers see "Review skipped (stale
  // head)" in the Checks tab.
  it("emits the stale-head title with `neutral` conclusion for stale-head dispatcher signal", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({ handle, conclusion: "skipped" })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { conclusion: string; output: { title: string; summary: string } }
    expect(p.conclusion).toBe("neutral")
    expect(p.output.title).toContain("stale head")
  })

  // SIG-216 follow-up (PR #176): failure internal signal → wire
  // `neutral` (bot errored = ambiguous, not a hard gate). Title
  // renders "Review failed" for diagnostic visibility; reserve wire
  // `failure` for future opt-in P0 gates.
  it("emits the `failed` title with `neutral` conclusion on the error path", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({ handle, conclusion: "failure" })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { conclusion: string; output: { title: string } }
    expect(p.conclusion).toBe("neutral")
    expect(p.output.title).toContain("failed")
  })

  it("swallows updateCheckRun failures (best-effort — dispatcher must not crash)", async () => {
    mockUpdateCheckRun.mockRejectedValue(new Error("HTTP 422 Validation Failed"))
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    // Should NOT throw — the underlying review has already posted
    // (or failed) by this point and a check-update failure shouldn't
    // bubble up and corrupt the dispatcher.
    await expect(completeCheckRun({ handle, conclusion: "success" })).resolves.toBeUndefined()
  })

  // ARC-276 + SIG-216: when the dispatcher threads `reviewMeta`, the
  // Check Run title reflects the verdict directly. SIG-216 collapsed
  // the summary to the Greptile-direction one-liner; the
  // "APPROVE"/"REQUEST_CHANGES"/"COMMENT" verb is no longer in the
  // summary text but the title still distinguishes verdicts.
  it("renders the APPROVE title + `Sigilix approved` summary when reviewMeta says APPROVE + 0 findings", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      reviewMeta: { event: "APPROVE", findingsCount: 0, prNumber: 42 },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { title: string; summary: string } }
    expect(p.output.title).toBe("Approved — no issues found")
    expect(p.output.summary).toBe(
      "Sigilix approved · [View PR](https://github.com/Arc-and-Anchor/sigilix/pull/42)",
    )
  })

  it("renders the REQUEST_CHANGES title + Greptile-direction findings summary when reviewMeta says REQUEST_CHANGES", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 3, prNumber: 42 },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { title: string; summary: string } }
    expect(p.output.title).toBe("3 findings — changes requested")
    expect(p.output.summary).toBe(
      "3 suggestions · [View review](https://github.com/Arc-and-Anchor/sigilix/pull/42)",
    )
  })

  it("renders the COMMENT title + Greptile-direction findings summary with non-blocking count", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      reviewMeta: { event: "COMMENT", findingsCount: 2, prNumber: 42 },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { title: string; summary: string } }
    expect(p.output.title).toBe("2 non-blocking findings posted")
    expect(p.output.summary).toBe(
      "2 suggestions · [View review](https://github.com/Arc-and-Anchor/sigilix/pull/42)",
    )
  })

  it("singularizes the title and summary when REQUEST_CHANGES has exactly 1 finding", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 1, prNumber: 42 },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { title: string; summary: string } }
    expect(p.output.title).toBe("1 finding — changes requested")
    // SIG-216: singular "suggestion" in the Greptile-direction summary too.
    expect(p.output.summary).toBe(
      "1 suggestion · [View review](https://github.com/Arc-and-Anchor/sigilix/pull/42)",
    )
  })

  // SIG-216: when no prNumber is threaded (legacy producer that
  // hasn't been updated), the summary degrades gracefully to a
  // link-less form rather than producing a broken markdown link.
  it("falls back to the link-less summary form when reviewMeta lacks `prNumber`", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 2 },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { summary: string } }
    expect(p.output.summary).toBe("2 suggestions")
  })

  // SIG-184: runner-evidence trust pill. When the ensemble threads
  // `runnerEvidence`, the summary appends the VERIFIED/PENDING badge `<img>`;
  // the title is never touched (Kimi spec). Absent → byte-identical summary.
  it("appends the VERIFIED runner pill to the APPROVE summary, leaving the title untouched", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      reviewMeta: { event: "APPROVE", findingsCount: 0, prNumber: 42, runnerEvidence: "verified" },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { title: string; summary: string } }
    expect(p.output.title).toBe("Approved — no issues found") // title NOT decorated
    expect(p.output.summary).toBe(
      "Sigilix approved · [View PR](https://github.com/Arc-and-Anchor/sigilix/pull/42)" +
        ' · <img src="https://raw.githubusercontent.com/Sigilix/sigilix-glyphs/v20260531-1/runner-verified.svg" alt="Runner verified: GitHub-signed receipt attests provenance">',
    )
  })

  it("appends the PENDING runner pill to a findings summary", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 3, prNumber: 42, runnerEvidence: "evidence-pending" },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { summary: string } }
    expect(p.output.summary).toBe(
      "3 suggestions · [View review](https://github.com/Arc-and-Anchor/sigilix/pull/42)" +
        ' · <img src="https://raw.githubusercontent.com/Sigilix/sigilix-glyphs/v20260531-1/runner-pending.svg" alt="Runner evidence pending: receipt expected">',
    )
  })

  it("renders NO runner pill when runnerEvidence is omitted (runner-absent — the default)", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      reviewMeta: { event: "APPROVE", findingsCount: 0, prNumber: 42 },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { summary: string } }
    expect(p.output.summary).toBe(
      "Sigilix approved · [View PR](https://github.com/Arc-and-Anchor/sigilix/pull/42)",
    )
    expect(p.output.summary).not.toContain("<img")
  })

  it("falls back to the generic 'Review posted' title when reviewMeta is omitted on success", async () => {
    // Legacy callers + dedupe-hit skip paths don't carry reviewMeta.
    // The generic copy is the right surface for "we don't know what
    // the review verdict was, but the check needs to complete."
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({ handle, conclusion: "success" })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { title: string } }
    expect(p.output.title).toBe("Review posted")
  })

  // ARC-279: when the ensemble's comment-fallback fires, the
  // dispatcher maps `posted` + `surface: "comment"` to conclusion
  // `"failure"` with the reviewMeta still carrying surface info.
  // The Check Run title points the user at the PR comment instead
  // of saying the bot was silent.
  it("renders 'Couldn't post review — see PR comment' on failure when reviewMeta.surface === 'comment'", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "failure",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 2, surface: "comment" },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { conclusion: string; output: { title: string; summary: string } }
    // SIG-216 follow-up (PR #176): failure internal signal → wire
    // `neutral`; title + summary carry the diagnostic surface info.
    expect(p.conclusion).toBe("neutral")
    expect(p.output.title).toBe("Couldn't post review — see PR comment")
    expect(p.output.summary).toContain("GitHub silently rejected")
    expect(p.output.summary).toContain("PR comment")
  })

  it("renders the generic 'Review failed' title on failure when reviewMeta is omitted", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({ handle, conclusion: "failure" })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { output: { title: string } }
    expect(p.output.title).toBe("Review failed")
  })

  // ARC-280 follow-up: skip-notice path → distinct title pointing
  // the user at the PR comment that explains what failed.
  it("renders 'Couldn't review — see PR comment' on failure when reviewMeta.surface === 'skip-notice'", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "failure",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 0, surface: "skip-notice" },
    })

    const [, , , payload] = mockUpdateCheckRun.mock.calls[0]!
    const p = payload as { conclusion: string; output: { title: string; summary: string } }
    // SIG-216 follow-up (PR #176): failure internal signal → wire
    // `neutral`; title + summary carry the diagnostic surface info.
    expect(p.conclusion).toBe("neutral")
    expect(p.output.title).toBe("Couldn't review — see PR comment")
    expect(p.output.summary).toContain("couldn't generate a model review")
    expect(p.output.summary).toContain("PR comment")
  })
})

// ───────────────────────── SIG-144 ─────────────────────────
// GitHub Checks annotations as a configurable second output surface.

describe("SIG-144: completeCheckRun annotation posting", () => {
  function makeAnnotations(n: number): CheckRunAnnotation[] {
    return Array.from({ length: n }, (_, i) => ({
      path: "src/app.ts",
      start_line: i + 1,
      end_line: i + 1,
      annotation_level: "warning" as const,
      title: `[P2] finding ${i + 1}`,
      message: "**Body** finding",
    }))
  }

  it("posts annotations in ≤50 batches when surface=both (51 → completion + 2 batches)", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      surface: "both",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 51, prNumber: 5, checkAnnotations: makeAnnotations(51) },
    })

    // 1 completion PATCH (no annotations) + 2 annotation batches (50 + 1)
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(3)
    const completion = mockUpdateCheckRun.mock.calls[0]![3] as { status: string; output: { annotations?: unknown[] } }
    expect(completion.status).toBe("completed")
    expect(completion.output.annotations).toBeUndefined()

    const b1 = mockUpdateCheckRun.mock.calls[1]![3] as { output: { title: string; summary: string; annotations: CheckRunAnnotation[] } }
    const b2 = mockUpdateCheckRun.mock.calls[2]![3] as { output: { summary: string; annotations: CheckRunAnnotation[] } }
    expect(b1.output.annotations).toHaveLength(50) // GitHub's per-request cap
    expect(b2.output.annotations).toHaveLength(1)
    // GitHub's Update-a-check-run schema requires `output.summary` whenever an
    // `output` object is sent with annotations — on EVERY follow-up batch, not
    // just the first (CodeRabbit, PR #339). `title` is optional but we send it.
    expect(typeof b1.output.title).toBe("string")
    expect(typeof b1.output.summary).toBe("string")
    expect(typeof b2.output.summary).toBe("string")
    // plain-text sanitization applied to the posted annotation message
    expect(b1.output.annotations[0]!.message).toBe("Body finding")
  })

  it("posts annotations when surface=annotations", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      surface: "annotations",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 2, checkAnnotations: makeAnnotations(2) },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2) // completion + 1 batch
  })

  it("does NOT post annotations on a non-success conclusion even when surface=both", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "skipped",
      surface: "both",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 2, checkAnnotations: makeAnnotations(2) },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1) // completion only
  })

  it("pre-filters annotations GitHub would reject (bad path / line range)", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })
    const annotations: CheckRunAnnotation[] = [
      { path: "src/app.ts", start_line: 5, end_line: 5, annotation_level: "warning", message: "ok" },
      { path: "src/app.ts", start_line: 0, end_line: 0, annotation_level: "warning", message: "bad line" },
      { path: "", start_line: 3, end_line: 3, annotation_level: "warning", message: "no path" },
      { path: "src/app.ts", start_line: 9, end_line: 2, annotation_level: "warning", message: "end<start" },
    ]

    await completeCheckRun({
      handle,
      conclusion: "success",
      surface: "both",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 4, checkAnnotations: annotations },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2) // completion + 1 batch (1 survivor)
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as { output: { annotations: CheckRunAnnotation[] } }
    expect(batch.output.annotations).toHaveLength(1)
    expect(batch.output.annotations[0]!.message).toBe("ok")
  })

  it("drops only the offending annotation when a batch is 422-rejected (graceful degradation)", async () => {
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    // completion (no annotations) ok; the multi-annotation batch 422s
    // (one stale line poisoned it); the per-annotation retry re-posts
    // survivors and drops the stale one.
    mockUpdateCheckRun.mockImplementation(async (...a: unknown[]) => {
      const payload = a[3] as { output?: { annotations?: CheckRunAnnotation[] } }
      const ann = payload.output?.annotations
      if (!ann) return undefined // completion PATCH
      if (ann.length > 1) throw new GitHubHttpError(422, "invalid annotation in batch")
      if (ann[0]!.start_line === 999) throw new GitHubHttpError(422, "line out of range")
      return undefined
    })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })
    const annotations: CheckRunAnnotation[] = [
      { path: "src/a.ts", start_line: 1, end_line: 1, annotation_level: "warning", message: "good 1" },
      { path: "src/a.ts", start_line: 999, end_line: 999, annotation_level: "failure", message: "stale" },
      { path: "src/a.ts", start_line: 3, end_line: 3, annotation_level: "warning", message: "good 2" },
    ]

    await completeCheckRun({
      handle,
      conclusion: "success",
      surface: "both",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 3, checkAnnotations: annotations },
    })

    // completion(1) + failed batch(1) + 3 single-annotation retries = 5
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(5)
    // CodeRabbit nit (PR #339): pin that the retries are single-annotation
    // PATCHes carrying exactly the batch's annotations — the drop-the-
    // offender contract, not just the call count. A regression that
    // re-posted the stale one or dropped a good one would surface here.
    const retryPayloads = mockUpdateCheckRun.mock.calls
      .slice(2)
      .map((c) => (c[3] as { output: { annotations: CheckRunAnnotation[] } }).output.annotations)
    expect(retryPayloads.every((a) => a.length === 1)).toBe(true)
    expect(retryPayloads.map((a) => a[0]!.message)).toEqual(["good 1", "stale", "good 2"])
  })

  it("does NOT retry per-annotation on a transient (non-422) batch error — duplication guard", async () => {
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    // GitHub APPENDS annotations across PATCHes, so a blind retry after a
    // 5xx/timeout (where the write may have landed) could duplicate. Only
    // 422 (atomic reject → nothing stored) is safe to retry.
    mockUpdateCheckRun.mockImplementation(async (...a: unknown[]) => {
      const payload = a[3] as { output?: { annotations?: CheckRunAnnotation[] } }
      if (!payload.output?.annotations) return undefined // completion
      throw new GitHubHttpError(503, "service unavailable")
    })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      surface: "both",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 3, checkAnnotations: makeAnnotations(3) },
    })

    // completion(1) + the single failed batch(1) — NO per-annotation retries
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
  })

  it("never throws when annotation posting fails entirely (best-effort)", async () => {
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    mockUpdateCheckRun.mockImplementation(async (...a: unknown[]) => {
      const payload = a[3] as { output?: { annotations?: CheckRunAnnotation[] } }
      if (payload.output?.annotations) throw new GitHubHttpError(422, "bad")
      return undefined // completion succeeds
    })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await expect(completeCheckRun({
      handle,
      conclusion: "success",
      surface: "both",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 1, checkAnnotations: makeAnnotations(1) },
    })).resolves.toBeUndefined()
  })
})

// ───────────────────────── SIG-171 ─────────────────────────
// Deterministic SARIF/RDF/linter Lane A annotations are scanner-derived, not
// model-authored review comments. They post independently from the LLM annotation
// output surface and survive LLM degradation paths once the scan has run.

describe("SIG-171: deterministic Check annotations", () => {
  const deterministic: CheckRunAnnotation[] = [
    {
      path: "src/app.ts",
      start_line: 7,
      end_line: 7,
      annotation_level: "failure",
      title: "[SARIF error] Semgrep: no-eval",
      message: "Avoid eval.",
    },
  ]

  const model: CheckRunAnnotation[] = [
    {
      path: "src/model.ts",
      start_line: 9,
      end_line: 9,
      annotation_level: "warning",
      title: "[P2] logic: model finding",
      message: "Model-authored finding.",
    },
  ]

  it("posts deterministic annotations even when review surface defaults to comments", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      // surface omitted -> comments, so model annotations are still gated off.
      reviewMeta: {
        event: "APPROVE",
        findingsCount: 0,
        prNumber: 5,
        checkAnnotations: model,
        deterministicCheckAnnotations: deterministic,
      },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    const completion = mockUpdateCheckRun.mock.calls[0]![3] as { output: { summary: string } }
    expect(completion.output.summary).toContain("1 scanner diagnostic from deterministic analysis")
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as { output: { annotations: CheckRunAnnotation[] } }
    expect(batch.output.annotations).toEqual(deterministic)
  })

  it("combines deterministic and model annotations on successful annotation surfaces", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "success",
      surface: "both",
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 1,
        prNumber: 5,
        checkAnnotations: model,
        deterministicCheckAnnotations: deterministic,
      },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    const completion = mockUpdateCheckRun.mock.calls[0]![3] as { output: { summary: string } }
    expect(completion.output.summary).toContain("1 scanner diagnostic from deterministic analysis")
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as { output: { annotations: CheckRunAnnotation[] } }
    expect(batch.output.annotations).toEqual([...model, ...deterministic])
  })

  it("posts deterministic annotations when the LLM review degraded to a failure conclusion", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "failure",
      surface: "both",
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 0,
        surface: "skip-notice",
        checkAnnotations: model,
        deterministicCheckAnnotations: deterministic,
      },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    const completion = mockUpdateCheckRun.mock.calls[0]![3] as {
      conclusion: string
      output: { title: string; summary: string }
    }
    expect(completion.conclusion).toBe("neutral")
    expect(completion.output.title).toBe("Couldn't review — see PR comment")
    expect(completion.output.summary).toContain("couldn't generate a model review")
    expect(completion.output.summary).toContain("Deterministic analysis still found 1 scanner diagnostic")
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as { output: { annotations: CheckRunAnnotation[] } }
    expect(batch.output.annotations).toEqual(deterministic)
  })

  it("keeps deterministic scanner context on review-submit comment fallback", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "failure",
      surface: "comments",
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 0,
        surface: "comment",
        checkAnnotations: model,
        deterministicCheckAnnotations: deterministic,
      },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    const completion = mockUpdateCheckRun.mock.calls[0]![3] as {
      conclusion: string
      output: { title: string; summary: string }
    }
    expect(completion.conclusion).toBe("neutral")
    expect(completion.output.title).toBe("Couldn't post review — see PR comment")
    expect(completion.output.summary).toContain("Deterministic analysis also found 1 scanner diagnostic")
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as { output: { annotations: CheckRunAnnotation[] } }
    expect(batch.output.annotations).toEqual(deterministic)
  })

  it("posts deterministic annotations on generic post-scan review failure", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "failure",
      surface: "both",
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 0,
        deterministicCheckAnnotations: deterministic,
      },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2)
    const completion = mockUpdateCheckRun.mock.calls[0]![3] as {
      conclusion: string
      output: { title: string; summary: string }
    }
    expect(completion.conclusion).toBe("neutral")
    expect(completion.output.title).toBe("Review failed")
    expect(completion.output.summary).toContain("1 scanner diagnostic from deterministic analysis")
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as { output: { annotations: CheckRunAnnotation[] } }
    expect(batch.output.annotations).toEqual(deterministic)
  })

  it("does not post deterministic annotations on stale-head skip", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })

    await completeCheckRun({
      handle,
      conclusion: "skipped",
      surface: "both",
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 0,
        deterministicCheckAnnotations: deterministic,
      },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1)
  })
})
