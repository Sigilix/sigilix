// SIG-298 follow-on — "SDK guidance packs" v1 (Greptile-partners-style vendor
// review context, self-authored from public docs; NOT a partner integration —
// no endorsement claims, no logos).
//
// Pure types only. A pack is static TS data (no DB, no network) matched
// against a PR's diff at review time and, when matched, injected into the
// specialist prompts (not synth) as a labeled "SDK guidance" section — the
// same context-injection channel `src/features/learnings` uses for per-repo
// learned rules (see `renderLearningsForPrompt` / `buildSpecialistInitialMessage`
// `learningsBlock`).

/**
 * A single review-actionable rule inside a pack: a known SDK/framework
 * failure pattern or implementation rule, 1-3 sentences, written so a
 * specialist model can apply it directly against a diff.
 */
export interface SdkPackRule {
  /** Stable id, unique within the pack (e.g. "webhook-signature-verification"). */
  id: string
  /** Short human title shown in the prompt list. */
  title: string
  /** 1-3 sentence, review-actionable guidance. */
  guidance: string
  /** A soft priority hint for the model — never a score mutation, never a gate. */
  severityHint: "P1" | "P2" | "P3"
  /** Optional rule-specific docs link; falls back to the pack's `docsUrl`. */
  docsUrl?: string
}

/**
 * Matchers used to decide whether a pack is relevant to a PR's diff. All
 * matching is cheap regex/string work over the diff text already fetched
 * for the review — no extra fetches.
 */
export interface SdkPackMatchers {
  /** `package.json` dependency names (exact match against an added dep line). */
  packages: readonly string[]
  /** Regexes tested against changed import/require specifier text. */
  importPatterns: readonly RegExp[]
  /** Optional glob-ish path patterns (simple `*`/`**` glob, no braces) that also count as a match. */
  pathGlobs?: readonly string[]
}

/**
 * A self-authored SDK/framework guidance pack. Rendered as a clearly-labeled
 * "SDK guidance" section, distinct from repo-owner guidance and learnings —
 * never a partner/endorsement claim.
 */
export interface SdkPack {
  /** Stable id, used as the `[sdk:<id>]` attribution marker and in telemetry. */
  id: string
  /** Display name shown in the prompt + attribution line, e.g. "Stripe". */
  vendor: string
  /** Canonical public docs URL shown in the attribution line. */
  docsUrl: string
  matchers: SdkPackMatchers
  rules: readonly SdkPackRule[]
}

/** Off (default) | shadow (detect + log, no injection) | on (inject + attribute). */
export type SdkPacksMode = "off" | "shadow" | "on"

/** A pack that matched the diff, with the subset of files that triggered the match. */
export interface MatchedSdkPack {
  pack: SdkPack
  /** Changed paths whose import/package match contributed to this pack's relevance. */
  matchedPaths: readonly string[]
}
