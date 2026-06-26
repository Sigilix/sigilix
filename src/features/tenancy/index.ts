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
export { upsertTenantAndRepo, readTenantCap } from "./adapters/d1-tenant-store"
export { appendUsage } from "./adapters/d1-usage-ledger"
