// SIG-545 (Boreas CLI gateway) — fixed GCP / Vertex identifiers for the keyless
// Workload-Identity-Federation token mint + the Vertex chat proxy. These are
// deployment-stable infrastructure constants (project/pool/provider/SA/model),
// baked in deliberately rather than env-driven: they pin WHICH GCP identity the
// gateway federates into, so they are part of the security contract, not config a
// per-environment secret should be able to move. The only runtime-configurable
// knob is the OIDC issuer (env OPENCLAW_GATEWAY_ISSUER) — it must match the worker
// origin the GCP provider was created against.

/** GCP project id hosting the Vertex endpoint + the Vertex service account. */
export const PROJECT_ID = "sigilix-496118"
/** GCP project NUMBER — the STS audience addresses the WIF pool by number. */
export const PROJECT_NUMBER = "102681693225"
/** Vertex location (this deployment is global, not a region). */
export const LOCATION = "global"
/** The service account the federated identity impersonates (has roles/aiplatform.user). */
export const SERVICE_ACCOUNT = "sigilix-vertex@sigilix-496118.iam.gserviceaccount.com"
/** Workload Identity Federation pool. */
export const WIF_POOL = "sigilix-gateway-pool"
/** OIDC provider inside the pool (issuer = the worker origin). */
export const WIF_PROVIDER = "sigilix-worker-oidc"

/** Assertion-JWT `sub` — the federated subject mapped to google.subject. */
export const ASSERTION_SUBJECT = "sigilix-gateway"
/** Assertion-JWT `aud` — the provider's single allowed-audience. */
export const ASSERTION_AUDIENCE = "sigilix-vertex-gateway"

/** Forced Vertex model id — the gateway pins the model; the caller can't override it. */
export const VERTEX_MODEL = "qwen/qwen3-next-80b-a3b-instruct-maas"

/** OAuth scope requested at both STS exchange and SA impersonation. */
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

/** STS token-exchange endpoint (no Authorization header — the assertion JWT is the auth). */
export const STS_TOKEN_URL = "https://sts.googleapis.com/v1/token"

/**
 * Full WIF provider resource name — the `audience` of the STS exchange. The
 * assertion JWT's `aud` (ASSERTION_AUDIENCE) is a SEPARATE value the provider
 * validates; this addresses the provider itself.
 */
export const STS_AUDIENCE = `//iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/${LOCATION}/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}`

/** IAM Credentials generateAccessToken endpoint for the Vertex service account. */
export const GENERATE_ACCESS_TOKEN_URL = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SERVICE_ACCOUNT}:generateAccessToken`

/** Vertex OpenAPI chat-completions endpoint the gateway proxies to. */
export const VERTEX_CHAT_COMPLETIONS_URL = `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/endpoints/openapi/chat/completions`

/** KV key holding the self-bootstrapped OIDC PRIVATE JWK (never returned by any route). */
export const OIDC_PRIVKEY_KV_KEY = "gateway:oidc:privkey"
/** KV key holding the cached impersonated Vertex access token. */
export const VERTEX_TOKEN_KV_KEY = "gateway:vertex:token"
