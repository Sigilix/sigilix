// DO NOT MERGE — VERIFIED reliability probe (SIG-470 Phase 3b, 2026-06-19).
// Intentionally vulnerable: a code-injection sink so the security specialist flags
// it AND our own no-eval-call AST detector fires at the same line. With Phase 3b,
// the co-located AST class should earn VERIFIED on the FIRST pass (no CWE needed),
// once the runner's independent ast-grep eval scan corroborates. Delete after probe.

export interface DiscountRule {
  /** A user-supplied discount formula, e.g. "subtotal * 0.15". */
  formula: string
  subtotal: number
}

/**
 * Applies a caller-supplied discount rule. Untrusted `rule.formula` flows straight
 * into eval(), so any request can execute arbitrary code in the worker (CWE-94).
 */
export function applyDiscountRule(rule: DiscountRule): number {
  const subtotal = rule.subtotal
  // VULN: attacker-controlled `rule.formula` passed directly to eval().
  const discounted = eval(rule.formula)
  return typeof discounted === "number" ? discounted : subtotal
}
