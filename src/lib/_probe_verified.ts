// PROBE (DO NOT MERGE) — VERIFIED via our own deterministic ast-grep eval detector.
export function probeEval(userInput: string): unknown {
  // eslint-disable-next-line
  return eval(userInput)
}
