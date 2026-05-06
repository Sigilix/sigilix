// ARC-181: rule registry — the canonical list of v1 rules and the
// config-aware filter that the runner calls per scan.
//
// Adding a new rule = (1) write `rules/<id>.ts` exporting an
// `AstRule`, (2) import it here, (3) add to `ALL_RULES`. The
// registry exposes a stable, ordered list — order matters only for
// telemetry determinism, not for finding semantics.

import type { AstRule, Severity } from "./types"
import { noEvalCall } from "./rules/no-eval-call"

/**
 * The full v1 rule set. Add new rules here; the order is the
 * deterministic emit order (the runner uses it for the prompt-block
 * stable sort within a file).
 */
export const ALL_RULES: readonly AstRule[] = [
  noEvalCall,
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
