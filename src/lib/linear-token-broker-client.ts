// SIG-144 (Linear unification cutover, slice 2): thin typed client for the
// LinearTokenBroker DO (`src/do/linear-token-broker.ts`) — mirrors the
// repo-graph-client.ts / graph-metrics-client.ts RPC-call pattern (resolve the
// singleton stub, call the typed method directly; no `.fetch()` wire hop).
//
// This is the SOURCE swap for `buildLinearAgentClient` (linear.ts): instead of
// reading the agent token from KV (`linear-agent-oauth.ts`), callers now read
// it from the DO, which is the strongly-consistent source of truth (see the DO
// file header for why). The broker itself does the refresh; this client never
// does — it only reads (`readOnly: true`) or, for the future 401-retry slice,
// forces a refresh (`forceRefreshViaBroker`).
//
// Fail-safe contract (preserved from the KV path): any failure — DO RPC throw,
// `{ ok: false }` (not-installed / no-refresh-token / refresh-failed) — maps to
// `null`. Never throws, never falls back to a human API key. A `null` here
// means "skip the agent activity post," exactly like the KV path's contract.
//
// SECURITY: token material is NEVER logged here. The only log lines this module
// emits are neutral breadcrumbs on the no-token / RPC-error read paths
// (`linear-token-broker-unavailable` with a reason, `linear-token-broker-rpc-error`
// with the error message) — never an access/refresh token. The DO emits its own
// neutral telemetry for the install/refresh paths.

import type { Env } from "@/src/shared/types/env"
import type { LinearTokenBroker, BrokerTokenResult } from "@/src/do/linear-token-broker"
import type { LinearAgentTokenRecord } from "@/src/lib/linear-agent-oauth"

/** Minimal env slice this client needs — mirrors the `AgentTokenEnv` /
 *  `LinearAuthEnv` minimal-slice convention in linear.ts / linear-agent-oauth.ts
 *  so a caller (or a test) doesn't need to satisfy the full `Env` shape. */
export type LinearTokenBrokerEnv = Pick<Env, "LINEAR_TOKEN_BROKER">

/** Matches the DO's singleton id (see linear-token-broker.ts header comment). */
const BROKER_SINGLETON_NAME = "linear-agent"

/** Isolate-level read cache TTL for the read-only path (the hot ACK /
 *  agent-activity path) — bounds DO subrequests without weakening the broker's
 *  role as source of truth: a stale or absent cache entry always falls through
 *  to the DO, which remains the only place that ever refreshes. */
const CACHE_TTL_MS = 30 * 1000

interface CachedToken {
  accessToken: string
  /** ms epoch when this CACHE ENTRY (not the underlying Linear token) goes
   *  stale and the next readOnly call must re-check the DO. */
  expiresAt: number
}

/** Module-level — ISOLATE-scoped (not cross-isolate, not durable). Each worker
 *  isolate gets its own cache; the DO is unaffected and stays authoritative. */
let cachedReadOnlyToken: CachedToken | null = null

/** Env declares LINEAR_TOKEN_BROKER as the unparameterised DurableObjectNamespace
 *  (mirrors REPO_GRAPH_DO / GRAPH_METRICS_DO). The cast is safe: wrangler.toml
 *  binds exactly LinearTokenBroker to the LINEAR_TOKEN_BROKER name. */
function brokerStub(env: LinearTokenBrokerEnv): DurableObjectStub<LinearTokenBroker> {
  const ns = env.LINEAR_TOKEN_BROKER as unknown as DurableObjectNamespace<LinearTokenBroker>
  return ns.get(ns.idFromName(BROKER_SINGLETON_NAME))
}

/**
 * Return a valid Linear agent access token via the broker DO, or `null` on any
 * failure (fail-safe).
 *
 * `readOnly: true` (the ACK / agent-activity path) — NEVER triggers a refresh;
 * served from the isolate cache when fresh (<30s old), otherwise a single DO
 * read which is then cached. `readOnly: false` always calls the DO directly
 * (no caching — a mutating caller wants the DO's own freshness decision, not a
 * stale isolate-local copy); reserved for a later slice, nothing calls it yet.
 *
 * Never throws: a DO RPC fault is caught and mapped to `null`, same as a
 * structured `{ ok: false }` result. Both no-token outcomes leave a NEUTRAL
 * breadcrumb (never token material) so the post-cutover "broker not yet
 * bootstrapped" state (`reason: "not-installed"` → re-run the install to
 * populate the DO) is distinguishable from a genuine token problem or a DO
 * outage — the DO emits telemetry for its own install/refresh, but not for a
 * read it answered as empty or one that never reached it.
 */
export async function getValidAgentTokenViaBroker(
  env: LinearTokenBrokerEnv,
  opts: { readOnly: boolean },
): Promise<string | null> {
  if (opts.readOnly && cachedReadOnlyToken && Date.now() < cachedReadOnlyToken.expiresAt) {
    return cachedReadOnlyToken.accessToken
  }

  let result: BrokerTokenResult
  try {
    result = await brokerStub(env).getValidToken({ readOnly: opts.readOnly })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "linear-token-broker-rpc-error",
        readOnly: opts.readOnly,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return null
  }

  if (!result.ok) {
    console.warn(
      JSON.stringify({ event: "linear-token-broker-unavailable", readOnly: opts.readOnly, reason: result.reason }),
    )
    return null
  }
  // A token never overwrites the cache on the readOnly path unless this call
  // actually went to the DO (a cache hit short-circuits above), so this only
  // ever stores a freshly-read token. The previous explicit cache clears on the
  // failure paths were dead code (a still-valid entry short-circuits before
  // reaching them) and could clobber a sibling call's fresh entry under
  // concurrent interleave — dropped.
  if (opts.readOnly) {
    cachedReadOnlyToken = { accessToken: result.accessToken, expiresAt: Date.now() + CACHE_TTL_MS }
  }
  return result.accessToken
}

/**
 * Always force a guarded refresh through the broker DO (reserved for the later
 * 401-retry slice — nothing calls this yet). Refreshes the isolate's read
 * cache with the freshly-forced token so an immediately-following readOnly
 * read in this isolate doesn't serve a pre-refresh token for the rest of the
 * TTL window. Never throws: maps any failure to `null`.
 */
export async function forceRefreshViaBroker(env: LinearTokenBrokerEnv): Promise<string | null> {
  let result: BrokerTokenResult
  try {
    result = await brokerStub(env).forceRefresh()
  } catch {
    return null
  }
  if (!result.ok) return null
  cachedReadOnlyToken = { accessToken: result.accessToken, expiresAt: Date.now() + CACHE_TTL_MS }
  return result.accessToken
}

/**
 * Bootstrap the broker DO's storage with a freshly-issued (or re-issued) agent
 * token record. Called from `handleLinearOAuthCallback` on every install /
 * re-install, alongside (not instead of) the existing KV `putLinearAgentToken`
 * write — this slice ADDS the DO path, it does not remove the KV one.
 *
 * Invalidates the isolate read cache so a subsequent readOnly read in THIS
 * isolate reflects the new install immediately rather than serving a token
 * cached before it.
 *
 * Returns `true` on success, `false` on any DO RPC fault (never throws) — the
 * caller treats this as best-effort/additive: a broker install failure must
 * not fail the OAuth callback, since KV remains the install's source of truth
 * for this slice.
 */
export async function installAgentTokenToBroker(
  env: LinearTokenBrokerEnv,
  record: LinearAgentTokenRecord,
): Promise<boolean> {
  try {
    await brokerStub(env).install(record)
  } catch {
    return false
  }
  cachedReadOnlyToken = null
  return true
}

/**
 * Test-only: clear the isolate read cache. Production code never calls this;
 * Vitest calls it between cases so a cached token from one test isn't read by
 * the next (the cache is module-level, so it otherwise persists for the life
 * of the test file's module instance).
 */
export function __resetBrokerClientCacheForTests(): void {
  cachedReadOnlyToken = null
}
