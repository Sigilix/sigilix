# boreas-gateway (SIG-545)

An authenticated Worker gateway that proxies CLI requests to **Google Vertex AI**
(`qwen/qwen3-next-80b-a3b-instruct-maas`, project `sigilix-496118`, location
`global`) using **keyless Workload Identity Federation** — no service-account key
ever exists (org policy `disableServiceAccountKeyCreation` blocks them). Users hit
the Sigilix Worker with the shared `SIGILIX_API_KEY`; the Worker mints GCP creds
server-side. Users never touch GCP.

## Modules

- `constants.ts` — fixed GCP identifiers (project / pool / provider / SA / model /
  STS audience / endpoint URLs / KV keys). Baked in deliberately: they pin *which*
  GCP identity the gateway federates into, so they are part of the security
  contract, not per-environment config.
- `oidc.ts` — self-bootstrapping OIDC issuer. `getOrCreateSigningKey(kv)` generates
  an RSA-2048 (RS256) keypair on first need, persists the **private** JWK in
  `OPENCLAW_STATE` under `gateway:oidc:privkey`, and imports it **non-extractable**.
  The private JWK is never returned by any route and never logged; only the public
  half (kty/n/e + kid/alg/use) is ever served.
- `well-known-routes.ts` — the **unauthenticated** discovery GCP fetches:
  `GET /.well-known/jwks.json` and `GET /.well-known/openid-configuration` (inert
  503 until `OPENCLAW_GATEWAY_ISSUER` is set).
- `vertex-token.ts` — the keyless mint: sign assertion JWT → STS token-exchange →
  SA impersonation (`generateAccessToken`). The SA token is cached (KV + an
  in-isolate memo) and reused until `expireTime − 5min` (minus a small jitter); a
  per-isolate single-flight collapses concurrent refreshes into one mint.
- `api-boreas-route.ts` — `POST /v1/boreas/chat/completions`. Validates the shared
  bearer **first** (503 unset / 401 bad — before body read, token mint, or any GCP
  call), forces the model id, meters a daily KV counter, and streams the Vertex
  response back transparently.

## Assertion JWT (the WIF subject token)

- header `{ alg:"RS256", typ:"JWT", kid }` (kid matches the JWKS key)
- payload `{ iss:<OPENCLAW_GATEWAY_ISSUER, no trailing slash>, sub:"sigilix-gateway",
  aud:"sigilix-vertex-gateway", iat:(now−60), exp:(now+300) }`

## Configuration

- `OPENCLAW_SIGILIX_API_KEY` — the shared caller bearer (reused from `/v1/review`).
- `OPENCLAW_GATEWAY_ISSUER` — the exact worker origin (no trailing slash) the GCP
  WIF provider was created against. Unset → the gateway + discovery doc are inert.

The founder-run GCP setup (enable APIs, create the pool + OIDC provider against the
deployed issuer, grant `roles/iam.workloadIdentityUser`) is recorded in the SIG-545
WIF design doc — run it **after** the `/.well-known/*` routes are live.
