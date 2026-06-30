// SIG-545 — the self-bootstrapping OIDC signing key: generate-once, persist the
// PRIVATE JWK in KV, derive a PUBLIC-only JWK, never leak private material.

import { afterEach, describe, expect, it } from "vitest"
import { getOrCreateSigningKey, __resetSigningKeyCacheForTests } from "@/src/lib/boreas-gateway/oidc"
import { OIDC_PRIVKEY_KV_KEY } from "@/src/lib/boreas-gateway/constants"
import { inMemoryKv } from "@/src/lib/boreas-gateway/boreas-gateway.test-helpers"

afterEach(() => {
  __resetSigningKeyCacheForTests()
})

const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi"] as const

describe("getOrCreateSigningKey", () => {
  it("generates an RSA-2048 key, persists the PRIVATE JWK, returns a PUBLIC-only JWK", async () => {
    const store = new Map<string, string>()
    const sk = await getOrCreateSigningKey(inMemoryKv(store))

    // Public JWK shape — kid matches, RS256/use=sig, has n/e.
    expect(typeof sk.kid).toBe("string")
    expect(sk.kid.length).toBeGreaterThan(0)
    expect(sk.publicJwk.kid).toBe(sk.kid)
    expect(sk.publicJwk.kty).toBe("RSA")
    expect(sk.publicJwk.alg).toBe("RS256")
    expect(sk.publicJwk.use).toBe("sig")
    expect(typeof sk.publicJwk.n).toBe("string")
    expect(sk.publicJwk.e).toBe("AQAB")

    // The public JWK carries NO private material.
    for (const f of PRIVATE_JWK_FIELDS) {
      expect(f in sk.publicJwk).toBe(false)
    }

    // The PRIVATE JWK is persisted under the dedicated key + DOES carry private material.
    const stored = store.get(OIDC_PRIVKEY_KV_KEY)
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored as string) as Record<string, unknown>
    expect(parsed.kid).toBe(sk.kid)
    expect(typeof parsed.d).toBe("string") // private exponent present at rest
  })

  it("imports the private key as NON-extractable (cannot be re-exported)", async () => {
    const sk = await getOrCreateSigningKey(inMemoryKv())
    expect(sk.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey("jwk", sk.privateKey)).rejects.toBeTruthy()
  })

  it("is stable across a cold isolate — re-reads the SAME key from KV, never regenerates", async () => {
    const store = new Map<string, string>()
    const kv = inMemoryKv(store)
    const first = await getOrCreateSigningKey(kv)
    const writtenAfterFirst = store.get(OIDC_PRIVKEY_KV_KEY)

    // Simulate a fresh isolate: drop the in-memory cache but keep KV.
    __resetSigningKeyCacheForTests()
    const second = await getOrCreateSigningKey(kv)

    expect(second.kid).toBe(first.kid)
    expect(second.publicJwk.n).toBe(first.publicJwk.n)
    // No new key was generated — the stored blob is byte-identical.
    expect(store.get(OIDC_PRIVKEY_KV_KEY)).toBe(writtenAfterFirst)
  })

  it("collapses concurrent cold bootstraps into a single key (single-flight)", async () => {
    const store = new Map<string, string>()
    const kv = inMemoryKv(store)
    const [a, b] = await Promise.all([getOrCreateSigningKey(kv), getOrCreateSigningKey(kv)])
    expect(a.kid).toBe(b.kid)
  })
})
