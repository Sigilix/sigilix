// sig-public-demo — the ABUSE CONTROLS behind POST /v1/demo/review (the public,
// no-signup "try it on any PR" endpoint). This endpoint has NO AUTH and every
// admitted request spends real model money (~$0.25/review, measured; up to ~$0.83 on
// a big diff), so these guards are the feature — the review is the easy part.
//
// The layers, in the order the route applies them:
//
//   1. KILL SWITCH (`SIGILIX_DEMO_MODE`) — FAIL CLOSED. Unset / unknown / anything
//      other than the exact string "on" → the endpoint is OFF (503 demo_disabled).
//      This inverts the repo's usual fail-open flag default ON PURPOSE: a
//      cost-spending unauthenticated endpoint that silently defaults ON if a var is
//      dropped from the Worker config is a liability, not a convenience.
//   2. PER-IP QUOTA (`SIGILIX_DEMO_IP_LIMIT`, default 3 / UTC-day) — keyed on the
//      hashed CF-Connecting-IP. Read BEFORE any GitHub/model work so an exhausted IP
//      is rejected for free; only CONSUMED on a real (uncached) review.
//   3. GLOBAL DAILY USD BUDGET (`SIGILIX_DEMO_DAILY_BUDGET_USD`, default $20) — the
//      BACKSTOP. Incremented by the REAL `computeReviewCost` the ensemble reports, so
//      worst-case spend is bounded no matter what else fails (a rotating-IP botnet
//      still hits this). Charged with a pre-reservation (see `reserveDemoSpend`) so a
//      concurrent burst can't all read an under-budget counter and all run.
//   4. RESULT CACHE (7d, keyed on owner/repo/pr/headSha) — a repeat request for the
//      same PR at the same SHA costs $0, consumes no budget, and consumes no IP
//      quota. This is what makes an HN front page (thousands of hits on the same few
//      example PRs) survivable.
//
// The counters live in KV (OPENCLAW_STATE). KV has no atomic increment, so the
// check-then-increment is non-atomic — the same COARSE-ceiling tradeoff the
// /v1/review daily ceiling already makes (a burst may slip a few past; runaway spend
// is still bounded). The budget pre-reservation narrows that window to the reconcile
// delta rather than a full review's cost per racer.

import type { Env } from "@/src/shared/types/env"
import { sha256Hex } from "@/src/lib/auth-bearer"

/**
 * The demo's own env slice, declared HERE rather than on `Env` — the same pattern
 * `PortalCorsEnv` (portal-cors.ts) uses, and required anyway because
 * `src/shared/types/env.ts` sits exactly on its 1,500-line hard ceiling
 * (COMPLIANCE §4). Every field is optional, so a plain `Env` is structurally
 * assignable to `DemoEnv` and the Worker entry point needs no cast.
 *
 * All seven are ABUSE CONTROLS. Set them with `wrangler secret put` / `[vars]`:
 *
 *   SIGILIX_DEMO_MODE             KILL SWITCH. "on" enables the endpoint; ANY other
 *                                 value (unset, "off", "ON", "true", a typo, a var
 *                                 dropped from the config) disables it. FAIL CLOSED —
 *                                 deliberately the OPPOSITE default from every other
 *                                 flag in this repo, because this one spends money
 *                                 without auth.
 *   SIGILIX_DEMO_IP_LIMIT         Demo reviews per IP per UTC-day. Unset → 3.
 *   SIGILIX_DEMO_DAILY_BUDGET_USD Global model spend per UTC-day, USD. Unset → 20.
 *                                 THE BACKSTOP: charged the REAL per-review cost.
 *   SIGILIX_DEMO_MAX_LINES        Changed-line cap. Unset → 1500.
 *   SIGILIX_DEMO_MAX_FILES        Changed-file cap. Unset → 40.
 *   SIGILIX_DEMO_ORIGINS          CORS allowlist (comma-separated, exact). Unset →
 *                                 the marketing site + local dev. NOT an abuse
 *                                 control — curl ignores CORS.
 *   SIGILIX_DEMO_GITHUB_TOKEN     OPTIONAL scopeless read-only token, used ONLY to
 *                                 lift GitHub's 60/hr unauthenticated rate limit.
 *                                 NEVER accepted from the caller; the public-repo
 *                                 assertion does not depend on it.
 */
export interface DemoEnv extends Env {
  SIGILIX_DEMO_MODE?: string
  SIGILIX_DEMO_IP_LIMIT?: string
  SIGILIX_DEMO_DAILY_BUDGET_USD?: string
  SIGILIX_DEMO_MAX_LINES?: string
  SIGILIX_DEMO_MAX_FILES?: string
  SIGILIX_DEMO_ORIGINS?: string
  SIGILIX_DEMO_GITHUB_TOKEN?: string
}

/** Per-IP demo reviews per UTC-day when `SIGILIX_DEMO_IP_LIMIT` is unset/unparseable. */
export const DEFAULT_DEMO_IP_LIMIT = 3
/** Global demo model spend per UTC-day when `SIGILIX_DEMO_DAILY_BUDGET_USD` is unset. */
export const DEFAULT_DEMO_DAILY_BUDGET_USD = 20
/** Changed-line ceiling (additions + deletions) when `SIGILIX_DEMO_MAX_LINES` is unset. */
export const DEFAULT_DEMO_MAX_LINES = 1500
/** Changed-file ceiling when `SIGILIX_DEMO_MAX_FILES` is unset. */
export const DEFAULT_DEMO_MAX_FILES = 40
/** Hard cap on the fetched diff itself — a 40-file / 1500-line PR can still carry a
 *  pathological single-line blob. Bytes, not lines. */
export const DEMO_MAX_DIFF_BYTES = 400_000
/** The cost we RESERVE against the daily budget before a review runs, and the amount
 *  charged when the engine throws before reporting telemetry (a thrown engine may
 *  still have spent). ~1 measured review. Reconciled to the real cost afterwards. */
export const DEMO_ASSUMED_COST_USD = 0.25
/** Result-cache TTL. Long enough that a launch-day example PR is paid for once. */
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60
/** Day-keyed counters expire after 2 days (yesterday's key is dead weight). */
const DAY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60

export type DemoMode = "on" | "off"

/**
 * FAIL CLOSED: only the exact lowercase string "on" enables the demo. Unset,
 * misspelled, "true", "ON", or a dropped var all resolve to "off". See the header —
 * this is deliberately the opposite default from the other feature flags in this repo.
 */
export function resolveDemoMode(env: DemoEnv): DemoMode {
  return env.SIGILIX_DEMO_MODE === "on" ? "on" : "off"
}

/** A positive integer env override, or the default. Rejects 0, negatives, NaN, floats. */
function positiveIntOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** A positive finite number env override, or the default. */
function positiveNumberOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export interface DemoLimits {
  ipLimit: number
  dailyBudgetUsd: number
  maxLines: number
  maxFiles: number
}

export function resolveDemoLimits(env: DemoEnv): DemoLimits {
  return {
    ipLimit: positiveIntOr(env.SIGILIX_DEMO_IP_LIMIT, DEFAULT_DEMO_IP_LIMIT),
    dailyBudgetUsd: positiveNumberOr(env.SIGILIX_DEMO_DAILY_BUDGET_USD, DEFAULT_DEMO_DAILY_BUDGET_USD),
    maxLines: positiveIntOr(env.SIGILIX_DEMO_MAX_LINES, DEFAULT_DEMO_MAX_LINES),
    maxFiles: positiveIntOr(env.SIGILIX_DEMO_MAX_FILES, DEFAULT_DEMO_MAX_FILES),
  }
}

// ─── PR URL parsing (pure) ──────────────────────────────────────────

export interface DemoPrTarget {
  owner: string
  repo: string
  prNumber: number
}

const GITHUB_HOSTS: ReadonlySet<string> = new Set(["github.com", "www.github.com"])
const NAME_RE = /^[A-Za-z0-9._-]+$/

/**
 * Parse `https://github.com/<owner>/<repo>/pull/<n>` (trailing segments like `/files`,
 * a query string, or a fragment are tolerated). Anything else — another host, a
 * non-PR path, a non-numeric number, a `..`/`.` path segment — returns null → 400
 * invalid_url. Strict on the host so this can never be pointed at an internal or
 * attacker-controlled API base.
 */
export function parseDemoPrUrl(raw: string): DemoPrTarget | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts.length < 4) return null
  const [owner, repo, kind, num] = parts as [string, string, string, string]
  if (kind !== "pull" && kind !== "pulls") return null
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null
  if (!/^[0-9]+$/.test(num)) return null
  const prNumber = Number(num)
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null
  const cleanRepo = repo.replace(/\.git$/, "")
  if (cleanRepo === "") return null // e.g. ".git" strips to empty → not a real repo
  return { owner, repo: cleanRepo, prNumber }
}

/**
 * The quota bucket key for an IP. For IPv6 we bucket on the /64 PREFIX, not the full
 * address: a single host is routinely handed an entire /64 (18 quintillion addresses)
 * and can rotate its source address per request, so keying on the full address would
 * make the per-IP cap trivially bypassable. IPv4 keeps its full address.
 */
export function ipBucket(ip: string): string {
  if (ip.includes(":")) {
    // Expand `::` so we can take a stable first-four-hextet (/64) prefix.
    const [head = "", tail = ""] = ip.split("::")
    const headParts = head.split(":").filter(Boolean)
    const tailParts = tail.split(":").filter(Boolean)
    const missing = Math.max(0, 8 - headParts.length - tailParts.length)
    const full = [...headParts, ...Array(missing).fill("0"), ...tailParts]
    return `v6:${full.slice(0, 4).join(":")}`
  }
  return `v4:${ip}`
}

// ─── KV-backed counters ─────────────────────────────────────────────

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/** Seconds until the next UTC midnight — the `retryAfterSec` a rate-limited caller gets. */
export function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

/** IPs are PII — key the quota on a hash of the IP BUCKET (a /64 for IPv6), never the
 *  raw address. */
async function ipKey(ip: string, now: Date): Promise<string> {
  return `demo:ip:${await sha256Hex(ipBucket(ip))}:${utcDay(now)}`
}

export interface IpQuota {
  used: number
  limit: number
  exhausted: boolean
}

/**
 * READ the caller's IP quota WITHOUT consuming it. Called before any GitHub or model
 * work so an over-quota IP costs us nothing. Fail-CLOSED on a KV fault: an
 * unauthenticated spend endpoint must not fall open into "unlimited" when its counter
 * is unreadable (this is the opposite of the /v1/review ceiling's fail-open, and it is
 * the right call here — the worst case of failing closed is a down demo, the worst case
 * of failing open is an unbounded bill).
 */
export async function readIpQuota(env: DemoEnv, ip: string, now: Date, limits: DemoLimits): Promise<IpQuota> {
  try {
    const used = Number(await env.OPENCLAW_STATE.get(await ipKey(ip, now))) || 0
    return { used, limit: limits.ipLimit, exhausted: used >= limits.ipLimit }
  } catch {
    return { used: limits.ipLimit, limit: limits.ipLimit, exhausted: true }
  }
}

/** CONSUME one unit of the caller's IP quota. Only called for a real (uncached) review. */
export async function consumeIpQuota(env: DemoEnv, ip: string, now: Date): Promise<void> {
  try {
    const key = await ipKey(ip, now)
    const used = Number(await env.OPENCLAW_STATE.get(key)) || 0
    await env.OPENCLAW_STATE.put(key, String(used + 1), { expirationTtl: DAY_COUNTER_TTL_SECONDS })
  } catch {
    /* best-effort: the global budget is the hard backstop */
  }
}

function spendKey(now: Date): string {
  return `demo:spend:${utcDay(now)}`
}

async function readSpend(env: DemoEnv, now: Date): Promise<number> {
  const raw = Number(await env.OPENCLAW_STATE.get(spendKey(now)))
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Is the global daily demo budget exhausted? Fail-CLOSED on a KV fault, same reasoning
 * as `readIpQuota` — this counter is the ONLY thing bounding worst-case spend, so an
 * unreadable counter means "stop", not "spend freely".
 */
export async function isDemoBudgetExhausted(env: DemoEnv, now: Date, limits: DemoLimits): Promise<boolean> {
  try {
    return (await readSpend(env, now)) >= limits.dailyBudgetUsd
  } catch {
    return true
  }
}

/**
 * Add `usd` to the day's spend counter (a negative value reconciles an over-reservation).
 * Best-effort: a KV write failure here can't be allowed to fail the review the user
 * already paid for, but it IS logged — a persistently-failing counter is a spend hole.
 */
export async function addDemoSpend(env: DemoEnv, now: Date, usd: number): Promise<void> {
  try {
    const key = spendKey(now)
    const current = await readSpend(env, now)
    const next = Math.max(0, current + usd)
    await env.OPENCLAW_STATE.put(key, next.toFixed(6), { expirationTtl: DAY_COUNTER_TTL_SECONDS })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "demo-spend-write-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

/**
 * RESERVE one review's assumed cost against the day's budget BEFORE running it, so a
 * concurrent burst can't all read an under-budget counter and all spend. Reconciled by
 * `settleDemoSpend` with the real `costUsd` once the ensemble reports it.
 */
export async function reserveDemoSpend(env: DemoEnv, now: Date): Promise<void> {
  await addDemoSpend(env, now, DEMO_ASSUMED_COST_USD)
}

/** Reconcile the reservation to the REAL cost the ensemble reported (delta, may be negative). */
export async function settleDemoSpend(env: DemoEnv, now: Date, actualUsd: number): Promise<void> {
  const actual = Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : DEMO_ASSUMED_COST_USD
  await addDemoSpend(env, now, actual - DEMO_ASSUMED_COST_USD)
}

// ─── Result cache ───────────────────────────────────────────────────

function cacheKey(target: DemoPrTarget, headSha: string): string {
  return `demo:review:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}/pr/${target.prNumber}/${headSha}`
}

/** A cached review body, or null on a miss / KV fault (a miss just means we pay again). */
export async function readDemoCache<T>(env: DemoEnv, target: DemoPrTarget, headSha: string): Promise<T | null> {
  try {
    return await env.OPENCLAW_STATE.get<T>(cacheKey(target, headSha), "json")
  } catch {
    return null
  }
}

export async function writeDemoCache(
  env: DemoEnv,
  target: DemoPrTarget,
  headSha: string,
  body: unknown,
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(cacheKey(target, headSha), JSON.stringify(body), {
      expirationTtl: CACHE_TTL_SECONDS,
    })
  } catch {
    /* best-effort — a cache-write failure only costs money on the next identical request */
  }
}
