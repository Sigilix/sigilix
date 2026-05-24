const BADGE_STYLES = {
  p0: {
    label: "P0",
    fill: "#B91C1C",
    glyph: "M9 7H18L20 9L18 11H9L7 9ZM18 11L20 9L22 11V15L20 17L18 15ZM7 9L9 11V15L7 17L5 15V11ZM9 15H18L20 17L18 19H9L7 17ZM7 17L9 19V23L7 25L5 23V19ZM28 7H37L39 9L37 11H28L26 9ZM37 11L39 9L41 11V15L39 17L37 15ZM37 17L39 19V23L37 25L35 23V19ZM28 23H37L39 25L37 27H28L26 25ZM26 17L28 19V23L26 25L24 23V19ZM26 9L28 11V15L26 17L24 15V11Z",
  },
  p1: {
    label: "P1",
    fill: "#C2410C",
    glyph: "M9 7H18L20 9L18 11H9L7 9ZM18 11L20 9L22 11V15L20 17L18 15ZM7 9L9 11V15L7 17L5 15V11ZM9 15H18L20 17L18 19H9L7 17ZM7 17L9 19V23L7 25L5 23V19ZM37 11L39 9L41 11V15L39 17L37 15ZM37 17L39 19V23L37 25L35 23V19Z",
  },
  p2: {
    label: "P2",
    fill: "#854D0E",
    glyph: "M9 7H18L20 9L18 11H9L7 9ZM18 11L20 9L22 11V15L20 17L18 15ZM7 9L9 11V15L7 17L5 15V11ZM9 15H18L20 17L18 19H9L7 17ZM7 17L9 19V23L7 25L5 23V19ZM28 7H37L39 9L37 11H28L26 9ZM37 11L39 9L41 11V15L39 17L37 15ZM28 15H37L39 17L37 19H28L26 17ZM26 17L28 19V23L26 25L24 23V19ZM28 23H37L39 25L37 27H28L26 25Z",
  },
  p3: {
    label: "P3",
    fill: "#475569",
    glyph: "M9 7H18L20 9L18 11H9L7 9ZM18 11L20 9L22 11V15L20 17L18 15ZM7 9L9 11V15L7 17L5 15V11ZM9 15H18L20 17L18 19H9L7 17ZM7 17L9 19V23L7 25L5 23V19ZM28 7H37L39 9L37 11H28L26 9ZM37 11L39 9L41 11V15L39 17L37 15ZM28 15H37L39 17L37 19H28L26 17ZM37 17L39 19V23L37 25L35 23V19ZM28 23H37L39 25L37 27H28L26 25Z",
  },
} as const

export type BadgeAssetName = keyof typeof BADGE_STYLES

export const PUBLIC_BADGE_BASE_URL = "https://sigilix.dan-martinezjulio.workers.dev/assets/badges"

const BADGE_ASSET_VERSION = "v20260524-4"
const BADGE_PATH_RE = /^\/assets\/badges\/(?:v[0-9-]+\/)?(p[0-3])\.svg$/

function renderBadgeSvg(style: (typeof BADGE_STYLES)[BadgeAssetName]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 32" width="52" height="32" role="img" aria-label="${style.label}">
  <rect x="0.5" y="0.5" width="51" height="31" rx="5" fill="${style.fill}" stroke="#FFFFFF" stroke-opacity="0.24"/>
  <path transform="translate(4.5 0.5)" fill="#67E8F9" opacity="0.38" d="${style.glyph}"/>
  <path transform="translate(4 0)" fill="#FFFFFF" d="${style.glyph}"/>
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
