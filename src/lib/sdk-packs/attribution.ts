// SIG-298 follow-on — SDK guidance attribution marker parsing.
//
// The learnings feature attributes a finding to a per-repo rule
// DETERMINISTICALLY: the render-prep suppress gate re-derives the match
// (`shapedByLearning`, see `src/lib/ensemble/app/learnings-suppress-prep.ts`)
// — no model-authored marker involved. SDK guidance can't reuse that
// mechanism: a pack rule is prompt-level guidance the model may or may not
// have actually used to shape a given finding, not a deterministic fact we
// can re-check post-hoc. So this feature adds the lightweight marker scheme
// the SIG-298 spec calls for: the model appends `[sdk:<packId>]` to a
// finding's body when a rule informed it; we parse it out here, strip it
// from the user-visible text, and stamp a quiet `sdkGuidance` attribution on
// the finding (rendered as "via <Vendor> SDK guidance — <docsUrl>",
// mirroring `formatLearningAttribution`'s `<sub>` convention).
//
// Pure — no IO, no env.

const MARKER_RE = /\s*\[sdk:([a-z0-9][a-z0-9-]*)\]/gi

export interface ParsedSdkGuidanceMarkers {
  /** The body text with every `[sdk:<packId>]` marker removed. */
  text: string
  /** Deduped pack ids found, in first-seen order. */
  packIds: string[]
}

/**
 * Strip every `[sdk:<packId>]` marker from `text` and return the cleaned
 * text plus the deduped list of referenced pack ids. A marker referencing a
 * pack id that wasn't actually injected into this review's context is still
 * stripped from the user-visible text (never leak raw marker syntax) but the
 * caller is responsible for dropping ids that don't match a matched pack
 * before rendering attribution.
 */
export function parseSdkGuidanceMarkers(text: string): ParsedSdkGuidanceMarkers {
  const packIds: string[] = []
  const seen = new Set<string>()
  const stripped = text.replace(MARKER_RE, (_match, id: string) => {
    const normalized = id.toLowerCase()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      packIds.push(normalized)
    }
    return ""
  })
  return { text: stripped.trimEnd(), packIds }
}
