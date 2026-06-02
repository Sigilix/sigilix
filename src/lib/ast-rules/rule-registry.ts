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
 * Filter `ALL_RULES` by the per-repo astRules config. Returns an
 * empty list when the scanner is disabled OR every candidate rule
 * is below threshold or in the disabled list.
 */
export function getEnabledRules(config: ResolvedAstRulesConfig): readonly AstRule[] {
  if (!config.enabled) return []
  const minRank = SEVERITY_RANK[config.severityThreshold]
  const disabled = new Set(config.disabledRules)
  return ALL_RULES.filter((r) =>
    !disabled.has(r.id) && SEVERITY_RANK[r.severity] >= minRank,
  )
}
