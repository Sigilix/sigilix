// ARC-181: rule registry — the canonical list of v1 rules and the
// config-aware filter that the runner calls per scan.
//
// Adding a new rule = (1) write `rules/<id>.ts` exporting an
// `AstRule`, (2) import it here, (3) add to `ALL_RULES`. The
// registry exposes a stable, ordered list — order matters only for
// telemetry determinism, not for finding semantics.

import type { AstRule, Severity } from "./types"
import { noEvalCall } from "./rules/no-eval-call"
import { noNewFunctionConstructor } from "./rules/no-new-function-constructor"
import { spawnShellTrue } from "./rules/spawn-shell-true"
import { noExecShellInterpolation } from "./rules/no-exec-shell-interpolation"
import { noDisabledTlsRejectUnauthorized } from "./rules/no-disabled-tls-reject-unauthorized"
import { noDocumentWriteCall } from "./rules/no-document-write-call"
import { noAsyncWithoutAwait } from "./rules/no-async-without-await"
import { noThrowLiteral } from "./rules/no-throw-literal"
import { noAwaitInLoop } from "./rules/no-await-in-loop"
import { noFloatingPromiseCallKnownAsync } from "./rules/no-floating-promise-call-known-async"
import { noProcessEnvMutation } from "./rules/no-process-env-mutation"
// SIG-109: logic-specialist correctness rules.
import { noDupeSwitchCase } from "./rules/no-dupe-switch-case"
import { noDupeObjectKeys } from "./rules/no-dupe-object-keys"
import { noReturnInFinally } from "./rules/no-return-in-finally"
import { noUnreachableAfterJump } from "./rules/no-unreachable-after-jump"
import { noSelfAssignment } from "./rules/no-self-assignment"
import { noConstantBinaryCondition } from "./rules/no-constant-binary-condition"
import { noInvalidTypeofCompare } from "./rules/no-invalid-typeof-compare"
import { noUnsafeNegation } from "./rules/no-unsafe-negation"
// SIG-110: performance-specialist rules.
import { noSpreadAccumulatorInLoop } from "./rules/no-spread-accumulator-in-loop"
import { noAllocationInLoop } from "./rules/no-allocation-in-loop"
import { noNPlusOneCallInLoop } from "./rules/no-n-plus-one-call-in-loop"
import { noSyncIoInRequestPath } from "./rules/no-sync-io-in-request-path"
// SIG-310: contract-drift type-pattern detector.
import { noSnakeCamelOptionalAlias } from "./rules/no-snake-camel-optional-alias"
// SIG-392 (b8): runtime double-assertion contract-drift detector.
import { noDoubleCastThroughUnknown } from "./rules/no-double-cast-through-unknown"
// SIG-314: deterministic IDOR/BOLA floor (security, warning/P2-capped).
import { noUnauthorizedObjectLookup } from "./rules/no-unauthorized-object-lookup"
import { noInsecureRandomToken } from "./rules/no-insecure-random-token"
import { noOpenRedirect } from "./rules/no-open-redirect"
import { noSsrf } from "./rules/no-ssrf"
import { noPathTraversal } from "./rules/no-path-traversal"
import { noSqlInjection } from "./rules/no-sql-injection"
import { noSsti } from "./rules/no-ssti"
import { noNosqlInjection } from "./rules/no-nosql-injection"
import { noPrototypePollution } from "./rules/no-prototype-pollution"
import { noXxe } from "./rules/no-xxe"
// SIG-392 (b14): deterministic fail-open hardcoded-secret floor (CWE-798).
import { noHardcodedSecretFallback } from "./rules/no-hardcoded-secret-fallback"
// SIG-392 (b20): deterministic HMAC-over-reserialized-body floor (CWE-345/347).
import { noHmacOverReserializedBody } from "./rules/no-hmac-over-reserialized-body"

/**
 * The full v1 rule set. Add new rules here; the order is the
 * deterministic emit order (the runner uses it for the prompt-block
 * stable sort within a file).
 */
export const ALL_RULES: readonly AstRule[] = [
  // Security (severity: error)
  noEvalCall,
  noNewFunctionConstructor,
  spawnShellTrue,
  noExecShellInterpolation,
  noDisabledTlsRejectUnauthorized,
  noDocumentWriteCall,
  // Correctness / perf (severity: warning)
  noAsyncWithoutAwait,
  noThrowLiteral,
  noAwaitInLoop,
  noFloatingPromiseCallKnownAsync,
  noProcessEnvMutation,
  // SIG-109: logic-specialist correctness rules (severity: warning).
  noDupeSwitchCase,
  noDupeObjectKeys,
  noReturnInFinally,
  noUnreachableAfterJump,
  noSelfAssignment,
  noConstantBinaryCondition,
  noInvalidTypeofCompare,
  noUnsafeNegation,
  // SIG-110: performance-specialist rules (severity: warning).
  noSpreadAccumulatorInLoop,
  noAllocationInLoop,
  noNPlusOneCallInLoop,
  noSyncIoInRequestPath,
  // SIG-310: logic-specialist contract-drift type-pattern (severity: warning).
  noSnakeCamelOptionalAlias,
  // SIG-392 (b8): logic-specialist runtime launder-cast contract-drift (severity: warning).
  noDoubleCastThroughUnknown,
  // SIG-314: security-specialist deterministic IDOR/BOLA floor (severity: warning).
  noUnauthorizedObjectLookup,
  // security-specialist deterministic weak-randomness floor (CWE-338, severity: warning).
  noInsecureRandomToken,
  // security-specialist deterministic open-redirect floor (CWE-601, severity: warning).
  noOpenRedirect,
  // security-specialist deterministic SSRF floor (CWE-918, severity: warning).
  noSsrf,
  // security-specialist deterministic path-traversal floor (CWE-22, severity: warning).
  noPathTraversal,
  // security-specialist deterministic SQL-injection floor (CWE-89, severity: warning).
  noSqlInjection,
  // security-specialist deterministic SSTI floor (CWE-1336, severity: warning).
  noSsti,
  // security-specialist deterministic NoSQL-injection floor (CWE-943, severity: warning).
  noNosqlInjection,
  // security-specialist deterministic prototype-pollution floor (CWE-1321, severity: warning).
  noPrototypePollution,
  // security-specialist deterministic XXE floor (CWE-611, severity: warning).
  noXxe,
  // SIG-392 (b14): security-specialist deterministic fail-open hardcoded-secret floor (CWE-798, severity: warning).
  noHardcodedSecretFallback,
  noHmacOverReserializedBody,
] as const

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
}

export interface ResolvedAstRulesConfig {
  enabled: boolean
  severityThreshold: Severity
  disabledRules: string[]
  autoInline: boolean
}

/**
 * The per-repo config predicate a rule must satisfy to run: not in
 * `disabledRules` AND at/above the `severityThreshold`. Shared with the SIG-312
 * line-scan pseudo rule (CodeRabbit #296) so it honors `severityThreshold`, not
 * just the disabled list, exactly like a registry rule.
 */
export function ruleEnabledByConfig(config: ResolvedAstRulesConfig, id: string, severity: Severity): boolean {
  return !config.disabledRules.includes(id) && SEVERITY_RANK[severity] >= SEVERITY_RANK[config.severityThreshold]
}

/**
 * Filter `ALL_RULES` by the per-repo astRules config. Returns an
 * empty list when the scanner is disabled OR every candidate rule
 * is below threshold or in the disabled list.
 */
export function getEnabledRules(config: ResolvedAstRulesConfig): readonly AstRule[] {
  if (!config.enabled) return []
  return ALL_RULES.filter((r) => ruleEnabledByConfig(config, r.id, r.severity))
}
