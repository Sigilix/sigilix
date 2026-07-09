// GitHub App authentication for the Worker. Signs an RS256 JWT with the
// App's private key, exchanges it for a per-installation access token, and
// caches the access token in KV. Comments / API calls made with the token
// post under the `@openclaw[bot]` identity rather than a developer's PAT.
//
// Ported from rema-portal/tools/openclaw/lib/github-app.mjs. Adapted to
// Web Crypto since Workers don't have node:crypto.createSign.
//
// Required secrets:
//   GITHUB_APP_ID            — numeric App ID from the App settings page
//   GITHUB_PRIVATE_KEY       — PEM-encoded RSA private key (PKCS#1 or PKCS#8)
//
// Installation id arrives on each webhook payload as `installation.id` —
// no env var needed. The Worker fans out across repos in the org by
// reusing whatever installation the inbound webhook came from.
//
// Security note: the private key is the App's master credential. Treat it
// like a root secret — rotate it via GitHub if leaked.
//
// PEM format compat: GitHub's "Generate a private key" button downloads
// PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`). Web Crypto only accepts
// PKCS#8 (`-----BEGIN PRIVATE KEY-----`). We wrap PKCS#1 inline so the
// operator can paste the GitHub download directly into wrangler secret.

const TOKEN_CACHE_PREFIX = "gh-installation-token:"
const REFRESH_BEFORE_MS = 5 * 60 * 1000 // refresh 5min before expiry
const JWT_TTL_SECONDS = 9 * 60 // GitHub caps App JWTs at 10min; leave 1min headroom
const JWT_SKEW_SECONDS = 60 // backdate iat to absorb local-clock drift

interface CachedToken {
  token: string
  expiresAt: number
}

interface InstallationTokenResponse {
  token?: string
  expires_at?: string
}

/**
 * Sign a GitHub App JWT (RS256). Algorithm is locked to RS256 — GitHub
 * rejects HS256 / ES256 / etc. Returns the compact JWT string.
 */
export async function signGitHubAppJwt(
  appId: string,
  privateKeyPem: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!appId) throw new Error("signGitHubAppJwt: missing appId")
  if (!privateKeyPem) throw new Error("signGitHubAppJwt: missing privateKeyPem")

  const key = await importRsaPrivateKey(privateKeyPem)

  const header = { alg: "RS256", typ: "JWT" }
  const payload = {
    iat: now - JWT_SKEW_SECONDS,
    exp: now + JWT_TTL_SECONDS,
    iss: String(appId),
  }

  const encoder = new TextEncoder()
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, encoder.encode(signingInput))

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

/**
 * Get an installation access token, using a cached value when fresh. Tokens
 * are cached per-installation in KV so cold-start cost is amortized across
 * webhooks targeting the same install. GitHub installation tokens last
 * about an hour; we refresh REFRESH_BEFORE_MS early to avoid serving a
 * token that's seconds from expiring.
 */
export async function getInstallationToken(args: {
  kv: KVNamespace
  appId: string
  privateKey: string
  installationId: number
}): Promise<string> {
  const cacheKey = `${TOKEN_CACHE_PREFIX}${args.installationId}`
  const cached = (await args.kv.get(cacheKey, "json")) as CachedToken | null
  if (
    cached &&
    typeof cached.token === "string" &&
    typeof cached.expiresAt === "number" &&
    cached.expiresAt > Date.now() + REFRESH_BEFORE_MS
  ) {
    return cached.token
  }

  const jwt = await signGitHubAppJwt(args.appId, args.privateKey)
  const res = await fetch(`https://api.github.com/app/installations/${args.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "sigilix-worker",
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub installation token fetch failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as InstallationTokenResponse
  if (typeof json.token !== "string" || typeof json.expires_at !== "string") {
    throw new Error(`GitHub installation token response missing fields: ${JSON.stringify(json).slice(0, 200)}`)
  }
  const expiresAt = Date.parse(json.expires_at)
  if (!Number.isFinite(expiresAt)) {
    throw new Error(`Could not parse expires_at: ${json.expires_at}`)
  }
  const ttlSeconds = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
  await args.kv.put(cacheKey, JSON.stringify({ token: json.token, expiresAt } satisfies CachedToken), {
    expirationTtl: ttlSeconds,
  })
  return json.token
}

/**
 * Import an RSA private key (PEM) into a CryptoKey usable with
 * RSASSA-PKCS1-v1_5 + SHA-256. Accepts both PKCS#1 (`BEGIN RSA PRIVATE KEY`,
 * GitHub's default download) and PKCS#8 (`BEGIN PRIVATE KEY`).
 */
async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const trimmed = pem.trim()
  let pkcs8Der: ArrayBuffer
  if (trimmed.includes("BEGIN RSA PRIVATE KEY")) {
    const pkcs1Der = pemBodyToBuffer(trimmed, "RSA PRIVATE KEY")
    pkcs8Der = wrapPkcs1AsPkcs8(pkcs1Der)
  } else if (trimmed.includes("BEGIN PRIVATE KEY")) {
    pkcs8Der = pemBodyToBuffer(trimmed, "PRIVATE KEY")
  } else {
    throw new Error("GITHUB_PRIVATE_KEY must be PEM (BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY)")
  }
  return crypto.subtle.importKey("pkcs8", pkcs8Der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
}

function pemBodyToBuffer(pem: string, label: string): ArrayBuffer {
  const begin = `-----BEGIN ${label}-----`
  const end = `-----END ${label}-----`
  const start = pem.indexOf(begin)
  const stop = pem.indexOf(end)
  if (start < 0 || stop < 0) {
    throw new Error(`PEM missing ${label} markers`)
  }
  const body = pem.slice(start + begin.length, stop).replace(/\s+/g, "")
  const decoded = base64Decode(body)
  // Copy into a fresh ArrayBuffer — see wrapPkcs1AsPkcs8 for the rationale.
  const out = new ArrayBuffer(decoded.byteLength)
  new Uint8Array(out).set(decoded)
  return out
}

/**
 * Wrap a PKCS#1 RSA private key (just the RSAPrivateKey ASN.1) as PKCS#8.
 * Web Crypto only accepts PKCS#8 for `importKey("pkcs8", …)`. The wrapper
 * is a fixed ASN.1 envelope: `PrivateKeyInfo SEQUENCE { version 0,
 * algorithm AlgorithmIdentifier(rsaEncryption, NULL), privateKey
 * OCTET STRING containing the PKCS#1 RSAPrivateKey } ` — well-known and
 * stable, hence inline here without an ASN.1 lib.
 */
function wrapPkcs1AsPkcs8(pkcs1: ArrayBuffer): ArrayBuffer {
  const pkcs1Bytes = new Uint8Array(pkcs1)
  // AlgorithmIdentifier: rsaEncryption (1.2.840.113549.1.1.1) + NULL params
  const algId = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ])
  const versionInt = new Uint8Array([0x02, 0x01, 0x00]) // INTEGER 0
  const octetHeader = encodeAsnLength(pkcs1Bytes.length, 0x04)
  const inner = concatBytes(versionInt, algId, octetHeader, pkcs1Bytes)
  const outer = concatBytes(encodeAsnLength(inner.length, 0x30), inner)
  // Copy into a fresh ArrayBuffer (Uint8Array.buffer can be SharedArrayBuffer
  // in some runtimes; Web Crypto only accepts plain ArrayBuffer for pkcs8).
  const out = new ArrayBuffer(outer.byteLength)
  new Uint8Array(out).set(outer)
  return out
}

function encodeAsnLength(length: number, tag: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([tag, length])
  if (length < 0x100) return new Uint8Array([tag, 0x81, length])
  if (length < 0x10000) return new Uint8Array([tag, 0x82, length >> 8, length & 0xff])
  if (length < 0x1000000) {
    return new Uint8Array([tag, 0x83, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff])
  }
  throw new Error(`encodeAsnLength: length too large (${length})`)
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
}

function base64Decode(input: string): Uint8Array {
  const binary = atob(input)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

/**
 * SIG-156: resolve the installation id for a repo via the App JWT
 * (`GET /repos/{owner}/{repo}/installation`). Used by the admin manual-index
 * endpoint + the backfill so a caller only needs owner/repo, not the numeric
 * installation id. Returns null when the app isn't installed on the repo or
 * the lookup fails (caller maps to 404).
 */
export async function resolveRepoInstallationId(
  appId: string,
  privateKeyPem: string,
  owner: string,
  repo: string,
): Promise<number | null> {
  // Fully fail-soft: ANY failure (JWT signing, network, non-OK HTTP, JSON
  // parse, missing/non-numeric id) returns null so the caller's "not
  // found/unavailable" (404) path is consistent — never a 500. The reason is
  // logged so an operator can still distinguish not-installed from a transient
  // GitHub error / wrong-or-expired key.
  try {
    const jwt = await signGitHubAppJwt(appId, privateKeyPem)
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "sigilix-worker",
        },
      },
    )
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          event: "resolve-repo-installation-failed",
          owner,
          repo,
          status: res.status,
        }),
      )
      return null
    }
    const json = (await res.json()) as { id?: unknown }
    return typeof json.id === "number" ? json.id : null
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "resolve-repo-installation-error",
        owner,
        repo,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }
}

const GH_API_HEADERS = (auth: string): Record<string, string> => ({
  accept: "application/vnd.github+json",
  authorization: auth,
  "x-github-api-version": "2022-11-28",
  "user-agent": "sigilix-worker",
})
const MAX_PAGES = 50 // hard cap (5000 installs / repos) — defensive

/** A paginated listing that reports whether the enumeration ran to completion. */
export interface ListingResult<T> {
  items: T[]
  /** false if any page errored / threw / the MAX_PAGES cap was hit — i.e. the
   *  result may be a partial subset. The backfill surfaces this so an operator
   *  knows to re-run rather than trust incomplete coverage. */
  complete: boolean
}

/**
 * SIG-156: list every GitHub App installation id via the App JWT
 * (`GET /app/installations`, paginated). Fail-soft — returns whatever pages
 * succeeded plus a `complete` flag (false on any error / cap hit).
 */
export async function listAppInstallationIds(appId: string, privateKeyPem: string): Promise<ListingResult<number>> {
  const items: number[] = []
  try {
    const jwt = await signGitHubAppJwt(appId, privateKeyPem)
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(`https://api.github.com/app/installations?per_page=100&page=${page}`, {
        headers: GH_API_HEADERS(`Bearer ${jwt}`),
      })
      if (!res.ok) {
        console.warn(JSON.stringify({ event: "list-app-installations-failed", page, status: res.status }))
        return { items, complete: false }
      }
      const arr = (await res.json()) as Array<{ id?: unknown }>
      if (!Array.isArray(arr) || arr.length === 0) return { items, complete: true }
      for (const inst of arr) if (typeof inst.id === "number") items.push(inst.id)
      if (arr.length < 100) return { items, complete: true }
      if (page === MAX_PAGES) {
        console.warn(JSON.stringify({ event: "list-app-installations-truncated", max_pages: MAX_PAGES }))
        return { items, complete: false }
      }
    }
    return { items, complete: false }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "list-app-installations-error",
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return { items, complete: false }
  }
}

/**
 * An App installation with the account it targets. `accountId` is the IMMUTABLE
 * numeric GitHub id (never reused/renamed — the safe principal to match a user
 * on); `accountLogin` is the mutable handle (kept for the org-members roster URL
 * + logging).
 */
export interface AppInstallation {
  id: number
  accountId: number
  accountLogin: string
  accountType: string
}

/**
 * sig-cli-login-org: list every App installation WITH its account (id + login +
 * type) via the App JWT (`GET /app/installations`, paginated). Same server-to-
 * server credential + fail-soft `complete` contract as {@link listAppInstallationIds}
 * — the difference is it keeps `account.id` / `account.login` / `account.type` so
 * a caller can match a user to the org/personal install they belong to WITHOUT
 * the user's own OAuth token (which may be expired). Fail-soft: returns whatever
 * pages succeeded plus `complete=false` on any error / cap hit.
 */
export async function listAppInstallations(
  appId: string,
  privateKeyPem: string,
): Promise<ListingResult<AppInstallation>> {
  const items: AppInstallation[] = []
  try {
    const jwt = await signGitHubAppJwt(appId, privateKeyPem)
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(`https://api.github.com/app/installations?per_page=100&page=${page}`, {
        headers: GH_API_HEADERS(`Bearer ${jwt}`),
      })
      if (!res.ok) {
        console.warn(JSON.stringify({ event: "list-app-installations-acct-failed", page, status: res.status }))
        return { items, complete: false }
      }
      const arr = (await res.json()) as Array<{
        id?: unknown
        account?: { id?: unknown; login?: unknown; type?: unknown } | null
      }>
      if (!Array.isArray(arr) || arr.length === 0) return { items, complete: true }
      for (const inst of arr) {
        if (typeof inst.id !== "number") continue
        const accountId = typeof inst.account?.id === "number" ? inst.account.id : 0
        const login = typeof inst.account?.login === "string" ? inst.account.login : ""
        const type = typeof inst.account?.type === "string" ? inst.account.type : ""
        items.push({ id: inst.id, accountId, accountLogin: login, accountType: type })
      }
      if (arr.length < 100) return { items, complete: true }
      if (page === MAX_PAGES) {
        console.warn(JSON.stringify({ event: "list-app-installations-acct-truncated", max_pages: MAX_PAGES }))
        return { items, complete: false }
      }
    }
    return { items, complete: false }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "list-app-installations-acct-error",
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return { items, complete: false }
  }
}

/**
 * sig-cli-login-org: the IMMUTABLE numeric ids of an organization's members via
 * the App installation token (`GET /orgs/{org}/members`, paginated). A sibling of
 * {@link listOrgMembers} that returns `id` (not login) so membership can be
 * checked against a session's immutable `githubUserId` rather than a mutable
 * handle. Fail-soft + `complete` flag; a 403/404 (App lacks "Members" read, or
 * not an org) yields `{ items: [], complete: false }`.
 */
export async function listOrgMemberIds(
  kv: KVNamespace,
  appId: string,
  privateKey: string,
  installationId: number,
  orgLogin: string,
): Promise<ListingResult<number>> {
  const items: number[] = []
  try {
    const token = await getInstallationToken({ kv, appId, privateKey, installationId })
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/members?per_page=100&page=${page}`,
        { headers: GH_API_HEADERS(`token ${token}`) },
      )
      if (!res.ok) {
        console.warn(
          JSON.stringify({
            event: "list-org-member-ids-failed",
            installation_id: installationId,
            page,
            status: res.status,
          }),
        )
        return { items, complete: false }
      }
      const arr = (await res.json()) as Array<{ id?: unknown }>
      if (!Array.isArray(arr) || arr.length === 0) return { items, complete: true }
      for (const m of arr) if (typeof m.id === "number") items.push(m.id)
      if (arr.length < 100) return { items, complete: true }
      if (page === MAX_PAGES) {
        console.warn(JSON.stringify({ event: "list-org-member-ids-truncated", installation_id: installationId }))
        return { items, complete: false }
      }
    }
    return { items, complete: false }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "list-org-member-ids-error",
        installation_id: installationId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return { items, complete: false }
  }
}

/** A GitHub account (org member or repo collaborator) as the org page needs it. */
export interface GitHubMember {
  login: string
  /** GitHub avatar URL from the API payload; "" when the payload omitted it. */
  avatarUrl: string
}

/**
 * sig-org-members: list an ORGANIZATION's members via the App installation
 * token (`GET /orgs/{org}/members`, paginated). Powers the portal Organization
 * → Members roster for an org install. Fail-soft + `complete` flag, mirroring
 * listInstallationRepoFullNames — a 403/404 (the App lacks the "Members" org
 * read permission, or the account isn't an org) returns `{ items: [], complete:
 * false }` so the caller degrades to the activity-derived seats rather than 5xx.
 */
export async function listOrgMembers(
  kv: KVNamespace,
  appId: string,
  privateKey: string,
  installationId: number,
  orgLogin: string,
): Promise<ListingResult<GitHubMember>> {
  const items: GitHubMember[] = []
  try {
    const token = await getInstallationToken({ kv, appId, privateKey, installationId })
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/members?per_page=100&page=${page}`,
        { headers: GH_API_HEADERS(`token ${token}`) },
      )
      if (!res.ok) {
        console.warn(
          JSON.stringify({
            event: "list-org-members-failed",
            installation_id: installationId,
            page,
            status: res.status,
          }),
        )
        return { items, complete: false }
      }
      const arr = (await res.json()) as Array<{ login?: unknown; avatar_url?: unknown }>
      if (!Array.isArray(arr) || arr.length === 0) return { items, complete: true }
      for (const m of arr) {
        if (typeof m.login === "string" && m.login !== "") {
          items.push({ login: m.login, avatarUrl: typeof m.avatar_url === "string" ? m.avatar_url : "" })
        }
      }
      if (arr.length < 100) return { items, complete: true }
      if (page === MAX_PAGES) {
        console.warn(JSON.stringify({ event: "list-org-members-truncated", installation_id: installationId }))
        return { items, complete: false }
      }
    }
    return { items, complete: false }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "list-org-members-error",
        installation_id: installationId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return { items, complete: false }
  }
}

/**
 * sig-org-members: list the deduped set of repo COLLABORATORS across every repo
 * an installation can access (`GET /repos/{owner}/{repo}/collaborators`,
 * installation-token auth). Used for a PERSONAL (`account.type: "User"`) install
 * where there is no org roster — the "members" are the people who can touch the
 * installed repos. Deduped case-insensitively (first-seen avatar wins). Fail-soft
 * + `complete` flag: any repo enumeration / page error marks the result partial
 * but keeps whatever was collected.
 */
export async function listInstallationCollaborators(
  kv: KVNamespace,
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<ListingResult<GitHubMember>> {
  const byLogin = new Map<string, GitHubMember>()
  const repos = await listInstallationRepoFullNames(kv, appId, privateKey, installationId)
  let complete = repos.complete
  try {
    const token = await getInstallationToken({ kv, appId, privateKey, installationId })
    for (const fullName of repos.items) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await fetch(`https://api.github.com/repos/${fullName}/collaborators?per_page=100&page=${page}`, {
          headers: GH_API_HEADERS(`token ${token}`),
        })
        if (!res.ok) {
          console.warn(
            JSON.stringify({
              event: "list-collaborators-failed",
              installation_id: installationId,
              repo: fullName,
              status: res.status,
            }),
          )
          complete = false
          break
        }
        const arr = (await res.json()) as Array<{ login?: unknown; avatar_url?: unknown }>
        if (!Array.isArray(arr) || arr.length === 0) break
        for (const c of arr) {
          if (typeof c.login !== "string" || c.login === "") continue
          const key = c.login.toLowerCase()
          if (!byLogin.has(key)) {
            byLogin.set(key, { login: c.login, avatarUrl: typeof c.avatar_url === "string" ? c.avatar_url : "" })
          }
        }
        if (arr.length < 100) break
        if (page === MAX_PAGES) complete = false
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "list-collaborators-error",
        installation_id: installationId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    complete = false
  }
  return { items: [...byLogin.values()], complete }
}

/**
 * SIG-156: list the `full_name`s of repos an installation can access
 * (`GET /installation/repositories`, paginated, installation-token auth).
 * Fail-soft + `complete` flag, mirroring listAppInstallationIds.
 */
export async function listInstallationRepoFullNames(
  kv: KVNamespace,
  appId: string,
  privateKey: string,
  installationId: number,
): Promise<ListingResult<string>> {
  const items: string[] = []
  try {
    const token = await getInstallationToken({ kv, appId, privateKey, installationId })
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(
        `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
        // Installation tokens use the `token` auth scheme (matches github.ts);
        // only the App JWT uses `Bearer`.
        { headers: GH_API_HEADERS(`token ${token}`) },
      )
      if (!res.ok) {
        console.warn(
          JSON.stringify({
            event: "list-installation-repos-failed",
            installation_id: installationId,
            page,
            status: res.status,
          }),
        )
        return { items, complete: false }
      }
      const json = (await res.json()) as { repositories?: Array<{ full_name?: unknown }> }
      const repos = json.repositories
      if (!Array.isArray(repos) || repos.length === 0) return { items, complete: true }
      for (const r of repos) if (typeof r.full_name === "string") items.push(r.full_name)
      if (repos.length < 100) return { items, complete: true }
      if (page === MAX_PAGES) {
        console.warn(
          JSON.stringify({
            event: "list-installation-repos-truncated",
            installation_id: installationId,
            max_pages: MAX_PAGES,
          }),
        )
        return { items, complete: false }
      }
    }
    return { items, complete: false }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "list-installation-repos-error",
        installation_id: installationId,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return { items, complete: false }
  }
}
