// SIG-545 (Boreas CLI gateway) — the UNAUTHENTICATED OIDC discovery routes GCP's
// Workload Identity Federation provider fetches:
//
//   GET /.well-known/jwks.json            → the public signing key (JWKS)
//   GET /.well-known/openid-configuration → the minimal OIDC discovery document
//
// Both are intentionally public — GCP fetches them unauthenticated to verify the
// gateway's assertion JWTs. JWKS serves only the PUBLIC half (no private material).
// The discovery doc needs the issuer to build absolute URLs, so it is inert (503)
// until OPENCLAW_GATEWAY_ISSUER is configured.

import type { Env } from "@/src/shared/types/env"
import { getOrCreateSigningKey } from "./oidc"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** GET /.well-known/jwks.json — `{ keys: [ publicJwk w/ kid, alg, use ] }`. Public. */
export async function handleJwksRoute(env: Env): Promise<Response> {
  const { publicJwk } = await getOrCreateSigningKey(env.OPENCLAW_STATE)
  return json({ keys: [publicJwk] }, 200)
}

/** GET /.well-known/openid-configuration — minimal OIDC discovery. Public; 503 until issuer set. */
export function handleOpenidConfigurationRoute(env: Env): Response {
  const issuer = env.OPENCLAW_GATEWAY_ISSUER
  if (!issuer) return json({ error: "boreas_gateway_not_configured" }, 503)
  const base = issuer.replace(/\/$/, "")
  return json(
    {
      issuer: base,
      jwks_uri: `${base}/.well-known/jwks.json`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    },
    200,
  )
}
