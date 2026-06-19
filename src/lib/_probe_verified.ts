import { exec } from "node:child_process"

// PROBE (DO NOT MERGE) — validates the VERIFIED proof-tier unlock end-to-end.
// Deliberate OS command injection: user input is interpolated straight into a
// shell command. semgrep `p/security-audit` flags this child_process exec, and
// our security specialist should flag it as a sev-high security finding — the
// overlap is what the receipt-join corroborates into a VERIFIED pill.
export function probeRunUserCommand(userInput: string): void {
  // eslint-disable-next-line
  exec(`echo ${userInput}`)
}

export function probeRunUserCommand2(userInput: string): void {
  // eslint-disable-next-line
  exec(`cat ${userInput}`)
}

export function probeRunUserCommand3(userInput: string): void {
  // eslint-disable-next-line
  exec(`grep ${userInput} /etc/hosts`)
}
