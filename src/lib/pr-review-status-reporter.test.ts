import { describe, expect, it, vi } from "vitest"
import {
  createReviewStatusReporter,
  patchExistingOverviewStatusComment,
  publishOverviewStatusComment,
} from "@/src/lib/pr-review-status-reporter"
import { buildReviewStatusBlock, REVIEW_STATUS_BLOCK_START } from "@/src/lib/pr-review-status-render"
import { OVERVIEW_MARKER } from "@/src/lib/triage-pr-overview-scan"

const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12"

describe("review status reporter", () => {
  it("posts progress to the DO before patching the overview comment", async () => {
    const events: string[] = []
    const reporter = createReviewStatusReporter({
      runId: "run-1",
      headSha: HEAD_SHA,
      postStatusProgress: vi.fn(async () => {
        events.push("do")
        return { accepted: true as const, phase: "retrieval" as const }
      }),
      patchOverviewComment: vi.fn(async () => {
        events.push("patch")
        return { kind: "updated" as const, commentId: 10 }
      }),
      publishOverviewComment: vi.fn(async () => ({ kind: "updated" as const, commentId: 10 })),
    })

    reporter.report({ phase: "retrieval" })
    await reporter.flush()

    expect(events).toEqual(["do", "patch"])
  })

  it("serializes updates and skips comment patches rejected by the DO", async () => {
    const patched: string[] = []
    const reporter = createReviewStatusReporter({
      runId: "run-1",
      headSha: HEAD_SHA,
      postStatusProgress: vi
        .fn()
        .mockResolvedValueOnce({ accepted: true as const, phase: "retrieval" as const })
        .mockResolvedValueOnce({ accepted: false as const, phase: "retrieval" as const, reason: "stale-phase" })
        .mockResolvedValueOnce({ accepted: true as const, phase: "synth" as const }),
      patchOverviewComment: vi.fn(async (snapshot) => {
        patched.push(snapshot.phase)
        return { kind: "updated" as const, commentId: 10 }
      }),
      publishOverviewComment: vi.fn(async () => ({ kind: "updated" as const, commentId: 10 })),
    })

    reporter.report({ phase: "retrieval" })
    reporter.report({ phase: "specialists" })
    reporter.report({ phase: "synth" })
    await reporter.flush()

    expect(patched).toEqual(["retrieval", "synth"])
  })

  it("serializes the overview morph between synth and terminal status writes", async () => {
    let releaseSynth!: () => void
    let releaseOverview!: () => void
    const events: string[] = []
    const patchOverviewComment = vi.fn(async (snapshot: { phase: string }) => {
      events.push(`status:${snapshot.phase}:start`)
      if (snapshot.phase === "synth") {
        await new Promise<void>((resolve) => {
          releaseSynth = resolve
        })
      }
      events.push(`status:${snapshot.phase}:done`)
      return { kind: "updated" as const, commentId: 10 }
    })
    const publishOverviewComment = vi.fn(async () => {
      events.push("overview:start")
      await new Promise<void>((resolve) => {
        releaseOverview = resolve
      })
      events.push("overview:done")
      return { kind: "updated" as const, commentId: 10 }
    })
    const reporter = createReviewStatusReporter({
      runId: "run-1",
      headSha: HEAD_SHA,
      postStatusProgress: vi.fn(async (snapshot: { phase: string }) => ({
        accepted: true as const,
        phase: snapshot.phase as "synth" | "posted",
      })),
      patchOverviewComment,
      publishOverviewComment,
    })

    reporter.report({ phase: "synth" })
    const overview = reporter.publishOverview("## Sigilix Overview\n\nKeep me.")
    await vi.waitFor(() => expect(events).toEqual(["status:synth:start"]))
    expect(publishOverviewComment).not.toHaveBeenCalled()

    releaseSynth()
    await vi.waitFor(() => expect(events).toContain("overview:start"))
    reporter.report({
      phase: "posted",
      final: { status: "posted", findingsCount: 1 },
    })
    expect(events).not.toContain("status:posted:start")

    releaseOverview()
    await overview
    await reporter.flush()

    expect(events).toEqual([
      "status:synth:start",
      "status:synth:done",
      "overview:start",
      "overview:done",
      "status:posted:start",
      "status:posted:done",
    ])
  })
})

describe("patchExistingOverviewStatusComment", () => {
  it("updates the existing overview marker in place and preserves the overview body", async () => {
    const updateIssueComment = vi.fn(
      async (_owner: string, _repo: string, _commentId: number, _body: string) => undefined,
    )
    const client = {
      listIssueCommentsPage: vi.fn(async () => [
        {
          id: 44,
          body: `${OVERVIEW_MARKER}\n\n## Sigilix Overview\n\n### Summary\n\nKeep me.`,
        },
      ]),
      updateIssueComment,
    }

    const out = await patchExistingOverviewStatusComment({
      client: client as never,
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 7,
      snapshot: { phase: "specialists", headSha: HEAD_SHA, sequence: 3 },
    })

    expect(out).toEqual({ kind: "updated", commentId: 44 })
    expect(updateIssueComment).toHaveBeenCalledOnce()
    const body = updateIssueComment.mock.calls[0]![3]
    expect(body).toContain(REVIEW_STATUS_BLOCK_START)
    expect(body).toContain("Specialists")
    expect(body).toContain("Keep me.")
  })

  it("does not create a duplicate comment when the overview marker is missing", async () => {
    const client = {
      listIssueCommentsPage: vi.fn(async () => []),
      updateIssueComment: vi.fn(async () => undefined),
      createIssueComment: vi.fn(async () => ({ id: 99 })),
    }

    const out = await patchExistingOverviewStatusComment({
      client: client as never,
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 7,
      snapshot: { phase: "retrieval", headSha: HEAD_SHA, sequence: 2 },
    })

    expect(out).toEqual({ kind: "missing-overview" })
    expect(client.updateIssueComment).not.toHaveBeenCalled()
    expect(client.createIssueComment).not.toHaveBeenCalled()
  })
})

describe("publishOverviewStatusComment", () => {
  it("morphs a status-only sticky into the rich overview and preserves status", async () => {
    const statusBody = buildReviewStatusBlock({
      phase: "synth",
      headSha: HEAD_SHA,
      sequence: 4,
    })
    const updateIssueComment = vi.fn(
      async (_owner: string, _repo: string, _commentId: number, _body: string) => undefined,
    )
    const client = {
      listIssueCommentsPage: vi
        .fn()
        .mockResolvedValueOnce([{ id: 55, body: statusBody }])
        .mockResolvedValueOnce([]),
      updateIssueComment,
    }

    const out = await publishOverviewStatusComment({
      client: client as never,
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 7,
      body: `${OVERVIEW_MARKER}\n\n## Sigilix Overview\n\nKeep me.`,
    })

    expect(out).toEqual({ kind: "updated", commentId: 55 })
    expect(updateIssueComment).toHaveBeenCalledOnce()
    const body = updateIssueComment.mock.calls[0]![3]
    expect(body).toContain("## Sigilix Overview")
    expect(body).toContain(REVIEW_STATUS_BLOCK_START)
    expect(body).toContain("**Phase:** Synth")
  })
})
