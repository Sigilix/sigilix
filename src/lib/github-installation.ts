// Resolve the GitHub App installation ID for an owner/repo pair.
//
// The webhook-driven handlers (PR review, CI triage, GitHub @-mention)
// receive `installation.id` directly from the webhook payload. The Linear
// @-mention handler doesn't — when it sees a PR URL in a comment, it
// has to look up which installation can reach that repo.
//
// Lookup is keyed on a JSON-encoded env var:
//   `{"<owner>/<repo>": "<id>", "<owner>": "<id>"}`
//
// Order: exact `owner/repo` beats owner-only fallback. This matters for
// "selected repos" GitHub App installs — the owner-level entry might
// cover most repos but specific ones could 404, so prefer the explicit
// override when present.
//
// IDs are accepted as either string or number (env vars are strings,
// but JSON allows both shapes); we coerce to number internally.
//
// Bad JSON soft-fails to `no_installation` rather than throwing — the
// Linear handler treats this as "no PR fetch happens for this comment"
// and continues with retrieval-only context.

export type InstallationLookup =
  | { ok: true; installationId: number }
  | { ok: false; reason: "no_installation" }

interface InstallationMap {
  [key: string]: string | number
}

function parseMap(raw: string | undefined): InstallationMap | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as InstallationMap
  } catch {
    return null
  }
}

function coerceId(value: string | number | undefined): number | null {
  if (value === undefined) return null
  // Strings: only accept pure digit sequences. `Number.parseInt("123abc", 10)`
  // returns 123, which would silently route auth to the wrong installation.
  // Numbers: require a positive safe integer — `Number.isFinite(1.5)` is true,
  // and floats / NaN / Infinity / negatives must not be accepted as IDs.
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return null
    const n = Number(value)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function resolveInstallation(
  owner: string,
  repo: string,
  mapJson: string | undefined
): InstallationLookup {
  const map = parseMap(mapJson)
  if (!map) return { ok: false, reason: "no_installation" }

  const exactId = coerceId(map[`${owner}/${repo}`])
  if (exactId !== null) return { ok: true, installationId: exactId }

  const ownerId = coerceId(map[owner])
  if (ownerId !== null) return { ok: true, installationId: ownerId }

  return { ok: false, reason: "no_installation" }
}

/**
 * Iterate every `{owner, repo}` pair the team-repo map produces. Used
 * by env-validate to verify each is resolvable in the installation map.
 */
export function listTeamRepoMappings(
  teamRepoMapJson: string | undefined
): Array<{ teamKey: string; owner: string; repo: string }> {
  if (!teamRepoMapJson) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(teamRepoMapJson)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const out: Array<{ teamKey: string; owner: string; repo: string }> = []
  for (const [teamKey, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { owner?: unknown }).owner === "string" &&
      typeof (value as { repo?: unknown }).repo === "string"
    ) {
      const v = value as { owner: string; repo: string }
      out.push({ teamKey, owner: v.owner, repo: v.repo })
    }
  }
  return out
}

/**
 * The universe of repo namespaces the agent loop is allowed to query
 * via `retrieve_codebase`.
 *
 * ARC-239 (2026-05-16): source of truth is now the `repo-index-manifest:*`
 * KV prefix — written by ARC-235's indexer on first install + push
 * re-index, deleted by ARC-238's uninstall handler. This replaces the
 * prior `OPENCLAW_INDEXED_REPOS` env-var allowlist that had the same
 * silent-downgrade failure mode as ARC-232's removed allowlist: an
 * operator-managed env-var lag would lock customers out of retrieval
 * even though their repo was actually indexed.
 *
 * Returned slugs are always lowercased (Vectorize namespaces are
 * lowercased at index time — see scripts/index-repo.mjs and the
 * `repoIndexManifestKey` helper in `repo-index-manifest.ts`).
 *
 * Cloudflare KV's edge cache absorbs the read cost on hot paths
 * (the agent loop calls this once per invocation; same-region
 * reads hit the cache for ~60s by default). The 5-minute caching
 * layer suggested in the ARC-239 spec is therefore deferred —
 * KV's built-in caching is sufficient at our scale.
 */
export async function listIndexedRepos(env: {
  OPENCLAW_STATE: KVNamespace
}): Promise<string[]> {
  const PREFIX = "repo-index-manifest:"
  const out = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    let page: { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    try {
      page = await env.OPENCLAW_STATE.list({
        prefix: PREFIX,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      }) as { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }
    } catch (err) {
      // Symmetry with `deleteKvPrefix` in src/lib/index-delete.ts:
      // transient KV.list errors become a partial-result + log; the
      // queue handler retries the whole job. Returning the partial
      // set keeps the agent loop from blowing up on a momentary blip.
      console.error(JSON.stringify({
        event: "list-indexed-repos-failed",
        err: err instanceof Error ? err.message : String(err),
        partial_count: out.size,
      }))
      break
    }
    for (const key of page.keys) {
      const repo = key.name.slice(PREFIX.length)
      if (repo.length > 0) out.add(repo)
    }
    if (page.list_complete) break
    if (!page.cursor) {
      // SDK violation guard: `list_complete: false` with no cursor is
      // unreachable per Cloudflare KV's contract, but log if it ever
      // happens so we notice instead of silently truncating.
      console.warn(JSON.stringify({
        event: "list-indexed-repos-truncated-no-cursor",
        partial_count: out.size,
      }))
      break
    }
    cursor = page.cursor
  }
  return Array.from(out)
}

/**
 * Resolve the team-key → {owner, repo} mapping for the current Linear
 * team. Used by mention-reply.ts to power the `inferRepo()` callback
 * passed into extractPullRequestRefs.
 */
export function parseTeamGithubRepo(
  teamRepoMapJson: string | undefined,
  teamKey: string | null
): { owner: string; repo: string } | null {
  if (!teamRepoMapJson || !teamKey) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(teamRepoMapJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const value = (parsed as Record<string, unknown>)[teamKey]
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { owner?: unknown }).owner === "string" &&
    typeof (value as { repo?: unknown }).repo === "string"
  ) {
    const v = value as { owner: string; repo: string }
    return { owner: v.owner, repo: v.repo }
  }
  return null
}
