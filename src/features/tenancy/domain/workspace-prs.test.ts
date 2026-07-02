// sig-workspace-prs — collapseWorkspacePrs unit tests.

import { describe, expect, it } from "vitest"
import { collapseWorkspacePrs, type WorkspacePrLedgerRow } from "./workspace-prs"

function row(overrides: Partial<WorkspacePrLedgerRow>): WorkspacePrLedgerRow {
  return {
    repo: "acme/api",
    prNumber: 1,
    headSha: "sha1",
    authorLogin: "octocat",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("collapseWorkspacePrs", () => {
  it("returns one entry per (repo, prNumber) with reviews=1 for a single review", () => {
    const result = collapseWorkspacePrs([row({})])
    expect(result).toEqual([
      {
        repo: "acme/api",
        prNumber: 1,
        headSha: "sha1",
        authorLogin: "octocat",
        reviews: 1,
        lastReviewedAt: "2026-06-01T00:00:00.000Z",
        url: "https://github.com/acme/api/pull/1",
      },
    ])
  })

  it("collapses multiple reviews of the same PR to the latest, counting reviews", () => {
    const result = collapseWorkspacePrs([
      row({ headSha: "sha-old", createdAt: "2026-06-01T00:00:00.000Z" }),
      row({ headSha: "sha-new", createdAt: "2026-06-03T00:00:00.000Z" }),
      row({ headSha: "sha-mid", createdAt: "2026-06-02T00:00:00.000Z" }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      headSha: "sha-new",
      reviews: 3,
      lastReviewedAt: "2026-06-03T00:00:00.000Z",
    })
  })

  it("keeps distinct PRs (same repo, different prNumber) as separate entries", () => {
    const result = collapseWorkspacePrs([row({ prNumber: 1 }), row({ prNumber: 2 })])
    expect(result).toHaveLength(2)
  })

  it("keeps distinct PRs (same prNumber, different repo) as separate entries", () => {
    const result = collapseWorkspacePrs([row({ repo: "acme/api" }), row({ repo: "acme/worker" })])
    expect(result).toHaveLength(2)
  })

  it("orders output newest-first by lastReviewedAt, regardless of input order", () => {
    const result = collapseWorkspacePrs([
      row({ prNumber: 1, createdAt: "2026-06-01T00:00:00.000Z" }),
      row({ prNumber: 2, createdAt: "2026-06-03T00:00:00.000Z" }),
      row({ prNumber: 3, createdAt: "2026-06-02T00:00:00.000Z" }),
    ])
    expect(result.map((r) => r.prNumber)).toEqual([2, 3, 1])
  })

  it("builds the GitHub PR url from repo + prNumber", () => {
    const result = collapseWorkspacePrs([row({ repo: "sigilix/portal", prNumber: 42 })])
    expect(result[0]!.url).toBe("https://github.com/sigilix/portal/pull/42")
  })

  it("preserves a null authorLogin", () => {
    const result = collapseWorkspacePrs([row({ authorLogin: null })])
    expect(result[0]!.authorLogin).toBeNull()
  })

  it("returns [] for an empty input", () => {
    expect(collapseWorkspacePrs([])).toEqual([])
  })
})
