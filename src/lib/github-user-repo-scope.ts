// Session-to-repository authorization for repo-grounded chat.
//
// A visible GitHub App installation is not enough to authorize every repo under
// its owner: installations can be limited to selected repositories. This seam
// therefore walks BOTH the authenticated user's installations and each
// installation's exact repository list. The result is safe to intersect with
// indexed manifests; partial/error results are never returned as authorization.

const MAX_PAGES = 20
const PER_PAGE = 100
const DEFAULT_TIMEOUT_MS = 5_000

interface Installation {
  id?: number
}

interface InstallationsResponse {
  installations?: Installation[]
}

interface Repository {
  id?: number
  full_name?: string
}

interface RepositoriesResponse {
  repositories?: Repository[]
}

export interface GithubUserInstallationRepo {
  installationId: number
  repoId?: number
  owner: string
  repo: string
}

export type GithubUserRepoScopeResult =
  | { ok: true; repos: GithubUserInstallationRepo[] }
  | { ok: false; reason: "lookup_failed" | "timeout" }

function headers(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

function splitFullName(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}

async function fetchJson<T>(
  url: string,
  accessToken: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(url, { headers: headers(accessToken), signal })
  if (!response.ok) throw new Error(`github_http_${response.status}`)
  return (await response.json()) as T
}

async function listInstallationIds(
  accessToken: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<number[]> {
  const ids: number[] = []
  // One sentinel page distinguishes exactly MAX_PAGES full pages from a result
  // that exceeds the bound. Page shape, not mutable total_count, is authoritative.
  for (let page = 1; page <= MAX_PAGES + 1; page++) {
    const body = await fetchJson<InstallationsResponse>(
      `https://api.github.com/user/installations?per_page=${PER_PAGE}&page=${page}`,
      accessToken,
      signal,
      fetchImpl,
    )
    if (!Array.isArray(body.installations)) throw new Error("github_shape")
    if (page > MAX_PAGES) {
      if (body.installations.length === 0) return [...new Set(ids)]
      throw new Error("github_page_cap")
    }
    for (const installation of body.installations) {
      if (typeof installation.id === "number" && Number.isInteger(installation.id) && installation.id > 0) {
        ids.push(installation.id)
      }
    }
    if (body.installations.length < PER_PAGE) return [...new Set(ids)]
  }
  throw new Error("github_page_cap")
}

async function listInstallationRepos(
  accessToken: string,
  installationId: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<GithubUserInstallationRepo[]> {
  const repos: GithubUserInstallationRepo[] = []
  for (let page = 1; page <= MAX_PAGES + 1; page++) {
    const body = await fetchJson<RepositoriesResponse>(
      `https://api.github.com/user/installations/${installationId}/repositories?per_page=${PER_PAGE}&page=${page}`,
      accessToken,
      signal,
      fetchImpl,
    )
    if (!Array.isArray(body.repositories)) throw new Error("github_shape")
    if (page > MAX_PAGES) {
      if (body.repositories.length === 0) return repos
      throw new Error("github_page_cap")
    }
    for (const repository of body.repositories) {
      if (typeof repository.full_name !== "string") continue
      const parsed = splitFullName(repository.full_name)
      if (parsed) {
        repos.push({
          installationId,
          ...(Number.isSafeInteger(repository.id) && Number(repository.id) > 0
            ? { repoId: Number(repository.id) }
            : {}),
          ...parsed,
        })
      }
    }
    if (body.repositories.length < PER_PAGE) return repos
  }
  throw new Error("github_page_cap")
}

/**
 * List the exact repositories the session's GitHub user token can access through
 * the App. One total timeout bounds every page and installation. Any incomplete
 * lookup fails closed, so a partial response can never widen repo authorization.
 */
export async function listGithubUserInstallationRepos(
  accessToken: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GithubUserRepoScopeResult> {
  if (!accessToken) return { ok: false, reason: "lookup_failed" }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    const installationIds = await listInstallationIds(accessToken, controller.signal, fetchImpl)
    const repos: GithubUserInstallationRepo[] = []
    for (const installationId of installationIds) {
      repos.push(...(await listInstallationRepos(accessToken, installationId, controller.signal, fetchImpl)))
    }
    const deduped = new Map<string, GithubUserInstallationRepo>()
    for (const repo of repos) deduped.set(`${repo.installationId}:${repo.owner}/${repo.repo}`.toLowerCase(), repo)
    return { ok: true, repos: [...deduped.values()] }
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "lookup_failed" }
  } finally {
    clearTimeout(timeout)
  }
}
