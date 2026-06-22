// SIG-304 (review CLI) Phase 1b — the splash: a "universe" loading motif. A
// drifting + twinkling starfield, a procedural spinning Earth (the loader), and a
// tiny red sigil stamp in the corner — "the mark of merge-ready code." No wordmark.
// Rendered with the half-block technique (▀ fg=top px / bg=bottom px) in truecolor.
// `renderSplashFrame` is pure + deterministic; `runWithSplash` animates to a TTY
// (stderr) IN PLACE (no scrollback churn), hard-gated by the caller to
// TTY && !NO_COLOR && !CI.

import { paint } from "./ansi"
import { THEME } from "./palette"
import { renderEarth } from "./earth"

const W = 46
const H = 10 // compact, Greptile-card scale
const EARTH_D = 16 // px diameter → 8 char rows
const EARTH_TOP = 1
const STAR_CYCLE = 8 // frames per twinkle pulse (dim → bright → dim)
// Per-star hue [bright, dim] — a varied "universe" palette (white/blue weighted,
// with cyan, gold, a soft violet, and an occasional warm brand-red accent).
const STAR_COLORS: ReadonlyArray<readonly [string, string]> = [
  ["#ffffff", "#5b6172"], // white
  ["#cdddff", "#39435e"], // pale blue
  ["#cdddff", "#39435e"], // pale blue (weighted)
  ["#a6ecff", "#355b66"], // cyan
  ["#ffe6a8", "#5f553a"], // gold
  ["#d8b4ff", "#443a5e"], // violet
  ["#ffb3ad", "#5f4040"], // warm brand-red accent
]
export const TOTAL = 24 // frames in the standalone (test/preview) loop 0..TOTAL-1
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

type Cell = { ch: string; fg: string; bg: string | null }

/**
 * Render ONE splash frame as an ANSI string. Pure + deterministic.
 * @param frame continuous tick — spins the Earth, drifts/twinkles stars, cycles the spinner.
 * @param progress 0..1; >=0.999 shows the "review complete" state. Defaults from `frame`.
 */
export function renderSplashFrame(frame: number, progress?: number): string {
  const p = Math.max(0, Math.min(1, progress ?? frame / (TOTAL - 1)))
  const done = p >= 0.999
  const grid: (Cell | null)[][] = Array.from({ length: H }, () => Array<Cell | null>(W).fill(null))
  const put = (y: number, x: number, ch: string, fg: string, bg: string | null = null): void => {
    if (y >= 0 && y < H && x >= 0 && x < W) grid[y]![x] = { ch, fg, bg }
  }
  const putText = (y: number, x: number, text: string, fg: string): void => {
    for (let i = 0; i < text.length; i++) put(y, x + i, text[i]!, fg)
  }

  // Dense, MULTICOLOR starfield with PARALLAX drift + a per-star dim→bright→dim
  // pulse, all keyed off `frame` so the field shimmers AND moves every tick. Each
  // star keeps a stable hue [bright, dim]; the pulse swaps glyph + brightness.
  let s = 9
  const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let i = 0; i < Math.floor(W * H * 0.14); i++) {
    const bx = Math.floor(rnd() * W)
    const y = Math.floor(rnd() * H)
    const speed = 0.3 + rnd() * 1.0 // varied → parallax
    const phase = Math.floor(rnd() * STAR_CYCLE)
    const [bright, dim] = STAR_COLORS[Math.floor(rnd() * STAR_COLORS.length)]!
    const x = Math.floor((((bx - frame * speed) % W) + W) % W)
    const t = (frame + phase) % STAR_CYCLE
    const level = t < STAR_CYCLE / 2 ? t : STAR_CYCLE - t // triangle wave 0..4..0
    const ch = level >= 3 ? "✦" : level >= 1 ? "·" : "."
    put(y, x, ch, level >= 2 ? bright : dim)
  }

  // the spinning Earth — centered (stars show through its transparent corners)
  const eLeft = Math.floor((W - EARTH_D) / 2)
  const earth = renderEarth(frame, EARTH_D)
  earth.forEach((row, cr) =>
    row.forEach((c, x) => {
      if (c.ch !== " ") put(EARTH_TOP + cr, eLeft + x, c.ch, c.fg, c.bg)
    }),
  )

  // tiny sigil stamp + lowercase wordmark, top-left corner
  put(0, 1, "❖", done ? THEME.diffPlus : THEME.red)
  putText(0, 3, "sigilix", THEME.dim)

  let out = "\n"
  for (let y = 0; y < H; y++) {
    let line = "  "
    for (let x = 0; x < W; x++) {
      const cell = grid[y]![x]
      line += cell ? paint(cell.ch, cell.bg ? { fg: cell.fg, bg: cell.bg } : { fg: cell.fg }) : " "
    }
    out += line + "\n"
  }
  // status line: spinner + verb while running, a check + "complete" when done
  const status = done
    ? paint("✓", { fg: THEME.diffPlus, bold: true }) + paint("  review complete", { fg: THEME.dim })
    : paint(SPINNER[frame % SPINNER.length]!, { fg: THEME.red }) +
      paint("  reviewing your changes…", { fg: THEME.dim, italic: true })
  out += "\n    " + status + "\n"
  return out
}

const ESC = String.fromCharCode(27)
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR_DOWN = `${ESC}[0J` // clear from cursor to end of screen (no scrollback churn)
const cursorUp = (n: number): string => (n > 0 ? `${ESC}[${n}A\r` : "\r")
const countLines = (str: string): number => (str.match(/\n/g) ?? []).length

export interface SplashOptions {
  out?: NodeJS.WriteStream
  frameMs?: number
  /** injectable for deterministic tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Animate the splash on `out` (default stderr) while `work` runs, then return its
 * result. Frames are REDRAWN IN PLACE (cursor-up + clear-down, never a full-screen
 * \x1b[2J and never a trailing newline mid-animation) so the animation leaves NO
 * stacked frames in the scrollback — scrolling up shows only the final frame. The
 * Earth spins + stars drift continuously while the review runs; when `work` settles
 * it shows the "review complete" frame, leaves it on screen (the review prints under
 * it), and always restores the cursor (incl. on SIGINT/SIGTERM). The CALLER must
 * gate this to an interactive, color-capable, non-CI terminal.
 */
export async function runWithSplash<T>(work: Promise<T>, opts: SplashOptions = {}): Promise<T> {
  const out = opts.out ?? process.stderr
  const frameMs = opts.frameMs ?? 90
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let settled = false
  let failed = false
  const tracked = work.then(
    (v) => {
      settled = true
      return v
    },
    (e: unknown) => {
      settled = true
      failed = true
      throw e
    },
  )
  // Keep `tracked` "handled" during the animation window so a mid-run rejection
  // never fires unhandledRejection; the real error still reaches the caller below.
  void tracked.catch(() => {})
  const restore = (): void => void out.write(SHOW_CURSOR)
  const onSignal = (): void => {
    restore()
    process.exit(130)
  }
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)
  out.write(HIDE_CURSOR)
  // Each frame is drawn WITHOUT its trailing newline so the cursor stays on the
  // last content line (no scroll); the next frame steps back up over it.
  let prevLines = 0
  const draw = (frame: string): void => {
    const body = frame.endsWith("\n") ? frame.slice(0, -1) : frame
    out.write(cursorUp(prevLines) + CLEAR_DOWN + body)
    prevLines = countLines(body)
  }
  try {
    let f = 0
    while (!settled) {
      draw(renderSplashFrame(f, 0))
      await sleep(frameMs)
      f++
    }
    // On SUCCESS, commit the "complete" frame (with a trailing newline) so it stays
    // on screen and the review prints below. On FAILURE, never show the ✓/"review
    // complete" — leave the last in-progress frame and let the error print under it.
    if (!failed) draw(renderSplashFrame(f, 1))
    out.write("\n")
  } finally {
    restore()
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
  }
  return tracked
}
