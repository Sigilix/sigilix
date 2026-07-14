import type { FindingCategory } from "@/src/shared/domain/finding-category"
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

/**
 * SIG-104 PR-3: render the precision-profile BOOST as a single prompt line —
 * the categories this repo has repeatedly ACCEPTED, so the specialists give them
 * priority. This is the "computed-but-unused boost finally applied at the
 * learnings prompt gate" the precision-profile README + spec §5 call for. It is
 * deliberately a low-risk PROMPT nudge (never a score mutation), and it stays
 * subordinate to the non-negotiable recall constraints — it raises attention, it
 * never suppresses. Returns "" when no category is boosted. Pure.
 */
/**
 * Render the org∪repo learnings a Slack / Linear ANSWER should apply, as a
 * prompt block. Distinct from `renderLearningsForPrompt` (PR review) in one way:
 * it labels ORG guardrails ABOVE repo facts — an org `durable_preference` (a
 * team policy an admin taught) is a must-follow, so it is surfaced FIRST and
 * tagged `[org policy — must follow]`. Other org entries are `[org guidance]`;
 * repo-scope entries keep the review polarity tags. Pure; returns "" for [].
 */
export function renderSurfaceLearningsForPrompt(entries: ReadonlyArray<LearningEntry>): string {
  if (entries.length === 0) return ""
  const isOrgPolicy = (e: LearningEntry): boolean => e.scope === "org" && e.type === "durable_preference"
  // Stable partition — org must-follow policies first, everything else after,
  // each keeping its incoming order. The label carries precedence; the ordering
  // reinforces it for the model.
  const ordered = [...entries.filter(isOrgPolicy), ...entries.filter((e) => !isOrgPolicy(e))]
  return [
    "## Team & repository guidance (learned from past reviews and chats)",
    "Apply this guidance when answering. Org policies are team-wide and take precedence over repo-specific facts.",
    ...ordered.map((entry) => `- ${surfacePromptTag(entry)} ${promptRule(entry)}`),
  ].join("\n")
}

function surfacePromptTag(entry: LearningEntry): string {
  if (entry.scope === "org") {
    return entry.type === "durable_preference" ? "[org policy — must follow]" : "[org guidance]"
  }
  return promptTag(entry)
}

export function renderBoostedCategoriesForPrompt(categories: ReadonlyArray<FindingCategory>): string {
  if (categories.length === 0) return ""
  const unique = [...new Set(categories)]
  return `Prioritize findings in these repeatedly-valued categories (do not lower the bar elsewhere): ${unique.join(", ")}.`
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
