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
const MAX_RESPONSE_BYTES = 1_000_000

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
  total_count?: number
  repositories?: Repository[]
}

export interface GithubUserInstallationRepo {
  installationId: number
  repoId?: number
  owner: string
  repo: string
}

export interface GithubUserInstallationRepoWithId extends GithubUserInstallationRepo {
  repoId: number
}

export type GithubUserRepoScopeResult =
  | { ok: true; repos: GithubUserInstallationRepo[] }
  | { ok: false; reason: "lookup_failed" | "timeout" }

export type GithubUserInstallationReposForInstallationResult =
  | { ok: true; repos: GithubUserInstallationRepoWithId[] }
  | { ok: false; reason: "lookup_failed" | "timeout" }

function headers(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "sigilix-worker",
  }
}

function installationTokenHeaders(installationToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `token ${installationToken}`,
    "user-agent": "sigilix-worker",
  }
}

function splitFullName(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], repo: parts[1] }
}

function splitValidFullName(fullName: unknown): { owner: string; repo: string } | null {
  if (
    typeof fullName !== "string" ||
    fullName.length > 512 ||
    fullName.trim() !== fullName ||
    /[\s\u0000-\u001f\u007f]/u.test(fullName) ||
    hasUnpairedSurrogate(fullName)
  ) {
    return null
  }
  return splitFullName(fullName)
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true
    }
  }
  return false
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

async function fetchExactRepositoryPage(
  url: string,
  requestHeaders: HeadersInit,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<RepositoriesResponse> {
  const fetchOperation = fetchImpl(url, { headers: requestHeaders, signal })
  const response = await raceAbort(fetchOperation, signal, (lateResponse) => {
    void lateResponse.body?.cancel().catch(() => undefined)
  })
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(`github_http_${response.status}`)
  }
  return (await readJsonCapped(response, signal)) as RepositoriesResponse
}

type ExactRepositoryPageFetcher = (
  page: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
) => Promise<RepositoriesResponse>

async function readJsonCapped(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error("github_response_too_large")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("github_empty_response")
  const chunks: Uint8Array[] = []
  let total = 0
  let complete = false
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal)
      if (done) {
        complete = true
        break
      }
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error("github_response_too_large")
      chunks.push(value)
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      // A timed-out read may still hold the lock until cancellation settles.
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(merged)
  return JSON.parse(text) as unknown
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal, onLateResolve?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(Object.assign(new Error("GitHub repository lookup timed out"), { name: "AbortError" }))
    }
    void operation.then(
      (value) => {
        if (settled) {
          try {
            onLateResolve?.(value)
          } catch {
            // Late-result cleanup is best effort and must never reject unobserved.
          }
          return
        }
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function listExactInstallationRepositories(
  installationId: number,
  fetchPage: ExactRepositoryPageFetcher,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GithubUserInstallationReposForInstallationResult> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return { ok: false, reason: "lookup_failed" }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const repos: GithubUserInstallationRepoWithId[] = []
  const namesById = new Map<number, string>()
  const idsByName = new Map<string, number>()
  let expectedTotalCount: number | null = null
  try {
    for (let page = 1; page <= MAX_PAGES + 1; page++) {
      const body = await fetchPage(page, controller.signal, fetchImpl)
      if (
        !Number.isSafeInteger(body.total_count) ||
        Number(body.total_count) < 0 ||
        !Array.isArray(body.repositories) ||
        body.repositories.length > PER_PAGE
      ) {
        throw new Error("github_shape")
      }
      const totalCount = Number(body.total_count)
      if (expectedTotalCount === null) expectedTotalCount = totalCount
      else if (totalCount !== expectedTotalCount) throw new Error("github_total_count_changed")
      if (page > MAX_PAGES) {
        if (body.repositories.length === 0 && repos.length === expectedTotalCount) return { ok: true, repos }
        throw new Error("github_page_cap")
      }
      for (const repository of body.repositories) {
        if (!Number.isSafeInteger(repository.id) || Number(repository.id) <= 0) {
          throw new Error("github_repository_id")
        }
        const parsed = splitValidFullName(repository.full_name)
        if (!parsed) throw new Error("github_repository_name")
        const repoId = Number(repository.id)
        const normalizedName = `${parsed.owner}/${parsed.repo}`.toLowerCase()
        const priorName = namesById.get(repoId)
        const priorId = idsByName.get(normalizedName)
        if (priorName !== undefined) throw new Error("github_repository_duplicate_id")
        if (priorId !== undefined) throw new Error("github_repository_duplicate_name")
        namesById.set(repoId, normalizedName)
        idsByName.set(normalizedName, repoId)
        repos.push({ installationId, repoId, ...parsed })
      }
      if (body.repositories.length < PER_PAGE) {
        if (repos.length !== expectedTotalCount) throw new Error("github_total_count_mismatch")
        return { ok: true, repos }
      }
    }
    return { ok: false, reason: "lookup_failed" }
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "lookup_failed" }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * List the complete repository set visible to one user for one request-selected
 * installation. This user-scoped endpoint is intentionally distinct from the
 * app-installation wrapper below.
 */
export async function listGithubUserInstallationReposForInstallation(
  accessToken: string,
  installationId: number,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GithubUserInstallationReposForInstallationResult> {
  if (!accessToken) return { ok: false, reason: "lookup_failed" }
  return listExactInstallationRepositories(
    installationId,
    (page, signal, fetchImpl) =>
      fetchExactRepositoryPage(
        `https://api.github.com/user/installations/${installationId}/repositories?per_page=${PER_PAGE}&page=${page}`,
        headers(accessToken),
        signal,
        fetchImpl,
      ),
    options,
  )
}

/**
 * List the complete repository set installed for one GitHub App installation.
 * The caller must pass that installation's access token; no user-scoped repo
 * endpoint or aggregate installation enumeration is used.
 */
export async function listGithubAppInstallationRepos(
  installationToken: string,
  installationId: number,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GithubUserInstallationReposForInstallationResult> {
  if (!installationToken) return { ok: false, reason: "lookup_failed" }
  return listExactInstallationRepositories(
    installationId,
    (page, signal, fetchImpl) =>
      fetchExactRepositoryPage(
        `https://api.github.com/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
        installationTokenHeaders(installationToken),
        signal,
        fetchImpl,
      ),
    options,
  )
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
