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

/** Forced Vertex model id for the Boreas route — the gateway pins it; the caller can't override it. */
export const VERTEX_MODEL = "qwen/qwen3-next-80b-a3b-instruct-maas"

/** Forced Vertex model id for the Pyroeis route — same gateway/SA/token mint, different model. */
export const PYROEIS_MODEL = "google/gemma-4-26b-a4b-it-maas"

/** Forced Vertex model id for the Astraeus route — same gateway/SA/token mint, different model. */
export const ASTRAEUS_MODEL = "zai-org/glm-5-maas"

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

// ── #158 failover chain — leg 2 (Ollama Turbo, per-token/serverless) ───────────
//
// Same auth pattern the rest of the Worker already uses for Ollama Turbo
// (Authorization: Bearer OLLAMA_API_KEY) and the same OpenAI-compatible base URL
// (`https://ollama.com/v1`, e.g. admin-agent-run-route.ts / linear-agent-run.ts) —
// NOT the NDJSON `/api/chat` / `/api/generate` adapters, which speak a different
// wire protocol. The gateway proxies raw OpenAI chat-completions bodies, so the
// OpenAI-compatible endpoint is the one that lets us pass the body straight
// through unchanged (same shape as the Vertex leg), model id swapped only.
export const OLLAMA_TURBO_CHAT_COMPLETIONS_URL = "https://ollama.com/v1/chat/completions"

/**
 * Built-in default Turbo fallback model for the Boreas route (env
 * OPENCLAW_BOREAS_FALLBACK_TURBO_MODEL overrides it). A strong Qwen3 Ollama Turbo
 * tag — already in production use as the logic-specialist fallback
 * (shared/domain/config/types.ts), so it's a proven-live tag, not a guess.
 */
export const DEFAULT_BOREAS_FALLBACK_TURBO_MODEL = "qwen3-coder-next:cloud"

/**
 * Built-in default Turbo fallback model for the Astraeus route (env
 * OPENCLAW_ASTRAEUS_FALLBACK_TURBO_MODEL overrides it). Astraeus's Vertex model is
 * GLM-5.2 (zai-org/glm-5-maas); glm-5.2:cloud is the SAME model family already
 * live as the agent-runner's Ollama Turbo default (admin-agent-run-route.ts /
 * linear-agent-run.ts), so it's the closest real substitution available.
 */
export const DEFAULT_ASTRAEUS_FALLBACK_TURBO_MODEL = "glm-5.2:cloud"

// NOTE: Pyroeis has NO built-in default Turbo fallback model. Its Vertex model is
// Gemma 4 26B (google/gemma-4-26b-a4b-it-maas); there is no confirmed Gemma tag on
// Ollama Turbo in this codebase today, and guessing one risks silently routing to a
// model that doesn't exist. OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL must be set
// explicitly to enable a Turbo leg for Pyroeis — unset means Pyroeis has only the
// Vertex leg (plus Bedrock, once configured).

// ── #158 failover chain — leg 3 (AWS Bedrock, serverless — SCAFFOLD, disabled
// until OPENCLAW_AWS_* creds + a per-model OPENCLAW_<MODEL>_FALLBACK_BEDROCK_MODEL
// are set) ──────────────────────────────────────────────────────────────────────
/** AWS SigV4 service name for Bedrock's model-invocation runtime plane. */
export const BEDROCK_SIGV4_SERVICE = "bedrock"

/** Bedrock Runtime Converse REST endpoint for a given region + model id. */
export function bedrockConverseUrl(region: string, modelId: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`
}
