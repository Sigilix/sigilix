// Linear OAuth client_credentials flow for app-actor tokens.
//
// When LINEAR_OAUTH_CLIENT_ID + LINEAR_OAUTH_CLIENT_SECRET are configured,
// the Worker fetches a 30-day app-actor access token from Linear's OAuth
// endpoint. Comments and field updates made with that token are attributed
// to the OAuth app (e.g. "OpenClaw") rather than the human owner of the
// personal API key — which is the only way to get a bot identity in Linear.
//
// Tokens are cached in KV with the same TTL Linear returns. Refresh starts
// REFRESH_BEFORE_MS ahead of expiry so the Worker never serves a request
// with a token that's seconds from expiring.

const TOKEN_ENDPOINT = "https://api.linear.app/oauth/token"
const TOKEN_CACHE_KEY = "oauth:app-actor-token"
const REFRESH_BEFORE_MS = 5 * 24 * 60 * 60 * 1000 // 5 days
const SCOPES = "read,write,comments:create,issues:create"

interface CachedToken {
  accessToken: string
  expiresAt: number // ms epoch
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  token_type?: string
}

export async function getAppActorToken(kv: KVNamespace, clientId: string, clientSecret: string): Promise<string> {
  const cached = (await kv.get(TOKEN_CACHE_KEY, "json")) as CachedToken | null
  if (
    cached &&
    typeof cached.accessToken === "string" &&
    typeof cached.expiresAt === "number" &&
    cached.expiresAt > Date.now() + REFRESH_BEFORE_MS
  ) {
    return cached.accessToken
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: SCOPES,
    client_id: clientId,
    client_secret: clientSecret,
  })
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Linear OAuth token fetch failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as TokenResponse
  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error(`Linear OAuth token response missing fields: ${JSON.stringify(json).slice(0, 200)}`)
  }

  const expiresAt = Date.now() + json.expires_in * 1000
  const record: CachedToken = { accessToken: json.access_token, expiresAt }
  await kv.put(TOKEN_CACHE_KEY, JSON.stringify(record), {
    expirationTtl: json.expires_in,
  })
  return json.access_token
}
