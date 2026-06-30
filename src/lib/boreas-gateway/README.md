# boreas-gateway (SIG-545)

An authenticated Worker gateway that proxies CLI requests to **Google Vertex AI**
(Boreas → `qwen/qwen3-next-80b-a3b-instruct-maas`, Pyroeis → `google/gemma-4-26b-a4b-it-maas`,
Astraeus → `zai-org/glm-5-maas`; project `sigilix-496118`, location `global`) using **keyless
Workload Identity Federation** — no service-account key
ever exists (org policy `disableServiceAccountKeyCreation` blocks them). Users hit
the Sigilix Worker with the shared `SIGILIX_API_KEY`; the Worker mints GCP creds
server-side. Users never touch GCP.

## Modules

- `constants.ts` — fixed GCP identifiers (project / pool / provider / SA / model /
  STS audience / endpoint URLs / KV keys). Baked in deliberately: they pin *which*
  GCP identity the gateway federates into, so they are part of the security
  contract, not per-environment config.
- `oidc.ts` — self-bootstrapping OIDC issuer.
  `getOrCreateSigningKey(kv, encryptionKey)` generates an RSA-2048 (RS256) keypair on
  first need, persists the **private** JWK **encrypted at rest** (AES-GCM, keyed by
  `OPENCLAW_SESSION_ENCRYPTION_KEY` — the auth-session.ts pattern) in `OPENCLAW_STATE`
  under `gateway:oidc:privkey`, and imports it **non-extractable**. **KV is the single
  source of truth**: every sign/JWKS path loads the key from KV and only generates one
  when KV is absent; the in-isolate cache is a SHORT-lived memo (5 min) re-validated
  against KV on expiry, so all isolates converge on the KV value (no permanent stale
  per-isolate key → no WIF kid-miss). **Fails closed** (the gateway is inert) if
  `OPENCLAW_SESSION_ENCRYPTION_KEY` is unset — it never stores the private JWK as
  plaintext. The private JWK is never returned by any route and never logged; only the
  public half (kty/n/e + kid/alg/use) is ever served.
- `well-known-routes.ts` — the **unauthenticated** discovery GCP fetches:
  `GET /.well-known/jwks.json` (inert 503 until `OPENCLAW_SESSION_ENCRYPTION_KEY` is
  set) and `GET /.well-known/openid-configuration` (inert 503 until
  `OPENCLAW_GATEWAY_ISSUER` is set). Both carry an explicit short `Cache-Control`.
  **Deploy precondition:** curl `/.well-known/jwks.json` once after deploy to bootstrap
  the KV signing key, *before* the GCP WIF provider is configured against the issuer.
- `vertex-token.ts` — the keyless mint: sign assertion JWT → STS token-exchange →
  SA impersonation (`generateAccessToken`). The SA token is cached (KV + an
  in-isolate memo) and reused until `expireTime − 5min` (minus a small jitter); a
  per-isolate single-flight collapses concurrent refreshes into one mint.
- `vertex-chat-route.ts` — the **shared** authenticated Vertex chat proxy
  (`handleVertexChatRoute`). Validates the shared bearer **first** (503 unset / 401 bad —
  before body read, token mint, or any GCP call), then enforces a coarse daily KV ceiling
  (numeric env var; unset → a built-in default) that returns **429** once the day's count
  hits the limit — checked before the token mint so an over-limit request bills no GCP. It
  forces the model id and streams the Vertex response back transparently. A GCP/Vertex
  failure → 502 with a **generic** detail (the GCP error body is logged server-side, never
  returned to the caller). The forced model id + the daily-counter key/limit are the ONLY
  per-route knobs (`VertexChatRouteConfig`); everything else is identical.
- `api-boreas-route.ts` — `POST /v1/boreas/chat/completions`. A thin wrapper over
  `handleVertexChatRoute` pinning the Boreas model (`qwen/qwen3-next-80b-a3b-instruct-maas`),
  counter key `boreas:count:<day>`, and `OPENCLAW_BOREAS_DAILY_LIMIT`.
- `api-pyroeis-route.ts` — `POST /v1/pyroeis/chat/completions`. The same wrapper pinning the
  Pyroeis model (`google/gemma-4-26b-a4b-it-maas` — Gemma 4 26B serverless MaaS), counter key
  `pyroeis:count:<day>`, and `OPENCLAW_PYROEIS_DAILY_LIMIT`. Same project / SA / WIF token
  mint as Boreas — only the forced model and the metering counter/limit differ.
- `api-astraeus-route.ts` — `POST /v1/astraeus/chat/completions`. The same wrapper pinning the
  Astraeus model (`zai-org/glm-5-maas` — GLM-5.2 serverless MaaS), counter key
  `astraeus:count:<day>`, and `OPENCLAW_ASTRAEUS_DAILY_LIMIT`. Same project / SA / WIF token
  mint as Boreas/Pyroeis — only the forced model and the metering counter/limit differ.

## Assertion JWT (the WIF subject token)

- header `{ alg:"RS256", typ:"JWT", kid }` (kid matches the JWKS key)
- payload `{ iss:<OPENCLAW_GATEWAY_ISSUER, no trailing slash>, sub:"sigilix-gateway",
  aud:"sigilix-vertex-gateway", iat:(now−60), exp:(now+300) }`

## Configuration

- `OPENCLAW_SIGILIX_API_KEY` — the shared caller bearer (reused from `/v1/review`).
- `OPENCLAW_GATEWAY_ISSUER` — the exact worker origin (no trailing slash) the GCP
  WIF provider was created against. Unset → the gateway + discovery doc are inert.
- `OPENCLAW_SESSION_ENCRYPTION_KEY` — the AES-256 key (reused from auth-session) that
  encrypts the OIDC private JWK at rest. Unset → the gateway fails closed (JWKS 503,
  no token mint); it never persists the key as plaintext.
- `OPENCLAW_BOREAS_DAILY_LIMIT` — coarse endpoint-wide daily request ceiling for the Boreas
  route (numeric; unset → a built-in default). Over the limit → 429.
- `OPENCLAW_PYROEIS_DAILY_LIMIT` — the same ceiling for the Pyroeis route (numeric; unset →
  a built-in default). Over the limit → 429.
- `OPENCLAW_ASTRAEUS_DAILY_LIMIT` — the same ceiling for the Astraeus route (numeric; unset →
  a built-in default). Over the limit → 429.

The founder-run GCP setup (enable APIs, create the pool + OIDC provider against the
deployed issuer, grant `roles/iam.workloadIdentityUser`) is recorded in the SIG-545
WIF design doc — run it **after** the `/.well-known/*` routes are live.
