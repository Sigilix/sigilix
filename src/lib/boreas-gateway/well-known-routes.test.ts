// SIG-545 — the UNAUTHENTICATED OIDC discovery routes: JWKS serves the public key
// (never private material); openid-configuration is inert until the issuer is set.

import { afterEach, describe, expect, it } from "vitest"
import { handleJwksRoute, handleOpenidConfigurationRoute } from "@/src/lib/boreas-gateway/well-known-routes"
import { __resetSigningKeyCacheForTests } from "@/src/lib/boreas-gateway/oidc"
import { makeEnv } from "@/src/lib/boreas-gateway/boreas-gateway.test-helpers"

afterEach(() => {
  __resetSigningKeyCacheForTests()
})

describe("handleJwksRoute", () => {
  it("returns the public key with a kid + RS256/use=sig, and NO private material", async () => {
    const env = makeEnv()
    const res = await handleJwksRoute(env)
    expect(res.status).toBe(200)
    const text = await res.text()
    // Strong leak check: the private exponent must never appear in the JWKS body.
    expect(text.includes('"d"')).toBe(false)
    const body = JSON.parse(text) as { keys: Array<Record<string, unknown>> }
    expect(Array.isArray(body.keys)).toBe(true)
    expect(body.keys).toHaveLength(1)
    const jwk = body.keys[0]
    expect(jwk).toBeDefined()
    expect(typeof jwk!.kid).toBe("string")
    expect(jwk!.kty).toBe("RSA")
    expect(jwk!.alg).toBe("RS256")
    expect(jwk!.use).toBe("sig")
    expect(typeof jwk!.n).toBe("string")
    expect(jwk!.e).toBe("AQAB")
    for (const f of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect(f in jwk!).toBe(false)
    }
  })
})

describe("handleOpenidConfigurationRoute", () => {
  it("returns 503 (inert) when OPENCLAW_GATEWAY_ISSUER is unset", () => {
    const res = handleOpenidConfigurationRoute(makeEnv())
    expect(res.status).toBe(503)
  })

  it("returns the discovery doc with a normalized issuer + jwks_uri when set", async () => {
    // Trailing slash must be stripped so the issuer matches the GCP provider exactly.
    const env = makeEnv({ OPENCLAW_GATEWAY_ISSUER: "https://gw.example/" })
    const res = handleOpenidConfigurationRoute(env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.issuer).toBe("https://gw.example")
    expect(body.jwks_uri).toBe("https://gw.example/.well-known/jwks.json")
    expect(body.id_token_signing_alg_values_supported).toEqual(["RS256"])
  })
})
