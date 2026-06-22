// SIG-304 (review CLI) Phase 1b — a procedural spinning globe for the splash, the
// "universe" loading motif. Rendered with the half-block technique (▀ fg=top px /
// bg=bottom px) in TRUECOLOR: a lit sphere with day/night terminator shading, a
// cyan atmosphere limb, scrolling continents + clouds, and ice caps. Pure +
// deterministic given `frame`; no I/O.

export interface EarthCell {
  ch: string
  fg: string
  bg: string | null
}

type RGB = [number, number, number]
const DAY_OCEAN: RGB = [37, 110, 200]
const DAY_LAND: RGB = [46, 160, 86]
const NIGHT: RGB = [8, 16, 40]
const ATMO: RGB = [120, 200, 255]
const ICE: RGB = [232, 244, 255]
const CLOUD: RGB = [240, 246, 252]

// Continents as angular blobs (lon°[-180,180], lat°[-90,90], radius°) — enough to
// read as a recognizable, spinning planet without a full texture map.
const LAND: ReadonlyArray<readonly [number, number, number]> = [
  [-105, 45, 34],
  [-70, -12, 30],
  [18, 8, 30],
  [26, -28, 24],
  [60, 30, 22],
  [105, 48, 36],
  [132, -22, 18],
]

const DEG = 180 / Math.PI
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]
const hex = (c: RGB): string => `#${c.map((v) => clamp(v, 0, 255).toString(16).padStart(2, "0")).join("")}`

// angular distance (deg) between two lon/lat points, lon wrapping at ±180
const angDist = (lon1: number, lat1: number, lon2: number, lat2: number): number => {
  let dlon = Math.abs(lon1 - lon2)
  if (dlon > 180) dlon = 360 - dlon
  const dlat = lat1 - lat2
  // cheap elliptical metric (good enough for blob coastlines), weight lon by cos(lat)
  const k = Math.cos((lat1 / DEG) * 1)
  return Math.hypot(dlon * Math.max(0.25, k), dlat)
}

// deterministic value-noise in [0,1] for cloud/coastline jitter
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// Light from upper-left, toward viewer.
const LX = -0.55,
  LY = -0.5,
  LZ = 0.67
const LL = Math.hypot(LX, LY, LZ)

/** Per-pixel surface color of the globe at (px,py) for a given spin frame, or null outside the disc. */
function surface(px: number, py: number, d: number, frame: number): RGB | null {
  const r = (d - 1) / 2
  const dx = (px - r) / r
  const dy = (py - r) / r
  const d2 = dx * dx + dy * dy
  if (d2 > 1) return null
  const nz = Math.sqrt(Math.max(0, 1 - d2))
  // lighting
  const b = clamp((dx * LX + dy * LY + nz * LZ) / LL, 0, 1)
  const lit = Math.pow(b, 0.85)
  // sphere → lon/lat (deg), spin scrolls longitude
  const lat = Math.asin(clamp(dy, -1, 1)) * DEG
  const lon = ((Math.atan2(dx, nz) * DEG + frame * 4.2 + 540) % 360) - 180
  // ice caps
  if (Math.abs(lat) > 74) {
    const base = mix(NIGHT, ICE, lit)
    return d2 > 0.86 ? mix(base, ATMO, 0.4 * lit) : base
  }
  // land vs ocean (with a little coastline jitter)
  let land = false
  for (const [blon, blat, br] of LAND) {
    if (angDist(lon, lat, blon, blat) < br + (noise(blon + lon * 0.06, blat + lat * 0.06) - 0.5) * 10) {
      land = true
      break
    }
  }
  let base = mix(NIGHT, land ? DAY_LAND : DAY_OCEAN, lit)
  // scrolling clouds on the lit side
  const cl = noise(Math.floor((lon + frame * 2.2) / 14), Math.floor(lat / 12))
  if (cl > 0.74 && lit > 0.25) base = mix(base, CLOUD, (cl - 0.74) * 2.6 * lit)
  // atmosphere limb glow on the lit edge
  if (d2 > 0.8) base = mix(base, ATMO, (d2 - 0.8) * 4 * lit)
  return base
}

/** Render the globe as half-block char-cells: `ceil(d/2)` rows × `d` cols. */
export function renderEarth(frame: number, d = 16): EarthCell[][] {
  const rows: EarthCell[][] = []
  for (let cr = 0; cr < Math.ceil(d / 2); cr++) {
    const row: EarthCell[] = []
    for (let x = 0; x < d; x++) {
      const top = surface(x, 2 * cr, d, frame)
      const bot = surface(x, 2 * cr + 1, d, frame)
      if (!top && !bot) row.push({ ch: " ", fg: "", bg: null })
      else if (top && bot) row.push({ ch: "▀", fg: hex(top), bg: hex(bot) })
      else if (top) row.push({ ch: "▀", fg: hex(top), bg: null })
      else row.push({ ch: "▄", fg: hex(bot!), bg: null })
    }
    rows.push(row)
  }
  return rows
}
