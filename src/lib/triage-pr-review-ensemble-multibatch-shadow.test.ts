// SIG-418 — orchestrator-boundary tests for in-invocation multi-batch review
// wiring (`OPENCLAW_REVIEW_MULTIBATCH_MODE`).
//
// These pin the output-safety + recall/cost-safety invariants the wiring must
// hold, driven through the REAL `handlePrReviewEnsemble` (mocked GitHub + model
// surface, mirroring `triage-pr-review-ensemble-router-skip-paths.test.ts`):
//
//   1. STALE HEAD → the shadow pass NEVER runs. When the head moved, the
//      orchestrator returns at a stale-head guard before reaching the shadow
//      scheduler, so a stale head can never spend spillover model calls — no
//      `multibatch-decision` / `multibatch-summary` telemetry. (Codex sign-off:
//      schedule shadow only after the stale-head guard passes; this is the
//      regression guard for that placement.)
//   2. OFF (default or explicit) → output stays byte-identical.
//   3. ON → spillover specialists run before synth; source-floor-restored P1s
//      from batch 1 publish against the batch-1 inline anchor.
//   4. ON + deadline halt → synth and the published body disclose partial
//      coverage honestly, including incremental-coverage pending paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockChat,
  mockGetPullRequest,
  mockGetPullRequestDiff,
  mockListOpenPullRequests,
  mockGetFileContent,
  mockSubmitReview,
  mockListPullRequestReviews,
  mockListPullRequestFiles,
  mockCreateIssueComment,
  mockRunSarifEvidence,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockChat: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestDiff: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockSubmitReview: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockListPullRequestFiles: vi.fn(),
  mockCreateIssueComment: vi.fn(),
  mockRunSarifEvidence: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, chat: (...args: unknown[]) => mockChat(...args) }
})

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  class GitHubClientMock {
    async getPullRequest(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequest(...args)
    }
    async getPullRequestDiff(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequestDiff(...args)
    }
    async listOpenPullRequests(...args: unknown[]): Promise<unknown> {
      return mockListOpenPullRequests(...args)
    }
    async getFileContent(...args: unknown[]): Promise<unknown> {
      return mockGetFileContent(...args)
    }
    async submitReview(...args: unknown[]): Promise<unknown> {
      return mockSubmitReview(...args)
    }
    async listPullRequestReviews(...args: unknown[]): Promise<unknown> {
      return mockListPullRequestReviews(...args)
    }
    async listPullRequestFiles(...args: unknown[]): Promise<unknown> {
      return mockListPullRequestFiles(...args)
    }
    async createIssueComment(...args: unknown[]): Promise<unknown> {
      return mockCreateIssueComment(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

vi.mock("@/src/features/sarif-evidence", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/sarif-evidence")>("@/src/features/sarif-evidence")
  return { ...actual, runSarifEvidence: (...args: unknown[]) => mockRunSarifEvidence(...args) }
})

import { handlePrReviewEnsemble } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { Env } from "@/src/shared/types/env"

function makeKvStub(seed: Record<string, string> = {}): Env["OPENCLAW_STATE"] {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const seededKv = overrides.OPENCLAW_STATE ?? makeKvStub()
  return {
    OPENCLAW_STATE: seededKv,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OLLAMA_API_KEY: "fake-ollama-key",
    OPENROUTER_API_KEY: "fake-openrouter-key",
    OLLAMA_CHAT_ENABLE: "on",
    OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR: "0",
    ...overrides,
  } as unknown as Env
}

const HEAD_SHA = "deadbeef1234567890abcdef1234567890abcdef"
const BASE_SHA = "basesha000000000000000000000000000000000"
const DIFFERENT_SHA = "f00dface1234567890abcdef1234567890abcdef"

// Docs-only-no-fences diff → the router takes the docs shortcut → empty
// specialist set → the orchestrator skips before any model dispatch (for the
// off/on inertness cases — they only need to prove the shadow scheduler is or
// isn't reached, not a full review).
const DOCS_ONLY_DIFF = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Sigilix

+New paragraph about the project — prose only, no code fences.
+
## Overview
`

function sourceFileDiff(path: string, exportName: string, approxChars = 30_000): string {
  const filler = "x".repeat(approxChars)
  return `diff --git a/${path} b/${path}
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/${path}
@@ -0,0 +1 @@
+export const ${exportName} = "${filler}"
`
}

const BATCH_ZERO_DIFF = sourceFileDiff("src/batch-zero.ts", "batchZeroValue")
const BATCH_ONE_DIFF = sourceFileDiff("src/batch-one.ts", "batchOneValue")
const BATCH_TWO_DIFF = sourceFileDiff("src/batch-two.ts", "batchTwoValue")
const MULTIBATCH_DIFF = [BATCH_ZERO_DIFF, BATCH_ONE_DIFF].join("\n")
const MULTIBATCH_INCREMENTAL_DIFF = [BATCH_ZERO_DIFF, BATCH_ONE_DIFF, BATCH_TWO_DIFF].join("\n")

function noFindingVerdict(summary = "No issues found."): PrReviewVerdict {
  return {
    summary,
    confidence: 5,
    confidenceReason: "test fixture",
    findings: [],
  }
}

function batchOneFinding(): PrReviewFinding {
  return {
    path: "src/batch-one.ts",
    line: 1,
    score: 4,
    category: "logic",
    headline: "`batchOneValue` is accepted without validation",
    body:
      "The new `batchOneValue` export is introduced on the added line without any validation guard, " +
      "so callers can consume unchecked data from this path.",
  }
}

function batchZeroFinding(): PrReviewFinding {
  return {
    path: "src/batch-zero.ts",
    line: 1,
    score: 4,
    category: "logic",
    headline: "`batchZeroValue` is accepted without validation",
    body:
      "The new `batchZeroValue` export is introduced on the added line without any validation guard, " +
      "so the reviewed batch publishes a concrete issue alongside the partial-coverage disclosure.",
  }
}

function chatResult(payload: unknown): {
  message: { role: "assistant"; content: string }
  usage: { inputTokens: number; outputTokens: number }
} {
  return {
    message: { role: "assistant", content: JSON.stringify(payload) },
    usage: { inputTokens: 10, outputTokens: 5 },
  }
}

function synthResult(verdict: PrReviewVerdict) {
  return chatResult({ verdict, provenance: { findings: [], dropped: [] } })
}

function callRole(arg: unknown): "logic" | "security" | "tests" | "performance" | null {
  if (!arg || typeof arg !== "object") return null
  const messages = (arg as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return null
  const text = messages
    .map((m) => (m && typeof m === "object" ? String((m as { content?: unknown }).content ?? "") : ""))
    .join("\n")
  if (/\*\*SECURITY specialist\*\*/.test(text)) return "security"
  if (/\*\*LOGIC specialist\*\*/.test(text)) return "logic"
  if (/\*\*TESTS specialist\*\*/.test(text)) return "tests"
  if (/\*\*PERFORMANCE specialist\*\*/.test(text)) return "performance"
  return null
}

function userMessageText(arg: unknown): string {
  if (!arg || typeof arg !== "object") return ""
  const messages = (arg as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return ""
  return messages
    .filter((m) => m && typeof m === "object" && (m as { role?: unknown }).role === "user")
    .map((m) => String((m as { content?: unknown }).content ?? ""))
    .join("\n")
}

function configureFullReviewChat(
  options: {
    batchOneFinding?: boolean
    batchZeroFinding?: boolean
    synthFindings?: PrReviewFinding[]
    onAfterInitialSpecialists?: () => void
    captureSynthMessage?: (message: string) => void
  } = {},
): void {
  let initialSpecialistCalls = 0
  mockChat.mockImplementation(async (arg: unknown) => {
    const role = callRole(arg)
    const userMessage = userMessageText(arg)
    if (role !== null) {
      const isSpilloverBatch =
        userMessage.includes("diff --git a/src/batch-one.ts b/src/batch-one.ts") ||
        userMessage.includes("diff --git a/src/batch-two.ts b/src/batch-two.ts")
      if (!isSpilloverBatch) {
        initialSpecialistCalls += 1
        if (initialSpecialistCalls === 4) options.onAfterInitialSpecialists?.()
      }
      if (role === "logic" && !isSpilloverBatch && options.batchZeroFinding === true) {
        return chatResult(verdictWithFindings([batchZeroFinding()]))
      }
      if (role === "logic" && userMessage.includes("src/batch-one.ts") && options.batchOneFinding !== false) {
        return chatResult(verdictWithFindings([batchOneFinding()]))
      }
      return chatResult(noFindingVerdict())
    }
    options.captureSynthMessage?.(userMessage)
    return synthResult(verdictWithFindings(options.synthFindings ?? []))
  })
}

function verdictWithFindings(findings: PrReviewFinding[]): PrReviewVerdict {
  return {
    summary: findings.length > 0 ? "Found issues." : "No issues found.",
    confidence: 5,
    confidenceReason: "test fixture",
    findings,
  }
}

function configureReviewFixture(args: { prNumber: number; diff: string; files: Record<string, string> }): void {
  mockGetPullRequest.mockResolvedValue({
    head: { sha: HEAD_SHA, ref: "sig-418-enforce" },
    base: { sha: BASE_SHA, ref: "main" },
    merged_at: null,
    labels: [],
    title: "SIG-418 enforce path",
    body: "Exercise multi-batch enforcement.",
    user: { login: "review-author" },
  })
  mockGetPullRequestDiff.mockResolvedValue(args.diff)
  mockListOpenPullRequests.mockResolvedValue([])
  mockGetFileContent.mockImplementation(async (...callArgs: unknown[]) => {
    const path = String(callArgs[2] ?? "")
    if (path === "sigilix.json") return null
    return `export const fixture = "${path}"`
  })
  mockSubmitReview.mockResolvedValue({ id: args.prNumber, state: "COMMENTED" })
  mockListPullRequestReviews.mockResolvedValue([{ id: args.prNumber, state: "COMMENTED", commitId: HEAD_SHA }])
  mockListPullRequestFiles.mockResolvedValue(
    Object.entries(args.files).map(([filename, sha]) => ({
      filename,
      sha,
      status: "modified",
      additions: 1,
      deletions: 0,
    })),
  )
}

function submittedReviewBody(): string {
  const review = mockSubmitReview.mock.calls.at(-1)?.[3] as { body?: unknown } | undefined
  return String(review?.body ?? "")
}

function submittedReviewComments(): Array<{ path?: string; line?: number; body?: string }> {
  const review = mockSubmitReview.mock.calls.at(-1)?.[3] as { comments?: unknown } | undefined
  const comments = review?.comments
  return Array.isArray(comments) ? (comments as Array<{ path?: string; line?: number; body?: string }>) : []
}

let logSpy: ReturnType<typeof vi.spyOn>

function loggedEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((e) => typeof e["event"] === "string")
}

function multibatchEvents(): Array<Record<string, unknown>> {
  return loggedEvents().filter((e) => String(e["event"]).startsWith("multibatch-"))
}

beforeEach(() => {
  mockGetInstallationToken.mockClear().mockResolvedValue("test-token")
  mockChat.mockReset()
  mockGetPullRequest.mockReset()
  mockGetPullRequestDiff.mockReset()
  mockListOpenPullRequests.mockReset()
  mockGetFileContent.mockReset()
  mockSubmitReview.mockReset()
  mockListPullRequestReviews.mockReset()
  mockListPullRequestFiles.mockReset()
  mockCreateIssueComment.mockReset()
  mockRunSarifEvidence.mockReset().mockResolvedValue({ skipped: true, reason: "disabled-config" })
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("handlePrReviewEnsemble — SIG-418 multi-batch shadow wiring", () => {
  it("STALE HEAD: shadow=on, but a moved head returns before the shadow scheduler → zero multibatch telemetry", async () => {
    // Guard #1 fires: the first getPullRequest reports a head SHA different from
    // the queued one, so the orchestrator returns `stale_head` BEFORE packing,
    // routing, fan-out, or the multi-batch shadow scheduler. The shadow pass can
    // never run on a stale head — no model calls, no multibatch telemetry.
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: DIFFERENT_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9100,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({ OPENCLAW_REVIEW_MULTIBATCH_MODE: "shadow" } as unknown as Env),
    })

    expect(result.status).toBe("stale_head")
    expect(result.telemetry.fellBackReason).toBe("stale_head_before_fanout")
    // The CORE safety invariant: no spillover model calls, no shadow telemetry.
    expect(mockChat).not.toHaveBeenCalled()
    expect(multibatchEvents()).toEqual([])
  })

  it("OFF (default): the shadow scheduler is never reached → zero multibatch telemetry", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(DOCS_ONLY_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9101,
      headSha: HEAD_SHA,
      installationId: 1,
      // Router on → docs-only diff → empty specialists → clean skip. multiBatchMode
      // absent → off. Either way the shadow scheduler must never fire.
      env: makeEnv({ OPENCLAW_ENSEMBLE_ROUTER_ENABLED: "on" } as unknown as Env),
    })

    expect(result.status).toBe("skipped")
    expect(mockChat).not.toHaveBeenCalled()
    expect(multibatchEvents()).toEqual([])
  })

  it("OFF and SHADOW explicit modes are byte-identical to mode unset on the posted review output", async () => {
    const runOffPath = async (prNumber: number, mode?: string) => {
      mockChat.mockReset()
      mockGetPullRequest.mockReset()
      mockGetPullRequestDiff.mockReset()
      mockListOpenPullRequests.mockReset()
      mockGetFileContent.mockReset()
      mockSubmitReview.mockReset()
      mockListPullRequestReviews.mockReset()
      mockListPullRequestFiles.mockReset()
      configureReviewFixture({
        prNumber,
        diff: MULTIBATCH_DIFF,
        files: {
          "src/batch-zero.ts": "batch-zero-sha",
          "src/batch-one.ts": "batch-one-sha",
        },
      })
      configureFullReviewChat({ batchOneFinding: false })
      const backgroundWork: Promise<void>[] = []
      const result = await handlePrReviewEnsemble({
        owner: "Sigilix",
        repo: "sigilix",
        prNumber,
        headSha: HEAD_SHA,
        installationId: 1,
        env: makeEnv({
          ...(mode !== undefined ? { OPENCLAW_REVIEW_MULTIBATCH_MODE: mode } : {}),
        } as unknown as Env),
        backgroundWaitUntil: (promise) => backgroundWork.push(promise),
      })
      expect(result.status).toBe("posted")
      const output = { body: submittedReviewBody(), comments: submittedReviewComments() }
      await Promise.all(backgroundWork)
      return output
    }

    const unset = await runOffPath(9102)
    const explicitOff = await runOffPath(9103, "off")
    const explicitShadow = await runOffPath(9106, "shadow")

    expect(explicitOff).toEqual(unset)
    expect(explicitShadow).toEqual(unset)
    // SIG-450: this case runs the full ensemble pipeline 3× (unset/off/shadow) to prove
    // byte-identity, so it's the heaviest test in the suite (~5s). The default 5000ms
    // budget is too tight in the resource-constrained Cloudflare Workers Build container
    // (it intermittently times out at 5138ms and reds the prod deploy); give it headroom.
  }, 20_000)

  it("ON posts a source-floor-restored batch-1 P1 as an inline comment on the batch-1 file", async () => {
    configureReviewFixture({
      prNumber: 9104,
      diff: MULTIBATCH_DIFF,
      files: {
        "src/batch-zero.ts": "batch-zero-sha",
        "src/batch-one.ts": "batch-one-sha",
      },
    })
    configureFullReviewChat({ synthFindings: [] })

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9104,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({ OPENCLAW_REVIEW_MULTIBATCH_MODE: "on" } as unknown as Env),
    })

    expect(result.status).toBe("posted")
    const comments = submittedReviewComments()
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      path: "src/batch-one.ts",
      line: 1,
    })
    expect(comments[0]?.body).toContain("`batchOneValue` is accepted without validation")
    expect(mockChat.mock.calls.map((call) => callRole(call[0])).filter(Boolean)).toContain("logic")
  })

  it("ON deadline halt posts incremental partial coverage and sends the SIG-443 scope block to synth", async () => {
    const priorCoverage = {
      schemaVersion: 1,
      files: {
        "src/batch-two.ts": {
          reviewedAtBlobSha: "same-batch-two-sha",
          reviewedAtHeadSha: "older-head",
          reviewedAt: "2026-06-15T00:00:00.000Z",
        },
      },
    }
    configureReviewFixture({
      prNumber: 9105,
      diff: MULTIBATCH_INCREMENTAL_DIFF,
      files: {
        "src/batch-zero.ts": "batch-zero-sha",
        "src/batch-one.ts": "batch-one-sha",
        "src/batch-two.ts": "same-batch-two-sha",
      },
    })

    const synthMessages: string[] = []
    let now = 1_700_000_000_000
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    configureFullReviewChat({
      batchOneFinding: false,
      batchZeroFinding: true,
      onAfterInitialSpecialists: () => {
        now += 900_000
      },
      captureSynthMessage: (message) => synthMessages.push(message),
    })

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9105,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({
        OPENCLAW_REVIEW_MULTIBATCH_MODE: "on",
        OPENCLAW_INCREMENTAL_REVIEW_MODE: "on",
        OPENCLAW_STATE: makeKvStub({
          "pr-review-coverage:Sigilix/sigilix#9105": JSON.stringify(priorCoverage),
        }),
      } as unknown as Env),
    })
    dateNowSpy.mockRestore()

    expect(result.status).toBe("posted")
    const body = submittedReviewBody()
    expect(body).toContain("Reviewed 2 of 3 changed files across this PR so far")
    expect(body).toContain("the remaining 1 was below the priority cutoff")
    expect(synthMessages.at(-1)).toContain("[REVIEW COVERAGE SCOPE]")
    expect(synthMessages.at(-1)).toContain("Deadline/budget halted")
    expect(synthMessages.at(-1)).toContain("Skipped or not launched files (1/2): src/batch-one.ts")
  })
})
