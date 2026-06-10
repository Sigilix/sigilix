// auth-session: AES-GCM round-trip with AAD binding, base64url helpers,
// cookie helpers, KV CRUD against a fake KV.

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  base64urlDecode,
  base64urlEncode,
  clearSessionCookie,
  clearStateCookie,
  createSession,
  decryptAccessToken,
  deleteSession,
  encryptAccessToken,
  getSession,
  mintSessionId,
  mintStateNonce,
  readCookie,
  setSessionCookie,
  setStateCookie,
  touchSession,
} from "@/src/lib/auth-session"

interface FakeKV {
  get: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  _store: Map<string, string>
}

function makeKV(initial: Record<string, string> = {}): FakeKV {
  const store = new Map(Object.entries(initial))
  return {
    _store: store,
    get: vi.fn(async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  }
}

// 32 random bytes, base64url-encoded — matches the production secret shape.
const TEST_KEY = base64urlEncode(new Uint8Array(32).fill(7))

describe("base64url round-trip", () => {
  it("encodes then decodes arbitrary bytes losslessly", () => {
    const bytes = new Uint8Array([0, 1, 2, 0x80, 0xff, 0xa5, 0x33])
    expect(base64urlDecode(base64urlEncode(bytes))).toEqual(bytes)
  })

  it("does not contain `+`, `/`, or trailing `=` padding", () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff])
    const encoded = base64urlEncode(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
  })
})

describe("AES-GCM encrypt + decrypt with AAD", () => {
  it("round-trips a token under the same sessionId + key", async () => {
    const ct = await encryptAccessToken("ghu_secrettoken", "alice-session", TEST_KEY)
    const pt = await decryptAccessToken(
      { encryptedAccessToken: ct.ciphertext, iv: ct.iv },
      "alice-session",
      TEST_KEY,
    )
    expect(pt).toBe("ghu_secrettoken")
  })

  it("rejects decryption with wrong sessionId (AAD mismatch)", async () => {
    // Codex blocker #1 / spec test #17: ciphertext-swap between session
    // records must fail at decrypt time so a misplaced ciphertext can
    // never decrypt as another user's bearer token.
    const ct = await encryptAccessToken("ghu_alice", "alice-session", TEST_KEY)
    await expect(
      decryptAccessToken(
        { encryptedAccessToken: ct.ciphertext, iv: ct.iv },
        "bob-session",
        TEST_KEY,
      ),
    ).rejects.toThrow()
  })

  it("rejects decryption with wrong key", async () => {
    const ct = await encryptAccessToken("ghu_token", "session-x", TEST_KEY)
    const otherKey = base64urlEncode(new Uint8Array(32).fill(13))
    await expect(
      decryptAccessToken(
        { encryptedAccessToken: ct.ciphertext, iv: ct.iv },
        "session-x",
        otherKey,
      ),
    ).rejects.toThrow()
  })

  it("uses a fresh IV per encryption", async () => {
    const a = await encryptAccessToken("token", "s", TEST_KEY)
    const b = await encryptAccessToken("token", "s", TEST_KEY)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it("rejects keys that do not decode to 32 bytes", async () => {
    const shortKey = base64urlEncode(new Uint8Array(16).fill(1))
    await expect(encryptAccessToken("t", "s", shortKey)).rejects.toThrow(/32 bytes/)
  })
})

describe("session ID + state nonce minting", () => {
  it("produces non-equal opaque IDs", () => {
    const a = mintSessionId()
    const b = mintSessionId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(40) // 32 bytes ~ 43 chars in base64url
  })

  it("produces 16-byte state nonces", () => {
    const a = mintStateNonce()
    const b = mintStateNonce()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(20) // 16 bytes ~ 22 chars
  })
})

describe("session CRUD against KV", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("createSession writes encrypted record + sets sliding TTL", async () => {
    const kv = makeKV()
    const sessionId = "test-session-id"
    const record = await createSession({
      kv: kv as unknown as KVNamespace,
      sessionId,
      login: "alice",
      githubUserId: 12345,
      accessToken: "ghu_alice_token",
      encryptionKeyB64url: TEST_KEY,
    })
    expect(record.login).toBe("alice")
    expect(record.githubUserId).toBe(12345)
    expect(record.encryptedAccessToken).toBeTruthy()
    expect(record.iv).toBeTruthy()
    // Plaintext token must not be in the stored value.
    const stored = kv._store.get(`auth_session:${sessionId}`)
    expect(stored).toBeTruthy()
    expect(stored).not.toContain("ghu_alice_token")
    // Verify TTL was passed.
    expect(kv.put).toHaveBeenCalledWith(
      `auth_session:${sessionId}`,
      expect.any(String),
      expect.objectContaining({ expirationTtl: 30 * 24 * 60 * 60 }),
    )
  })

  it("getSession returns null for unknown id", async () => {
    const kv = makeKV()
    const out = await getSession({
      kv: kv as unknown as KVNamespace,
      sessionId: "unknown",
    })
    expect(out).toBeNull()
  })

  it("getSession returns the parsed record for a known id", async () => {
    const kv = makeKV()
    await createSession({
      kv: kv as unknown as KVNamespace,
      sessionId: "alice-id",
      login: "alice",
      githubUserId: 1,
      accessToken: "ghu_alice",
      encryptionKeyB64url: TEST_KEY,
    })
    const out = await getSession({
      kv: kv as unknown as KVNamespace,
      sessionId: "alice-id",
    })
    expect(out?.login).toBe("alice")
  })

  it("touchSession bumps lastSeenAt and refreshes TTL", async () => {
    const kv = makeKV()
    const sessionId = "alice-id"
    const record = await createSession({
      kv: kv as unknown as KVNamespace,
      sessionId,
      login: "alice",
      githubUserId: 1,
      accessToken: "ghu",
      encryptionKeyB64url: TEST_KEY,
    })
    const before = record.lastSeenAt
    await new Promise((r) => setTimeout(r, 5))
    await touchSession({ kv: kv as unknown as KVNamespace, sessionId, record })
    const updated = await getSession({ kv: kv as unknown as KVNamespace, sessionId })
    expect(updated?.lastSeenAt).toBeGreaterThan(before)
  })

  it("deleteSession removes the record", async () => {
    const kv = makeKV()
    await createSession({
      kv: kv as unknown as KVNamespace,
      sessionId: "alice-id",
      login: "alice",
      githubUserId: 1,
      accessToken: "ghu",
      encryptionKeyB64url: TEST_KEY,
    })
    await deleteSession({ kv: kv as unknown as KVNamespace, sessionId: "alice-id" })
    const out = await getSession({ kv: kv as unknown as KVNamespace, sessionId: "alice-id" })
    expect(out).toBeNull()
  })
})

describe("cookie helpers", () => {
  it("readCookie extracts a value by name", () => {
    const req = new Request("https://example.com", {
      headers: {
        cookie: "foo=1; __Host-sigilix_session=abc123; bar=2",
      },
    })
    expect(readCookie(req, "__Host-sigilix_session")).toBe("abc123")
    expect(readCookie(req, "foo")).toBe("1")
    expect(readCookie(req, "missing")).toBeNull()
  })

  it("setSessionCookie produces the locked attribute set", () => {
    const c = setSessionCookie("session-abc")
    expect(c).toContain("__Host-sigilix_session=session-abc")
    expect(c).toContain("HttpOnly")
    expect(c).toContain("Secure")
    expect(c).toContain("SameSite=Lax")
    expect(c).toContain("Path=/")
    expect(c).toContain("Max-Age=2592000")
  })

  it("clearSessionCookie sets Max-Age=0 with the same locked attributes", () => {
    const c = clearSessionCookie()
    expect(c).toContain("__Host-sigilix_session=")
    expect(c).toContain("Max-Age=0")
    expect(c).toContain("HttpOnly")
    expect(c).toContain("Secure")
  })

  it("setStateCookie has 600s TTL", () => {
    const c = setStateCookie("nonce-xyz")
    expect(c).toContain("__Host-sigilix_oauth_state=nonce-xyz")
    expect(c).toContain("Max-Age=600")
  })

  it("clearStateCookie zeroes the state cookie", () => {
    const c = clearStateCookie()
    expect(c).toContain("__Host-sigilix_oauth_state=")
    expect(c).toContain("Max-Age=0")
  })
})
