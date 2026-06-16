export type LearningsCommand = { kind: "remember"; rule: string } | { kind: "forget" } | { kind: "list" }

/**
 * Parse a learnings command from the MENTION-STRIPPED comment text. The caller
 * strips the @-handle (via `stripMentionFromBody`) before calling — exactly
 * like `parseDismissCommand`, which parses the already-stripped `question`. So
 * this stays agnostic to the configurable + legacy mention triggers
 * (`OPENCLAW_MENTION_TRIGGERS` / `arc` / `openclaw`) instead of hardcoding one
 * handle the rest of the system doesn't agree on (code-review P1).
 */
export function parseLearningsCommand(body: string): LearningsCommand | null {
  const normalized = body.trim().replace(/\s+/g, " ")
  const match = /^(remember|forget|list)(?:\s+(.+))?$/i.exec(normalized)
  if (match === null) return null

  const command = match[1]?.toLowerCase()
  const rest = match[2]?.trim()
  switch (command) {
    case "remember":
      return rest && rest.length > 0 ? { kind: "remember", rule: rest } : null
    case "forget":
      return rest === undefined ? { kind: "forget" } : null
    case "list":
      return rest === undefined ? { kind: "list" } : null
    default:
      return null
  }
}
