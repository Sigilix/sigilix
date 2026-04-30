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
  now: number = Math.floor(Date.now() / 1000)
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

  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    encoder.encode(signingInput)
  )

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
  const res = await fetch(
    `https://api.github.com/app/installations/${args.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "openclaw-worker",
      },
    }
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `GitHub installation token fetch failed: HTTP ${res.status} ${text.slice(0, 300)}`
    )
  }
  const json = (await res.json()) as InstallationTokenResponse
  if (typeof json.token !== "string" || typeof json.expires_at !== "string") {
    throw new Error(
      `GitHub installation token response missing fields: ${JSON.stringify(json).slice(0, 200)}`
    )
  }
  const expiresAt = Date.parse(json.expires_at)
  if (!Number.isFinite(expiresAt)) {
    throw new Error(`Could not parse expires_at: ${json.expires_at}`)
  }
  const ttlSeconds = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000))
  await args.kv.put(
    cacheKey,
    JSON.stringify({ token: json.token, expiresAt } satisfies CachedToken),
    { expirationTtl: ttlSeconds }
  )
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
    throw new Error(
      "GITHUB_PRIVATE_KEY must be PEM (BEGIN RSA PRIVATE KEY or BEGIN PRIVATE KEY)"
    )
  }
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  )
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
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
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
    return new Uint8Array([
      tag,
      0x83,
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff,
    ])
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
  return btoa(binary)
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

function base64Decode(input: string): Uint8Array {
  const binary = atob(input)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}
