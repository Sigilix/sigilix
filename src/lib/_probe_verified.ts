// PROBE (DO NOT MERGE) — code-injection VERIFIED validation.
// Direct eval() of user input: our no-eval-call AST rule (sev error) flags it,
// and semgrep p/security-audit (detect-eval-with-expression) flags it too —
// same line, same canonical class (code-injection) → runner-confirmed VERIFIED.
export function probeEval(userInput: string): unknown {
  // eslint-disable-next-line
  return eval(userInput)
}
