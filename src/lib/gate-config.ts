// SIG-161 PR 4a — KV-backed gate config (threshold + logistic model).
//
// Two values live in KV (NOT wrangler.toml) so a calibration retune is
// a `wrangler kv:key put` not a redeploy:
//
//   config:gate-threshold:v1   — number 0..1 (default 1.0 = never block)
//   config:gate-model:v1       — JSON {intercept, coefs} (default null =
//                                 use the hand-blend in `computeGateScore`)
//
// A 60-second in-memory cache bounds the worst-case staleness window:
// after `wrangler kv:key put`, the next request that lands on a Worker
// instance with a stale cache sees the old value, but within 60s every
// instance has read-through to the new one. KV read latency makes this
// the right tradeoff (no need to read on every PR review).
//
// Both reads have hardcoded fallbacks (1.0 / null) so a KV miss never
// breaks production — the legacy verdict path still ships.

import type { Env } from "@/src/shared/types/env"

/** KV keys — versioned so a schema change increments the suffix. */
export const GATE_THRESHOLD_KV_KEY = "config:gate-threshold:v1"
export const GATE_MODEL_KV_KEY = "config:gate-model:v1"

/**
 * Default threshold when KV is missing or unparseable. `1.0` is the
 * "off-equivalent" value — with `missingScorePolicy: "block"`, a
 * finding's effective score defaults to 1.0, which is >= 1.0 → blocks
 * (matches the legacy `findings.length > 0 → REQUEST_CHANGES`).
 *
 * Calibrated production threshold lives in KV (e.g. 0.85). After PR 4c
 * lands, founder runs `wrangler kv:key put` with the calibration's
 * recommended value.
 */
export const DEFAULT_GATE_THRESHOLD = 1.0

/** TTL for the in-memory cache, in milliseconds. */
const CACHE_TTL_MS = 60_000

// Per-key cache entry: either a settled value with an expiry, OR an
// in-flight Promise (single-flight coalescing — see below).
type CacheEntry<T> =
  | { kind: "value"; value: T; expiresAt: number }
  | { kind: "pending"; promise: Promise<T> }

// Per-binding caches keyed on the KVNamespace object itself. This
// matters in two scenarios:
//   1. A single isolate handling multiple environments (e.g. a future
//      multi-tenant worker, or tests that spin up Envs with separate
//      KV mocks). A process-global cache would leak a threshold read
//      from one env's KV into another for up to 60 s.
//   2. Tests that swap Env between cases without calling
//      `__resetGateConfigCacheForTests` — the WeakMap means each test
//      Env gets a fresh slot by construction.
//
// WeakMap so an Env going out of scope releases its cache entry
// automatically; KV bindings are durable in production but cheap to
// re-cache if dropped.
//
// Single-flight rationale: Workers JS is single-threaded but `await`
// yields the event loop. Two concurrent requests hitting a cold cache
// would both pass the expiry check and both fire `OPENCLAW_STATE.get`
// before either could write the cache. KV reads are idempotent so the
// functional impact is benign, but a populated `kind: "pending"` slot
// lets concurrent reads share one KV roundtrip — both `await` the
// same Promise. In PR 4c's `enforce` regime under real customer
// traffic this is the difference between 1 KV read per minute and
// 1 KV read per concurrent request during cache-fill windows.
// Mutable so `__resetGateConfigCacheForTests` can swap them. WeakMap
// doesn't expose `.clear()` in the spec, so reassignment is the way
// to nuke every entry at once. Production code never reassigns.
let thresholdCache: WeakMap<KVNamespace, CacheEntry<number>> = new WeakMap()
let modelCache: WeakMap<KVNamespace, CacheEntry<GateModel | null>> = new WeakMap()

/**
 * Shape of the logistic-regression model artifact committed to KV in
 * PR 4c. Predicts P(TP | features) from the same feature vector as
 * `computeGateScore`'s hand-blend (rescaled confidence, evidence flag,
 * agreement count, severity).
 *
 * `intercept` and `coefs` are emitted by `scripts/calibrate-sig-161.ts`
 * after fitting on the labeled dataset. Inference is one dot product
 * + sigmoid — runs in the Worker without any ML runtime.
 */
export interface GateModel {
  /** Schema version of this artifact. v1 = logistic regression. */
  version: 1
  /** Logistic-regression intercept (β₀). */
  intercept: number
  /** Coefficient per feature, in the order produced by the trainer. */
  coefs: ReadonlyArray<number>
  /** Feature names matching the coef order — keeps inference honest. */
  featureNames: ReadonlyArray<string>
  /**
   * The threshold that was active at calibration time. Stored for audit
   * (so a future re-eval knows what threshold the labels were judged
   * against). Operator-set in KV, NOT read by the gate at runtime.
   */
  calibratedAt?: string
}

/**
 * Read the gate's `enforce` posture from `OPENCLAW_GATE`. Three values
 * recognised: "off" (default), "shadow", "enforce". Anything else
 * (typo, legacy value) is treated as "off" defensively.
 *
 * Cheap — no KV read. Reads the env var directly.
 */
export type GateMode = "off" | "shadow" | "enforce"

export function readGateMode(env: Env): GateMode {
  const raw = (env.OPENCLAW_GATE ?? "").trim().toLowerCase()
  if (raw === "shadow") return "shadow"
  if (raw === "enforce") return "enforce"
  return "off"
}

/**
 * Read the calibrated threshold from KV, falling back to
 * `DEFAULT_GATE_THRESHOLD` on miss / malformed / KV error. Cached for
 * 60 s per Worker isolate.
 *
 * Returns a finite number in `[0, 1]`. Out-of-range values in KV are
 * clamped silently — a `wrangler kv:key put 2.0` typo doesn't blow up
 * production; the gate just behaves as if threshold = 1.0.
 */
export async function readGateThreshold(env: Env): Promise<number> {
  const kv = env.OPENCLAW_STATE
  const now = Date.now()
  const cached = thresholdCache.get(kv)
  if (cached?.kind === "value" && cached.expiresAt > now) return cached.value
  if (cached?.kind === "pending") return cached.promise

  const promise: Promise<number> = (async () => {
    let value = DEFAULT_GATE_THRESHOLD
    try {
      const raw = await kv.get(GATE_THRESHOLD_KV_KEY)
      // Trim + reject blank/whitespace BEFORE Number() — `Number("")`
      // and `Number("   ")` both return 0, which without this guard
      // would silently produce the most aggressive threshold (gateScore
      // >= 0 blocks everything) on a malformed KV value.
      if (raw !== null) {
        const trimmed = raw.trim()
        if (trimmed.length > 0) {
          const parsed = Number(trimmed)
          if (Number.isFinite(parsed)) {
            value = Math.max(0, Math.min(1, parsed))
          }
        }
      }
    } catch {
      // KV read failure — keep the default. Observability for these
      // failures is owned by the call site (it can log `gate-config-kv-error`).
    }
    thresholdCache.set(kv, {
      kind: "value",
      value,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    return value
  })()
  thresholdCache.set(kv, { kind: "pending", promise })
  return promise
}

/**
 * Read the logistic-regression model artifact from KV. Returns `null`
 * when the artifact is missing (the PR 4a state — KV is empty) or
 * malformed; callers fall back to the hand-blend in `computeGateScore`.
 *
 * Cached for 60 s per Worker isolate. The cache stores `null` too —
 * we don't re-read on every request just because the model is absent.
 */
export async function readGateModel(env: Env): Promise<GateModel | null> {
  const kv = env.OPENCLAW_STATE
  const now = Date.now()
  const cached = modelCache.get(kv)
  if (cached?.kind === "value" && cached.expiresAt > now) return cached.value
  if (cached?.kind === "pending") return cached.promise

  const promise: Promise<GateModel | null> = (async () => {
    let value: GateModel | null = null
    try {
      const raw = await kv.get(GATE_MODEL_KV_KEY)
      if (raw !== null) {
        const parsed = parseGateModel(raw)
        if (parsed) value = parsed
      }
    } catch {
      // KV read failure — keep null. Observability owned by call site.
    }
    modelCache.set(kv, {
      kind: "value",
      value,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    return value
  })()
  modelCache.set(kv, { kind: "pending", promise })
  return promise
}

/**
 * Parse + validate a JSON model artifact. Returns null when any
 * required field is missing/wrong-shape — defense against a hand-
 * edited KV value. Pure — exported for tests.
 */
export function parseGateModel(raw: string): GateModel | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) return null
  // Strict numeric: refuse string-typed numerics like "0.5". `Number()`
  // would coerce them silently, which lets a malformed artifact pass
  // validation in a way the hand-blend fallback can't detect at
  // inference time. Coefs + intercept must all be JSON numbers.
  if (typeof obj.intercept !== "number" || !Number.isFinite(obj.intercept)) return null
  const intercept = obj.intercept
  if (!Array.isArray(obj.coefs)) return null
  const coefs = (obj.coefs as unknown[]).filter(
    (c): c is number => typeof c === "number" && Number.isFinite(c),
  )
  if (coefs.length === 0 || coefs.length !== obj.coefs.length) return null
  if (!Array.isArray(obj.featureNames)) return null
  const featureNames = (obj.featureNames as unknown[]).filter(
    (n): n is string => typeof n === "string" && n.length > 0,
  )
  if (featureNames.length !== coefs.length) return null
  const out: GateModel = { version: 1, intercept, coefs, featureNames }
  if (typeof obj.calibratedAt === "string") out.calibratedAt = obj.calibratedAt
  return out
}

/**
 * Test-only — invalidate both caches across ALL bindings. Production
 * code never calls this; Vitest does between tests so KV reads aren't
 * shared across cases.
 *
 * Reassigns each WeakMap to a fresh instance so every prior entry is
 * unreachable. Tests that build a fresh Env per case (the common
 * pattern) also benefit from the per-binding isolation the WeakMaps
 * provide by construction — but calling this is the explicit
 * "nothing is cached" guarantee.
 */
export function __resetGateConfigCacheForTests(): void {
  thresholdCache = new WeakMap()
  modelCache = new WeakMap()
}
