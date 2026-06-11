// SIG-144 / SIG-171 — GitHub Checks annotations as a configurable second
// output surface for the "Sigilix Review" check run.
//
// Sibling of pr-review-check-run.test.ts (split out under SIG-318/SIG-376
// to keep each suite ≤1,000 lines). The `vi.hoisted` mock fns + `vi.mock`
// factories + `beforeEach`/`afterEach` are replicated here because vitest
// hoists `vi.mock` per file and mock state does not cross files. Shared
// pure fixtures come from pr-review-check-run.test-helpers.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockGetInstallationToken, mockCreateCheckRun, mockUpdateCheckRun, mockListCheckRunsForRef } = vi.hoisted(
  () => ({
    mockGetInstallationToken: vi.fn(async () => "test-token"),
    mockCreateCheckRun: vi.fn(),
    mockUpdateCheckRun: vi.fn(),
    mockListCheckRunsForRef: vi.fn(),
  }),
)

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
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

import { completeCheckRun, startInProgressCheckRun } from "@/src/lib/pr-review-check-run"
import { GitHubHttpError } from "@/src/shared/adapters/github"
import type { CheckRunAnnotation } from "@/src/shared/types/github"
import { makeEnv, baseArgs } from "@/src/lib/pr-review-check-run.test-helpers"

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
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 51,
        prNumber: 5,
        checkAnnotations: makeAnnotations(51),
      },
    })

    // 1 completion PATCH (no annotations) + 2 annotation batches (50 + 1)
    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(3)
    const completion = mockUpdateCheckRun.mock.calls[0]![3] as {
      status: string
      output: { annotations?: unknown[] }
    }
    expect(completion.status).toBe("completed")
    expect(completion.output.annotations).toBeUndefined()

    const b1 = mockUpdateCheckRun.mock.calls[1]![3] as {
      output: { title: string; summary: string; annotations: CheckRunAnnotation[] }
    }
    const b2 = mockUpdateCheckRun.mock.calls[2]![3] as {
      output: { summary: string; annotations: CheckRunAnnotation[] }
    }
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
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 2,
        checkAnnotations: makeAnnotations(2),
      },
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
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 2,
        checkAnnotations: makeAnnotations(2),
      },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(1) // completion only
  })

  it("pre-filters annotations GitHub would reject (bad path / line range)", async () => {
    mockUpdateCheckRun.mockResolvedValue(undefined)
    mockCreateCheckRun.mockResolvedValue({ id: 7777 })
    const env = makeEnv()
    const handle = await startInProgressCheckRun({ env, ...baseArgs })
    const annotations: CheckRunAnnotation[] = [
      {
        path: "src/app.ts",
        start_line: 5,
        end_line: 5,
        annotation_level: "warning",
        message: "ok",
      },
      {
        path: "src/app.ts",
        start_line: 0,
        end_line: 0,
        annotation_level: "warning",
        message: "bad line",
      },
      { path: "", start_line: 3, end_line: 3, annotation_level: "warning", message: "no path" },
      {
        path: "src/app.ts",
        start_line: 9,
        end_line: 2,
        annotation_level: "warning",
        message: "end<start",
      },
    ]

    await completeCheckRun({
      handle,
      conclusion: "success",
      surface: "both",
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 4, checkAnnotations: annotations },
    })

    expect(mockUpdateCheckRun).toHaveBeenCalledTimes(2) // completion + 1 batch (1 survivor)
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as {
      output: { annotations: CheckRunAnnotation[] }
    }
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
      {
        path: "src/a.ts",
        start_line: 1,
        end_line: 1,
        annotation_level: "warning",
        message: "good 1",
      },
      {
        path: "src/a.ts",
        start_line: 999,
        end_line: 999,
        annotation_level: "failure",
        message: "stale",
      },
      {
        path: "src/a.ts",
        start_line: 3,
        end_line: 3,
        annotation_level: "warning",
        message: "good 2",
      },
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
      reviewMeta: {
        event: "REQUEST_CHANGES",
        findingsCount: 3,
        checkAnnotations: makeAnnotations(3),
      },
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

    await expect(
      completeCheckRun({
        handle,
        conclusion: "success",
        surface: "both",
        reviewMeta: {
          event: "REQUEST_CHANGES",
          findingsCount: 1,
          checkAnnotations: makeAnnotations(1),
        },
      }),
    ).resolves.toBeUndefined()
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
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as {
      output: { annotations: CheckRunAnnotation[] }
    }
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
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as {
      output: { annotations: CheckRunAnnotation[] }
    }
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
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as {
      output: { annotations: CheckRunAnnotation[] }
    }
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
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as {
      output: { annotations: CheckRunAnnotation[] }
    }
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
    const batch = mockUpdateCheckRun.mock.calls[1]![3] as {
      output: { annotations: CheckRunAnnotation[] }
    }
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
