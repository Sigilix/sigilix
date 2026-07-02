// sig-workspace-prs — read adapter backing GET /v1/workspace/prs (the
// portal's Pull-requests workspace page).
//
// Reads the most recent ~100 usage_ledger rows joined to repo.full_name,
// optionally scoped to a caller-owned set of installation ids. Grouping
// (collapsing multiple reviews of the same PR to the latest) is the pure
// domain function `collapseWorkspacePrs` in ../domain/workspace-prs.ts — this
// adapter only fetches the flat rows.
//
// Fail-soft by design (the workspace panel must never 500): a missing
// binding OR an empty scope short-circuits to `{ ok: true, rows: [] }`
// without touching D1; a genuine D1 error logs a warn and returns
// `{ ok: false }` so the route can distinguish "fault" from "genuinely no
// rows" while still rendering an empty panel either way.

import type { Env } from "@/src/shared/types/env"

// The 100-row cap applies to RAW ledger rows, before collapse — i.e. the
// window is "latest ~100 reviews", not "latest 100 distinct PRs". On a busy
// installation, a handful of hot PRs can consume the whole window, so a
// less-active author's PR (feeding the route's `mine` section) can legitimately
// fall outside it even though it was reviewed recently. Known/accepted
// tradeoff for a "recent activity" panel — flagged here rather than silently
// baked in, in case `mine`'s completeness needs a dedicated author-scoped
// query later.
const RECENT_LIMIT = 100

export type WorkspacePrRawRow = {
  repo: string
  prNumber: number
  headSha: string
  authorLogin: string | null
  createdAt: string
}

type RawQueryRow = {
  repo: unknown
  prNumber: unknown
  headSha: unknown
  authorLogin: unknown
  createdAt: unknown
}

/**
 * `installationIds === "all"` mirrors the legacy global-key sentinel
 * semantics (see api-key-resolver.ts's LEGACY_TENANT_INSTALLATION_ID /
 * callerOwnsInstallation) — that caller is Sigilix-internal, never handed to
 * an external tenant, so it deliberately sees every installation's rows. Any
 * other caller passes its own owned installation id(s) and the query is
 * scoped with `WHERE installation_id IN (...)` — one tenant can never read
 * another's rows through this adapter.
 */
export async function readRecentWorkspacePrs(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationIds: number[] | "all",
): Promise<{ ok: true; rows: WorkspacePrRawRow[] } | { ok: false }> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: true, rows: [] }
  if (installationIds !== "all" && installationIds.length === 0) return { ok: true, rows: [] }

  const db = env.SIGILIX_PLATFORM_DB
  try {
    const sql =
      "SELECT r.full_name AS repo, u.pr_number AS prNumber, u.head_sha AS headSha," +
      " u.author_login AS authorLogin, u.created_at AS createdAt" +
      " FROM usage_ledger u JOIN repo r ON r.repo_id = u.repo_id" +
      (installationIds === "all" ? "" : ` WHERE u.installation_id IN (${installationIds.map(() => "?").join(",")})`) +
      " ORDER BY u.created_at DESC LIMIT ?"

    const stmt =
      installationIds === "all"
        ? db.prepare(sql).bind(RECENT_LIMIT)
        : db.prepare(sql).bind(...installationIds, RECENT_LIMIT)

    const { results } = await stmt.all<RawQueryRow>()
    const rows: WorkspacePrRawRow[] = results.map((r) => ({
      repo: typeof r.repo === "string" ? r.repo : "",
      prNumber: Number(r.prNumber) || 0,
      headSha: typeof r.headSha === "string" ? r.headSha : "",
      authorLogin: typeof r.authorLogin === "string" ? r.authorLogin : null,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    }))
    return { ok: true, rows }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-workspace-prs-read-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false }
  }
}
