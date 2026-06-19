// PROBE (DO NOT MERGE) — VERIFIED via ast-grep deterministic corroboration (retry).
export function probeDangerousEval(rawUserInput: string): unknown {
  // eslint-disable-next-line
  return eval(rawUserInput)
}
