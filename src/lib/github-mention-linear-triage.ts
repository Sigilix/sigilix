// SIG-545 A: GitHub-PR "@sigilix make a linear triage" command. Dark by default.
import type { Env } from "@/src/shared/types/env"
export type GithubLinearTriageMode = "off" | "shadow" | "on"
export function resolveGithubLinearTriageMode(env: Pick<Env, "OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE">): GithubLinearTriageMode {
  const v = env.OPENCLAW_GITHUB_LINEAR_TRIAGE_MODE
  return v === "shadow" || v === "on" ? v : "off"
}

// Leading-imperative regexes for "make/create a linear triage/issue/ticket" forms.
// Anchored at the start so descriptive questions ("what would a linear triage look like?") don't match.
const MAKE_CREATE_RE = /^\s*(?:(?:can\s+you\s+)?(?:make|create)\s+(?:a\s+)?linear\s+(?:triage|issue|ticket))/i
const TRIAGE_INTO_RE = /^\s*triage\s+(?:this\s+)?into\s+linear/i

export function parseLinearTriageCommand(question: string): { matched: boolean } {
  return { matched: MAKE_CREATE_RE.test(question) || TRIAGE_INTO_RE.test(question) }
}
