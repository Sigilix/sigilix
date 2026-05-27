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
 * SIG-238 round-9 (2026-05-27): retired the r7 transparent inset.
 *
 * History — what rounds 4 and 7 got wrong:
 *   - r4: "Primer rounds `a > img`, switch to bare `<img>`."
 *     Founder's 2026-05-26 screenshot showed badges STILL rounded
 *     with bare `<img>` + rx=0 — diagnosis was wrong.
 *   - r7: "Add 6px transparent inset so CSS rounding clips margin
 *     not rect." That DID give sharp colored corners but exposed
 *     Primer's `background-color: var(--bgColor-muted)` rule —
 *     the transparent margin showed the bg through it, creating a
 *     visible rounded "bubble" frame around each badge.
 *   - r8: "Revert to round-6 with rounded corners." Rejected because
 *     founder already vetoed rounded corners in r4.
 *
 * What actually works (empirical):
 *   - SVG: viewBox=20x20, rect width=19.512 height=19.512 rx=1,
 *     fill="none" on outer svg. Tiny ~0.5px transparent gutter +
 *     intentional 1px rx that the SVG itself OWNS.
 *   - HTML: `<a href="#"><img alt src align="top"></a>` with NO
 *     explicit width/height attributes. The anchor-wrap + missing
 *     dimensions suppress whichever Primer rule was painting the
 *     bubble around our bare-img badges.
 *
 * `BADGE_PADDING_PX = 0` retires the r7 transparent inset. The new
 * load-bearing constants are the gutter + the anchor wrap; encoded in
 * `renderBadgeSvg` / `renderCategoryBadgeSvg` directly.
 */
export const BADGE_PADDING_PX = 0

/**
 * Sub-pixel transparent gutter between the colored rect and the SVG's
 * viewBox boundary (0.488px = 20 - 19.512). Small enough that the
 * colored rect appears full-bleed at any reasonable zoom; combined
 * with the `<a>` wrap + missing IMG width/height, this is the
 * geometry recipe that defeats Primer's border-radius bubble effect
 * on github.com PR comments.
 */
export const BADGE_GUTTER_PX = 0.488

/**
 * Corner radius on the SVG rect itself — 1px. Small enough to look
 * square at glance but large enough that the SVG OWNS the corner
 * rounding so Primer's CSS doesn't have a chance to add its own
 * larger radius.
 */
export const BADGE_RECT_RX = 1
