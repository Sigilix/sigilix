export {
  emptyState,
  decideAcquire,
  release,
  findExpiredLeaseIds,
  extendLease,
  computeBackoffMs,
  LEASE_TTL_MS,
  DEFAULT_TENANT_CAP,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_DEFERS,
} from "./domain/fairness"
export type { FairnessState, Lease, AcquireResult } from "./domain/fairness"
export { admitTenant, releaseTenant } from "./adapters/concurrency-client"
export type { AdmitResult } from "./adapters/concurrency-client"
export { resolveFairnessConfig } from "./domain/config"
export type { FairnessConfig } from "./domain/config"
export { resolveQuotaMode, computeWouldExceed } from "./domain/quota"
export type { QuotaMode } from "./domain/quota"
export {
  resolveRateLimitMode,
  resolveRateLimitCap,
  isFullPaidStatus,
  decideRateLimit,
  computeResetMs,
  formatUsageFooter,
  RATE_LIMIT_WINDOW_MS,
  DEFAULT_RATE_LIMIT_CAP,
  RATE_LIMIT_BURST,
  TRIAGE_RATE_LIMIT_WINDOW_MS,
  DEFAULT_TRIAGE_RATE_LIMIT_CAP,
} from "./domain/rate-limit"
export type { RateLimitMode } from "./domain/rate-limit"
export {
  upsertTenantAndRepo,
  upsertTenantTier,
  readTenantConfig,
  readTenantSubscriptionStatus,
  lookupRepoByFullName,
} from "./adapters/d1-tenant-store"
export { resolveTenantCap } from "./adapters/resolve-tenant-cap"
export { appendUsage } from "./adapters/d1-usage-ledger"
export { readTenantUsageSince, readUsageRollupSince } from "./adapters/d1-usage-read"
export type { TenantUsageRow } from "./adapters/d1-usage-read"
export {
  resolveUsageMeterMode,
  resolveUsagePoolCap,
  decideUsagePool,
  usagePct,
  meterPool,
  ORG_METERS,
  SEAT_METERS,
  DEFAULT_POOL_CAPS,
  USAGE_WINDOW_LABEL,
  USAGE_SESSION_WINDOW_MS,
  USAGE_WEEKLY_WINDOW_MS,
  weeklyWindowStartMs,
  weeklyWindowResetMs,
} from "./domain/usage-meters"
export type { UsagePool, UsageMeter, UsageWindow, UsageEventMeter, UsageMeterMode } from "./domain/usage-meters"
export { appendUsageEvent } from "./adapters/d1-usage-events"
export { readUsageEventCount, readUsageEventAuthorBreakdown } from "./adapters/d1-usage-events-read"
export { checkUsagePool } from "./adapters/check-usage-pool"
export type { UsagePoolDecision, UsagePoolWindowState } from "./adapters/check-usage-pool"
export { checkShadowQuota } from "./adapters/check-shadow-quota"
export { readRollingReviewCount } from "./adapters/d1-rate-limit-read"
export { checkRateLimit } from "./adapters/check-rate-limit"
export type { RateLimitDecision } from "./adapters/check-rate-limit"
export { appendTriageUsage } from "./adapters/d1-triage-usage-ledger"
export { readRollingTriageCount } from "./adapters/d1-triage-rate-limit-read"
export { checkTriageRateLimit } from "./adapters/check-triage-rate-limit"
export type { TriageRateLimitDecision } from "./adapters/check-triage-rate-limit"
export { readRecentWorkspacePrs } from "./adapters/d1-workspace-prs-read"
export type { WorkspacePrRawRow } from "./adapters/d1-workspace-prs-read"
export { collapseWorkspacePrs } from "./domain/workspace-prs"
export type { WorkspacePrLedgerRow, WorkspacePrSummary } from "./domain/workspace-prs"
