// SIG-304 (review CLI) Phase 1b — the animated launch splash (founder-approved
// v7): a red SIGILIX wordmark over a drifting starfield, with a rocket that
// flies in, pitches up, and lands tail-down on a glm-5.2 Earth as the review
// runs — the rocket's progress IS the bar. Rendered with the half-block
// technique (▀ fg=top px / bg=bottom px). `renderSplashFrame` is pure +
// deterministic; `runWithSplash` animates to a TTY (stderr) while a promise runs,
// hard-gated by the caller to TTY && !NO_COLOR && !CI so piped output is never
// touched.

import { paint } from "./ansi"
import { THEME } from "./palette"
import {
  logoCells,
  LOGO_GRAD,
  GLM_LEG,
  GLM_FLYING,
  GLM_45,
  GLM_VERTICAL,
  GLM_TOUCHDOWN,
  GLM_FLAME_LONG,
  GLM_FLAME_SHORT,
  GLM_DUST,
  GLM_PLANET,
  GLM_PLANET_LEG,
} from "./sprites"

const W = 76
const H = 34
export const TOTAL = 22 // frames: fly → pitch → vertical retro-descent → land

type Cell = { ch: string; fg: string; bg: string | null }
const gw = (rows: readonly string[]): number => Math.max(...rows.map((r) => r.length))

/** Render ONE splash frame (0..TOTAL-1) as an ANSI string. Pure + deterministic. */
export function renderSplashFrame(frame: number): string {
  const grid: (Cell | null)[][] = Array.from({ length: H }, () => Array<Cell | null>(W).fill(null))
  const put = (y: number, x: number, ch: string, fg: string, bg: string | null = null): void => {
    if (y >= 0 && y < H && x >= 0 && x < W) grid[y]![x] = { ch, fg, bg }
  }
  const blit = (rows: readonly string[], top: number, left: number, leg: Record<string, string> = GLM_LEG): void => {
    const cw = gw(rows)
    const cell = (ch: string | undefined): string | null => {
      const c = ch === undefined ? undefined : leg[ch]
      return c && c !== "#0d0d12" ? c : null
    }
    for (let cr = 0; cr < Math.ceil(rows.length / 2); cr++)
      for (let x = 0; x < cw; x++) {
        const t = cell((rows[2 * cr] ?? "")[x])
        const b = cell((rows[2 * cr + 1] ?? "")[x])
        if (!t && !b) continue
        if (t && b) put(top + cr, left + x, "▀", t, b)
        else if (t) put(top + cr, left + x, "▀", t)
        else if (b) put(top + cr, left + x, "▄", b)
      }
  }

  // drifting starfield (deterministic LCG; each star parallax-drifts left, wraps)
  let s = 7
  const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let i = 0; i < Math.floor(W * H * 0.08); i++) {
    const bx = Math.floor(rnd() * W)
    const y = Math.floor(rnd() * H)
    const sp = 0.25 + rnd() * 0.9
    const x = Math.floor((((bx - frame * sp) % W) + W) % W)
    const r = rnd()
    put(y, x, r > 0.9 ? "✦" : r > 0.55 ? "·" : ".", r > 0.9 ? THEME.starHi : r > 0.72 ? THEME.star2 : THEME.star)
  }

  // wordmark: red vertical gradient + a deep-red floor shadow row
  const { fills } = logoCells()
  const lw = logoCells().w
  const lx = Math.floor((W - lw) / 2)
  fills.forEach((k) => {
    const [r, c] = k.split(",").map(Number) as [number, number]
    if (r === 4) put(r + 1, lx + c, "▀", THEME.redDeep)
  })
  fills.forEach((k) => {
    const [r, c] = k.split(",").map(Number) as [number, number]
    put(r, lx + c, "█", LOGO_GRAD[r] ?? THEME.red)
  })

  // Earth — the landing target, lower-right
  const pw = gw(GLM_PLANET)
  const earthCharTop = 21
  const earthLeft = W - pw - 2
  const earthCx = earthLeft + pw / 2
  blit(GLM_PLANET, earthCharTop, earthLeft, GLM_PLANET_LEG)

  // progress = the rocket's flight: approach → pitch → vertical retro-descent → land
  const p = Math.max(0, Math.min(1, frame / (TOTAL - 1))) // clamp: keep repeat() counts non-negative for any frame
  const flyTop = 5
  const approachEnd = 0.36
  const pitchEnd = 0.46
  const legsAt = 0.82
  const flameShortAt = 0.74
  const contactAt = 0.92
  const settleAt = 0.97
  const vCharH = Math.ceil(GLM_VERTICAL.length / 2)
  const vleft = Math.round(earthCx - gw(GLM_VERTICAL) / 2)
  const flameLeft = Math.round(earthCx - gw(GLM_FLAME_LONG) / 2)
  const vtopEnd = earthCharTop - vCharH + 1
  if (p < approachEnd) {
    const tp = p / approachEnd
    const startLeft = -8
    const endLeft = Math.round(earthCx - gw(GLM_FLYING) / 2)
    const left = Math.round(startLeft + (endLeft - startLeft) * tp)
    for (let x = 2; x < left + 8; x += 2) put(flyTop + 3, x, "·", THEME.star)
    blit(GLM_FLYING, flyTop, left)
  } else if (p < pitchEnd) {
    blit(GLM_45, flyTop, Math.round(earthCx - gw(GLM_45) / 2))
  } else {
    const dfrac = Math.min(1, (p - pitchEnd) / (contactAt - pitchEnd))
    const vtop = Math.round(flyTop + (vtopEnd - flyTop) * dfrac)
    const contact = p >= contactAt
    blit(p >= legsAt ? GLM_TOUCHDOWN : GLM_VERTICAL, vtop, vleft)
    if (!contact) blit(p < flameShortAt ? GLM_FLAME_LONG : GLM_FLAME_SHORT, vtop + vCharH, flameLeft)
    else if (p < settleAt + 0.03) blit(GLM_DUST, earthCharTop - 1, Math.round(earthCx - gw(GLM_DUST) / 2))
    if (p >= settleAt) put(earthCharTop - 1, Math.round(earthLeft + pw + 1), "✓", THEME.diffPlus)
  }

  let out = "\n"
  for (let y = 0; y < H; y++) {
    let line = "  "
    for (let x = 0; x < W; x++) {
      const cell = grid[y]![x]
      line += cell ? paint(cell.ch, cell.bg ? { fg: cell.fg, bg: cell.bg } : { fg: cell.fg }) : " "
    }
    out += line + "\n"
  }
  // status line + a literal progress bar echoing the rocket's progress
  const barLen = 22
  const filled = Math.round(p * barLen)
  const bar = paint("█".repeat(filled), { fg: THEME.red }) + paint("░".repeat(barLen - filled), { fg: "#2a2a33" })
  const label =
    p >= 0.995
      ? paint("review complete", { fg: THEME.diffPlus, bold: true }) + paint("  ·  landed", { fg: THEME.dim })
      : paint("reviewing your changes…", { fg: THEME.dim, italic: true })
  out += "\n    " + label + "\n"
  out +=
    "    " +
    paint("[", { fg: THEME.dim }) +
    bar +
    paint("]", { fg: THEME.dim }) +
    paint(`  ${Math.round(p * 100)}%`, { fg: THEME.dim }) +
    "\n"
  return out
}

const ESC = String.fromCharCode(27)
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR_HOME = `${ESC}[2J${ESC}[H`

export interface SplashOptions {
  out?: NodeJS.WriteStream
  total?: number
  frameMs?: number
  /** injectable for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Animate the splash on `out` (default stderr) while `work` runs, then return its
 * result. Cycles frames until `work` settles, shows the landed frame, clears, and
 * always restores the cursor (incl. on SIGINT/SIGTERM). The CALLER must gate this
 * to an interactive, color-capable, non-CI terminal — it writes ANSI + cursor
 * controls unconditionally once invoked.
 */
export async function runWithSplash<T>(work: Promise<T>, opts: SplashOptions = {}): Promise<T> {
  const out = opts.out ?? process.stderr
  const total = Math.max(1, opts.total ?? TOTAL)
  const frameMs = opts.frameMs ?? 90
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let settled = false
  const tracked = work.then(
    (v) => {
      settled = true
      return v
    },
    (e: unknown) => {
      settled = true
      throw e
    },
  )
  // Keep `tracked` "handled" during the animation window so a mid-run rejection
  // never fires unhandledRejection; the real error is still surfaced to the
  // caller via the returned `tracked` below.
  void tracked.catch(() => {})
  const restore = (): void => void out.write(SHOW_CURSOR)
  const onSignal = (): void => {
    restore()
    process.exit(130)
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  out.write(HIDE_CURSOR)
  try {
    let f = 0
    while (!settled) {
      out.write(CLEAR_HOME + renderSplashFrame(f % total))
      await sleep(frameMs)
      f++
    }
    out.write(CLEAR_HOME + renderSplashFrame(total - 1)) // landed
    await sleep(frameMs)
    out.write(CLEAR_HOME) // clear the splash before the review output prints
  } finally {
    restore()
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
  }
  return tracked
}
