// SIG-216 follow-up: shared geometry constants for badge SVG rendering.
// Consumed by src/lib/badge-assets.ts (runtime SVG renderer) AND
// scripts/generate-badge-glyph-paths.ts (offline glyph-path generator)
// so both code paths share one source of truth and can't drift on
// centering math.

// Greptile-direction priority badge: 20x20 filled square. This is
// the SVG INTRINSIC geometry (viewBox) — the path-baked glyphs at
// `src/lib/badge-glyph-paths.ts` are positioned for this 20×20
// coordinate space, so changing this constant would invalidate every
// glyph path.
export const PRIORITY_BADGE_WIDTH = 20
export const PRIORITY_BADGE_HEIGHT = 20

/**
 * Multiplier applied at the `<img>` tag DISPLAY size (not the SVG
 * viewBox). Held at **1.0** after Kimi K2.6 round-4 diagnosis
 * (2026-05-26): the founder's "still rounded" screenshots were NOT
 * caused by bitmap interpolation on upscale — they were caused by
 * GitHub Primer CSS applying `border-radius` to anchor-wrapped images
 * in markdown comments. The SVG was always rendering sharp; the
 * surrounding `<a>` container clipped the corners. Real fix: drop
 * the `<a>` wrap (see `badgeImg` in `triage-pr-review.ts`).
 *
 * The prior 1.6× scale bloated the badges relative to comment text
 * without actually fixing the rounding. Holding at 1.0 keeps the
 * constant in place as a future hook (e.g. if a downstream surface
 * needs a higher-density source asset) without anchoring the wrong
 * fix in the production rendering path.
 */
export const BADGE_DISPLAY_SCALE = 1.0

// Category pill matches the priority badge height (20px) for visual unity,
// mirroring Greptile's same-height priority+category pairing.
export const CATEGORY_BADGE_HEIGHT = 20

export function categoryBadgeWidth(label: string): number {
  // Geist Mono 9.5px @ 600 metrics: ~6.5px advance + 16px horizontal padding.
  return Math.ceil(label.length * 6.5 + 16)
}

/**
 * SIG-238 round-7 (Kimi K2.6 spec, 2026-05-27): transparent inset wrapped
 * around the colored badge rect inside the SVG so GitHub's Primer CSS
 * `.markdown-body img { border-radius: ~6px }` clips the TRANSPARENT
 * margin instead of the visible rect.
 *
 * Round 4's "drop the <a> wrap → use bare <img>" fix was necessary but
 * INSUFFICIENT: Primer's stylesheet was tightened (some recent revision)
 * to apply border-radius to ALL .markdown-body img, not just anchor-
 * wrapped ones. The 2026-05-26 founder screenshot showed P1 + PERF
 * still visibly rounded despite bare <img> + rx=0 SVG + crispEdges.
 *
 * 6px exceeds GitHub's observed ~6px radius with zero safety margin —
 * Kimi's exact spec; no extra pixel needed because the rect is INSET,
 * not bleeding. Inline `style` strip-by-sanitizer makes a CSS override
 * non-viable; the geometry change is the only stable surface.
 *
 * Trade-offs (per Kimi r7):
 *   - Vertical baseline: the +12px height shifts the badge's visual
 *     center up vs the adjacent text line (`align="top"` preserves
 *     top-alignment; the gap is at the bottom).
 *   - Repo size: +600 bytes total across 13 glyphs — negligible.
 *   - HiDPI: 32px is divisible by 16; slightly cleaner pixel snapping
 *     than the prior 20px on 2× displays.
 *   - Glyph paths: UNCHANGED — paths are wrapped in `<g translate(6 6)>`
 *     at render time so the baked Geist Mono geometry doesn't need
 *     re-baking. Future glyph regeneration (`generate-badge-glyph-paths`)
 *     stays at the original 20x20 coordinate space.
 */
export const BADGE_PADDING_PX = 6
