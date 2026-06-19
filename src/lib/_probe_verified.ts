import { exec } from "node:child_process"
export function probeRunUserCommand(userInput: string): void {
  // eslint-disable-next-line
  exec(`echo ${userInput}`)
}
