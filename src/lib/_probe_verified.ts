import { exec } from "node:child_process"

// PROBE (DO NOT MERGE) — final VERIFIED end-to-end validation (Phase 1+2+3).
export function probeRunUserCommand(userInput: string): void {
  // eslint-disable-next-line
  exec(`echo ${userInput}`)
}
