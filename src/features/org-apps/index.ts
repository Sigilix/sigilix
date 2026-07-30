// Per-org APP on/off policy — the customer's choice of which Sigilix surfaces they
// run. Distinct from ENTITLEMENT (their tier) and from CONNECTED (OAuth installed).
// Public surface of the feature (barrel-only imports per COMPLIANCE.md).

export { resolveOrgAppPolicy, isOrgAppEnabled } from "./domain/resolve"
export { ORG_APP_IDS, isOrgAppId } from "./domain/types"
export type { OrgAppId, OrgAppPolicy, OrgAppPolicyRow, OrgAppState } from "./domain/types"
export { readOrgAppPolicy, writeOrgAppPolicy } from "./adapters/d1-org-app-policy"
export type { WriteOrgAppPolicyResult } from "./adapters/d1-org-app-policy"
