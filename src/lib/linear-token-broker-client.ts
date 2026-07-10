// Tenant-sharded LinearTokenBroker RPC client.
//
// SIG-242 removes the global `linear-agent` singleton from every new install.
// The immutable Linear organization id selects the DO shard and the immutable
// GitHub installation id is sent again as record metadata. The broker verifies
// both before returning a token, so a wrong lookup key fails closed instead of
// authenticating as a neighboring tenant. Read caches are keyed by the same
// pair; no token can ever satisfy another tenant's cache lookup.

import type { LinearTokenBroker, BrokerTokenResult, BrokerTenantScope } from "@/src/do/linear-token-broker"
import type { LinearAgentTokenRecord } from "@/src/lib/linear-agent-oauth"
import type { Env } from "@/src/shared/types/env"

export type LinearTokenBrokerEnv = Pick<Env, "LINEAR_TOKEN_BROKER"> &
  Partial<Pick<Env, "OPENCLAW_LINEAR_ALLOWED_ORG_ID" | "OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID">>
export type LinearTokenScope = BrokerTenantScope
export interface LinearTenantInstallReceipt {
  generation: string
}

const CACHE_TTL_MS = 30_000
const SHARD_PREFIX = "linear-org:v1:"

interface CachedToken {
  accessToken: string
  expiresAt: number
}

const cachedReadOnlyTokens = new Map<string, CachedToken>()

function validScope(scope: LinearTokenScope): boolean {
  return (
    typeof scope.organizationId === "string" &&
    scope.organizationId.length > 0 &&
    Number.isSafeInteger(scope.installationId) &&
    scope.installationId > 0
  )
}

function cacheKey(scope: LinearTokenScope): string {
  return `${scope.organizationId}\u0000${scope.installationId}`
}

function brokerStub(env: LinearTokenBrokerEnv, scope: LinearTokenScope): DurableObjectStub<LinearTokenBroker> {
  const ns = env.LINEAR_TOKEN_BROKER as unknown as DurableObjectNamespace<LinearTokenBroker>
  return ns.get(ns.idFromName(`${SHARD_PREFIX}${scope.organizationId}`))
}

function legacyScopeMatches(env: LinearTokenBrokerEnv, scope: LinearTokenScope): boolean {
  const legacyInstallationId = Number(env.OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID)
  return (
    !!env.OPENCLAW_LINEAR_ALLOWED_ORG_ID &&
    env.OPENCLAW_LINEAR_ALLOWED_ORG_ID === scope.organizationId &&
    Number.isSafeInteger(legacyInstallationId) &&
    legacyInstallationId > 0 &&
    legacyInstallationId === scope.installationId
  )
}

async function migrateLegacyDogfoodRecord(env: LinearTokenBrokerEnv, scope: LinearTokenScope): Promise<boolean> {
  if (!legacyScopeMatches(env, scope)) return false
  const ns = env.LINEAR_TOKEN_BROKER as unknown as DurableObjectNamespace<LinearTokenBroker>
  try {
    const record = await ns.get(ns.idFromName("linear-agent")).exportLegacyRecordForMigration()
    if (!record) return false
    const tenantRecord: LinearAgentTokenRecord = {
      ...record,
      organizationId: scope.organizationId,
      installationId: scope.installationId,
      actorType: "app",
    }
    await brokerStub(env, scope).installTenant(tenantRecord, scope)
    console.log(
      JSON.stringify({
        event: "linear-token-legacy-dogfood-migrated",
        organizationId: scope.organizationId,
        installationId: scope.installationId,
      }),
    )
    return true
  } catch {
    return false
  }
}

export function getValidAgentTokenViaBroker(
  env: LinearTokenBrokerEnv,
  scope: LinearTokenScope,
  opts: { readOnly: boolean },
): Promise<string | null>
/** @deprecated Pre-SIG-242 singleton seam, retained only for migration tests. */
export function getValidAgentTokenViaBroker(
  env: LinearTokenBrokerEnv,
  opts: { readOnly: boolean },
): Promise<string | null>
export async function getValidAgentTokenViaBroker(
  env: LinearTokenBrokerEnv,
  scopeOrOpts: LinearTokenScope | { readOnly: boolean },
  maybeOpts?: { readOnly: boolean },
): Promise<string | null> {
  if (maybeOpts === undefined) {
    const opts = scopeOrOpts as { readOnly: boolean }
    const legacyKey = "__legacy_singleton__"
    const cached = cachedReadOnlyTokens.get(legacyKey)
    if (opts.readOnly && cached && Date.now() < cached.expiresAt) return cached.accessToken
    const ns = env.LINEAR_TOKEN_BROKER as unknown as DurableObjectNamespace<LinearTokenBroker>
    let legacyResult: BrokerTokenResult
    try {
      legacyResult = await ns.get(ns.idFromName("linear-agent")).getValidToken(opts)
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "linear-token-broker-rpc-error",
          readOnly: opts.readOnly,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return null
    }
    if (!legacyResult.ok) {
      console.warn(
        JSON.stringify({
          event: "linear-token-broker-unavailable",
          readOnly: opts.readOnly,
          reason: legacyResult.reason,
        }),
      )
      return null
    }
    if (opts.readOnly) {
      cachedReadOnlyTokens.set(legacyKey, {
        accessToken: legacyResult.accessToken,
        expiresAt: Date.now() + CACHE_TTL_MS,
      })
    }
    return legacyResult.accessToken
  }
  const scope = scopeOrOpts as LinearTokenScope
  const opts = maybeOpts
  if (!validScope(scope)) return null
  const key = cacheKey(scope)
  const cached = cachedReadOnlyTokens.get(key)
  if (opts.readOnly && cached && Date.now() < cached.expiresAt) return cached.accessToken

  let result: BrokerTokenResult
  try {
    result = await brokerStub(env, scope).getValidTenantToken({ ...scope, readOnly: opts.readOnly })
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "linear-token-broker-rpc-error",
        organizationId: scope.organizationId,
        installationId: scope.installationId,
        readOnly: opts.readOnly,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return null
  }
  if (!result.ok && result.reason === "not-installed" && (await migrateLegacyDogfoodRecord(env, scope))) {
    try {
      result = await brokerStub(env, scope).getValidTenantToken({ ...scope, readOnly: opts.readOnly })
    } catch {
      return null
    }
  }
  if (!result.ok) {
    console.warn(
      JSON.stringify({
        event: "linear-token-broker-unavailable",
        organizationId: scope.organizationId,
        installationId: scope.installationId,
        readOnly: opts.readOnly,
        reason: result.reason,
      }),
    )
    return null
  }
  if (opts.readOnly) {
    cachedReadOnlyTokens.set(key, { accessToken: result.accessToken, expiresAt: Date.now() + CACHE_TTL_MS })
  }
  return result.accessToken
}

/** Explicit dogfood-only read for legacy callers that cannot yet carry a
 * webhook tenant tuple (currently Slack). It is disabled unless BOTH immutable
 * ids are configured; no default/global fallback exists. */
export async function getLegacyDogfoodAgentTokenViaBroker(
  env: LinearTokenBrokerEnv,
  opts: { readOnly: boolean },
): Promise<string | null> {
  const organizationId = env.OPENCLAW_LINEAR_ALLOWED_ORG_ID
  const installationId = Number(env.OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID)
  if (!organizationId || !Number.isSafeInteger(installationId) || installationId <= 0) return null
  return getValidAgentTokenViaBroker(env, { organizationId, installationId }, opts)
}

export function forceRefreshViaBroker(env: LinearTokenBrokerEnv, scope: LinearTokenScope): Promise<string | null>
/** @deprecated Pre-SIG-242 singleton seam, retained only for migration tests. */
export function forceRefreshViaBroker(env: LinearTokenBrokerEnv): Promise<string | null>
export async function forceRefreshViaBroker(
  env: LinearTokenBrokerEnv,
  scope?: LinearTokenScope,
): Promise<string | null> {
  if (!scope) {
    const ns = env.LINEAR_TOKEN_BROKER as unknown as DurableObjectNamespace<LinearTokenBroker>
    let legacyResult: BrokerTokenResult
    try {
      legacyResult = await ns.get(ns.idFromName("linear-agent")).forceRefresh()
    } catch {
      return null
    }
    if (!legacyResult.ok) return null
    cachedReadOnlyTokens.set("__legacy_singleton__", {
      accessToken: legacyResult.accessToken,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    return legacyResult.accessToken
  }
  if (!validScope(scope)) return null
  let result: BrokerTokenResult
  try {
    result = await brokerStub(env, scope).forceRefreshTenant(scope)
  } catch {
    return null
  }
  if (!result.ok) return null
  cachedReadOnlyTokens.set(cacheKey(scope), {
    accessToken: result.accessToken,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
  return result.accessToken
}

/** Persist a new actor=app token into exactly one organization shard. */
export async function installAgentTokenToBroker(
  env: LinearTokenBrokerEnv,
  scopeOrLegacyRecord: LinearTokenScope | LinearAgentTokenRecord,
  tenantRecord?: LinearAgentTokenRecord,
): Promise<boolean> {
  // Explicit legacy migration seam: only a caller holding a pre-SIG-242 token
  // record invokes the two-argument form. New OAuth installs always pass the
  // tenant scope + metadata-bearing record below and never touch the singleton.
  if (tenantRecord === undefined) {
    const ns = env.LINEAR_TOKEN_BROKER as unknown as DurableObjectNamespace<LinearTokenBroker>
    try {
      await ns.get(ns.idFromName("linear-agent")).install(scopeOrLegacyRecord as LinearAgentTokenRecord)
      cachedReadOnlyTokens.delete("__legacy_singleton__")
      return true
    } catch {
      return false
    }
  }
  const scope = scopeOrLegacyRecord as LinearTokenScope
  const record = tenantRecord
  if (
    !validScope(scope) ||
    record.organizationId !== scope.organizationId ||
    record.installationId !== scope.installationId ||
    record.actorType !== "app"
  ) {
    return false
  }
  try {
    await brokerStub(env, scope).installTenant(record, scope)
  } catch {
    return false
  }
  cachedReadOnlyTokens.delete(cacheKey(scope))
  return true
}

/** Stage a tenant OAuth token without replacing an existing active credential.
 * The generation is minted before the RPC, so even a lost response can be
 * rolled back precisely. */
export async function stageAgentTokenToBroker(
  env: LinearTokenBrokerEnv,
  scope: LinearTokenScope,
  record: LinearAgentTokenRecord,
  receipt: LinearTenantInstallReceipt,
): Promise<boolean> {
  if (
    !validScope(scope) ||
    !receipt.generation ||
    record.organizationId !== scope.organizationId ||
    record.installationId !== scope.installationId ||
    record.actorType !== "app"
  ) {
    return false
  }
  try {
    const result = await brokerStub(env, scope).stageTenantInstall(record, scope, receipt.generation)
    return result.ok
  } catch {
    return false
  }
}

/** Promote exactly one staged generation after D1 has linked the tenant. */
export async function commitAgentTokenToBroker(
  env: LinearTokenBrokerEnv,
  scope: LinearTokenScope,
  receipt: LinearTenantInstallReceipt,
): Promise<boolean> {
  if (!validScope(scope) || !receipt.generation) return false
  try {
    const result = await brokerStub(env, scope).commitTenantInstall(scope, receipt.generation)
    if (!result.ok) return false
  } catch {
    return false
  }
  cachedReadOnlyTokens.delete(cacheKey(scope))
  return true
}

/** Remove exactly one uncommitted generation. The broker leaves any prior
 * active token untouched. */
export async function rollbackAgentTokenFromBroker(
  env: LinearTokenBrokerEnv,
  scope: LinearTokenScope,
  receipt: LinearTenantInstallReceipt,
): Promise<boolean> {
  if (!validScope(scope) || !receipt.generation) return false
  try {
    const result = await brokerStub(env, scope).rollbackTenantInstall(scope, receipt.generation)
    return result.ok
  } catch {
    return false
  }
}

/** Exact-scope compensation for a tenant OAuth install that could not be
 * linked durably in D1. A mismatched shard record is never removed. */
export async function uninstallAgentTokenFromBroker(
  env: LinearTokenBrokerEnv,
  scope: LinearTokenScope,
): Promise<boolean> {
  if (!validScope(scope)) return false
  try {
    const result = await brokerStub(env, scope).uninstallTenant(scope)
    if (!result.ok) return false
  } catch {
    return false
  }
  cachedReadOnlyTokens.delete(cacheKey(scope))
  return true
}

export function __resetBrokerClientCacheForTests(): void {
  cachedReadOnlyTokens.clear()
}
