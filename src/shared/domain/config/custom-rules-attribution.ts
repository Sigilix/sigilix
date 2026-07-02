// Config-as-code — custom-rule attribution marker parsing.
//
// A custom rule is prompt-level guidance the model may or may not have
// actually used to shape a given finding, not a deterministic fact we can
// re-check post-hoc. So the model is instructed (in
// `renderCustomRulesForPrompt`) to append `[repo-rule:<id>]` to a finding's
// body when a rule informed it; we parse it out here, strip it from the
// user-visible text, and the caller stamps a quiet `repoRule` attribution on
// the finding (mirrors the SDK-pack `[sdk:<id>]` scheme in
// `@/src/lib/sdk-packs/attribution`).
//
// Pure — no IO, no env.

const MARKER_RE = /\s*\[repo-rule:([a-z0-9][a-z0-9-]*)\]/gi

export interface ParsedCustomRuleMarkers {
  /** The body text with every `[repo-rule:<id>]` marker removed. */
  text: string
  /** Deduped rule ids found, in first-seen order. */
  ruleIds: string[]
}

/**
 * Strip every `[repo-rule:<id>]` marker from `text` and return the cleaned
 * text plus the deduped list of referenced rule ids. A marker referencing an
 * id that wasn't actually injected into this review's context is still
 * stripped from the user-visible text (never leak raw marker syntax) but the
 * caller is responsible for dropping ids that don't match an injected rule
 * before rendering attribution.
 */
export function parseCustomRuleMarkers(text: string): ParsedCustomRuleMarkers {
  const ruleIds: string[] = []
  const seen = new Set<string>()
  const stripped = text.replace(MARKER_RE, (_match, id: string) => {
    const normalized = id.toLowerCase()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      ruleIds.push(normalized)
    }
    return ""
  })
  return { text: stripped.trimEnd(), ruleIds }
}
