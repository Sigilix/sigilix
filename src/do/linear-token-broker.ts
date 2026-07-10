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
import { normalizeEnv } from "@/src/shared/util/normalize-env"
import {
  performAgentTokenRefresh,
  resolveAgentOAuthCreds,
  REFRESH_BUFFER_MS,
  FALLBACK_TOKEN_TTL_MS,
  type LinearAgentTokenRecord,
} from "@/src/lib/linear-agent-oauth"
import { getLinearConnectionByInstallation } from "@/src/features/linear-integration"

/** DO-storage key holding the single agent token record (strongly consistent). */
const TOKEN_KEY = "linear-agent-token"

/** One staged OAuth credential that is not visible to token readers until D1
 * durably links the tenant. Keeping it under a separate key preserves an older
 * active token throughout a reconnect attempt. Both keys + the alarm are
 * changed in one DO storage transaction. */
const PENDING_TOKEN_KEY = "linear-agent-token-pending"

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

/** A staged credential is first reconciled quickly, then retried while D1 is
 * unavailable. The hard ceiling prevents an unreachable D1 from retaining an
 * unlinked refresh token forever. */
const PENDING_RECONCILE_DELAY_MS = 30 * 1000
const PENDING_RECONCILE_RETRY_MS = 5 * 60 * 1000
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Structured result of a token read/refresh. Never null → no NPE at call sites.
 *  `not-installed` = cold start / empty storage; `no-refresh-token` = a record
 *  exists but cannot be refreshed; `refresh-failed` = refresh failed AND the old
 *  token is hard-expired (no safe fallback). */
export type BrokerTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "not-installed" | "no-refresh-token" | "refresh-failed" }

export interface BrokerTenantScope {
  organizationId: string
  installationId: number
}

interface PendingTenantInstall {
  generation: string
  record: LinearAgentTokenRecord
  reconcileAt: number
  expiresAt: number
}

export type BrokerTenantStageResult =
  | { ok: true }
  | { ok: false; reason: "tenant-conflict" | "install-in-progress" | "invalid-generation" }

export type BrokerLegacyInstallResult = { ok: true } | { ok: false; reason: "tenant-metadata-present" }

export type BrokerTenantInstallResult = { ok: true } | { ok: false; reason: "tenant-conflict" }

export type BrokerTenantCommitResult =
  | { ok: true; committed: boolean }
  | { ok: false; reason: "tenant-mismatch" | "generation-mismatch" | "not-staged" }

export type BrokerTenantRollbackResult = { ok: true; removed: boolean } | { ok: false; reason: "generation-mismatch" }

export type BrokerTenantUninstallResult = { ok: true; removed: boolean } | { ok: false; reason: "tenant-mismatch" }

/** Neutral structured log — NEVER token material. */
function emit(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, system: "linear-token-broker", ...fields }))
}

/** Loud neutral alert (stderr) — NEVER token material. */
function alert(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, system: "linear-token-broker", ...fields }))
}

export class LinearTokenBroker extends DurableObject<Env> {
  // sig-worker-debrand-openclaw: resolve SIGILIX_ (preferred) / OPENCLAW_ (fallback)
  // Linear agent OAuth creds on `this.env` so a founder-set SIGILIX_ secret applies
  // inside the broker DO too (see normalize-env.ts).
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, normalizeEnv(env))
  }

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
  /** @deprecated Pre-SIG-242 singleton bootstrap. Tenant-bearing records must
   * use installTenant on their organization shard. */
  async install(record: LinearAgentTokenRecord): Promise<BrokerLegacyInstallResult> {
    if (
      record.organizationId !== undefined ||
      record.installationId !== undefined ||
      record.actorType !== undefined ||
      record.appUserId !== undefined ||
      record.installGeneration !== undefined
    ) {
      return { ok: false, reason: "tenant-metadata-present" }
    }
    return this.persistInstall(record)
  }

  private async persistInstall(record: LinearAgentTokenRecord): Promise<{ ok: true }> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(TOKEN_KEY, record)
      await this.scheduleNextAlarmInTransaction(txn)
    })
    emit("linear-token-broker-installed", {
      hasRefresh: !!record.refreshToken,
      hasExpiry: typeof record.expiresAt === "number",
      scopePresent: !!record.scope,
    })
    return { ok: true }
  }

  /** Strict SIG-242 install entry. The caller-selected DO shard is not trusted
   * by itself: every stored record must carry the same immutable tenant pair. */
  async installTenant(record: LinearAgentTokenRecord, expected: BrokerTenantScope): Promise<BrokerTenantInstallResult> {
    if (
      !this.validTenantScope(expected) ||
      record.organizationId !== expected.organizationId ||
      record.installationId !== expected.installationId ||
      record.actorType !== "app"
    ) {
      return { ok: false, reason: "tenant-conflict" }
    }
    const existing = await this.read()
    if (existing && !this.matchesTenant(existing, expected)) {
      return { ok: false, reason: "tenant-conflict" }
    }
    return this.persistInstall(record)
  }

  /** Stage a tenant credential without replacing the current active token. The
   * caller creates `generation` before the RPC, so an ambiguous transport fault
   * can always be followed by an exact-generation rollback. */
  async stageTenantInstall(
    record: LinearAgentTokenRecord,
    expected: BrokerTenantScope,
    generation: string,
  ): Promise<BrokerTenantStageResult> {
    if (!this.validTenantScope(expected) || !this.matchesTenant(record, expected)) {
      return { ok: false, reason: "tenant-conflict" }
    }
    if (!generation || generation.length > 128) return { ok: false, reason: "invalid-generation" }

    const now = Date.now()
    return this.ctx.storage.transaction(async (txn) => {
      const active = await this.readFrom(txn)
      if (active && !this.matchesTenant(active, expected)) return { ok: false, reason: "tenant-conflict" }
      if (active?.installGeneration === generation) return { ok: true }

      const pending = await this.readPendingFrom(txn)
      if (pending && pending.generation === generation) {
        return this.matchesTenant(pending.record, expected) ? { ok: true } : { ok: false, reason: "tenant-conflict" }
      }
      if (pending && pending.expiresAt > now) return { ok: false, reason: "install-in-progress" }

      await txn.put(PENDING_TOKEN_KEY, {
        generation,
        record,
        reconcileAt: now + PENDING_RECONCILE_DELAY_MS,
        expiresAt: now + PENDING_MAX_AGE_MS,
      } satisfies PendingTenantInstall)
      await this.scheduleNextAlarmInTransaction(txn)
      return { ok: true }
    })
  }

  /** Atomically promote only the staged generation that D1 linked. A repeated
   * commit after a lost RPC response is idempotent via installGeneration. */
  async commitTenantInstall(expected: BrokerTenantScope, generation: string): Promise<BrokerTenantCommitResult> {
    if (!this.validTenantScope(expected)) return { ok: false, reason: "tenant-mismatch" }
    return this.ctx.storage.transaction(async (txn) => {
      const active = await this.readFrom(txn)
      const pending = await this.readPendingFrom(txn)
      if (!pending) {
        if (active && this.matchesTenant(active, expected) && active.installGeneration === generation) {
          return { ok: true, committed: false }
        }
        return { ok: false, reason: "not-staged" }
      }
      if (pending.generation !== generation) return { ok: false, reason: "generation-mismatch" }
      if (!this.matchesTenant(pending.record, expected)) return { ok: false, reason: "tenant-mismatch" }

      await txn.put(TOKEN_KEY, { ...pending.record, installGeneration: generation })
      await txn.delete(PENDING_TOKEN_KEY)
      await this.scheduleNextAlarmInTransaction(txn)
      emit("linear-token-broker-install-committed", {
        organizationId: expected.organizationId,
        installationId: expected.installationId,
      })
      return { ok: true, committed: true }
    })
  }

  /** Delete only the matching staged generation. The active token is never
   * touched, so a failed reconnect cannot erase a previously valid credential. */
  async rollbackTenantInstall(expected: BrokerTenantScope, generation: string): Promise<BrokerTenantRollbackResult> {
    if (!this.validTenantScope(expected)) return { ok: false, reason: "generation-mismatch" }
    return this.ctx.storage.transaction(async (txn) => {
      const pending = await this.readPendingFrom(txn)
      if (!pending) return { ok: true, removed: false }
      if (pending.generation !== generation || !this.matchesTenant(pending.record, expected)) {
        return { ok: false, reason: "generation-mismatch" }
      }
      await txn.delete(PENDING_TOKEN_KEY)
      await this.scheduleNextAlarmInTransaction(txn)
      emit("linear-token-broker-install-rolled-back", {
        organizationId: expected.organizationId,
        installationId: expected.installationId,
      })
      return { ok: true, removed: true }
    })
  }

  /** Remove only the token whose immutable metadata exactly matches the
   * requested tenant. Used to compensate a failed OAuth finalization after the
   * token has been persisted but before D1 has durably linked the tenant. */
  async uninstallTenant(expected: BrokerTenantScope): Promise<BrokerTenantUninstallResult> {
    // A refresh that began before compensation can otherwise write the record
    // back after the delete. Let that single-flight settle before the final
    // read/metadata check/delete sequence.
    if (this.refreshInFlight) await this.refreshInFlight.catch(() => undefined)
    return this.ctx.storage.transaction(async (txn) => {
      const record = await this.readFrom(txn)
      if (!record) return { ok: true, removed: false }
      if (!this.matchesTenant(record, expected)) return { ok: false, reason: "tenant-mismatch" }
      await txn.delete(TOKEN_KEY)
      await this.scheduleNextAlarmInTransaction(txn)
      emit("linear-token-broker-uninstalled", {
        organizationId: expected.organizationId,
        installationId: expected.installationId,
      })
      return { ok: true, removed: true }
    })
  }

  /** Read the pre-SIG-242 singleton record for the one explicitly-configured
   * dogfood migration. Called only on the singleton shard; never logged. */
  async exportLegacyRecordForMigration(): Promise<LinearAgentTokenRecord | null> {
    const record = await this.read()
    if (!record || record.organizationId || record.installationId) return null
    return record
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

  async getValidTenantToken(args: BrokerTenantScope & { readOnly: boolean }): Promise<BrokerTokenResult> {
    const record = await this.read()
    if (!record) return { ok: false, reason: "not-installed" }
    if (!this.matchesTenant(record, args)) return { ok: false, reason: "not-installed" }
    if (args.readOnly || typeof record.expiresAt !== "number") return { ok: true, accessToken: record.accessToken }
    if (Date.now() < record.expiresAt - REFRESH_BUFFER_MS) return { ok: true, accessToken: record.accessToken }
    return this.guardedRefresh(args)
  }

  /** Always perform a guarded refresh (used later by the 401-retry path). */
  async forceRefresh(): Promise<BrokerTokenResult> {
    return this.guardedRefresh()
  }

  async forceRefreshTenant(expected: BrokerTenantScope): Promise<BrokerTokenResult> {
    const record = await this.read()
    if (!record || !this.matchesTenant(record, expected)) return { ok: false, reason: "not-installed" }
    return this.guardedRefresh(expected)
  }

  /**
   * Proactive refresh fired by the DO alarm — this is what keeps the token fresh
   * without any request traffic. Runs the guarded refresh, then re-arms the alarm:
   * on success doRefresh already armed it to the new expiry; on failure (still
   * installed) re-arm a short retry so we try again before the hard expiry.
   */
  override async alarm(): Promise<void> {
    const now = Date.now()
    const pendingAtWake = await this.readPendingFrom(this.ctx.storage)
    const pendingWasDue = !!pendingAtWake && pendingAtWake.reconcileAt <= now
    await this.reconcilePendingInstall(now)

    const record = await this.read()
    const refreshAt = this.activeRefreshDueAt(record)
    let result: BrokerTokenResult = record
      ? { ok: true, accessToken: record.accessToken }
      : { ok: false, reason: "not-installed" }
    // Preserve the broker's original proactive-alarm contract: an active-only
    // wake refreshes immediately. When the wake was specifically for pending
    // reconciliation, refresh the active token only if its own deadline is due.
    if (record && (!pendingWasDue || (refreshAt !== null && refreshAt <= now))) {
      result = await this.guardedRefresh()
      if (!(await this.ctx.storage.getAlarm())) {
        await this.scheduleNextAlarm(now + ALARM_RETRY_MS)
      }
    } else {
      await this.scheduleNextAlarm()
    }
    emit("linear-token-broker-alarm", { tokenAvailable: result.ok })
  }

  // ── internals ─────────────────────────────────────────────────────

  /** Read + validate the stored record, or null when none / malformed. */
  private async read(): Promise<LinearAgentTokenRecord | null> {
    return this.readFrom(this.ctx.storage)
  }

  private async readFrom(
    storage: Pick<DurableObjectStorage, "get"> | Pick<DurableObjectTransaction, "get">,
  ): Promise<LinearAgentTokenRecord | null> {
    const record = await storage.get<LinearAgentTokenRecord>(TOKEN_KEY)
    if (record && typeof record.accessToken === "string" && record.accessToken) return record
    return null
  }

  private async readPendingFrom(
    storage: Pick<DurableObjectStorage, "get"> | Pick<DurableObjectTransaction, "get">,
  ): Promise<PendingTenantInstall | null> {
    const pending = await storage.get<PendingTenantInstall>(PENDING_TOKEN_KEY)
    if (
      !pending ||
      typeof pending.generation !== "string" ||
      !pending.generation ||
      !Number.isFinite(pending.reconcileAt) ||
      !Number.isFinite(pending.expiresAt) ||
      !pending.record ||
      typeof pending.record.accessToken !== "string" ||
      !pending.record.accessToken ||
      typeof pending.record.organizationId !== "string" ||
      !pending.record.organizationId ||
      !Number.isSafeInteger(pending.record.installationId) ||
      Number(pending.record.installationId) <= 0 ||
      pending.record.actorType !== "app"
    ) {
      return null
    }
    return pending
  }

  /**
   * Single-flight guard: dedupe concurrent refresh callers to ONE in-flight POST.
   * The leader (first caller) creates the promise; joiners await the same one. The
   * slot is cleared in `finally` so the next refresh starts fresh. doRefresh starts
   * running synchronously (up to its first await) BEFORE the slot is assigned, but
   * the DO is single-threaded, so no concurrent caller can observe the unset slot
   * mid-creation.
   */
  private guardedRefresh(expected?: BrokerTenantScope): Promise<BrokerTokenResult> {
    if (this.refreshInFlight) return this.refreshInFlight
    const inFlight = this.doRefresh(expected).finally(() => {
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
  private async doRefresh(expected?: BrokerTenantScope): Promise<BrokerTokenResult> {
    const record = await this.read()
    if (!record) return { ok: false, reason: "not-installed" }
    if (expected && !this.matchesTenant(record, expected)) return { ok: false, reason: "not-installed" }
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
    if (record.organizationId) next.organizationId = record.organizationId
    if (record.installationId) next.installationId = record.installationId
    if (record.actorType) next.actorType = record.actorType
    if (record.appUserId) next.appUserId = record.appUserId
    if (record.installGeneration) next.installGeneration = record.installGeneration
    if (typeof result.scope === "string") next.scope = result.scope
    else if (record.scope) next.scope = record.scope

    // The POST already succeeded and rotated the refresh token at Linear. Persist
    // the new record durably BEFORE returning the new token.
    const persistence = await this.persistWithRetry(record, next)
    if (persistence.status === "superseded") {
      // A tenant commit/uninstall won while the Linear refresh POST was in
      // flight. Never overwrite that newer state with the old generation's
      // rotated token.
      const current = persistence.current
      if (current && (!expected || this.matchesTenant(current, expected))) {
        return { ok: true, accessToken: current.accessToken }
      }
      return { ok: false, reason: "not-installed" }
    }
    if (persistence.status === "failed") {
      // Persist failed AFTER a successful POST: loud alert, leave the stored record
      // intact (do NOT corrupt it), and return the OLD token if still valid so the
      // agent keeps working inside Linear's ~30-min refresh-replay grace.
      alert("linear-token-broker-persist-failed")
      return this.fallbackOrError(record)
    }

    // Durable with its next alarm in the same transaction — now safe to return.
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

  private matchesTenant(record: LinearAgentTokenRecord, expected: BrokerTenantScope): boolean {
    return (
      record.organizationId === expected.organizationId &&
      record.installationId === expected.installationId &&
      record.actorType === "app"
    )
  }

  private validTenantScope(scope: BrokerTenantScope): boolean {
    return (
      typeof scope.organizationId === "string" &&
      scope.organizationId.length > 0 &&
      Number.isSafeInteger(scope.installationId) &&
      scope.installationId > 0
    )
  }

  /**
   * Persist the rotated record, retrying a few times on a transient storage fault.
   * Returns true once the put is durable, false if every attempt threw. NEVER logs
   * the record (token material).
   */
  private async persistWithRetry(
    previous: LinearAgentTokenRecord,
    next: LinearAgentTokenRecord,
  ): Promise<
    { status: "persisted" } | { status: "superseded"; current: LinearAgentTokenRecord | null } | { status: "failed" }
  > {
    for (let attempt = 0; attempt < PERSIST_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.ctx.storage.transaction(async (txn) => {
          const current = await this.readFrom(txn)
          if (!this.sameTokenGeneration(current, previous)) {
            return { status: "superseded" as const, current }
          }
          await txn.put(TOKEN_KEY, next)
          await this.scheduleNextAlarmInTransaction(txn)
          return { status: "persisted" as const }
        })
      } catch {
        // best-effort; loop and retry. Never log the record.
      }
    }
    return { status: "failed" }
  }

  private sameTokenGeneration(current: LinearAgentTokenRecord | null, expected: LinearAgentTokenRecord): boolean {
    return (
      current !== null &&
      current.accessToken === expected.accessToken &&
      current.refreshToken === expected.refreshToken &&
      current.installedAt === expected.installedAt &&
      current.installGeneration === expected.installGeneration &&
      current.organizationId === expected.organizationId &&
      current.installationId === expected.installationId &&
      current.actorType === expected.actorType &&
      current.appUserId === expected.appUserId
    )
  }

  /** Resolve a staged credential after a callback could not establish D1's
   * outcome. Pending credentials are never served. Once D1 is readable, an
   * exact active link commits it and every other state rolls it back. Repeated
   * D1 faults retry until the hard pending ceiling, then discard it. */
  private async reconcilePendingInstall(now: number): Promise<void> {
    const pending = await this.readPendingFrom(this.ctx.storage)
    if (!pending || pending.reconcileAt > now) return
    const expected = {
      organizationId: pending.record.organizationId ?? "",
      installationId: pending.record.installationId ?? 0,
    }
    if (!this.matchesTenant(pending.record, expected)) {
      const result = await this.rollbackTenantInstall(expected, pending.generation)
      this.reportReconcileResult("rollback", result, expected)
      return
    }
    if (pending.expiresAt <= now) {
      const result = await this.rollbackTenantInstall(expected, pending.generation)
      this.reportReconcileResult("rollback", result, expected)
      return
    }

    try {
      const connection = await getLinearConnectionByInstallation(this.env, expected.installationId)
      if (
        connection?.status === "active" &&
        connection.organizationId === expected.organizationId &&
        connection.installationId === expected.installationId
      ) {
        const result = await this.commitTenantInstall(expected, pending.generation)
        this.reportReconcileResult("commit", result, expected)
      } else {
        const result = await this.rollbackTenantInstall(expected, pending.generation)
        this.reportReconcileResult("rollback", result, expected)
      }
    } catch {
      await this.ctx.storage.transaction(async (txn) => {
        const current = await this.readPendingFrom(txn)
        if (!current || current.generation !== pending.generation) return
        await txn.put(PENDING_TOKEN_KEY, {
          ...current,
          reconcileAt: Math.min(current.expiresAt, now + PENDING_RECONCILE_RETRY_MS),
        } satisfies PendingTenantInstall)
        await this.scheduleNextAlarmInTransaction(txn)
      })
      alert("linear-token-broker-install-reconcile-deferred", {
        organizationId: expected.organizationId,
        installationId: expected.installationId,
      })
    }
  }

  private reportReconcileResult(
    action: "commit" | "rollback",
    result: BrokerTenantCommitResult | BrokerTenantRollbackResult,
    expected: BrokerTenantScope,
  ): void {
    if (result.ok) return
    alert("linear-token-broker-install-reconcile-failed", {
      action,
      reason: result.reason,
      organizationId: expected.organizationId,
      installationId: expected.installationId,
    })
  }

  private activeRefreshDueAt(record: LinearAgentTokenRecord | null): number | null {
    if (!record || typeof record.expiresAt !== "number") return null
    return record.expiresAt - REFRESH_BUFFER_MS
  }

  private async scheduleNextAlarm(activeRetryAt?: number): Promise<void> {
    await this.ctx.storage.transaction((txn) => this.scheduleNextAlarmInTransaction(txn, activeRetryAt))
  }

  private async scheduleNextAlarmInTransaction(txn: DurableObjectTransaction, activeRetryAt?: number): Promise<void> {
    const now = Date.now()
    const [active, pending] = await Promise.all([this.readFrom(txn), this.readPendingFrom(txn)])
    const activeDueAt = activeRetryAt ?? this.activeRefreshDueAt(active)
    const activeAt = activeDueAt === null ? null : Math.max(activeDueAt, now + ALARM_MIN_DELAY_MS)
    const pendingAt = pending ? Math.max(pending.reconcileAt, now + ALARM_MIN_DELAY_MS) : null
    const candidates = [activeAt, pendingAt].filter((value): value is number => typeof value === "number")
    if (candidates.length === 0) {
      await txn.deleteAlarm()
      return
    }
    await txn.setAlarm(Math.min(...candidates))
  }

  /**
   * Arm the proactive-refresh alarm at expiresAt - REFRESH_BUFFER_MS, clamped to at
   * least ALARM_MIN_DELAY_MS in the future so a near/past expiry still schedules a
   * near-future fire. A record with no expiresAt (legacy) → no alarm (freshness
   * cannot be computed).
   */
}
