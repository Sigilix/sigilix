// SIG-216 follow-up: shared geometry constants for badge SVG rendering.
// Consumed by src/lib/badge-assets.ts (runtime SVG renderer) AND
// scripts/generate-badge-glyph-paths.ts (offline glyph-path generator)
// so both code paths share one source of truth and can't drift on
// centering math.

// Greptile-direction priority badge: 20x20 filled square (rx=1).
export const PRIORITY_BADGE_WIDTH = 20
export const PRIORITY_BADGE_HEIGHT = 20

// Category pill matches the priority badge height (20px) for visual unity,
// mirroring Greptile's same-height priority+category pairing.
export const CATEGORY_BADGE_HEIGHT = 20

export function categoryBadgeWidth(label: string): number {
  // Geist Mono 9.5px @ 600 metrics: ~6.5px advance + 16px horizontal padding.
  return Math.ceil(label.length * 6.5 + 16)
}
