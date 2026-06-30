// SIG-545 — the self-bootstrapping OIDC signing key: generate-once, persist the
// PRIVATE JWK ENCRYPTED in KV, derive a PUBLIC-only JWK, never leak private material,
// fail closed without the at-rest key, and converge on the KV value (no permanent
// per-isolate stale cache).

import { afterEach, describe, expect, it } from "vitest"
import { getOrCreateSigningKey, __resetSigningKeyCacheForTests } from "@/src/lib/boreas-gateway/oidc"
import { OIDC_PRIVKEY_KV_KEY } from "@/src/lib/boreas-gateway/constants"
import { inMemoryKv, TEST_ENCRYPTION_KEY } from "@/src/lib/boreas-gateway/boreas-gateway.test-helpers"
import { encryptAccessToken, decryptAccessToken } from "@/src/lib/auth-session"

afterEach(() => {
  __resetSigningKeyCacheForTests()
})

const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi"] as const

/** Build a fresh, valid stored private JWK (a DIFFERENT key, distinct kid) for the
 *  convergence test — the shape getOrCreateSigningKey persists + reads. */
async function makeStoredJwk(): Promise<{ jwk: Record<string, unknown>; kid: string }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<string, unknown>
  const kid = crypto.randomUUID()
  return { jwk: { ...jwk, kid, alg: "RS256", use: "sig" }, kid }
}

describe("getOrCreateSigningKey", () => {
  it("generates an RSA-2048 key, persists the PRIVATE JWK ENCRYPTED, returns a PUBLIC-only JWK", async () => {
    const store = new Map<string, string>()
    const sk = await getOrCreateSigningKey(inMemoryKv(store), TEST_ENCRYPTION_KEY)

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

    // The stored blob is ENCRYPTED at rest — NOT the raw JWK JSON.
    const stored = store.get(OIDC_PRIVKEY_KV_KEY)
    expect(stored).toBeTruthy()
    expect(stored!.includes('"d"')).toBe(false) // private exponent never at rest in plaintext
    expect(stored!.includes(sk.kid)).toBe(false) // kid not in plaintext either
    const blob = JSON.parse(stored!) as { ciphertext?: unknown; iv?: unknown }
    expect(typeof blob.ciphertext).toBe("string")
    expect(typeof blob.iv).toBe("string")

    // Round-trip: decrypt → the JWK with private material + matching kid.
    const pt = await decryptAccessToken(
      { encryptedAccessToken: blob.ciphertext as string, iv: blob.iv as string },
      OIDC_PRIVKEY_KV_KEY,
      TEST_ENCRYPTION_KEY,
    )
    const jwk = JSON.parse(pt) as Record<string, unknown>
    expect(jwk.kid).toBe(sk.kid)
    expect(typeof jwk.d).toBe("string") // private exponent present in the decrypted JWK
  })

  it("imports the private key as NON-extractable (cannot be re-exported)", async () => {
    const sk = await getOrCreateSigningKey(inMemoryKv(), TEST_ENCRYPTION_KEY)
    expect(sk.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey("jwk", sk.privateKey)).rejects.toBeTruthy()
  })

  it("fails CLOSED when OPENCLAW_SESSION_ENCRYPTION_KEY is unavailable (never stores plaintext)", async () => {
    const store = new Map<string, string>()
    await expect(getOrCreateSigningKey(inMemoryKv(store), undefined)).rejects.toThrow(/OPENCLAW_SESSION_ENCRYPTION_KEY/)
    // Nothing was persisted — the gateway is inert, not silently plaintext-keyed.
    expect(store.get(OIDC_PRIVKEY_KV_KEY)).toBeUndefined()
  })

  it("is stable across a cold isolate — re-reads the SAME key from KV, never regenerates", async () => {
    const store = new Map<string, string>()
    const kv = inMemoryKv(store)
    const first = await getOrCreateSigningKey(kv, TEST_ENCRYPTION_KEY)
    const writtenAfterFirst = store.get(OIDC_PRIVKEY_KV_KEY)

    // Simulate a fresh isolate: drop the in-memory cache but keep KV.
    __resetSigningKeyCacheForTests()
    const second = await getOrCreateSigningKey(kv, TEST_ENCRYPTION_KEY)

    expect(second.kid).toBe(first.kid)
    expect(second.publicJwk.n).toBe(first.publicJwk.n)
    // No new key was generated — the stored blob is byte-identical (read path never re-puts).
    expect(store.get(OIDC_PRIVKEY_KV_KEY)).toBe(writtenAfterFirst)
  })

  it("collapses concurrent cold bootstraps into a single key (single-flight)", async () => {
    const store = new Map<string, string>()
    const kv = inMemoryKv(store)
    const [a, b] = await Promise.all([
      getOrCreateSigningKey(kv, TEST_ENCRYPTION_KEY),
      getOrCreateSigningKey(kv, TEST_ENCRYPTION_KEY),
    ])
    expect(a.kid).toBe(b.kid)
  })

  it("adopts a changed KV key once the memo window expires (no permanent stale cache)", async () => {
    const store = new Map<string, string>()
    const kv = inMemoryKv(store)
    const T0 = 1_700_000_000_000
    const clock = { ms: T0 }
    const now = () => clock.ms

    // This isolate memoizes key A and persists it to KV.
    const first = await getOrCreateSigningKey(kv, TEST_ENCRYPTION_KEY, { now })

    // ANOTHER isolate (elsewhere) rewrites KV with a different key B (distinct kid).
    const { jwk: jwkB, kid: kidB } = await makeStoredJwk()
    expect(kidB).not.toBe(first.kid)
    const { ciphertext, iv } = await encryptAccessToken(JSON.stringify(jwkB), OIDC_PRIVKEY_KV_KEY, TEST_ENCRYPTION_KEY)
    store.set(OIDC_PRIVKEY_KV_KEY, JSON.stringify({ ciphertext, iv }))

    // Still inside the memo window → this isolate keeps serving the OLD key A.
    const within = await getOrCreateSigningKey(kv, TEST_ENCRYPTION_KEY, { now })
    expect(within.kid).toBe(first.kid)

    // Past the memo window → it re-reads KV and ADOPTS key B (no permanent stale cache).
    clock.ms = T0 + 6 * 60 * 1000
    const after = await getOrCreateSigningKey(kv, TEST_ENCRYPTION_KEY, { now })
    expect(after.kid).toBe(kidB)
    expect(after.kid).not.toBe(first.kid)
  })
})
