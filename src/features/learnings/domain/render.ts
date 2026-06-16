import type { LearningEntry } from "./types"

/**
 * SIG-104: escape a user/LLM-derived rule before embedding it in a markdown
 * container (the `<details>` footer / blockquote) so a crafted rule can't break
 * out of the container or inject HTML. The rule is persisted + user/LLM-derived
 * (unlike Sigilix-authored finding bodies), so it gets escaped — code-review P2.
 */
function escapeInlineMarkdown(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function renderConfirmReply(rule: string): string {
  return `<sub>Learned something new</sub>\n> "${escapeInlineMarkdown(rule)}"\n> Undo: reply \`@sigilix forget\` to this comment.`
}

export function renderForgetConfirm(): string {
  return "Forgot that rule.\n\n<sub>Sigilix will no longer apply it in future reviews.</sub>"
}

export function renderLearningsForPrompt(entries: ReadonlyArray<LearningEntry>): string {
  if (entries.length === 0) return ""
  return [
    "## Repository-specific guidance (learned from past reviews)",
    ...entries.map((entry) => `- ${promptTag(entry)} ${promptRule(entry)}`),
  ].join("\n")
}

export function renderOverviewFooter(entries: ReadonlyArray<LearningEntry>): string {
  if (entries.length === 0) return ""
  return [
    `<sub>·</sub> <details><summary><b>Memory</b> · ${entries.length} rules applied</summary>`,
    "",
    ...entries.map((entry) => `- ${escapeInlineMarkdown(entry.rule)}`),
    "</details>",
  ].join("\n")
}

function promptTag(entry: LearningEntry): string {
  switch (entry.polarity) {
    case "require":
      return "[require]"
    case "context":
      return "[context]"
    case "suppress":
      return "[suppress-as-context]"
  }
}

function promptRule(entry: LearningEntry): string {
  if (entry.polarity !== "suppress") return entry.rule
  return `${entry.rule} Use this only as context for noise reduction; do not silently drop security, logic, P0, or P1 findings.`
}
