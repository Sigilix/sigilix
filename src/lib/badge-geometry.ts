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
 * viewBox). Kimi K2.6 follow-up (2026-05-26 round 3): the founder's
 * screenshots kept showing rounded badge corners even with rx=0 +
 * shape-rendering="crispEdges" baked in. Diagnosis: bitmap
 * interpolation downstream of the SVG render — a 20×20 SVG rasters
 * to 40×40 device pixels on retina, and any further bitmap zoom (in
 * a screenshot tool, chat preview, browser zoom) bilinear-smears the
 * hard 90° corner into a 2-3 pixel gradient that reads as rounded.
 *
 * Fix: render the IMG tag at 1.6× the SVG intrinsic size (20×20 → 32×32
 * for priority badges; category badge height 20 → 32). The SVG
 * renderer still produces a crisp square at the new display size (it
 * rescales the viewBox; glyphs stay positioned correctly because
 * they're stored in viewBox units). Downstream bitmap consumers now
 * get a 64×64 device-pixel source to interpolate from instead of
 * 40×40, so the corner stays visually sharp through reasonable zoom.
 */
export const BADGE_DISPLAY_SCALE = 1.6

// Category pill matches the priority badge height (20px) for visual unity,
// mirroring Greptile's same-height priority+category pairing.
export const CATEGORY_BADGE_HEIGHT = 20

export function categoryBadgeWidth(label: string): number {
  // Geist Mono 9.5px @ 600 metrics: ~6.5px advance + 16px horizontal padding.
  return Math.ceil(label.length * 6.5 + 16)
}
