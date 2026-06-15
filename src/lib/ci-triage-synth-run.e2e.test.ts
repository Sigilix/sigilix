// SIG-426 (PR 2) — E2E through the real `handleCiTriage` → `runCiTriage` path
// with a FAKE GitHub client + a STUBBED synth (no live model). Drives the wiring
// behind OPENCLAW_CI_TRIAGE_SYNTH_MODE and asserts the grounded-inline disposition,
// dedup, idempotency, and the default-off legacy fallback. Each test would FAIL if
// the wiring were reverted.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"

// ── hoisted mocks ───────────────────────────────────────────────────────────
const { mockGetInstallationToken, mockRunSynthesizer, mockGenerate, gh } = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockRunSynthesizer: vi.fn(),
  mockGenerate: vi.fn(),
  gh: {
    getPullRequest: vi.fn(),
    getWorkflowRunJobs: vi.fn(),
    getWorkflowJobLog: vi.fn(),
    getPullRequestDiff: vi.fn(),
    getFileContent: vi.fn(),
    listIssueComments: vi.fn(),
    createIssueComment: vi.fn(),
    updateIssueComment: vi.fn(),
    listPullRequestReviewComments: vi.fn(),
    listPullRequestReviews: vi.fn(),
    submitReview: vi.fn(),
  },
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  class GitHubClientMock {
    getPullRequest = gh.getPullRequest
    getWorkflowRunJobs = gh.getWorkflowRunJobs
    getWorkflowJobLog = gh.getWorkflowJobLog
    getPullRequestDiff = gh.getPullRequestDiff
    getFileContent = gh.getFileContent
    listIssueComments = gh.listIssueComments
    createIssueComment = gh.createIssueComment
    updateIssueComment = gh.updateIssueComment
    listPullRequestReviewComments = gh.listPullRequestReviewComments
    listPullRequestReviews = gh.listPullRequestReviews
    submitReview = gh.submitReview
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

// Stub the synth seam directly (no live model). Preserve SYNTHESIZER_CONFIG +
// the routing helpers — the code reads `SYNTHESIZER_CONFIG.perAttemptTimeoutMs`
// and selects an API key.
vi.mock("@/src/lib/ensemble/adapters/model-provider", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/ensemble/adapters/model-provider")>(
    "@/src/lib/ensemble/adapters/model-provider",
  )
  return { ...actual, runSynthesizer: (args: unknown) => mockRunSynthesizer(args) }
})

// Stub the legacy glm `generate` so the off / shadow legacy path doesn't hit a model.
vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return { ...actual, generate: (args: unknown) => mockGenerate(args) }
})

import { handleCiTriage } from "@/src/lib/triage-ci"
import type { Env } from "@/src/shared/types/env"

// ── fixtures ────────────────────────────────────────────────────────────────

const OWNER = "Sigilix"
const REPO = "sigilix"
const PR = 7
const RUN_ID = 12345
const HEAD = "a".repeat(40)

// A unified diff where line 2 of src/a.ts is added (RIGHT-reviewable). The synth
// finding anchors there.
const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1
+const y: number = "2"
 const z = 3
`

// The failed CI log the synth is handed. The corroborated finding quotes a span
// of THIS log verbatim; the uncorroborated finding quotes something not present.
const CI_LOG = `=== job: build ===
src/a.ts:2:7 - error TS2322: Type 'string' is not assignable to type 'number'.
`

const LOG_EXCERPT_REAL = "TS2322: Type 'string' is not assignable to type 'number'."
const LOG_EXCERPT_FAKE = "TS9999: invented error that is not in the log"

function makeKvStub(): Env["OPENCLAW_STATE"] {
  const store = new Map<string, string>()
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
  return {
    OPENCLAW_STATE: makeKvStub(),
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    AI: {} as Ai,
    OPENCLAW_JOBS: {} as Queue<never>,
    OLLAMA_API_KEY: "ollama-key",
    OPENROUTER_API_KEY: "openrouter-key",
    // SIG-431: chat must be ENABLED for the synth call to fire — the run derives
    // `chatEnabled` from this (parity with the ensemble synth path). Mirrors prod.
    OLLAMA_CHAT_ENABLE: "on",
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "key",
    ...overrides,
  } as Env
}

/** A synth verdict with one finding anchored at src/a.ts:2 carrying `logExcerpt`. */
function synthVerdict(logExcerpt: string, opts?: { line?: number; headline?: string }): PrReviewVerdict {
  return {
    summary: "CI failure analysis",
    confidence: 4,
    confidenceReason: "log-grounded",
    findings: [
      {
        path: "src/a.ts",
        line: opts?.line ?? 2,
        score: 4,
        category: "logic",
        headline: opts?.headline ?? "Type error: string assigned to number",
        body: '`const y: number = "2"` assigns a string to a number-typed binding.',
        fixExample: "const y: number = 2",
        // Threaded as a top-level field by the CI synth preamble; retained by
        // parsePrReviewResponse (SIG-426) — here we inject it straight onto the
        // stubbed verdict so isLogGrounded can check it.
        logExcerpt,
      } as PrReviewVerdict["findings"][number],
    ],
  }
}

function synthOk(verdict: PrReviewVerdict): ReturnType<typeof mockRunSynthesizer> {
  return {
    verdict,
    provenance: null,
    elapsedMs: 10,
    modelUsed: "nvidia/nemotron-3-ultra-550b-a55b",
    attemptsUsed: 1,
  }
}

function wireBaseGitHub(): void {
  gh.getPullRequest.mockResolvedValue({
    number: PR,
    title: "add y",
    body: "",
    user: { login: "danny" },
    head: { sha: HEAD, ref: "feat/x" },
    base: { sha: "b".repeat(40), ref: "main" },
    state: "open",
  })
  gh.getWorkflowRunJobs.mockResolvedValue([
    { id: 99, name: "build", conclusion: "failure", status: "completed", html_url: null },
  ])
  gh.getWorkflowJobLog.mockResolvedValue(CI_LOG)
  gh.getPullRequestDiff.mockResolvedValue(DIFF)
  gh.getFileContent.mockResolvedValue(null)
  gh.listIssueComments.mockResolvedValue([])
  gh.createIssueComment.mockResolvedValue({ id: 1 })
  gh.updateIssueComment.mockResolvedValue({ id: 1 })
  gh.listPullRequestReviewComments.mockResolvedValue([])
  gh.listPullRequestReviews.mockResolvedValue([])
  gh.submitReview.mockResolvedValue({ id: 555, state: "COMMENTED" })
}

function args(env: Env): Parameters<typeof handleCiTriage>[0] {
  return { owner: OWNER, repo: REPO, prNumber: PR, runId: RUN_ID, headSha: HEAD, installationId: 99, env }
}

beforeEach(() => {
  for (const fn of Object.values(gh)) fn.mockReset()
  mockRunSynthesizer.mockReset()
  mockGenerate.mockReset()
  mockGetInstallationToken.mockClear().mockResolvedValue("test-token")
  wireBaseGitHub()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("SIG-426 CI-triage synth wiring (E2E through handleCiTriage)", () => {
  it("(a) enforce: anchored + log-corroborated → inline-CLEAN comment posted", async () => {
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_REAL)))
    const env = makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })

    await handleCiTriage(args(env))

    expect(mockRunSynthesizer).toHaveBeenCalledOnce()
    expect(gh.submitReview).toHaveBeenCalledOnce()
    const review = gh.submitReview.mock.calls[0]?.[3]
    expect(review.event).toBe("COMMENT")
    expect(review.comments).toHaveLength(1)
    const body: string = review.comments[0].body
    expect(review.comments[0]).toMatchObject({ path: "src/a.ts", line: 2, side: "RIGHT" })
    // Clean (corroborated) → NO hedge line; carries the markers + provenance line.
    expect(body).not.toContain("Couldn't corroborate")
    expect(body).toContain("<!-- sigilix:ci-review -->")
    expect(body).toContain(`<!-- sigilix:ci-run:${HEAD}:${RUN_ID} -->`)
    expect(body).toMatch(/<!-- sigilix:fingerprint:[0-9a-f]{64} -->/)
    expect(body).toContain(`actions/runs/${RUN_ID}`)
    // Legacy standalone sticky is SUPPRESSED in enforce.
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(gh.createIssueComment).not.toHaveBeenCalled()
  })

  it("(a') SIG-431: the synth call forwards chatEnabled from OLLAMA_CHAT_ENABLE — NOT hardcoded off", async () => {
    // The bug this guards: chatEnabled was hardcoded "off", which HARD-throws in
    // the chat adapter (openrouter-chat.ts:78), so the synth never ran. With chat
    // ENABLED the run MUST forward "on"; with it disabled it MUST fail closed to
    // "off" (the same kill-switch the ensemble synth path honors). Enforce mode so
    // the legacy glm path is suppressed and only the synth seam is exercised.
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_REAL)))

    await handleCiTriage(args(makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce", OLLAMA_CHAT_ENABLE: "on" })))
    expect(mockRunSynthesizer).toHaveBeenCalledOnce()
    expect(mockRunSynthesizer.mock.calls[0]?.[0]).toMatchObject({ chatEnabled: "on" })

    mockRunSynthesizer.mockClear()
    // Anything other than "on" (here "off", same as unset) → fail closed to
    // "off" (would throw in the real adapter; the mock just records it). Proves
    // the value is DERIVED from the env, not a literal "on".
    await handleCiTriage(args(makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce", OLLAMA_CHAT_ENABLE: "off" })))
    expect(mockRunSynthesizer.mock.calls[0]?.[0]).toMatchObject({ chatEnabled: "off" })
  })

  it("(b) enforce: anchored but UNcorroborated → HEDGED inline (default, not dropped)", async () => {
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_FAKE)))
    const env = makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })

    await handleCiTriage(args(env))

    expect(gh.submitReview).toHaveBeenCalledOnce()
    const body: string = gh.submitReview.mock.calls[0]?.[3].comments[0].body
    expect(body).toContain("Couldn't corroborate this against the CI log")
  })

  it("(b') enforce + hard-withhold flag: anchored UNcorroborated → WITHHELD (no post)", async () => {
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_FAKE)))
    const env = makeEnv({
      OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce",
      OPENCLAW_CI_TRIAGE_SYNTH_HARD_WITHHOLD: "true",
    })

    await handleCiTriage(args(env))

    expect(mockRunSynthesizer).toHaveBeenCalledOnce()
    expect(gh.submitReview).not.toHaveBeenCalled()
  })

  it("(c) enforce: off-diff finding → WITHHELD (flaky/infra, nothing inline)", async () => {
    // Line 999 is not a reviewable RIGHT position in the diff.
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_REAL, { line: 999 })))
    const env = makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })

    await handleCiTriage(args(env))

    expect(mockRunSynthesizer).toHaveBeenCalledOnce()
    expect(gh.submitReview).not.toHaveBeenCalled()
  })

  it("(d) enforce: dedup drops a finding the review already posted (fingerprint match)", async () => {
    // First run: capture the fingerprint the synth finding renders with.
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_REAL)))
    await handleCiTriage(args(makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })))
    const firstBody: string = gh.submitReview.mock.calls[0]?.[3].comments[0].body
    const fp = /<!-- sigilix:fingerprint:([0-9a-f]{64}) -->/.exec(firstBody)?.[1]
    expect(fp).toBeTruthy()

    // Second run: the review already has an inline comment with that fingerprint
    // BUT no ci-run marker (so idempotency doesn't short-circuit) — dedup must
    // hard-drop the finding, so nothing new posts.
    gh.submitReview.mockClear()
    gh.listPullRequestReviewComments.mockResolvedValue([
      { body: `<!-- sigilix:pr-review-finding -->\n<!-- sigilix:fingerprint:${fp} -->\nprior` },
    ])
    await handleCiTriage(args(makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })))
    expect(gh.submitReview).not.toHaveBeenCalled()
  })

  it("(e) enforce: idempotency — re-run for the same (pr,headSha,runId) skips", async () => {
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_REAL)))
    // A prior CI-synth comment for THIS run already exists.
    gh.listPullRequestReviewComments.mockResolvedValue([
      { body: `<!-- sigilix:ci-review -->\n<!-- sigilix:ci-run:${HEAD}:${RUN_ID} -->\nprior` },
    ])
    await handleCiTriage(args(makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })))
    expect(gh.submitReview).not.toHaveBeenCalled()
  })

  it("(e') enforce: a LATER distinct run on the same head is NOT suppressed", async () => {
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_REAL)))
    // Prior comment is for a DIFFERENT runId → must not match this run's marker.
    gh.listPullRequestReviewComments.mockResolvedValue([
      { body: `<!-- sigilix:ci-review -->\n<!-- sigilix:ci-run:${HEAD}:99999 -->\nold run` },
    ])
    await handleCiTriage(args(makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })))
    expect(gh.submitReview).toHaveBeenCalledOnce()
  })

  it("(e'') enforce: idempotency also honors the marker on a prior REVIEW body", async () => {
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_REAL)))
    // No matching inline comment, but a prior REVIEW for this run carries the
    // marker on its body → must still skip (belt-and-suspenders idempotency).
    gh.listPullRequestReviewComments.mockResolvedValue([])
    gh.listPullRequestReviews.mockResolvedValue([
      { body: `<!-- sigilix:ci-review -->\n<!-- sigilix:ci-run:${HEAD}:${RUN_ID} -->\nprior review body` },
    ])
    await handleCiTriage(args(makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })))
    expect(gh.submitReview).not.toHaveBeenCalled()
  })

  it("(f) off (default): legacy glm path runs, synth NOT called", async () => {
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({
        rootCause: "type error",
        affectedFiles: ["src/a.ts"],
        failureExcerpt: "TS2322",
        confidence: "high",
        patches: [],
      }),
    })
    // No mode set → default off.
    await handleCiTriage(args(makeEnv()))

    expect(mockRunSynthesizer).not.toHaveBeenCalled()
    expect(mockGenerate).toHaveBeenCalledOnce()
    expect(gh.createIssueComment).toHaveBeenCalledOnce()
    expect(gh.submitReview).not.toHaveBeenCalled()
  })

  // ── SIG-433: anchor remap wiring (default OFF; flip with OPENCLAW_CI_TRIAGE_ANCHOR_REMAP) ──
  // A diff where the model's anchor (the function HEADER, a RIGHT-reviewable
  // context line) is NOT the cause; the cause is the changed `const dedupeKey =`
  // assignment. No blank context lines (so the two diff parsers agree on line
  // numbers, as on a real diff). Only ONE changed strong-assignment line names a
  // finding symbol (`dedupeKey`), so the remap target is unambiguous. Header
  // `export function parseEvent` = new-side 3; the assignment = new-side 7.
  const REMAP_DIFF = `diff --git a/src/parse/event.ts b/src/parse/event.ts
--- a/src/parse/event.ts
+++ b/src/parse/event.ts
@@ -2,5 +2,7 @@ import { normalizeKind } from "./kind"
 type RawEvent = { runId: string; attempt?: number; kind?: string }
 export function parseEvent(line: string): ParsedEvent {
   const raw = JSON.parse(line) as RawEvent
   const attemptIndex = Number(raw.attempt ?? 0)
+  // build a stable key
+  const dedupeKey = \`\${raw.runId}:\${attemptIndex}\`
   return { runId: raw.runId, attemptIndex }
 }
`
  const REMAP_LOG = `=== job: test ===
 FAIL  tests/parse.test.ts > dedupeEvents > keeps distinct-kind events
AssertionError: expected length 2 but got 1
 ❯ tests/parse.test.ts:50:38
`
  const REMAP_EXCERPT = "expected length 2 but got 1"

  /** A synth verdict that DIAGNOSES the dedupeKey bug but ANCHORS the header (line 6). */
  function remapVerdict(line: number): PrReviewVerdict {
    return {
      summary: "CI failure analysis",
      confidence: 4,
      confidenceReason: "log-grounded",
      findings: [
        {
          path: "src/parse/event.ts",
          line,
          score: 4,
          category: "logic",
          headline: "dedupeKey omits attemptKind",
          body: "The `dedupeKey` is built from runId and attemptIndex only, so distinct-kind events collide.",
          logExcerpt: REMAP_EXCERPT,
        } as PrReviewVerdict["findings"][number],
      ],
    }
  }

  function wireRemapGitHub(): void {
    gh.getPullRequestDiff.mockResolvedValue(REMAP_DIFF)
    gh.getWorkflowJobLog.mockResolvedValue(REMAP_LOG)
  }

  it("(g) remap ON: a grounded finding anchored on the function header is re-homed to the dedupeKey assignment", async () => {
    wireRemapGitHub()
    // Model anchors the header (line 3) — a RIGHT-reviewable context line, but the
    // WITNESS, not the cause. With remap ON it must post on the assignment (line 7).
    mockRunSynthesizer.mockResolvedValue(synthOk(remapVerdict(3)))
    const env = makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce", OPENCLAW_CI_TRIAGE_ANCHOR_REMAP: "on" })

    await handleCiTriage(args(env))

    expect(gh.submitReview).toHaveBeenCalledOnce()
    expect(gh.submitReview.mock.calls[0]?.[3].comments[0]).toMatchObject({
      path: "src/parse/event.ts",
      line: 7, // remapped from 3 → the `const dedupeKey =` line
      side: "RIGHT",
    })
  })

  it("(g') remap OFF (default): the SAME finding posts on the model's original header line — proves OFF is a no-op", async () => {
    wireRemapGitHub()
    mockRunSynthesizer.mockResolvedValue(synthOk(remapVerdict(3)))
    // No OPENCLAW_CI_TRIAGE_ANCHOR_REMAP → default OFF.
    const env = makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce" })

    await handleCiTriage(args(env))

    expect(gh.submitReview).toHaveBeenCalledOnce()
    expect(gh.submitReview.mock.calls[0]?.[3].comments[0]).toMatchObject({
      path: "src/parse/event.ts",
      line: 3, // unchanged — the remap did NOT fire
      side: "RIGHT",
    })
  })

  it("(g'') remap ON but the model's anchor is ALREADY the cause line → no-op (posts on the same line)", async () => {
    wireRemapGitHub()
    // Model already anchored the assignment (line 7) — a substantive cause line.
    mockRunSynthesizer.mockResolvedValue(synthOk(remapVerdict(7)))
    const env = makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "enforce", OPENCLAW_CI_TRIAGE_ANCHOR_REMAP: "on" })

    await handleCiTriage(args(env))

    expect(gh.submitReview).toHaveBeenCalledOnce()
    expect(gh.submitReview.mock.calls[0]?.[3].comments[0]).toMatchObject({
      path: "src/parse/event.ts",
      line: 7,
    })
  })

  it("shadow: synth pass runs + telemeters, posts NOTHING new, legacy sticky still posts", async () => {
    mockRunSynthesizer.mockResolvedValue(synthOk(synthVerdict(LOG_EXCERPT_REAL)))
    mockGenerate.mockResolvedValue({
      text: JSON.stringify({
        rootCause: "type error",
        affectedFiles: ["src/a.ts"],
        failureExcerpt: "TS2322",
        confidence: "high",
        patches: [],
      }),
    })
    await handleCiTriage(args(makeEnv({ OPENCLAW_CI_TRIAGE_SYNTH_MODE: "shadow" })))

    expect(mockRunSynthesizer).toHaveBeenCalledOnce() // pass ran
    expect(gh.submitReview).not.toHaveBeenCalled() // posted nothing new
    expect(mockGenerate).toHaveBeenCalledOnce() // legacy still ran
    expect(gh.createIssueComment).toHaveBeenCalledOnce() // legacy sticky posted
  })
})
