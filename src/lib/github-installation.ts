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
