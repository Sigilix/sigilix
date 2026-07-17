import { describe, expect, it, vi } from "vitest"
import {
  findExistingOverviewComment,
  OVERVIEW_MARKER,
  REVIEW_STATUS_BLOCK_END,
  REVIEW_STATUS_BLOCK_START,
} from "./triage-pr-overview-scan"

const statusBody = `${REVIEW_STATUS_BLOCK_START}\nReview finished\n${REVIEW_STATUS_BLOCK_END}`

describe("overview comment status fallback", () => {
  it("returns an owned status-only sticky instead of treating the PR as empty", async () => {
    const client = {
      listIssueCommentsPage: vi
        .fn()
        .mockResolvedValueOnce([{ id: 8100, body: statusBody }])
        .mockResolvedValueOnce([]),
    }

    await expect(findExistingOverviewComment(client as never, "Sigilix", "sigilix", 894)).resolves.toEqual({
      id: 8100,
      body: statusBody,
    })
  })

  it("prefers a real overview on a later page over an earlier status-only fallback", async () => {
    const overviewBody = `${OVERVIEW_MARKER}\nold walkthrough`
    const client = {
      listIssueCommentsPage: vi
        .fn()
        .mockResolvedValueOnce([{ id: 8200, body: statusBody }])
        .mockResolvedValueOnce([{ id: 8201, body: overviewBody }]),
    }

    await expect(findExistingOverviewComment(client as never, "Sigilix", "sigilix", 894)).resolves.toEqual({
      id: 8201,
      body: overviewBody,
    })
  })
})
