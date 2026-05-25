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

export const PUBLIC_BADGE_BASE_URL = "https://sigilix.dan-martinezjulio.workers.dev/assets/badges"

const BADGE_ASSET_VERSION = "v20260525-3"
const BADGE_PATH_RE = /^\/assets\/badges\/(?:v[0-9-]+\/)?([a-z0-9-]+)\.svg$/

// Kimi R2 priority badge: outline-only 20x13.
const PRIORITY_BADGE_WIDTH = 20
const PRIORITY_BADGE_HEIGHT = 13

// Kimi R2 category badge: low-saturation filled 15-tall pill.
const CATEGORY_BADGE_HEIGHT = 15

// Kimi R2 treatment knobs for the category pill: figure/ground hierarchy
// is created by remapping the brand-hue accents to a deep BG + bright text
// at fixed saturation/lightness. Hue identity is preserved across all 9
// categories — only S/L change.
const CATEGORY_BG_SATURATION = 0.12
const CATEGORY_BG_LIGHTNESS = 0.18
const CATEGORY_TEXT_SATURATION = 0.65
const CATEGORY_TEXT_LIGHTNESS = 0.85

function categoryBadgeWidth(label: string): number {
  // Geist Mono 9.5px @ 600 metrics: ~6.5px advance + 16px horizontal padding.
  return Math.ceil(label.length * 6.5 + 16)
}

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

function renderBadgeSvg(style: (typeof BADGE_STYLES)[BadgeAssetName]): string {
  // Outline-only pill. Stroke at 70% opacity in the accent hue; text in the
  // same accent. ~40% less visual mass than the prior filled 24x18 chip.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PRIORITY_BADGE_WIDTH} ${PRIORITY_BADGE_HEIGHT}" width="${PRIORITY_BADGE_WIDTH}" height="${PRIORITY_BADGE_HEIGHT}" role="img" aria-label="${style.label}">
  <rect x="0.75" y="0.75" width="${PRIORITY_BADGE_WIDTH - 1.5}" height="${PRIORITY_BADGE_HEIGHT - 1.5}" rx="2.5" fill="none" stroke="${style.accent}" stroke-opacity="0.7" stroke-width="1.5"/>
  <text x="${PRIORITY_BADGE_WIDTH / 2}" y="9.5" text-anchor="middle" fill="${style.accent}" font-family="Geist Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="9.5" font-weight="600" letter-spacing="0.02em">${style.label}</text>
</svg>`
}

function renderCategoryBadgeSvg(style: (typeof CATEGORY_BADGE_STYLES)[CategoryBadgeAssetName]): string {
  const width = categoryBadgeWidth(style.label)
  const bg = applyHsl(style.accent, CATEGORY_BG_SATURATION, CATEGORY_BG_LIGHTNESS)
  const fg = applyHsl(style.accent, CATEGORY_TEXT_SATURATION, CATEGORY_TEXT_LIGHTNESS)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${CATEGORY_BADGE_HEIGHT}" width="${width}" height="${CATEGORY_BADGE_HEIGHT}" role="img" aria-label="${style.label}">
  <rect x="0" y="0" width="${width}" height="${CATEGORY_BADGE_HEIGHT}" rx="4" fill="${bg}"/>
  <text x="${width / 2}" y="10.75" text-anchor="middle" fill="${fg}" font-family="Geist Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="9.5" font-weight="600" letter-spacing="0.02em">${style.label}</text>
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
  if (name in BADGE_STYLES) return { width: PRIORITY_BADGE_WIDTH, height: PRIORITY_BADGE_HEIGHT }
  return {
    width: categoryBadgeWidth(CATEGORY_BADGE_STYLES[name as CategoryBadgeAssetName].label),
    height: CATEGORY_BADGE_HEIGHT,
  }
}

export function badgeAssetLabel(name: ReviewBadgeAssetName): string {
  if (name in BADGE_STYLES) return BADGE_STYLES[name as BadgeAssetName].label
  return CATEGORY_BADGE_STYLES[name as CategoryBadgeAssetName].label
}

export function getBadgeSvg(name: ReviewBadgeAssetName): string {
  return BADGE_SVGS[name]
}

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
