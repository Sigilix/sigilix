// sig-public-demo — the PUBLIC-ONLY GitHub reads behind POST /v1/demo/review.
//
// The demo is unauthenticated and reviews a stranger's PR, so the ONE thing this
// module exists to guarantee is: **we only ever read a public repository.**
//
//   - The reads go to api.github.com UNAUTHENTICATED by default. An unauthenticated
//     read of a private repo is a 404, so "public only" holds mechanically even if
//     the explicit check below were bypassed.
//   - `SIGILIX_DEMO_GITHUB_TOKEN` (optional, server-side ONLY) may be set to raise
//     GitHub's 60/hr unauthenticated per-IP rate limit. It must be a scopeless
//     read-only token. Because a mis-scoped token could otherwise reach private code,
//     `fetchPublicRepo` ALSO asserts `private === false` explicitly and refuses
//     anything else — belt and braces, so the public-only property does not depend on
//     how the token was minted.
//   - A token is NEVER accepted from the caller. There is no request field for one.
//
// Nothing here writes to GitHub. There is no write method in this module.

import { DEMO_MAX_DIFF_BYTES, type DemoEnv, type DemoPrTarget } from "@/src/lib/demo-review-guards"

const API_BASE = "https://api.github.com"
const USER_AGENT = "sigilix-demo-review"

/** Why a public read could not be served. Maps 1:1 onto the route's error codes. */
export type DemoGithubFailure =
  | { kind: "not_public" }
  | { kind: "not_found" }
  | { kind: "too_large" }
  | { kind: "unavailable"; detail: string }

export type DemoGithubResult<T> = { ok: true; value: T } | { ok: false; failure: DemoGithubFailure }

function headers(env: DemoEnv, accept: string): Record<string, string> {
  const token = env.SIGILIX_DEMO_GITHUB_TOKEN
  return {
    accept,
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

export interface DemoPrMeta {
  title: string
  headSha: string
  baseSha: string
  changedFiles: number
  changedLines: number
}

interface RepoWire {
  private?: unknown
  visibility?: unknown
}

interface PrWire {
  title?: unknown
  head?: { sha?: unknown }
  base?: { sha?: unknown }
  changed_files?: unknown
  additions?: unknown
  deletions?: unknown
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

/**
 * Assert the repo exists AND is public. A 404 (what an unauthenticated read of a
 * private/nonexistent repo returns) → `not_public`, so we never disclose whether a
 * private repo exists. A 200 whose `private` is anything but `false` → `not_public` too.
 * A 401/403 is an operational fault (our token / our rate limit), not the user's repo —
 * see the status handling below.
 */
export async function fetchPublicRepo(env: DemoEnv, target: DemoPrTarget): Promise<DemoGithubResult<true>> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/repos/${target.owner}/${target.repo}`, {
      headers: headers(env, "application/vnd.github+json"),
    })
  } catch (error) {
    return { ok: false, failure: { kind: "unavailable", detail: error instanceof Error ? error.message : "fetch" } }
  }
  // 404 is the ONLY status that means "private or nonexistent" (an unauthenticated —
  // or under-scoped — read of a private repo is a 404). A 401/403 here is an
  // OPERATIONAL fault (a bad SIGILIX_DEMO_GITHUB_TOKEN, or GitHub's per-egress-IP rate
  // limit exhausted) — NOT the user's repo being private. Reporting it as `not_public`
  // would accuse a legitimate public repo of being private and mask a spend/DoS alarm,
  // so it maps to `unavailable` (→ 502) and is logged loudly.
  if (response.status === 404) return { ok: false, failure: { kind: "not_public" } }
  if (response.status === 401 || response.status === 403) {
    console.error(
      JSON.stringify({
        event: "demo-github-auth-or-ratelimit",
        status: response.status,
        remaining: response.headers.get("x-ratelimit-remaining"),
      }),
    )
    return { ok: false, failure: { kind: "unavailable", detail: `repo lookup returned ${response.status}` } }
  }
  if (!response.ok) {
    return { ok: false, failure: { kind: "unavailable", detail: `repo lookup returned ${response.status}` } }
  }
  const body = (await response.json().catch(() => null)) as RepoWire | null
  if (!body || body.private !== false || (body.visibility !== undefined && body.visibility !== "public")) {
    return { ok: false, failure: { kind: "not_public" } }
  }
  return { ok: true, value: true }
}

/** PR metadata (title / head sha / size). Call ONLY after `fetchPublicRepo` says public. */
export async function fetchPrMeta(env: DemoEnv, target: DemoPrTarget): Promise<DemoGithubResult<DemoPrMeta>> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`, {
      headers: headers(env, "application/vnd.github+json"),
    })
  } catch (error) {
    return { ok: false, failure: { kind: "unavailable", detail: error instanceof Error ? error.message : "fetch" } }
  }
  if (response.status === 404) return { ok: false, failure: { kind: "not_found" } }
  if (!response.ok) {
    return { ok: false, failure: { kind: "unavailable", detail: `pull lookup returned ${response.status}` } }
  }
  const body = (await response.json().catch(() => null)) as PrWire | null
  const headSha = typeof body?.head?.sha === "string" ? body.head.sha : ""
  if (!body || headSha === "") {
    return { ok: false, failure: { kind: "unavailable", detail: "pull response missing head sha" } }
  }
  // FAIL CLOSED on the size fields: they drive the diff-size cap, so if GitHub omits
  // them we must NOT read them as 0 (which would silently pass an unbounded PR through
  // to the model). An absent count → `unavailable`, not a free pass. GitHub's pulls
  // endpoint always returns these, so this only fires on a malformed response.
  if (
    typeof body.changed_files !== "number" ||
    typeof body.additions !== "number" ||
    typeof body.deletions !== "number"
  ) {
    return { ok: false, failure: { kind: "unavailable", detail: "pull response missing size fields" } }
  }
  return {
    ok: true,
    value: {
      title: typeof body.title === "string" ? body.title : `${target.owner}/${target.repo}#${target.prNumber}`,
      headSha,
      baseSha: typeof body.base?.sha === "string" ? body.base.sha : headSha,
      changedFiles: num(body.changed_files),
      changedLines: num(body.additions) + num(body.deletions),
    },
  }
}

/**
 * The unified diff. GitHub answers 406 when the diff is too large for it to render —
 * which is exactly the expensive tail we already refuse, so it maps to `too_large`
 * rather than an outage. The byte cap is re-checked here because a PR can pass the
 * file/line caps and still carry a pathological single-line blob.
 */
export async function fetchPrDiff(env: DemoEnv, target: DemoPrTarget): Promise<DemoGithubResult<string>> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`, {
      headers: headers(env, "application/vnd.github.v3.diff"),
    })
  } catch (error) {
    return { ok: false, failure: { kind: "unavailable", detail: error instanceof Error ? error.message : "fetch" } }
  }
  if (response.status === 406) return { ok: false, failure: { kind: "too_large" } }
  if (response.status === 404) return { ok: false, failure: { kind: "not_found" } }
  if (!response.ok) {
    return { ok: false, failure: { kind: "unavailable", detail: `diff fetch returned ${response.status}` } }
  }
  const diff = await response.text()
  if (diff.length > DEMO_MAX_DIFF_BYTES) return { ok: false, failure: { kind: "too_large" } }
  if (diff.trim() === "") return { ok: false, failure: { kind: "unavailable", detail: "empty diff" } }
  return { ok: true, value: diff }
}
