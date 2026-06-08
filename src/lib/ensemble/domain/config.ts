// SIG-318 — the EnsembleConfig CONTRACT (domain layer).
//
// Pure domain types describing the ensemble's env-derived settings. The
// use-case / orchestrator depends on THIS contract; the edge parser
// (`../config.ts`) is the ONLY place that knows about the Worker env, and it
// IMPLEMENTS this shape and injects it inward. Per the dependency rule the
// contract lives inward (domain) while the framework detail (env reading) stays
// at the edge — never the reverse (Kimi clean-arch review, SIG-318 PR 4).
//
// The validator-mode fields reuse each validator's own exported mode type, so
// the contract is a single typed view, not a re-declaration.

import type { SecurityValidatorMode } from "../../validate-security-finding"
import type { TestsValidatorMode } from "../../validate-test-finding"
import type { LogicValidatorMode } from "../../validate-logic-finding"
import type { LogicRefutationMode } from "../../validate-logic-refutation"
import type { RefutationSurvivalMode } from "../../validate-refutation-survival"
import type { LogicClaimRefutationMode } from "../../validate-logic-claim-refutation"
import type { PerfValidatorMode } from "../../validate-perf-finding"
import type { InlineGroundingValidatorMode } from "../../validate-inline-grounding"
import type { AbsenceClaimValidatorMode } from "../../validate-absence-grounding"
import type { WindowBlindnessValidatorMode } from "../../validate-window-blindness"
import type { SecurityGroundingValidatorMode } from "../../validate-security-grounding"
import type { SecurityUsageValidatorMode } from "../../validate-security-usage"

/** Normalized `off | shadow | post` mode for an AST security scanner. Kept as a
 *  string to preserve the call sites' exact contract (`mode !== "post"`,
 *  `applyAstScanGate(...)`). */
export type AstScanMode = string

/** The AST security-scanner modes, one per scanner rule. */
export interface AstScanModes {
  authzIdor: AstScanMode
  weakRandom: AstScanMode
  openRedirect: AstScanMode
  ssrf: AstScanMode
  pathTraversal: AstScanMode
  sqlInjection: AstScanMode
  ssti: AstScanMode
  nosqlInjection: AstScanMode
  protoPollution: AstScanMode
  xxe: AstScanMode
}

/** The believability validator gate modes, one per validator — each typed by the
 *  validator's own exported mode union. */
export interface EnsembleValidatorModes {
  securityValidatorMode: SecurityValidatorMode
  testsValidatorMode: TestsValidatorMode
  logicValidatorMode: LogicValidatorMode
  logicRefutationMode: LogicRefutationMode
  refutationSurvivalMode: RefutationSurvivalMode
  logicClaimRefutationMode: LogicClaimRefutationMode
  perfValidatorMode: PerfValidatorMode
  inlineGroundingValidatorMode: InlineGroundingValidatorMode
  absenceClaimValidatorMode: AbsenceClaimValidatorMode
  windowBlindnessValidatorMode: WindowBlindnessValidatorMode
  securityGroundingValidatorMode: SecurityGroundingValidatorMode
  securityUsageValidatorMode: SecurityUsageValidatorMode
}

/** The parse-once, typed view of the ensemble's env-derived settings. Grows by
 *  cluster as the env→Config migration proceeds (SIG-318 PR 3+). */
export interface EnsembleConfig {
  astScanModes: AstScanModes
  validatorModes: EnsembleValidatorModes
}
