import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { guardUrl, isBlockedIpv4, isBlockedIpv6, fetchPage, type FetchLike } from "./fetch-guard"

describe("guardUrl — scheme + hostname rules", () => {
  it("allows a normal public https URL", () => {
    const r = guardUrl("https://example.com/docs")
    expect(r.ok).toBe(true)
  })

  it("rejects non-http(s) schemes", () => {
    expect(guardUrl("ftp://example.com").ok).toBe(false)
    expect(guardUrl("file:///etc/passwd").ok).toBe(false)
    expect(guardUrl("gopher://x").ok).toBe(false)
  })

  it("rejects localhost + *.internal + metadata hostnames", () => {
    expect(guardUrl("http://localhost/").ok).toBe(false)
    expect(guardUrl("http://foo.internal/").ok).toBe(false)
    expect(guardUrl("http://metadata.google.internal/").ok).toBe(false)
    expect(guardUrl("http://metadata/").ok).toBe(false)
  })

  it("rejects unparseable URLs", () => {
    expect(guardUrl("not a url").ok).toBe(false)
  })
})

describe("SSRF IPv4 blocklist", () => {
  const blocked = [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
  ]
  const allowed = ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.167.0.1", "93.184.216.34"]

  it.each(blocked)("blocks private/loopback/link-local %s", (ip) => {
    expect(isBlockedIpv4(ip)).toBe(true)
    expect(guardUrl(`http://${ip}/`).ok).toBe(false)
  })

  it.each(allowed)("allows public %s", (ip) => {
    expect(isBlockedIpv4(ip)).toBe(false)
    expect(guardUrl(`http://${ip}/`).ok).toBe(true)
  })
})

describe("SSRF IPv6 blocklist", () => {
  const blocked = ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.0.1"]
  it.each(blocked)("blocks %s", (ip) => {
    expect(isBlockedIpv6(ip)).toBe(true)
    expect(guardUrl(`http://[${ip}]/`).ok).toBe(false)
  })

  it("allows a public IPv6", () => {
    expect(isBlockedIpv6("2606:4700:4700::1111")).toBe(false)
    expect(guardUrl("http://[2606:4700:4700::1111]/").ok).toBe(true)
  })
})

// ── fetchPage ──────────────────────────────────────────────────────────

function htmlResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } })
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe("fetchPage", () => {
  it("fetches, strips HTML, and meters exactly once", async () => {
    const fake: FetchLike = async () =>
      htmlResponse("<html><title>Doc</title><body><p>hello world content</p></body></html>")
    const res = await fetchPage({ url: "https://example.com/x", runId: "r1", tenant: "t1", fetchImpl: fake })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.page.title).toBe("Doc")
      expect(res.page.domain).toBe("example.com")
      expect(res.page.text).toContain("hello world content")
    }
    // Metering line emitted once with runId + domain + tenant, no secrets.
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]))
    const metered = lines.filter((l) => l.includes("research-fetch-metered"))
    expect(metered).toHaveLength(1)
    expect(JSON.parse(metered[0]!)).toMatchObject({ runId: "r1", domain: "example.com", tenant: "t1" })
  })

  it("refuses a public URL that redirects to a private target (SSRF-via-redirect)", async () => {
    // Revert-proof: if the per-hop re-validation were removed, this would follow
    // the 302 to the metadata IP and succeed.
    const fake: FetchLike = async (url) => {
      if (url.startsWith("https://example.com")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
      }
      return htmlResponse("<p>SHOULD NEVER BE REACHED</p>")
    }
    const res = await fetchPage({ url: "https://example.com/redir", runId: "r2", tenant: "t1", fetchImpl: fake })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("redirect-blocked")
  })

  it("follows a redirect to another public URL", async () => {
    const fake: FetchLike = async (url) => {
      if (url.includes("start"))
        return new Response(null, { status: 301, headers: { location: "https://dest.example.org/final" } })
      return htmlResponse("<p>final content here for the reader</p>")
    }
    const res = await fetchPage({ url: "https://example.com/start", runId: "r3", tenant: "t1", fetchImpl: fake })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.page.domain).toBe("dest.example.org")
  })

  it("rejects a non-allowlisted content-type", async () => {
    const fake: FetchLike = async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    const res = await fetchPage({ url: "https://example.com/api", runId: "r4", tenant: "t1", fetchImpl: fake })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("unsupported-content-type")
  })

  it("refuses the initial URL when it is private", async () => {
    const fake: FetchLike = async () => htmlResponse("<p>x</p>")
    const res = await fetchPage({ url: "http://192.168.0.5/", runId: "r5", tenant: "t1", fetchImpl: fake })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("private-ipv4")
  })

  it("caps the redirect chain at 3 hops", async () => {
    let n = 0
    const fake: FetchLike = async () => {
      n++
      return new Response(null, { status: 302, headers: { location: `https://hop${n}.example.com/` } })
    }
    const res = await fetchPage({ url: "https://start.example.com/", runId: "r6", tenant: "t1", fetchImpl: fake })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("too-many-redirects")
  })

  it("aborts a stalled body read at the deadline (slow-loris — P1.2)", async () => {
    // Revert-proof: if the deadline did not cover the body read, this hangs
    // forever. The stream sends headers (200) but never enqueues/closes a body,
    // so reader.read() stays pending until the 15s timer aborts it.
    vi.useFakeTimers()
    try {
      const stalled = new ReadableStream<Uint8Array>({
        start() {
          /* never enqueue, never close → read() stays pending */
        },
      })
      const fake: FetchLike = async () =>
        new Response(stalled, { status: 200, headers: { "content-type": "text/html" } })
      const pending = fetchPage({ url: "https://slow.example.com/", runId: "r7", tenant: "t1", fetchImpl: fake })
      await vi.advanceTimersByTimeAsync(15_000)
      const res = await pending
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.reason).toBe("timeout")
    } finally {
      vi.useRealTimers()
    }
  })
})
