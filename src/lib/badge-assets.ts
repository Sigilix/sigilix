import { BADGE_GLYPH_PATHS, type BadgeGlyphPath } from "./badge-glyph-paths"
import {
  BADGE_DISPLAY_SCALE,
  BADGE_PADDING_PX,
  CATEGORY_BADGE_HEIGHT,
  PRIORITY_BADGE_HEIGHT,
  PRIORITY_BADGE_WIDTH,
  categoryBadgeWidth,
} from "./badge-geometry"

const BADGE_STYLES = {
  p0: {
    label: "P0",
    accent: "#B91C1C",
  },
  p1: {
    label: "P1",
    accent: "#F59E0B",
  },
  p2: {
    label: "P2",
    accent: "#84CC16",
  },
  p3: {
    label: "P3",
    accent: "#3B82F6",
  },
} as const

const CATEGORY_BADGE_STYLES = {
  logic: {
    label: "LOGIC",
    accent: "#7DD3FC",
  },
  security: {
    label: "SECURITY",
    accent: "#F0ABFC",
  },
  performance: {
    label: "PERF",
    accent: "#FDBA74",
  },
  "error-handling": {
    label: "ERROR",
    accent: "#FCA5A5",
  },
  testing: {
    label: "TESTING",
    accent: "#86EFAC",
  },
  complexity: {
    label: "COMPLEXITY",
    accent: "#C4B5FD",
  },
  style: {
    label: "STYLE",
    accent: "#93C5FD",
  },
  syntax: {
    label: "SYNTAX",
    accent: "#FDE68A",
  },
  docs: {
    label: "DOCS",
    accent: "#CBD5E1",
  },
} as const

export type BadgeAssetName = keyof typeof BADGE_STYLES
export type CategoryBadgeAssetName = keyof typeof CATEGORY_BADGE_STYLES
export type ReviewBadgeAssetName = BadgeAssetName | CategoryBadgeAssetName

// SIG-238 (2026-05-26 round-6 — THE ACTUAL FIX):
// host = `raw.githubusercontent.com/Sigilix/sigilix-glyphs`, a
// SEPARATE PUBLIC GitHub repo created tonight specifically to host
// the glyph SVGs. Tag-based versioning: each `BADGE_ASSET_VERSION`
// bump corresponds to a git tag in `Sigilix/sigilix-glyphs`, and the
// URL pulls the SVG from that immutable ref.
//
// Why this works when prior 5 iterations didn't:
//
//   1. **No Camo proxy.** GitHub's image renderer treats
//      `*.githubusercontent.com` hosts as same-origin and skips the
//      Camo proxy. Empirically verified via `gh api /markdown` —
//      raw.githubusercontent.com URLs render as bare `<img>` with
//      only responsive sizing, no `border-radius`, no
//      `background-color`. Camo-proxied URLs (workers.dev, sigilix.ai,
//      sigilix.github.io — all tested 2026-05-26) get
//      `data-canonical-src` wrapped + the `js-gh-image-fallback` JS
//      injects rounding at render time.
//   2. **No 404.** PR #192's first attempt pointed at
//      `Sigilix/sigilix/main` — the same repo, which is PRIVATE, so
//      raw.githubusercontent.com 404s for anonymous fetches.
//      `Sigilix/sigilix-glyphs` is intentionally **public** for
//      exactly this reason — the only thing in the repo is glyph
//      SVGs, no proprietary code.
//
// Prior failed attempts (all addressed by this approach):
//   1. SVG `rx=0` baked into the rect → js-gh-image-fallback overrode
//   2. `rx=0` + `shape-rendering="crispEdges"` → same
//   3. `BADGE_DISPLAY_SCALE = 1.6` → bloated, still rounded
//   4. Drop the `<a href>` anchor wrap → still rounded (the
//      js-gh-image-fallback class lives on the `<img>` directly)
//   5. raw.githubusercontent.com on the PRIVATE Sigilix/sigilix repo
//      → 404s, badges didn't load at all
//
// Build-time dependency: every `BADGE_ASSET_VERSION` bump requires
// mirroring the corresponding `assets/badges/<version>/*.svg` files
// to the public glyphs repo AND tagging that commit with the same
// version string. See `Sigilix/sigilix-glyphs` README for the
// upstream workflow.
export const PUBLIC_BADGE_BASE_URL = "https://raw.githubusercontent.com/Sigilix/sigilix-glyphs"

/**
 * SIG-238: kept as a back-compat anchor so the Worker keeps serving
 * older PR comments whose `<img src>` still points at the prior host.
 * The runtime `badgeAssetUrl()` ONLY emits raw.githubusercontent.com
 * URLs (the new pattern); this constant is purely for tests that
 * exercise the `handleBadgeAssetRoute(...)` self-serve path against
 * the original Workers route.
 */
export const LEGACY_WORKER_BADGE_BASE_URL = "https://sigilix.dan-martinezjulio.workers.dev/assets/badges"

// SIG-238 round-7 (2026-05-27): bumped v20260527-1 → v20260528-1 for
// Kimi K2.6's transparent-inset spec. SVG bytes change shape: viewBox
// grows by 2×BADGE_PADDING_PX on each axis, the visible rect is inset
// at (PADDING, PADDING), and the glyph wraps in a `<g translate>` so
// CSS rounding on the outer img clips the transparent margin instead
// of the colored rect. Founder's 2026-05-26 screenshot proved round-4's
// drop-the-<a>-wrap fix was insufficient: Primer's stylesheet now
// rounds bare <img> too, so geometry padding is the load-bearing fix.
// Bot dimensions returned by `badgeAssetSize()` also grow to match;
// every old comment keeps pointing at v20260527-1 (which still works
// since the SVGs are immutable per-tag in the glyphs repo).
export const BADGE_ASSET_VERSION = "v20260528-1"
const BADGE_PATH_RE = /^\/assets\/badges\/(?:v[0-9-]+\/)?([a-z0-9-]+)\.svg$/

// Priority badge geometry (PRIORITY_BADGE_WIDTH/HEIGHT, CATEGORY_BADGE_HEIGHT,
// categoryBadgeWidth) lives in `./badge-geometry` so the offline glyph-path
// generator (scripts/generate-badge-glyph-paths.ts) shares the same numbers.
// Glyph is path-baked (Geist Mono Medium @ 9.5px, frozen via opentype.js into
// src/lib/badge-glyph-paths.ts) so rendering is pixel-perfect regardless of
// the viewer's installed fonts. Category pill uses slightly more rounded
// corners (rx=2 vs priority's rx=1) to mark it as the secondary badge.

// Priority text color: near-black on bright accent fill (dark-on-bright for
// AA contrast across the P0..P3 palette). SIG-216 spec value (Kimi K2.6).
const PRIORITY_TEXT_COLOR = "#0A0A0A"

// Kimi R2 treatment knobs for the category pill: figure/ground hierarchy
// is created by remapping the brand-hue accents to a deep BG + bright text
// at fixed saturation/lightness. Hue identity is preserved across all 9
// categories — only S/L change.
const CATEGORY_BG_SATURATION = 0.12
const CATEGORY_BG_LIGHTNESS = 0.18
const CATEGORY_TEXT_SATURATION = 0.65
const CATEGORY_TEXT_LIGHTNESS = 0.85

// Color math kept inline (no helper module) since it's used only here and the
// applyHsl helper keeps the accent table readable as "base hue + treatment".
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m || !m[1]) throw new Error(`badge-assets: invalid hex ${hex}`)
  const int = parseInt(m[1], 16)
  const r = ((int >> 16) & 0xff) / 255
  const g = ((int >> 8) & 0xff) / 255
  const b = (int & 0xff) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) * 60
      break
    case g:
      h = ((b - r) / d + 2) * 60
      break
    default:
      h = ((r - g) / d + 4) * 60
      break
  }
  return { h, s, l }
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  const toHex = (v: number): string => {
    const n = Math.round((v + m) * 255)
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")
  }
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase()
}

function applyHsl(baseHex: string, targetSaturation: number, targetLightness: number): string {
  const { h } = hexToHsl(baseHex)
  return hslToHex(h, targetSaturation, targetLightness)
}

export function lookupGlyph(label: string): BadgeGlyphPath {
  const glyph = BADGE_GLYPH_PATHS[label]
  if (!glyph) {
    // Indicates a label was added to BADGE_STYLES / CATEGORY_BADGE_STYLES
    // without re-running `pnpm regenerate-badge-paths`. Fail loud at
    // construction time so the missing-glyph bug shows up in tests, not
    // in a deployed badge that silently renders an empty rect.
    throw new Error(`badge-assets: no baked glyph for label ${label} — run \`pnpm regenerate-badge-paths\``)
  }
  return glyph
}

function renderBadgeSvg(style: (typeof BADGE_STYLES)[BadgeAssetName]): string {
  // Visible rect stays at PRIORITY_BADGE_WIDTH × PRIORITY_BADGE_HEIGHT
  // (the coord space the baked Geist Mono glyph paths target) but the
  // outer SVG viewBox grows by 2×BADGE_PADDING_PX on each axis so the
  // colored rect lives INSET by `BADGE_PADDING_PX` on every side. The
  // glyph is wrapped in `<g transform="translate(...)">` so its baked
  // coordinates land at the same visual position inside the new larger
  // viewport. Trade-offs + history in `badge-geometry.ts:BADGE_PADDING_PX`.
  // rx=0 + crispEdges preserved on the rect; glyph keeps default
  // shape-rendering for legibility (per Kimi K2.6 round-2 spec).
  const glyph = lookupGlyph(style.label)
  const p = BADGE_PADDING_PX
  const outerW = PRIORITY_BADGE_WIDTH + p * 2
  const outerH = PRIORITY_BADGE_HEIGHT + p * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outerW} ${outerH}" width="${outerW}" height="${outerH}" role="img" aria-label="${style.label}">
  <rect x="${p}" y="${p}" width="${PRIORITY_BADGE_WIDTH}" height="${PRIORITY_BADGE_HEIGHT}" rx="0" fill="${style.accent}" shape-rendering="crispEdges"/>
  <g transform="translate(${p} ${p})"><path d="${glyph.d}" fill="${PRIORITY_TEXT_COLOR}"/></g>
</svg>`
}

function renderCategoryBadgeSvg(style: (typeof CATEGORY_BADGE_STYLES)[CategoryBadgeAssetName]): string {
  // Same padded-viewBox pattern as `renderBadgeSvg` above — visible
  // pill stays at `width × CATEGORY_BADGE_HEIGHT` to preserve the baked
  // glyph coordinates; outer viewBox grows by 2×BADGE_PADDING_PX so
  // CSS rounding on the outer img clips transparent margin only.
  const width = categoryBadgeWidth(style.label)
  const bg = applyHsl(style.accent, CATEGORY_BG_SATURATION, CATEGORY_BG_LIGHTNESS)
  const fg = applyHsl(style.accent, CATEGORY_TEXT_SATURATION, CATEGORY_TEXT_LIGHTNESS)
  const glyph = lookupGlyph(style.label)
  const p = BADGE_PADDING_PX
  const outerW = width + p * 2
  const outerH = CATEGORY_BADGE_HEIGHT + p * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outerW} ${outerH}" width="${outerW}" height="${outerH}" role="img" aria-label="${style.label}">
  <rect x="${p}" y="${p}" width="${width}" height="${CATEGORY_BADGE_HEIGHT}" rx="0" fill="${bg}" shape-rendering="crispEdges"/>
  <g transform="translate(${p} ${p})"><path d="${glyph.d}" fill="${fg}"/></g>
</svg>`
}

const BADGE_SVGS: Record<ReviewBadgeAssetName, string> = {
  p0: renderBadgeSvg(BADGE_STYLES.p0),
  p1: renderBadgeSvg(BADGE_STYLES.p1),
  p2: renderBadgeSvg(BADGE_STYLES.p2),
  p3: renderBadgeSvg(BADGE_STYLES.p3),
  logic: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.logic),
  security: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.security),
  performance: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.performance),
  "error-handling": renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES["error-handling"]),
  testing: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.testing),
  complexity: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.complexity),
  style: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.style),
  syntax: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.syntax),
  docs: renderCategoryBadgeSvg(CATEGORY_BADGE_STYLES.docs),
}

export function badgeAssetUrl(name: ReviewBadgeAssetName): string {
  return `${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/${name}.svg`
}

export function badgeAssetSize(name: ReviewBadgeAssetName): { width: number; height: number } {
  // Returns the `<img>` tag DISPLAY size. Must match the SVG INTRINSIC
  // viewBox (visible rect + 2×BADGE_PADDING_PX padding on each axis),
  // otherwise the browser scales the padding non-uniformly and either
  // shrinks the visible rect (img smaller than intrinsic) or stretches
  // the transparent margin out where CSS rounding can't reach the
  // colored edge anymore (img larger than intrinsic). 1:1 keeps the
  // padding doing its load-bearing CSS-clip-absorption job.
  // BADGE_DISPLAY_SCALE = 1.0 held; the constant remains as a future
  // hook (see badge-geometry.ts) but applies to the OUTER dims now.
  const p2 = BADGE_PADDING_PX * 2
  if (name in BADGE_STYLES) {
    return {
      width: Math.round((PRIORITY_BADGE_WIDTH + p2) * BADGE_DISPLAY_SCALE),
      height: Math.round((PRIORITY_BADGE_HEIGHT + p2) * BADGE_DISPLAY_SCALE),
    }
  }
  return {
    width: Math.round(
      (categoryBadgeWidth(CATEGORY_BADGE_STYLES[name as CategoryBadgeAssetName].label) + p2)
        * BADGE_DISPLAY_SCALE,
    ),
    height: Math.round((CATEGORY_BADGE_HEIGHT + p2) * BADGE_DISPLAY_SCALE),
  }
}

export function badgeAssetLabel(name: ReviewBadgeAssetName): string {
  if (name in BADGE_STYLES) return BADGE_STYLES[name as BadgeAssetName].label
  return CATEGORY_BADGE_STYLES[name as CategoryBadgeAssetName].label
}

export function getBadgeSvg(name: ReviewBadgeAssetName): string {
  return BADGE_SVGS[name]
}

/**
 * SIG-238 (CR catch): exhaustive list of badge names sourced from
 * `BADGE_SVGS` itself, so `scripts/generate-static-badges.ts` cannot
 * silently drift if a new badge is added to `BADGE_SVGS` without a
 * matching entry in the generator script. Keys are `ReviewBadgeAssetName`
 * by construction — the `Object.keys` typing is widened to `string[]`
 * at runtime, so we narrow it back via `as readonly ReviewBadgeAssetName[]`.
 */
export const ALL_BADGE_NAMES: readonly ReviewBadgeAssetName[] =
  Object.keys(BADGE_SVGS) as readonly ReviewBadgeAssetName[]

export function handleBadgeAssetRoute(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const { pathname } = new URL(request.url)
  const match = BADGE_PATH_RE.exec(pathname)
  if (!match) return null

  const name = match[1] as ReviewBadgeAssetName
  if (!Object.prototype.hasOwnProperty.call(BADGE_SVGS, name)) return null
  const svg = BADGE_SVGS[name]
  if (typeof svg !== "string" || !svg.trimStart().startsWith("<svg")) return null
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": "image/svg+xml; charset=utf-8",
    "x-content-type-options": "nosniff",
  }
  return new Response(request.method === "HEAD" ? null : svg, { headers })
}
