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

const BADGE_ASSET_VERSION = "v20260525-2"
const BADGE_PATH_RE = /^\/assets\/badges\/(?:v[0-9-]+\/)?([a-z0-9-]+)\.svg$/
const BADGE_HEIGHT = 18
const PRIORITY_BADGE_WIDTH = 24

function categoryBadgeWidth(label: string): number {
  return Math.ceil(label.length * 6.1 + 12)
}

function renderBadgeSvg(style: (typeof BADGE_STYLES)[BadgeAssetName]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PRIORITY_BADGE_WIDTH} ${BADGE_HEIGHT}" width="${PRIORITY_BADGE_WIDTH}" height="${BADGE_HEIGHT}" role="img" aria-label="${style.label}">
  <rect x="0.5" y="0.5" width="${PRIORITY_BADGE_WIDTH - 1}" height="${BADGE_HEIGHT - 1}" rx="3.5" fill="${style.accent}" stroke="#FFFFFF" stroke-opacity="0.22"/>
  <text x="${PRIORITY_BADGE_WIDTH / 2}" y="12.35" text-anchor="middle" fill="#0B0C10" font-family="Geist Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="10.2" font-weight="750">${style.label}</text>
</svg>`
}

function renderCategoryBadgeSvg(style: (typeof CATEGORY_BADGE_STYLES)[CategoryBadgeAssetName]): string {
  const width = categoryBadgeWidth(style.label)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${BADGE_HEIGHT}" width="${width}" height="${BADGE_HEIGHT}" role="img" aria-label="${style.label}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${BADGE_HEIGHT - 1}" rx="2.75" fill="${style.accent}" stroke="#FFFFFF" stroke-opacity="0.18"/>
  <text x="${width / 2}" y="12.35" text-anchor="middle" fill="#0B0C10" font-family="Geist Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="9.8" font-weight="650" letter-spacing="1.1">${style.label}</text>
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
  if (name in BADGE_STYLES) return { width: PRIORITY_BADGE_WIDTH, height: BADGE_HEIGHT }
  return {
    width: categoryBadgeWidth(CATEGORY_BADGE_STYLES[name as CategoryBadgeAssetName].label),
    height: BADGE_HEIGHT,
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
  if (!(name in BADGE_SVGS)) return null
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": "image/svg+xml; charset=utf-8",
    "x-content-type-options": "nosniff",
  }
  return new Response(request.method === "HEAD" ? null : BADGE_SVGS[name], { headers })
}
