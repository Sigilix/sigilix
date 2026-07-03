// sig-workspace-prs — read adapter backing GET /v1/workspace/prs (the
// portal's Pull-requests workspace page).
//
// Reads the most recent ~400 usage_ledger rows joined to repo.full_name,
// optionally scoped to a caller-owned set of installation ids. Grouping
// (collapsing multiple reviews of the same PR to the latest) is the pure
// domain function `collapseWorkspacePrs` in ../domain/workspace-prs.ts — this
// adapter only fetches the flat rows. The route caps the COLLAPSED output at
// 100 distinct PRs per section (see workspace-prs-route.ts) — this raw window
// is deliberately wider than that final cap (see RECENT_LIMIT below).
//
// Fail-soft by design (the workspace panel must never 500): a missing
// binding OR an empty scope short-circuits to `{ ok: true, rows: [] }`
// without touching D1; a genuine D1 error logs a warn and returns
// `{ ok: false }` so the route can distinguish "fault" from "genuinely no
// rows" while still rendering an empty panel either way.

import type { Env } from "@/src/shared/types/env"

// The cap applies to RAW ledger rows, before collapse — i.e. the window is
// "latest ~400 reviews", not "latest 400 distinct PRs". It is set wide
// relative to the route's 100-distinct-PR display cap specifically so that
// collapsing has room: on a busy installation a handful of hot PRs can rack
// up many review rows each, so a naive 1:1 raw-rows-to-displayed-PRs cap
// (i.e. RECENT_LIMIT == the display cap) would let those hot PRs crowd a
// less-active author's PR out of the raw window even though the COLLAPSED
// result would have had room for it. Widening the raw scan to 4x the display
// cap before collapsing (rather than collapsing in SQL — see
// ../domain/workspace-prs.ts's header for why grouping stays a pure,
// unit-tested TS function instead of a GROUP BY) makes that failure far less
// likely without giving up the domain-layer purity this codebase leans on. It
// is a mitigation, not a cure — an installation busy enough to fill even a
// 400-row raw window with hot-PR reviews could still crowd out a less-active
// author's older row. If that ever bites in practice, the real fix is a
// dedicated author-scoped query for `mine` rather than raising this further.
const RECENT_LIMIT = 400

export type WorkspacePrRawRow = {
  installationId: number
  repo: string
  prNumber: number
  headSha: string
  authorLogin: string | null
  createdAt: string
}

type RawQueryRow = {
  installationId: unknown
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
      "SELECT u.installation_id AS installationId, r.full_name AS repo, u.pr_number AS prNumber," +
      " u.head_sha AS headSha, u.author_login AS authorLogin, u.created_at AS createdAt" +
      " FROM usage_ledger u JOIN repo r ON r.repo_id = u.repo_id" +
      (installationIds === "all" ? "" : ` WHERE u.installation_id IN (${installationIds.map(() => "?").join(",")})`) +
      " ORDER BY u.created_at DESC LIMIT ?"

    const stmt =
      installationIds === "all"
        ? db.prepare(sql).bind(RECENT_LIMIT)
        : db.prepare(sql).bind(...installationIds, RECENT_LIMIT)

    const { results } = await stmt.all<RawQueryRow>()
    const rows: WorkspacePrRawRow[] = results.map((r) => ({
      installationId: Number(r.installationId) || 0,
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
