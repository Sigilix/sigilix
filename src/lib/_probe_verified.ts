import { exec } from "node:child_process"

// PROBE (DO NOT MERGE) — Phase 3 end-to-end VERIFIED validation.
// Deliberate OS command injection: semgrep p/security-audit (runner) flags it
// AND our security specialist flags it (CWE-78 → command-injection); the
// receipt-join should corroborate the matching class → render VERIFIED.
export function probeRunUserCommand(userInput: string): void {
  // eslint-disable-next-line
  exec(`echo ${userInput}`)
}
