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

export type BadgeAssetName = keyof typeof BADGE_STYLES

export const PUBLIC_BADGE_BASE_URL = "https://sigilix.dan-martinezjulio.workers.dev/assets/badges"

const BADGE_ASSET_VERSION = "v20260525-1"
const BADGE_PATH_RE = /^\/assets\/badges\/(?:v[0-9-]+\/)?(p[0-3])\.svg$/

function renderBadgeSvg(style: (typeof BADGE_STYLES)[BadgeAssetName]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 22" width="30" height="22" role="img" aria-label="${style.label}">
  <rect x="0.5" y="0.5" width="29" height="21" rx="4.25" fill="${style.accent}" stroke="#FFFFFF" stroke-opacity="0.22"/>
  <text x="15" y="14.8" text-anchor="middle" fill="#0B0C10" font-family="Geist Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="11.8" font-weight="700">${style.label}</text>
</svg>`
}

const BADGE_SVGS: Record<BadgeAssetName, string> = {
  p0: renderBadgeSvg(BADGE_STYLES.p0),
  p1: renderBadgeSvg(BADGE_STYLES.p1),
  p2: renderBadgeSvg(BADGE_STYLES.p2),
  p3: renderBadgeSvg(BADGE_STYLES.p3),
}

export function badgeAssetUrl(name: BadgeAssetName): string {
  return `${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/${name}.svg`
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
