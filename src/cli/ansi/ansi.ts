// SIG-304 (review CLI) Phase 1b — pure ANSI/truecolor primitives for the rich
// terminal render + the splash. No I/O: every helper returns a string. Emits
// 24-bit (truecolor) SGR sequences; callers gate on a `color` flag
// (process.stdout.isTTY && !NO_COLOR) and fall back to plain text when false.

export interface Rgb {
  r: number
  g: number
  b: number
}

const clamp = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : Math.round(n))

/** Parse a `#rrggbb` (or `rrggbb`) hex string into an {r,g,b} triple. Throws on malformed input. */
export function hexToRgb(hex: string): Rgb {
  const cleaned = hex.trim().replace(/^#/, "")
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    throw new Error(`hexToRgb: not a 6-digit hex color: ${JSON.stringify(hex)}`)
  }
  const n = parseInt(cleaned, 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

export const RESET = "\x1b[0m"
export const BOLD = "\x1b[1m"
export const DIM = "\x1b[2m"
export const ITALIC = "\x1b[3m"

/** Foreground truecolor SGR: `\x1b[38;2;r;g;bm`. */
export const fg = ({ r, g, b }: Rgb): string => `\x1b[38;2;${clamp(r)};${clamp(g)};${clamp(b)}m`
/** Background truecolor SGR: `\x1b[48;2;r;g;bm`. */
export const bg = ({ r, g, b }: Rgb): string => `\x1b[48;2;${clamp(r)};${clamp(g)};${clamp(b)}m`

export interface PaintOptions {
  /** foreground hex (`#rrggbb`) */
  fg?: string
  /** background hex (`#rrggbb`) */
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
}

/**
 * Wrap `text` in the requested SGR codes, ALWAYS closing with RESET so styles
 * never leak into subsequent output. With no options, returns `text` unchanged.
 *
 * LEAF-ONLY / NON-NESTABLE: the trailing RESET clears ALL attributes, so a
 * painted span placed INSIDE another painted span ends the outer style at the
 * inner RESET. Compose by painting discrete leaves (pill, headline, path) and
 * concatenating — never paint() a string that already contains paint() output.
 */
export function paint(text: string, opts: PaintOptions = {}): string {
  let prefix = ""
  if (opts.bold) prefix += BOLD
  if (opts.dim) prefix += DIM
  if (opts.italic) prefix += ITALIC
  if (opts.fg) prefix += fg(hexToRgb(opts.fg))
  if (opts.bg) prefix += bg(hexToRgb(opts.bg))
  return prefix === "" ? text : `${prefix}${text}${RESET}`
}

// Built via RegExp(ESC) rather than a control char in a regex literal (no-control-regex).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
/**
 * Strip SGR (color) escape sequences. NB: `stripAnsi(s).length` is ASCII visible
 * width only — NOT column-accurate for wide/CJK/emoji/combining glyphs.
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

// Sticky variant of ANSI_RE — matches an SGR sequence anchored at lastIndex.
const ANSI_AT = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "y")
/**
 * Truncate `s` to at most `width` VISIBLE chars, preserving SGR sequences (they
 * don't count toward width). Appends RESET if the cut lands mid-style, so a
 * clipped line never leaks color past the box border. ASCII-width only (see
 * stripAnsi). `width <= 0` → "".
 */
export function clipAnsi(s: string, width: number): string {
  if (width <= 0) return ""
  let out = ""
  let vis = 0
  let sawSgr = false
  let i = 0
  while (i < s.length) {
    ANSI_AT.lastIndex = i
    const m = ANSI_AT.exec(s)
    if (m) {
      out += m[0]
      sawSgr = true
      i += m[0].length
      continue
    }
    if (vis >= width) return out + (sawSgr ? RESET : "")
    out += s[i]
    vis++
    i++
  }
  return out
}
