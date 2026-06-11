// ARC-264 — `/sigilix describe apply` (apply: true) handler tests.
//
// Sibling of triage-pr-describe.test.ts (split out under SIG-318/SIG-376
// to keep each suite ≤1,000 lines). The `vi.mock` factories + mock fns +
// `beforeEach` are replicated here because vitest hoists `vi.mock`
// per file and mock state does not cross files. Shared pure fixtures come
// from triage-pr-describe.test-helpers.ts.

import { beforeEach, describe, expect, it, vi } from "vitest"

// Top-level mock fns. Initialized before any hoisted vi.mock factory
// runs. The factory below closes over them via arrow-function
// indirection so the mock is hoisting-safe (matches existing
// triage-pr-review-stale-head.test.ts pattern).
const mockGetInstallationToken = vi.fn(async (_args: unknown) => "fake-token")
const mockGetPullRequest = vi.fn()
const mockGetPullRequestDiff = vi.fn()
const mockCreateIssueComment = vi.fn()
const mockUpdatePullRequestBody = vi.fn(async (..._args: unknown[]) => undefined)
const mockGenerate = vi.fn()
const mockLoadSigilixConfig = vi.fn()

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
      getPullRequestDiff: (...args: unknown[]) => mockGetPullRequestDiff(...args),
      createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
      updatePullRequestBody: (...args: unknown[]) => mockUpdatePullRequestBody(...args),
    })),
  }
})

// SIG-212: tests resolve `mockGenerate` to a raw string (the old
// `generate()` return). After SIG-212 the helper returns `{ text,
// usage }`. The wrapper adapts string-returning mocks so existing
// `mockResolvedValue("...")` calls still work.
vi.mock("@/src/shared/adapters/model/ollama", () => ({
  generate: async (args: unknown) => {
    const result = await mockGenerate(args)
    return typeof result === "string" ? { text: result, usage: {} } : result
  },
}))

vi.mock("@/src/lib/sigilix-config", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/sigilix-config")>("@/src/lib/sigilix-config")
  return {
    ...actual,
    loadSigilixConfig: (...args: unknown[]) => mockLoadSigilixConfig(...args),
  }
})

import { GitHubHttpError } from "@/src/shared/adapters/github"
import { renderApplyFailureComment, handlePrDescribe } from "@/src/lib/triage-pr-describe"
import { makeKvStub, makeEnv } from "@/src/lib/triage-pr-describe.test-helpers"

beforeEach(() => {
  // mockClear (not mockReset) — preserves the implementation set by
  // the module-level vi.mock factory (matches the existing
  // triage-pr-review-stale-head.test.ts pattern).
  mockGetInstallationToken.mockClear()
  mockGetPullRequest.mockClear()
  mockGetPullRequestDiff.mockClear()
  mockCreateIssueComment.mockClear()
  mockUpdatePullRequestBody.mockReset().mockResolvedValue(undefined)
  mockGenerate.mockClear()
  mockLoadSigilixConfig.mockClear()
  mockGetPullRequest.mockResolvedValue({
    head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
    title: "Add widget",
    body: "Adds a widget",
  })
  mockGetPullRequestDiff.mockResolvedValue("diff --git a/foo.ts ...\n+const x = 1")
  mockCreateIssueComment.mockResolvedValue({})
  mockLoadSigilixConfig.mockResolvedValue({})
})

describe("renderApplyFailureComment (ARC-264)", () => {
  it("explains the apply failure + offers the comment-mode fallback for each mode", () => {
    const pr = renderApplyFailureComment("pr-description")
    expect(pr).toContain("could not write it to the PR body")
    expect(pr).toContain("/sigilix describe apply pr")
    expect(pr).toContain("/sigilix describe pr")

    const ext = renderApplyFailureComment("external-changelog")
    expect(ext).toContain("/sigilix describe apply external")
    expect(ext).toContain("/sigilix describe external")
  })
})

describe("handlePrDescribe — apply: true happy path (ARC-264)", () => {
  it("PATCHes the PR body and does NOT post a comment on success", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "Adds the widget for users.",
        body: "## Summary\n\nAdds a widget the users see on the home screen.",
      }),
    )
    // Two getPullRequest calls happen in the apply path: one early
    // for meta, one re-fetch immediately before the PATCH (H2 race
    // guard). Use mockResolvedValue (not Once) so both return the
    // same shape.
    mockGetPullRequest.mockResolvedValue({
      head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
      title: "Add widget",
      body: "Manual notes from the author.",
    })
    const { kv } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })

    expect(mockUpdatePullRequestBody).toHaveBeenCalledOnce()
    const [, , , bodyArg] = mockUpdatePullRequestBody.mock.calls[0] as [string, string, number, string]
    // Manual content preserved.
    expect(bodyArg).toContain("Manual notes from the author.")
    // Fresh marker block appended.
    expect(bodyArg).toContain("<!-- sigilix:describe:pr-description:start -->")
    expect(bodyArg).toContain("<!-- sigilix:describe:pr-description:end -->")
    expect(bodyArg).toContain("Adds a widget the users see on the home screen.")
    // No top-level comment posted in apply mode.
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("replaces the marker-fenced block in place when re-running on a PR that already has Sigilix markers", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "Refined summary for the auto-generated PR description.",
        body: "REFRESHED auto content v2. Includes the new widget on the home screen with multi-line content.",
      }),
    )
    const existingBody = [
      "Prose before markers.",
      "",
      "<!-- sigilix:describe:pr-description:start -->",
      "OLD auto content v1.",
      "<!-- sigilix:describe:pr-description:end -->",
      "",
      "Prose after markers.",
    ].join("\n")
    mockGetPullRequest.mockResolvedValue({
      head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
      title: "Add widget",
      body: existingBody,
    })
    const { kv } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })

    const [, , , bodyArg] = mockUpdatePullRequestBody.mock.calls[0] as [string, string, number, string]
    expect(bodyArg).toContain("Prose before markers.")
    expect(bodyArg).toContain("Prose after markers.")
    expect(bodyArg).toContain("REFRESHED auto content v2.")
    // OLD content gone.
    expect(bodyArg).not.toContain("OLD auto content v1.")
    // Markers still present exactly once each.
    expect(bodyArg.match(/sigilix:describe:pr-description:start/g)?.length).toBe(1)
    expect(bodyArg.match(/sigilix:describe:pr-description:end/g)?.length).toBe(1)
  })

  it("emits pr-describe-applied telemetry with existing_markers=false on first apply", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: "y".repeat(100),
      }),
    )
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { kv } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "external-changelog",
      apply: true,
      env: makeEnv(kv),
    })
    const appliedLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("pr-describe-applied"))
    expect(appliedLog).toBeDefined()
    const parsed = JSON.parse(appliedLog!)
    expect(parsed.mode).toBe("external-changelog")
    expect(parsed.apply).toBe(true)
    expect(parsed.existing_markers).toBe(false)
    logSpy.mockRestore()
  })

  // L1: assert the existing_markers=true path emits the same event
  // with the flag flipped — guards against a regression that
  // accidentally always logs `false`.
  it("emits pr-describe-applied telemetry with existing_markers=true on re-run", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "Refined summary line over ten chars.",
        body: "Refreshed auto content. Long enough to clear the 50-char body floor for verdict parse.",
      }),
    )
    mockGetPullRequest.mockResolvedValue({
      head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
      title: "Add widget",
      body:
        "Manual prose before.\n\n" +
        "<!-- sigilix:describe:pr-description:start -->\n" +
        "OLD\n" +
        "<!-- sigilix:describe:pr-description:end -->\n\n" +
        "Manual prose after.",
    })
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const { kv } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })
    const appliedLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("pr-describe-applied"))
    expect(appliedLog).toBeDefined()
    const parsed = JSON.parse(appliedLog!)
    expect(parsed.existing_markers).toBe(true)
    logSpy.mockRestore()
  })

  // L6: GitHub returns `body: null` for PRs created without a body.
  // Confirm the apply path handles it (the body-merge helper treats
  // null as empty).
  it("handles meta.body === null (PR created without a body) → writes just the marker block", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: "y".repeat(100),
      }),
    )
    mockGetPullRequest.mockResolvedValue({
      head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
      title: "Add widget",
      body: null,
    })
    const { kv } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })

    expect(mockUpdatePullRequestBody).toHaveBeenCalledOnce()
    const [, , , bodyArg] = mockUpdatePullRequestBody.mock.calls[0] as [string, string, number, string]
    expect(bodyArg.startsWith("<!-- sigilix:describe:pr-description:start -->")).toBe(true)
    expect(bodyArg.endsWith("<!-- sigilix:describe:pr-description:end -->\n")).toBe(true)
    // Provenance line (M2 catch) lives inside the markers.
    expect(bodyArg).toContain('<!-- sigilix-meta: {"kind":"describe-apply"')
  })

  it("uses an apply-suffixed dedupe key so `describe pr` and `describe apply pr` don't collide", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: "y".repeat(100),
      }),
    )
    const { kv, store } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })
    const keys = Array.from(store.keys()).filter((k) => k.startsWith("pr-describe:"))
    expect(keys.length).toBe(1)
    expect(keys[0]!).toMatch(/:pr-description:apply$/)
  })

  it("a prior `describe pr` lock does NOT suppress a follow-up `describe apply pr`", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: "y".repeat(100),
      }),
    )
    const { kv, store } = makeKvStub()
    // Lock the comment-mode dedupe key (no `:apply` suffix).
    store.set("pr-describe:acme/site#42@abc1234567890abcdef1234567890abcdef12345:pr-description", "1")
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })
    expect(mockUpdatePullRequestBody).toHaveBeenCalledOnce()
  })
})

describe("handlePrDescribe — apply: true failure paths (ARC-264)", () => {
  it("re-throws on 5xx PATCHing the PR body (queue retry path)", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: "y".repeat(100),
      }),
    )
    mockUpdatePullRequestBody.mockRejectedValueOnce(new GitHubHttpError(502, "HTTP 502 Bad Gateway"))
    const { kv } = makeKvStub()
    await expect(
      handlePrDescribe({
        owner: "acme",
        repo: "site",
        prNumber: 42,
        installationId: 1,
        mode: "pr-description",
        apply: true,
        env: makeEnv(kv),
      }),
    ).rejects.toThrow(/502/)
  })

  it("posts the apply-failure comment + does NOT re-throw on 4xx PATCHing the PR body", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: "y".repeat(100),
      }),
    )
    mockUpdatePullRequestBody.mockRejectedValueOnce(new GitHubHttpError(422, "HTTP 422 Unprocessable"))
    const { kv } = makeKvStub()
    await expect(
      handlePrDescribe({
        owner: "acme",
        repo: "site",
        prNumber: 42,
        installationId: 1,
        mode: "pr-description",
        apply: true,
        env: makeEnv(kv),
      }),
    ).resolves.toBeUndefined()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    const body = mockCreateIssueComment.mock.calls[0]![3] as string
    expect(body).toContain("could not write it to the PR body")
    expect(body).toContain("/sigilix describe apply pr")
    expect(body).toContain("/sigilix describe pr")
    // L7: the 7-char SHA suffix is in the comment for correlation.
    expect(body).toContain("`abc1234`")
  })

  // H3: re-running with bytes-identical content is a no-op — no
  // PATCH, no comment, just the noop telemetry event. Prevents
  // body-churn entries in GitHub's PR history on idempotent re-runs.
  it("no-ops when the merged body would be identical to the existing body", async () => {
    // Construct a body that already contains the EXACT block the
    // generator produces, then run apply with the same generator
    // output. The pre-merge equality check should return early.
    const generatedBody = "y".repeat(100)
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: generatedBody,
      }),
    )
    // We don't know the headSha-derived provenance line ahead of
    // time, so we run apply ONCE, capture the PATCHed body, then
    // re-run with that as the input body. The second run should
    // be a no-op.
    mockGetPullRequest.mockResolvedValue({
      head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
      title: "Add widget",
      body: "",
    })
    const { kv } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })
    expect(mockUpdatePullRequestBody).toHaveBeenCalledOnce()
    const firstBody = mockUpdatePullRequestBody.mock.calls[0]![3] as string

    // Reset for the second run (use a fresh KV so dedupe doesn't
    // suppress) and seed the body with the first-run output.
    mockUpdatePullRequestBody.mockClear()
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    mockGetPullRequest.mockResolvedValue({
      head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
      title: "Add widget",
      body: firstBody,
    })
    const { kv: kv2 } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv2),
    })
    expect(mockUpdatePullRequestBody).not.toHaveBeenCalled()
    const noopLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("pr-describe-applied-noop"))
    expect(noopLog).toBeDefined()
    logSpy.mockRestore()
  })

  // M1: merged body exceeds the soft cap → no PATCH, clear-error
  // comment posted instead of a generic 422.
  it("posts the too-large comment when the merged body would exceed PR_BODY_HARD_CAP", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: "y".repeat(100),
      }),
    )
    // Existing body sized so that `existing + block` exceeds 250000.
    mockGetPullRequest.mockResolvedValue({
      head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
      title: "Add widget",
      body: "z".repeat(250_000),
    })
    const { kv } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })
    expect(mockUpdatePullRequestBody).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    const body = mockCreateIssueComment.mock.calls[0]![3] as string
    expect(body).toContain("exceed GitHub's size cap")
    expect(body).toContain("/sigilix describe pr")
  })

  // H2: GET failure before PATCH falls back to the stale meta.body
  // snapshot rather than abort. Emits a warn event we can grep.
  it("falls back to stale meta.body when the pre-PATCH refetch GET fails", async () => {
    mockGenerate.mockResolvedValue(
      JSON.stringify({
        summary: "x".repeat(20),
        body: "y".repeat(100),
      }),
    )
    // First call: meta load (succeeds). Second call: pre-PATCH
    // refetch (fails).
    mockGetPullRequest.mockReset()
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: "abc1234567890abcdef1234567890abcdef12345" },
      title: "Add widget",
      body: "Stale meta body.",
    })
    mockGetPullRequest.mockRejectedValueOnce(new GitHubHttpError(503, "HTTP 503"))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { kv } = makeKvStub()
    await handlePrDescribe({
      owner: "acme",
      repo: "site",
      prNumber: 42,
      installationId: 1,
      mode: "pr-description",
      apply: true,
      env: makeEnv(kv),
    })
    expect(mockUpdatePullRequestBody).toHaveBeenCalledOnce()
    const bodyArg = mockUpdatePullRequestBody.mock.calls[0]![3] as string
    expect(bodyArg).toContain("Stale meta body.")
    const warnLine = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pr-describe-apply-prefetch-failed"))
    expect(warnLine).toBeDefined()
    warnSpy.mockRestore()
  })
})
