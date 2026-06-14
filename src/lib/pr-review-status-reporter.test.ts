import { describe, expect, it, vi } from "vitest"
import { createReviewStatusReporter, patchExistingOverviewStatusComment } from "@/src/lib/pr-review-status-reporter"
import { REVIEW_STATUS_BLOCK_START } from "@/src/lib/pr-review-status-render"
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
    })

    reporter.report({ phase: "retrieval" })
    reporter.report({ phase: "specialists" })
    reporter.report({ phase: "synth" })
    await reporter.flush()

    expect(patched).toEqual(["retrieval", "synth"])
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
