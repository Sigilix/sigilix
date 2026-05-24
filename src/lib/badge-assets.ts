const BADGE_STYLES = {
  p0: { label: "P0", fill: "#B91C1C", accent: "#FCA5A5" },
  p1: { label: "P1", fill: "#C2410C", accent: "#FDBA74" },
  p2: { label: "P2", fill: "#854D0E", accent: "#FDE68A" },
  p3: { label: "P3", fill: "#475569", accent: "#CBD5E1" },
} as const

export type BadgeAssetName = keyof typeof BADGE_STYLES

export const PUBLIC_BADGE_BASE_URL = "https://sigilix.dan-martinezjulio.workers.dev/assets/badges"

const BADGE_ASSET_VERSION = "20260524.2"
const BADGE_PATH_RE = /^\/assets\/badges\/(p[0-3])\.svg$/

function renderBadgeSvg(style: (typeof BADGE_STYLES)[BadgeAssetName]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 32" width="52" height="32" role="img" aria-label="${style.label}">
  <rect x="0.5" y="0.5" width="51" height="31" rx="5" fill="${style.fill}" stroke="#FFFFFF" stroke-opacity="0.24"/>
  <path d="M7 6.5H45M7 25.5H45" stroke="${style.accent}" stroke-opacity="0.58" stroke-width="1"/>
  <path d="M7.5 11V21M44.5 11V21" stroke="${style.accent}" stroke-opacity="0.36" stroke-width="1"/>
  <text x="26" y="21" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="15" font-weight="900" letter-spacing="1.4" fill="#FFFFFF">${style.label}</text>
</svg>`
}

const BADGE_SVGS: Record<BadgeAssetName, string> = {
  p0: renderBadgeSvg(BADGE_STYLES.p0),
  p1: renderBadgeSvg(BADGE_STYLES.p1),
  p2: renderBadgeSvg(BADGE_STYLES.p2),
  p3: renderBadgeSvg(BADGE_STYLES.p3),
}

export function badgeAssetUrl(name: BadgeAssetName): string {
  return `${PUBLIC_BADGE_BASE_URL}/${name}.svg?v=${BADGE_ASSET_VERSION}`
}

export function getBadgeSvg(name: BadgeAssetName): string {
  return BADGE_SVGS[name]
}

export function handleBadgeAssetRoute(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  const { pathname } = new URL(request.url)
  const match = BADGE_PATH_RE.exec(pathname)
  if (!match) return null

  const name = match[1] as BadgeAssetName
  const headers = {
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": "image/svg+xml; charset=utf-8",
    "x-content-type-options": "nosniff",
  }
  return new Response(request.method === "HEAD" ? null : BADGE_SVGS[name], { headers })
}
