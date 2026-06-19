// DO NOT MERGE — quiet-VERIFIED end-to-end probe (SIG-471, 2026-06-19).
// Intentionally vulnerable: a code-injection sink so the security specialist flags
// it inline, our no-eval-call AST detector fires, and the runner's independent
// ast-grep scan corroborates. Expected NEW behavior: ONE review whose body is
// essentially empty (the finding is inline); the Sigilix Overview carries the
// Proof + Manage lines and upgrades grounded→runner-verified IN PLACE when the
// receipt lands — no second review posted. Delete after the probe.

export interface FormulaRequest {
  /** A user-supplied arithmetic expression, e.g. "qty * price". */
  expression: string
  fallback: number
}

/**
 * Evaluates a caller-supplied formula. Untrusted `req.expression` flows straight
 * into eval(), so any request can execute arbitrary code in the worker (CWE-94).
 */
export function evaluateFormula(req: FormulaRequest): number {
  // VULN: attacker-controlled `req.expression` passed directly to eval().
  const value = eval(req.expression)
  return typeof value === "number" ? value : req.fallback
}
