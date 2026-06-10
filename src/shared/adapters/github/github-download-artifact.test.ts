// SIG-118 — tests for GitHubClient.downloadArtifactZip. The method's
// reason-to-exist is the token-leak guard: the install token rides only
// the api.github.com request; the 302 points at a signed storage host
// and the second request must carry NO auth. These tests pin that
// contract (Sigilix review HIGH) + the https-only + byte-cap guards.

import { describe, it, expect, vi, afterEach } from "vitest"
import { GitHubClient } from "@/src/shared/adapters/github"

afterEach(() => {
  vi.restoreAllMocks()
})

const newClient = () => new GitHubClient({ token: "ghs_secret_token" })

interface Captured {
  url: string
  init: RequestInit | undefined
}

/** Mock fetch: first call → 302 to `location`, second → `body`. Records
 *  each (url, init) so tests can assert on the headers per hop. */
function mockTwoHop(location: string | null, body: BodyInit | null, bodyStatus = 200) {
  const calls: Captured[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init })
    if (calls.length === 1) {
      const headers = new Headers()
      if (location !== null) headers.set("location", location)
      return new Response(null, { status: 302, headers })
    }
    return new Response(body, { status: bodyStatus })
  })
  return calls
}

function authOf(init: RequestInit | undefined): string | null {
  if (!init?.headers) return null
  return new Headers(init.headers).get("authorization")
}

describe("GitHubClient.downloadArtifactZip", () => {
  it("token rides the api request only; the signed-URL hop carries NO auth", async () => {
    const calls = mockTwoHop("https://signed.example/artifact.zip", new Uint8Array([1, 2, 3]))
    const out = await newClient().downloadArtifactZip("o", "r", 99)

    expect(out).toEqual(new Uint8Array([1, 2, 3]))
    expect(calls).toHaveLength(2)
    // Hop 1: api.github.com, install token present, manual redirect.
    expect(calls[0]!.url).toContain("api.github.com")
    expect(authOf(calls[0]!.init)).toBe("token ghs_secret_token")
    expect(calls[0]!.init?.redirect).toBe("manual")
    // Hop 2: the signed host, NO authorization header (the leak guard).
    expect(calls[1]!.url).toBe("https://signed.example/artifact.zip")
    expect(authOf(calls[1]!.init)).toBeNull()
  })

  it("rejects a non-https redirect target (token must never replay over http)", async () => {
    mockTwoHop("http://signed.example/artifact.zip", new Uint8Array([1]))
    await expect(newClient().downloadArtifactZip("o", "r", 99)).rejects.toThrow(/https/i)
  })

  it("rejects a missing Location header", async () => {
    mockTwoHop(null, new Uint8Array([1]))
    await expect(newClient().downloadArtifactZip("o", "r", 99)).rejects.toThrow(/Location/i)
  })

  it("rejects when the first response is not a 3xx redirect", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 200 }))
    await expect(newClient().downloadArtifactZip("o", "r", 99)).rejects.toThrow(/redirect/i)
  })

  it("enforces the byte cap on the streamed body", async () => {
    mockTwoHop("https://signed.example/a.zip", new Uint8Array([1, 2, 3, 4, 5]))
    // maxBytes = 2 < 5-byte body → must throw, not buffer.
    await expect(newClient().downloadArtifactZip("o", "r", 99, 2)).rejects.toThrow(/exceeds/i)
  })

  it("rejects a bodyless response without a valid in-cap Content-Length", async () => {
    const calls: Captured[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init })
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: new Headers({ location: "https://signed.example/a.zip" }) })
      }
      // No body, no content-length → must reject (don't buffer-then-check).
      return new Response(null, { status: 200 })
    })
    await expect(newClient().downloadArtifactZip("o", "r", 99)).rejects.toThrow(/content-length/i)
  })
})
