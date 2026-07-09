// sig-health-endpoints — PUBLIC, dependency-aware health probes for status.sigilix.ai.
//
//   GET /health               core liveness+readiness (PR Reviewer / CLI backend /
//                             Portal API) — verifies the runtime is up AND its real
//                             dependencies respond: KV (OPENCLAW_STATE, core) and D1
//                             (SIGILIX_PLATFORM_DB, optional metering store).
//   GET /health/models        the Models component (Boreas/Pyroeis/Astraeus) — a
//                             CHEAP, side-effect-free liveness probe of the model
//                             gateway. The gateway is THIS worker proxying to Vertex
//                             AI via keyless Workload-Identity-Federation, so the
//                             honest readiness signal is "can the worker mint a Vertex
//                             SA access token?" (exercises the full assertion-JWT → STS
//                             → SA-impersonation chain that every model call needs) —
//                             NOT a paid generation. The token is KV-cached + single-
//                             flighted, so probing every few minutes just reads cache.
//   GET /health/integrations  the Integrations component — best-effort config-presence
//                             + cheap, unauthenticated, no-cost reachability for
//                             GitHub / GitLab / Slack / Linear. Never calls anything
//                             that costs money or mutates state.
//
// DESIGN CONTRACT (all three routes):
//   - UNAUTHENTICATED, cheap, side-effect-free, SECRET-SAFE (only booleans + coarse
//     up/degraded/down leak out — never a token, key, base URL, or error body).
//   - Every dependency check is TIME-BOXED (see PROBE_TIMEOUT_MS) so a slow/hung
//     dependency surfaces as `degraded`/`down` instead of hanging the probe.
//   - FAIL-SAFE: a route erroring returns a clear non-200 / `status:"down"`, never
//     200-when-broken. `operational`/`degraded` → HTTP 200 (the status page reads the
//     `status` field from the body); `down` → HTTP 503.
//   - CORS: `Access-Control-Allow-Origin: *` (public JSON, no credentials) + a short
//     `Cache-Control` so a status page hitting every few minutes is cheap.

import type { Env } from "@/src/shared/types/env"
import { getVertexAccessToken } from "@/src/lib/boreas-gateway/vertex-token"
import { isTurboConfigured, resolveTurboModel } from "@/src/lib/boreas-gateway/turbo-chat"
import { isBedrockConfigured } from "@/src/lib/boreas-gateway/bedrock-chat"
import {
  DEFAULT_BOREAS_FALLBACK_TURBO_MODEL,
  DEFAULT_ASTRAEUS_FALLBACK_TURBO_MODEL,
} from "@/src/lib/boreas-gateway/constants"

/**
 * Dispatcher for the liveness + health surface (kept in one place so the entry
 * module stays within its file-size budget). Returns a Response for a matched
 * route, else `null` so the caller falls through to the rest of routing.
 *
 *   GET /                      the existing plaintext liveness probe (unchanged).
 *   GET /health                core worker readiness (KV + D1).
 *   GET /health/models         the model gateway (Vertex) liveness.
 *   GET /health/integrations   GitHub / GitLab / Slack / Linear reachability.
 */
export async function tryHandleHealthRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  if (request.method !== "GET") return null
  switch (url.pathname) {
    case "/":
      return new Response("Sigilix — alive\n", { headers: { "content-type": "text/plain" } })
    case "/health":
      return handleHealthRoute(env)
    case "/health/models":
      return handleModelsHealthRoute(env, ctx)
    case "/health/integrations":
      return handleIntegrationsHealthRoute(env)
    default:
      return null
  }
}

/** Coarse health state. Ordered worst-to-best for `worst()` aggregation. */
export type HealthStatus = "down" | "degraded" | "operational"

/** Per-dependency check result. `detail` is a short, SECRET-SAFE label only. */
export interface HealthCheck {
  status: HealthStatus | "not_configured"
  detail?: string
}

export interface HealthResponse {
  status: HealthStatus
  checks: Record<string, HealthCheck>
  ts: string
}

// Each individual dependency probe is capped well under the Cloudflare fetch
// budget so the ROUTE never hangs: a hung dependency aborts and reports
// `degraded`/`down`. 2.5s leaves headroom for the status page's own timeout.
const PROBE_TIMEOUT_MS = 2_500

/** Rank a HealthStatus for min-aggregation (`not_configured` is neutral-good). */
function rank(s: HealthStatus | "not_configured"): number {
  switch (s) {
    case "down":
      return 0
    case "degraded":
      return 1
    default:
      return 2 // operational | not_configured
  }
}

/** Aggregate: overall is the WORST non-neutral check (never worse than its inputs). */
function worst(checks: Record<string, HealthCheck>): HealthStatus {
  let overall: HealthStatus = "operational"
  for (const check of Object.values(checks)) {
    if (check.status === "not_configured") continue
    if (rank(check.status) < rank(overall)) overall = check.status
  }
  return overall
}

/** Build the JSON response. `down` → 503; everything else → 200. Public CORS + no-store-ish cache. */
function healthResponse(status: HealthStatus, checks: Record<string, HealthCheck>): Response {
  const body: HealthResponse = { status, checks, ts: new Date().toISOString() }
  return new Response(JSON.stringify(body), {
    status: status === "down" ? 503 : 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      // Short cache: safe to hit every few minutes without stampeding a dependency.
      "cache-control": "public, max-age=15",
    },
  })
}

/** Timeout sentinel — distinct from any value `fn` could legitimately resolve. */
const TIMED_OUT = Symbol("health-probe-timeout")

/**
 * A bounded, error-swallowing probe: returns `true` iff `fn` resolves truthy
 * within PROBE_TIMEOUT_MS. Uses `Promise.race` against a real timer (NOT the
 * shared `withTimeout`, which only aborts the signal and still awaits the
 * factory — insufficient here because `getVertexAccessToken` doesn't accept an
 * AbortSignal and would hang the route). The AbortSignal is still passed to
 * `fn` so signal-aware callers (fetch) get cancelled on timeout; signal-unaware
 * ones are bounded by the race regardless, so the ROUTE can never hang.
 */
async function probe(fn: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort()
      resolve(TIMED_OUT)
    }, PROBE_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([fn(ctrl.signal).catch(() => false), timeout])
    if (result === TIMED_OUT) return false
    return result !== false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ── GET /health ────────────────────────────────────────────────────────────
//
// Core liveness+readiness. KV (OPENCLAW_STATE) is a REQUIRED binding shared by
// the PR Reviewer, CLI backend, and Portal API — if it throws/times out the
// worker is genuinely broken → `down` (503). D1 (SIGILIX_PLATFORM_DB) is
// OPTIONAL (metering can be dark): unbound → `not_configured` (no penalty),
// bound-but-failing → `degraded`.
export async function handleHealthRoute(env: Env): Promise<Response> {
  try {
    const checks: Record<string, HealthCheck> = {}

    // KV: a bounded read of a sentinel key. A hit or a miss both prove the
    // binding is reachable; only a throw/timeout means KV is down.
    const kvOk = await probe(async () => {
      await env.OPENCLAW_STATE.get("health:probe")
      return true
    })
    checks.kv = kvOk ? { status: "operational" } : { status: "down", detail: "kv unreachable" }

    // D1: a cheap `SELECT 1`. Optional binding — absence is not a failure.
    if (env.SIGILIX_PLATFORM_DB) {
      const db = env.SIGILIX_PLATFORM_DB
      const d1Ok = await probe(async () => {
        await db.prepare("SELECT 1").first()
        return true
      })
      checks.d1 = d1Ok ? { status: "operational" } : { status: "degraded", detail: "d1 query failed" }
    } else {
      checks.d1 = { status: "not_configured" }
    }

    return healthResponse(worst(checks), checks)
  } catch {
    // Fail-safe: the route ITSELF threw — report down, never 200.
    return healthResponse("down", { worker: { status: "down", detail: "health route error" } })
  }
}

// ── GET /health/models ───────────────────────────────────────────────────────
//
// Models component. The model gateway is this worker proxying to Vertex AI via
// keyless WIF (see boreas-gateway/). There is NO separate gateway service to add
// a `/health` route to — the honest, no-cost liveness signal is whether the
// worker can obtain a Vertex SA access token (the auth chain every Boreas/
// Pyroeis/Astraeus call depends on). Boreas is served on Vertex today;
// Pyroeis/Astraeus are "coming soon" but share the exact same gateway/auth, so
// their served-state is derived from the same gateway probe.
//
// THRESHOLDS mirror the REAL gateway chain (vertex-chat-route.ts + fallback-chain.ts):
//   - The `/v1/*` model routes return 503 `boreas_gateway_not_configured` BEFORE
//     the failover chain runs unless an auth config (OPENCLAW_SIGILIX_API_KEY or
//     SIGILIX_PLATFORM_DB) AND OPENCLAW_GATEWAY_ISSUER are set. So when the route
//     is not serveable, NO fallback can serve → the whole Models component is
//     `down` (the probe is not even called — a full outage the status page must
//     see, not a false `degraded`).
//   - When the route IS serveable, the Vertex leg is tried first; only its
//     RUNTIME failure hands off to the ordered failover chain (Ollama Turbo →
//     Bedrock). Whether a leg is available is decided PER MODEL by the exact same
//     predicates the chain uses — `isTurboConfigured(OLLAMA_API_KEY,
//     resolveTurboModel(<model>_FALLBACK_TURBO_MODEL, <built-in default>))` and
//     `isBedrockConfigured({region, accessKey, secret}, <model>_FALLBACK_BEDROCK_MODEL)`
//     — reused here so this never drifts from the real routing. Consequences that
//     matter for honesty: Boreas + Astraeus have a built-in Turbo default (so a
//     Turbo key alone gives them a fallback); Pyroeis has NONE (Gemini is
//     Vertex-only) so it needs an explicit env; Bedrock counts only when region +
//     both AWS keys + the per-model Bedrock model id are ALL set.
export interface ModelsHealthDeps {
  /** Time-boxed gateway liveness probe. Returns true iff a Vertex SA token is obtainable. */
  probeGateway: (env: Env, ctx: ExecutionContext) => Promise<boolean>
}

const defaultModelsDeps: ModelsHealthDeps = {
  probeGateway: (env, ctx) =>
    probe(async (_signal) => {
      // getVertexAccessToken is KV-cached + single-flighted; on a cache hit this
      // is free, on a miss it mints ONE token (STS + SA impersonation) — no model
      // generation, no billing. It doesn't accept an AbortSignal, so `probe`'s
      // Promise.race timer is what bounds the route: on a hung mint the race
      // returns false (→ degraded/down) and the mint continues in the background,
      // never hanging the probe.
      const token = await getVertexAccessToken(env, ctx)
      return typeof token === "string" && token.length > 0
    }),
}

/** Per-model failover knobs — the exact env vars + built-in defaults each route pins. */
const MODEL_FALLBACKS = {
  boreas: {
    turboEnv: "OPENCLAW_BOREAS_FALLBACK_TURBO_MODEL",
    turboDefault: DEFAULT_BOREAS_FALLBACK_TURBO_MODEL,
    bedrockEnv: "OPENCLAW_BOREAS_FALLBACK_BEDROCK_MODEL",
  },
  pyroeis: {
    turboEnv: "OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL",
    turboDefault: undefined, // no built-in default — Gemini is Vertex-only
    bedrockEnv: "OPENCLAW_PYROEIS_FALLBACK_BEDROCK_MODEL",
  },
  astraeus: {
    turboEnv: "OPENCLAW_ASTRAEUS_FALLBACK_TURBO_MODEL",
    turboDefault: DEFAULT_ASTRAEUS_FALLBACK_TURBO_MODEL,
    bedrockEnv: "OPENCLAW_ASTRAEUS_FALLBACK_BEDROCK_MODEL",
  },
} as const

/** True iff a Turbo OR Bedrock fallback leg would be built for this model (mirrors fallback-chain.ts). */
function modelHasFallback(env: Env, cfg: (typeof MODEL_FALLBACKS)[keyof typeof MODEL_FALLBACKS]): boolean {
  const turboModel = resolveTurboModel(env[cfg.turboEnv] as string | undefined, cfg.turboDefault)
  const turbo = isTurboConfigured(env.OLLAMA_API_KEY, turboModel)
  const bedrock = isBedrockConfigured(
    {
      region: env.OPENCLAW_AWS_REGION,
      accessKeyId: env.OPENCLAW_AWS_ACCESS_KEY_ID,
      secretAccessKey: env.OPENCLAW_AWS_SECRET_ACCESS_KEY,
    },
    (env[cfg.bedrockEnv] as string | undefined)?.trim() || undefined,
  )
  return turbo || bedrock
}

export async function handleModelsHealthRoute(
  env: Env,
  ctx: ExecutionContext,
  deps: ModelsHealthDeps = defaultModelsDeps,
): Promise<Response> {
  try {
    const checks: Record<string, HealthCheck> = {}

    // The `/v1/*` routes 503 before the failover chain unless BOTH an auth config
    // and the gateway issuer are set (see vertex-chat-route.ts). If not serveable,
    // no model — Vertex OR fallback — can answer, so the whole component is down.
    const routeServeable = Boolean(
      (env.OPENCLAW_SIGILIX_API_KEY || env.SIGILIX_PLATFORM_DB) && env.OPENCLAW_GATEWAY_ISSUER,
    )
    if (!routeServeable) {
      checks.gateway = { status: "down", detail: "gateway route not configured" }
      checks.boreas = { status: "down" }
      checks.pyroeis = { status: "down" }
      checks.astraeus = { status: "down" }
      return healthResponse("down", checks)
    }

    const gatewayUp = await deps.probeGateway(env, ctx)
    checks.gateway = gatewayUp
      ? { status: "operational", detail: "vertex token mint ok" }
      : { status: "down", detail: "vertex leg unavailable" }

    // Per-model served state. Vertex up → operational. Vertex down → each model
    // degrades ONLY if its OWN fallback leg is CONFIGURED, else it is down.
    // SHALLOW-CHECK CAVEAT: a configured fallback is config-presence, NOT a
    // liveness probe of Turbo/Bedrock (those would cost an API call). So on a
    // Vertex outage a model with a dead-but-configured fallback reports
    // `degraded` (not `down`) — degraded is the honest "not fully healthy,
    // relying on an unverified fallback" signal, deliberately never `operational`.
    const modelChecks: Record<string, HealthCheck> = {}
    for (const [name, cfg] of Object.entries(MODEL_FALLBACKS)) {
      modelChecks[name] = gatewayUp
        ? { status: "operational" }
        : modelHasFallback(env, cfg)
          ? { status: "degraded", detail: "vertex down — fallback configured (not liveness-verified)" }
          : { status: "down" }
    }
    Object.assign(checks, modelChecks)

    // Overall reflects COMPONENT serveability, not the Vertex leg alone (the
    // `gateway` check is informational). Best-effort across models: all
    // operational → operational; some models down while others still serve →
    // degraded (partial); every model down → down. So one fallback-less model
    // (Pyroeis) going down during a Vertex outage degrades — it does not falsely
    // report a full outage while Boreas/Astraeus still serve via Turbo.
    const modelStates = Object.values(modelChecks).map((c) => c.status)
    const allOperational = modelStates.every((s) => s === "operational")
    const anyServing = modelStates.some((s) => s === "operational" || s === "degraded")
    const overall: HealthStatus = allOperational ? "operational" : anyServing ? "degraded" : "down"
    return healthResponse(overall, checks)
  } catch {
    return healthResponse("down", { models: { status: "down", detail: "models health route error" } })
  }
}

// ── GET /health/integrations ──────────────────────────────────────────────────
//
// Integrations component: GitHub / GitLab / Slack / Linear. Config-presence +
// a CHEAP, unauthenticated, no-cost, non-mutating reachability probe where one
// exists. Never calls anything billable and never mutates. Missing config or an
// unreachable host → `degraded`, never a crash. Reachability treats ANY HTTP
// response (even 4xx) as "host reachable" — we're testing DNS/TCP/TLS liveness,
// not auth. All four probes run CONCURRENTLY so a few hung hosts can't stack
// their timeouts. Slack has a true unauthenticated liveness endpoint (api.test);
// GitHub uses its public API root; GitLab uses its instance origin; Linear's API
// is auth-only so it is CONFIG-PRESENCE (API key OR OAuth OR agent creds) +
// host-reachability only (see report).
export interface IntegrationsHealthDeps {
  /** Reachability: resolve true iff the URL returns ANY HTTP response in time. */
  reach: (url: string, signal: AbortSignal) => Promise<boolean>
}

const defaultIntegrationsDeps: IntegrationsHealthDeps = {
  reach: async (url, signal) => {
    const res = await fetch(url, { method: "GET", signal, redirect: "manual" })
    // Any status (incl. 3xx/4xx) means the host answered → reachable.
    return res.status > 0
  },
}

/** Resolve a config-presence + reachability check into a HealthStatus. */
async function integrationCheck(
  configured: boolean,
  reachUrl: string | null,
  deps: IntegrationsHealthDeps,
  detail: string,
): Promise<HealthCheck> {
  if (!configured) return { status: "not_configured", detail: `${detail} (no config)` }
  if (!reachUrl) return { status: "operational", detail: `${detail} (config present)` }
  const reachable = await probe((signal) => deps.reach(reachUrl, signal))
  return reachable ? { status: "operational", detail } : { status: "degraded", detail: `${detail} unreachable` }
}

export async function handleIntegrationsHealthRoute(
  env: Env,
  deps: IntegrationsHealthDeps = defaultIntegrationsDeps,
): Promise<Response> {
  try {
    const gitlabBase = (env.SIGILIX_GITLAB_BASE_URL ?? "https://gitlab.com").replace(/\/+$/, "")

    // All four probes run CONCURRENTLY so total latency is ~one PROBE_TIMEOUT_MS,
    // not the sum — several hung hosts must not push the route toward ~10s.
    const [github, gitlab, slack, linear] = await Promise.all([
      // GitHub: App credentials present → configured; public API root is a cheap,
      // unauthenticated reachability target (no cost, no mutation).
      integrationCheck(Boolean(env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY), "https://api.github.com/", deps, "github"),
      // GitLab: configured = a token OR a COMPLETE OAuth id+secret pair (a bare
      // client id can't exchange tokens, so it isn't "configured"). Reach the
      // instance origin (SIGILIX_GITLAB_BASE_URL, default gitlab.com) — no auth call.
      integrationCheck(
        Boolean(
          env.SIGILIX_GITLAB_TOKEN || (env.SIGILIX_GITLAB_OAUTH_CLIENT_ID && env.SIGILIX_GITLAB_OAUTH_CLIENT_SECRET),
        ),
        `${gitlabBase}/-/health`,
        deps,
        "gitlab",
      ),
      // Slack: signing secret / bot token / client id present → configured;
      // api.test is Slack's unauthenticated liveness endpoint (no cost/mutation).
      integrationCheck(
        Boolean(env.SLACK_SIGNING_SECRET || env.SLACK_BOT_TOKEN || env.SLACK_CLIENT_ID),
        "https://slack.com/api/api.test",
        deps,
        "slack",
      ),
      // Linear: configured = a human API key, OR a COMPLETE OAuth id+secret pair,
      // OR a COMPLETE dedicated-agent id+secret pair (a bare client id can't
      // exchange tokens). A deployment may use any of these instead of a personal
      // LINEAR_API_KEY. Linear's API is auth-only (no public liveness route), so
      // this is CONFIG-PRESENCE + host reachability only.
      integrationCheck(
        Boolean(
          env.LINEAR_API_KEY ||
          (env.LINEAR_OAUTH_CLIENT_ID && env.LINEAR_OAUTH_CLIENT_SECRET) ||
          (env.OPENCLAW_LINEAR_AGENT_CLIENT_ID && env.OPENCLAW_LINEAR_AGENT_CLIENT_SECRET),
        ),
        "https://api.linear.app/",
        deps,
        "linear",
      ),
    ])

    const checks: Record<string, HealthCheck> = { github, gitlab, slack, linear }
    return healthResponse(worst(checks), checks)
  } catch {
    return healthResponse("down", { integrations: { status: "down", detail: "integrations health route error" } })
  }
}
