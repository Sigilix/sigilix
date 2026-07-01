// #158 (model-gateway failover chain) — a minimal, self-contained AWS Signature
// Version 4 signer for the Bedrock leg (scaffold, disabled until AWS creds
// exist — see fallback-chain.ts / bedrock-chat.ts). No new dependency: Cloudflare
// Workers ships Web Crypto (`crypto.subtle`), which is all SigV4 needs
// (SHA-256 digest + HMAC-SHA256) — the same pattern this repo already uses for
// RS256 JWT signing in vertex-token.ts/oidc.ts, just a different algorithm.
//
// Implements the canonical algorithm from AWS's "Signature Calculations" spec:
// canonical request -> string to sign -> derived signing key -> signature.
// aws-sigv4.test.ts re-derives the same steps independently with node:crypto
// (not by calling into this module) and asserts byte-identical output, so a
// transcription bug here would show up as a test failure rather than a
// silent bad signature.
//
// Deliberately narrow: signs a single POST request with a JSON body and the
// headers Bedrock's Converse endpoint needs (host, content-type, x-amz-date,
// x-amz-content-sha256). Not a general-purpose SigV4 library — if a future
// leg needs GET/query-string signing, extend it then.

const ALGORITHM = "AWS4-HMAC-SHA256"

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))
  return toHex(digest)
}

/** Raw HMAC-SHA256 — returns the MAC bytes (not hex), for signing-key chaining. */
async function hmacRaw(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyBytes = key instanceof Uint8Array ? key : new Uint8Array(key)
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data))
}

async function hmacHex(key: ArrayBuffer | Uint8Array, data: string): Promise<string> {
  return toHex(await hmacRaw(key, data))
}

/** amzDate: `YYYYMMDDTHHMMSSZ`; dateStamp: `YYYYMMDD` — both derived from one Date. */
function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "") // -> YYYYMMDDTHHMMSSZ
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

export interface SignAwsRequestArgs {
  method: "POST"
  url: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  /** Extra headers beyond host/x-amz-date/x-amz-content-sha256 to sign — e.g. content-type. */
  extraHeaders?: Record<string, string>
  body: string
  /** Injectable clock for deterministic tests; defaults to `new Date()`. */
  now?: Date
}

export interface SignedAwsRequest {
  /** Every header the caller must send, INCLUDING Authorization. Keys are lowercase. */
  headers: Record<string, string>
}

/**
 * Sign a single POST request per AWS SigV4. Returns the full header set to send
 * (Authorization + x-amz-date + x-amz-content-sha256 + host + any extraHeaders,
 * all lowercased) — the caller passes these straight to `fetch`.
 */
export async function signAwsRequestV4(args: SignAwsRequestArgs): Promise<SignedAwsRequest> {
  const { method, url, region, service, accessKeyId, secretAccessKey, body } = args
  const parsed = new URL(url)
  const { amzDate, dateStamp } = formatAmzDate(args.now ?? new Date())
  const payloadHash = await sha256Hex(body)

  const canonicalUri = parsed.pathname || "/"
  // Query-string signing isn't implemented (no leg needs it yet) — a query string
  // here would silently produce a WRONG signature (AWS requires it in the
  // canonical request), so fail loudly rather than mint a bad signature.
  if (parsed.search) throw new Error("signAwsRequestV4: query strings are not supported")

  const extra = args.extraHeaders ?? {}
  const headersToSign: Record<string, string> = {
    host: parsed.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const signedHeaderNames = Object.keys(headersToSign).sort()
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headersToSign[name]}\n`).join("")
  const signedHeaders = signedHeaderNames.join(";")

  const canonicalRequest = [
    method,
    canonicalUri,
    "", // canonical query string (none — see the throw above)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [ALGORITHM, amzDate, credentialScope, await sha256Hex(canonicalRequest)].join("\n")

  const kDate = await hmacRaw(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp)
  const kRegion = await hmacRaw(kDate, region)
  const kService = await hmacRaw(kRegion, service)
  const kSigning = await hmacRaw(kService, "aws4_request")
  const signature = await hmacHex(kSigning, stringToSign)

  const authorization =
    `${ALGORITHM} Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    headers: {
      ...headersToSign,
      authorization,
    },
  }
}
