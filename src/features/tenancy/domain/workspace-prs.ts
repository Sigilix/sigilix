// sig-workspace-prs — pure grouping logic for the portal's Pull-requests
// workspace page (GET /v1/workspace/prs).
//
// Takes a flat list of usage_ledger rows (one row per review, already joined
// to repo.full_name by the adapter) and collapses them to one entry per
// (repo, pr_number), keeping the most-recently-reviewed row's headSha +
// authorLogin and a running reviewCount. Pure — no D1, no clock, no IO — so
// it's unit-testable with plain inputs, per COMPLIANCE.md's domain-layer bar.
//
// `reviews` is the count of input rows collapsed into the group, which —
// because usage_ledger dedupes on UNIQUE(installation_id, repo_id,
// pr_number, head_sha) via INSERT OR IGNORE (see d1-usage-ledger.ts) — is
// really "distinct commits reviewed", not "review invocations" (a re-review
// of the same commit never increments it), and is bounded by whatever window
// the adapter fed in (see d1-workspace-prs-read.ts's RECENT_LIMIT comment).
//
// Input order is NOT assumed sorted: `lastReviewedAt` is the per-group max
// createdAt (ties keep the earliest-seen row, an arbitrary but stable choice),
// and the OUTPUT is explicitly sorted newest-first by lastReviewedAt. Plain
// string comparison is index-safe here because every write uses
// `new Date().toISOString()` (see d1-usage-read.ts's header comment), which
// sorts lexicographically identically to chronologically.

export interface WorkspacePrLedgerRow {
  repo: string
  prNumber: number
  headSha: string
  authorLogin: string | null
  createdAt: string
}

export interface WorkspacePrSummary {
  repo: string
  prNumber: number
  headSha: string
  authorLogin: string | null
  reviews: number
  lastReviewedAt: string
  url: string
}

/** Collapses raw ledger rows to one summary per (repo, prNumber), newest-first. */
export function collapseWorkspacePrs(rows: WorkspacePrLedgerRow[]): WorkspacePrSummary[] {
  const groups = new Map<string, { latest: WorkspacePrLedgerRow; reviews: number }>()
  for (const row of rows) {
    const key = `${row.repo}#${row.prNumber}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { latest: row, reviews: 1 })
      continue
    }
    existing.reviews += 1
    if (row.createdAt > existing.latest.createdAt) existing.latest = row
  }

  return Array.from(groups.values())
    .map(({ latest, reviews }) => ({
      repo: latest.repo,
      prNumber: latest.prNumber,
      headSha: latest.headSha,
      authorLogin: latest.authorLogin,
      reviews,
      lastReviewedAt: latest.createdAt,
      url: `https://github.com/${latest.repo}/pull/${latest.prNumber}`,
    }))
    .sort((a, b) => (a.lastReviewedAt < b.lastReviewedAt ? 1 : a.lastReviewedAt > b.lastReviewedAt ? -1 : 0))
}
