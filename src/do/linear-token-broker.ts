// SIG-144 (Linear unification cutover, slice 1): LinearTokenBroker — the Durable
// Object that OWNS the Linear agent token lifecycle and SERIALIZES refresh across
// isolates.
//
// Why a DO: the KV-backed path (linear-agent-oauth.ts) is correct for low traffic
// but has two structural gaps for a rotating, single-use refresh token —
//   1. KV is eventually-consistent, so a refresh persisted by one isolate can be
//      read stale by another → a double-rotation that invalidates the live token.
//   2. The in-isolate single-flight there is best-effort: two isolates can each
//      issue a refresh POST concurrently.
// Routing every token read/refresh through ONE DO instance
// (idFromName("linear-agent")) makes the DO's own transactional storage the single
// source of truth (strongly consistent, NOT KV) and collapses all refreshes to ONE
// in-flight POST globally — the cross-isolate gap is closed because there is exactly
// one isolate for the agent token.
//
// Slice 1 (this class) was INERT — it existed, compiled, deployed, and was tested,
// but nothing called it. Slice 2 (src/lib/linear-token-broker-client.ts) cuts
// `buildLinearAgentClient` (linear.ts) over to read through this broker (readOnly,
// never refreshing from the hot ACK path) and bootstraps it on install/re-install
// (`handleLinearOAuthCallback`). The agent-activity RUN path itself stays gated by
// `OPENCLAW_LINEAR_AGENT_RUN_MODE` — orthogonal to this DO. Slice 3 added the
// `onUnauthorized` 401-retry hook (`forceRefreshViaBroker`) to the broker-backed
// client. Slice 4 flag-gates `buildLinearAuth` itself (OPENCLAW_LINEAR_UNIFIED,
// default off) to route the client_credentials / human-LINEAR_API_KEY path's
// callers through this same broker (readOnly:false) when on, with no fallback to
// the human key on a broker miss — see `buildLinearAuth` / `buildLinearClient`.
//
// SECURITY: token + refresh-token material is NEVER logged. Every emit/alert here
// carries only neutral booleans (hasRefresh/hasExpiry/scopePresent) and failure
// reasons — never the tokens themselves, never the refresh response body.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
import {
  performAgentTokenRefresh,
  resolveAgentOAuthCreds,
  REFRESH_BUFFER_MS,
  FALLBACK_TOKEN_TTL_MS,
  type LinearAgentTokenRecord,
} from "@/src/lib/linear-agent-oauth"

/** DO-storage key holding the single agent token record (strongly consistent). */
const TOKEN_KEY = "linear-agent-token"

/** Aggressive write-retry count for persisting a rotated record. The POST already
 *  rotated (and consumed) the refresh token at Linear, so a dropped write is the
 *  worst case — the next refresh would use a consumed token. Retry hard. */
const PERSIST_RETRY_ATTEMPTS = 4

/** Floor for how soon a freshly-armed proactive-refresh alarm may fire, so a
 *  near/past expiry schedules a near-future fire instead of one in the past. */
const ALARM_MIN_DELAY_MS = 30 * 1000

/** Backoff used when an alarm-driven refresh FAILS — re-arm a short retry so the
 *  token is refreshed before its hard expiry rather than spinning immediately. */
const ALARM_RETRY_MS = 5 * 60 * 1000

/** Structured result of a token read/refresh. Never null → no NPE at call sites.
 *  `not-installed` = cold start / empty storage; `no-refresh-token` = a record
 *  exists but cannot be refreshed; `refresh-failed` = refresh failed AND the old
 *  token is hard-expired (no safe fallback). */
export type BrokerTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "not-installed" | "no-refresh-token" | "refresh-failed" }

/** Neutral structured log — NEVER token material. */
function emit(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, system: "linear-token-broker", ...fields }))
}

/** Loud neutral alert (stderr) — NEVER token material. */
function alert(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, system: "linear-token-broker", ...fields }))
}

export class LinearTokenBroker extends DurableObject<Env> {
  /**
   * In-instance single-flight: concurrent refresh callers dedupe to ONE in-flight
   * POST. Because this DO is a SINGLETON (idFromName("linear-agent")), there is
   * exactly ONE isolate for the agent token globally, so this promise is GLOBALLY
   * authoritative — it closes the cross-isolate gap that made the KV single-flight
   * (linear-agent-oauth.ts) best-effort. Preferred over blockConcurrencyWhile so
   * read-only token reads are never blocked while a refresh is in flight.
   */
  private refreshInFlight: Promise<BrokerTokenResult> | null = null

  /**
   * Persist the bootstrap token record (from the OAuth install) and arm the
   * proactive-refresh alarm at expiresAt - REFRESH_BUFFER_MS. The record becomes
   * the broker's source of truth in DO storage.
   */
  async install(record: LinearAgentTokenRecord): Promise<{ ok: true }> {
    await this.ctx.storage.put(TOKEN_KEY, record)
    await this.scheduleAlarm(record.expiresAt)
    emit("linear-token-broker-installed", {
      hasRefresh: !!record.refreshToken,
      hasExpiry: typeof record.expiresAt === "number",
      scopePresent: !!record.scope,
    })
    return { ok: true }
  }

  /**
   * Return a valid agent access token.
   *
   * - No stored record → structured `not-installed` (never null → no NPE).
   * - `readOnly`, a legacy record with no `expiresAt`, or comfortably within the
   *   refresh buffer → the CURRENT access token, no POST.
   * - Otherwise (mutating call at/near expiry) → a guarded, single-flight refresh.
   */
  async getValidToken(args: { readOnly: boolean }): Promise<BrokerTokenResult> {
    const record = await this.read()
    if (!record) return { ok: false, reason: "not-installed" }

    // readOnly OR legacy-no-expiry → return current token without refreshing.
    if (args.readOnly || typeof record.expiresAt !== "number") {
      return { ok: true, accessToken: record.accessToken }
    }
    // Comfortably fresh → current token.
    if (Date.now() < record.expiresAt - REFRESH_BUFFER_MS) {
      return { ok: true, accessToken: record.accessToken }
    }
    // At/near expiry, mutating call → guarded refresh.
    return this.guardedRefresh()
  }

  /** Always perform a guarded refresh (used later by the 401-retry path). */
  async forceRefresh(): Promise<BrokerTokenResult> {
    return this.guardedRefresh()
  }

  /**
   * Proactive refresh fired by the DO alarm — this is what keeps the token fresh
   * without any request traffic. Runs the guarded refresh, then re-arms the alarm:
   * on success doRefresh already armed it to the new expiry; on failure (still
   * installed) re-arm a short retry so we try again before the hard expiry.
   */
  override async alarm(): Promise<void> {
    const result = await this.guardedRefresh()
    // Keep the proactive cycle alive: a successful ROTATION already re-armed the
    // alarm to the new expiry in doRefresh; any other outcome (a fall-back to the
    // still-valid old token, or a hard failure) leaves no alarm set, so re-arm a
    // short retry to try again before hard expiry. `result.ok` is true on a
    // fall-back too, so we key off the actual alarm state, not the result. A
    // not-installed broker (no record) is left without an alarm so it never spins.
    const record = await this.read()
    if (record && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS)
    }
    emit("linear-token-broker-alarm", { tokenAvailable: result.ok })
  }

  // ── internals ─────────────────────────────────────────────────────

  /** Read + validate the stored record, or null when none / malformed. */
  private async read(): Promise<LinearAgentTokenRecord | null> {
    const record = await this.ctx.storage.get<LinearAgentTokenRecord>(TOKEN_KEY)
    if (record && typeof record.accessToken === "string" && record.accessToken) return record
    return null
  }

  /**
   * Single-flight guard: dedupe concurrent refresh callers to ONE in-flight POST.
   * The leader (first caller) creates the promise; joiners await the same one. The
   * slot is cleared in `finally` so the next refresh starts fresh. doRefresh starts
   * running synchronously (up to its first await) BEFORE the slot is assigned, but
   * the DO is single-threaded, so no concurrent caller can observe the unset slot
   * mid-creation.
   */
  private guardedRefresh(): Promise<BrokerTokenResult> {
    if (this.refreshInFlight) return this.refreshInFlight
    const inFlight = this.doRefresh().finally(() => {
      if (this.refreshInFlight === inFlight) this.refreshInFlight = null
    })
    this.refreshInFlight = inFlight
    return inFlight
  }

  /**
   * The correctness core: read → POST → persist, executed as the single in-flight
   * unit guarded by `guardedRefresh`. On a successful POST the rotated record is
   * persisted DURABLY (aggressive write-retry) BEFORE the new token is returned, so
   * a returned token is always backed by stored state. Any failure leaves the
   * stored record intact (never corrupted) and falls back to the old token while it
   * is still valid.
   */
  private async doRefresh(): Promise<BrokerTokenResult> {
    const record = await this.read()
    if (!record) return { ok: false, reason: "not-installed" }
    if (!record.refreshToken) {
      alert("linear-token-broker-no-refresh-token")
      return { ok: false, reason: "no-refresh-token" }
    }

    const { clientId, clientSecret } = resolveAgentOAuthCreds(this.env)
    if (!clientId || !clientSecret) {
      alert("linear-token-broker-refresh-failed", { reason: "missing-creds" })
      return this.fallbackOrError(record)
    }

    const result = await performAgentTokenRefresh(record.refreshToken, { clientId, clientSecret })
    if (!result.ok) {
      // Loud neutral log — never the response body (token material).
      alert("linear-token-broker-refresh-failed", { reason: result.reason, status: result.status })
      return this.fallbackOrError(record)
    }

    // Build the ROTATED record: new access token; new refresh token, falling back
    // to the old one ONLY if the response omitted one; expiresAt from expires_in
    // (default 24h when omitted); scope carried forward; installedAt preserved.
    const next: LinearAgentTokenRecord = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? record.refreshToken,
      installedAt: record.installedAt,
      expiresAt: Date.now() + (typeof result.expiresIn === "number" ? result.expiresIn * 1000 : FALLBACK_TOKEN_TTL_MS),
    }
    if (typeof result.scope === "string") next.scope = result.scope
    else if (record.scope) next.scope = record.scope

    // The POST already succeeded and rotated the refresh token at Linear. Persist
    // the new record durably BEFORE returning the new token.
    const persisted = await this.persistWithRetry(next)
    if (!persisted) {
      // Persist failed AFTER a successful POST: loud alert, leave the stored record
      // intact (do NOT corrupt it), and return the OLD token if still valid so the
      // agent keeps working inside Linear's ~30-min refresh-replay grace.
      alert("linear-token-broker-persist-failed")
      return this.fallbackOrError(record)
    }

    // Durable — now safe to re-arm the proactive alarm and return the NEW token.
    await this.scheduleAlarm(next.expiresAt)
    emit("linear-token-broker-refreshed", { scopePresent: !!next.scope })
    return { ok: true, accessToken: next.accessToken }
  }

  /**
   * Failure fallback: return the OLD access token when it is still valid (fail-safe
   * inside the refresh headroom / replay grace); otherwise a structured error.
   * NEVER corrupts stored state — it only reads the in-memory record.
   */
  private fallbackOrError(record: LinearAgentTokenRecord): BrokerTokenResult {
    if (typeof record.expiresAt !== "number" || Date.now() < record.expiresAt) {
      return { ok: true, accessToken: record.accessToken }
    }
    return { ok: false, reason: "refresh-failed" }
  }

  /**
   * Persist the rotated record, retrying a few times on a transient storage fault.
   * Returns true once the put is durable, false if every attempt threw. NEVER logs
   * the record (token material).
   */
  private async persistWithRetry(record: LinearAgentTokenRecord): Promise<boolean> {
    for (let attempt = 0; attempt < PERSIST_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.ctx.storage.put(TOKEN_KEY, record)
        return true
      } catch {
        // best-effort; loop and retry. Never log the record.
      }
    }
    return false
  }

  /**
   * Arm the proactive-refresh alarm at expiresAt - REFRESH_BUFFER_MS, clamped to at
   * least ALARM_MIN_DELAY_MS in the future so a near/past expiry still schedules a
   * near-future fire. A record with no expiresAt (legacy) → no alarm (freshness
   * cannot be computed).
   */
  private async scheduleAlarm(expiresAt?: number): Promise<void> {
    if (typeof expiresAt !== "number") return
    const at = Math.max(expiresAt - REFRESH_BUFFER_MS, Date.now() + ALARM_MIN_DELAY_MS)
    await this.ctx.storage.setAlarm(at)
  }
}
