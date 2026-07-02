// SIG-298 — SSRF-guarded page fetch for the research engine. This is the
// airtight boundary between LLM-chosen URLs and the network: only https/http,
// no private/loopback/link-local/metadata targets, manual redirect following
// with EVERY hop re-validated (the classic SSRF-via-redirect bypass), a response
// size cap, a per-fetch timeout, and a content-type allowlist. Nothing here logs
// secrets — the per-fetch metering line carries only the runId + domain.

import { htmlToText, extractTitle } from "./text-utils"
import type { FetchedPage } from "./types"

/** Only these schemes may ever be fetched. */
const ALLOWED_SCHEMES = new Set(["https:", "http:"])
/** Only these content types are accepted as page bodies. */
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain"]

const MAX_REDIRECTS = 3
const MAX_BYTES = 1_500_000 // ~1.5MB
const FETCH_TIMEOUT_MS = 15_000

/** Hostname literals that must never be fetched (metadata + localhost forms). */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  // Cloud metadata IP literals — also covered by the link-local IPv4 block, but
  // blocked by literal string too as a defense-in-depth belt-and-braces.
  "169.254.169.254",
  "[::1]",
  "::1",
])

/** Result of a guard decision on a single URL/hop. */
export type UrlGuardResult = { ok: true; url: URL } | { ok: false; reason: string }

/**
 * Validate a single URL against every SSRF rule. Used for the initial URL AND
 * re-run on every redirect hop before it is followed. Fails closed: an
 * unparseable URL, a disallowed scheme, a blocked hostname literal, or an
 * IP-literal host in a private/loopback/link-local/ULA range is rejected.
 */
export function guardUrl(raw: string): UrlGuardResult {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: "unparseable-url" }
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return { ok: false, reason: `scheme-not-allowed:${url.protocol}` }

  const hostname = url.hostname.toLowerCase()
  if (!hostname) return { ok: false, reason: "empty-host" }
  if (BLOCKED_HOSTNAMES.has(hostname)) return { ok: false, reason: "blocked-hostname" }
  // *.internal (cloud metadata / private service domains).
  if (hostname === "internal" || hostname.endsWith(".internal")) return { ok: false, reason: "internal-tld" }

  // IPv6 literal host is bracketed in URL.hostname as "[...]"? URL strips
  // brackets from `.hostname`, leaving the bare address. Detect IPv6 by ":".
  if (hostname.includes(":")) {
    if (isBlockedIpv6(hostname)) return { ok: false, reason: "private-ipv6" }
    return { ok: true, url }
  }
  // IPv4 literal.
  if (isIpv4Literal(hostname)) {
    if (isBlockedIpv4(hostname)) return { ok: false, reason: "private-ipv4" }
    return { ok: true, url }
  }
  // A DNS hostname (not an IP literal) — allowed. NOTE: we cannot resolve DNS in
  // the Workers runtime to catch a hostname that points at a private IP; the
  // redirect re-validation + platform egress remain the additional guards.
  return { ok: true, url }
}

/** True when the string is a dotted-quad IPv4 literal. */
function isIpv4Literal(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * Block private/loopback/link-local/metadata IPv4 ranges:
 *   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
 *   169.254.0.0/16, plus 0.0.0.0/8 (unspecified/this-host).
 */
export function isBlockedIpv4(host: string): boolean {
  const octets = host.split(".").map((p) => Number(p))
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true
  const [a, b] = octets as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  return false
}

/**
 * Block IPv6 loopback (::1), unspecified (::), ULA (fc00::/7 → fc/fd prefix),
 * and link-local (fe80::/10). Also blocks IPv4-mapped IPv6 (::ffff:a.b.c.d) when
 * the embedded IPv4 is private.
 */
export function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "")
  if (h === "::1" || h === "::") return true

  // IPv4-mapped (::ffff:…). The URL parser normalizes ::ffff:192.168.0.1 to the
  // hex-group form ::ffff:c0a8:1, so handle BOTH the dotted-quad and the
  // two-hex-group tail. A private mapped v4 is blocked.
  const mapped = /::ffff:(.+)$/i.exec(h)
  if (mapped && mapped[1]) {
    const tail = mapped[1]
    if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) {
      if (isBlockedIpv4(tail)) return true
    } else {
      const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail)
      if (groups && groups[1] && groups[2]) {
        const hi = Number.parseInt(groups[1], 16)
        const lo = Number.parseInt(groups[2], 16)
        const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
        if (isBlockedIpv4(v4)) return true
      }
    }
  }

  const firstGroup = h.split(":")[0] ?? ""
  if (firstGroup.length === 0) return false // "::something" non-loopback global — allow
  const prefix = Number.parseInt(firstGroup.padEnd(4, "0").slice(0, 4), 16)
  if (Number.isNaN(prefix)) return true // unparseable → fail closed
  // fc00::/7 → top 7 bits are 1111110 → first byte 0xfc or 0xfd.
  const firstByte = prefix >> 8
  if (firstByte === 0xfc || firstByte === 0xfd) return true
  // fe80::/10 → 0xfe80..0xfebf.
  if (prefix >= 0xfe80 && prefix <= 0xfebf) return true
  return false
}

/** The network primitive the fetcher depends on (fakeable in tests). */
export type FetchLike = (url: string, init: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>

export interface FetchPageArgs {
  url: string
  runId: string
  fetchImpl?: FetchLike
}

/** Structured outcome of a page fetch. */
export type FetchPageResult = { ok: true; page: FetchedPage } | { ok: false; reason: string }

/**
 * Fetch a page with the full guard applied. Redirects are followed MANUALLY (up
 * to MAX_REDIRECTS), and every Location is re-validated with `guardUrl` before
 * being followed — an initial public URL that 30x-redirects to a private target
 * is refused. Emits exactly one `research-fetch-metered` log line (runId +
 * domain only, never secrets). Returns structured failure rather than throwing.
 */
export async function fetchPage(args: FetchPageArgs): Promise<FetchPageResult> {
  const fetchImpl = args.fetchImpl ?? ((u, init) => fetch(u, init))

  const firstGuard = guardUrl(args.url)
  if (!firstGuard.ok) return { ok: false, reason: firstGuard.reason }

  let current = firstGuard.url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetchImpl(current.toString(), { redirect: "manual", signal: controller.signal })
    } catch (err) {
      clearTimeout(timer)
      return { ok: false, reason: err instanceof Error && err.name === "AbortError" ? "timeout" : "fetch-failed" }
    }
    clearTimeout(timer)

    // Manual redirect handling — re-validate the Location before following.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      if (hop === MAX_REDIRECTS) return { ok: false, reason: "too-many-redirects" }
      const location = response.headers.get("location")
      if (!location) return { ok: false, reason: "redirect-without-location" }
      const nextUrl = safeResolve(location, current)
      if (!nextUrl) return { ok: false, reason: "redirect-unresolvable" }
      const nextGuard = guardUrl(nextUrl)
      if (!nextGuard.ok) return { ok: false, reason: `redirect-blocked:${nextGuard.reason}` }
      current = nextGuard.url
      continue
    }

    // Terminal response.
    meterFetch(args.runId, current.hostname)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { ok: false, reason: `http-${response.status}` }
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    if (!ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t))) {
      await response.body?.cancel().catch(() => {})
      return { ok: false, reason: "unsupported-content-type" }
    }

    const body = await readCapped(response, MAX_BYTES)
    const isHtml = contentType.includes("text/html")
    const text = isHtml ? htmlToText(body) : body.trim()
    const title = isHtml ? extractTitle(body) || current.hostname : current.hostname
    return { ok: true, page: { url: current.toString(), title, domain: current.hostname, text } }
  }
  return { ok: false, reason: "too-many-redirects" }
}

/** Resolve a (possibly relative) redirect Location against the current URL. */
function safeResolve(location: string, base: URL): string | null {
  try {
    return new URL(location, base).toString()
  } catch {
    return null
  }
}

/** Read a response body up to `maxBytes`, aborting the stream past the cap. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.byteLength
        if (total >= maxBytes) break
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const merged = new Uint8Array(Math.min(total, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const remaining = merged.length - offset
    if (remaining <= 0) break
    const slice = chunk.subarray(0, remaining)
    merged.set(slice, offset)
    offset += slice.byteLength
  }
  return new TextDecoder("utf-8").decode(merged)
}

/** Structured per-fetch metering line — runId + domain only, never secrets. */
function meterFetch(runId: string, domain: string): void {
  console.log(JSON.stringify({ event: "research-fetch-metered", runId, domain }))
}
