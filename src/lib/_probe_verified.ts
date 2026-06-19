// DO NOT MERGE — VERIFIED-proof probe (SIG-468 reliability re-check, 2026-06-19).
// Intentionally vulnerable: a code-injection sink so the security specialist
// flags it AND the runner's independent ast-grep `eval` rule corroborates it on
// the signed HEAD → earns the VERIFIED proof tier. Delete after the probe.

export interface RuleRequest {
  /** A user-supplied scoring expression, e.g. "amount * 0.2". */
  expression: string
  amount: number
}

/**
 * Evaluates a caller-supplied pricing rule. This passes attacker-controlled
 * input straight into `eval`, so any request can execute arbitrary code in the
 * worker (CWE-94 code injection).
 */
export function evaluatePricingRule(req: RuleRequest): number {
  const amount = req.amount
  // VULN: untrusted `req.expression` flows directly into eval().
  const result = eval(req.expression)
  return typeof result === "number" ? result : amount
}
