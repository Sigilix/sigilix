// SIG-304 (review CLI) Phase 1b — render a Mermaid `sequenceDiagram` source (the
// real `PrOverviewVerdict.mermaidDiagram` the overview pass emits) as an
// ANSI/box-drawing diagram for the terminal. GitHub renders the fenced ```mermaid
// block graphically; the CLI lays out the same participants + messages as ASCII.
//
// Supported subset (what the engine emits): `participant X` / `participant X as Y`
// / `actor X` declarations, messages `A->>B: msg` (solid) / `A-->>B: msg`
// (dashed return) / `A-)B: msg` (async, drawn solid), `Note over X[,Y]: text` /
// `Note left of X: text` / `Note right of X: text`, and block markers
// `loop|alt|opt|par <label>` … `end`. Unknown lines are skipped, never thrown on.

import { paint, stripAnsi } from "@/src/cli/ansi/ansi"
import { THEME } from "@/src/cli/ansi/palette"

type Msg = { kind: "msg"; from: number; to: number; label: string; dashed: boolean }
type Note = { kind: "note"; from: number; to: number; label: string }
type Block = { kind: "block"; label: string }
type EndBlk = { kind: "end" }
type Event = Msg | Note | Block | EndBlk

interface Parsed {
  participants: string[] // display names, in declared/first-seen order
  events: Event[]
}

const MSG_RE = /^([\w$.]+)\s*(--?>>|->>|-\)|--?>)\s*([\w$.]+)\s*:\s*(.+)$/
const NOTE_RE = /^note\s+(over|left of|right of)\s+([\w$.]+)(?:\s*,\s*([\w$.]+))?\s*:\s*(.+)$/i
const PARTICIPANT_RE = /^(?:participant|actor)\s+([\w$.]+)(?:\s+as\s+(.+))?$/i
const BLOCK_RE = /^(loop|alt|opt|par|critical|break)\b\s*(.*)$/i

/** Parse the supported Mermaid sequenceDiagram subset. Returns null if no participants/messages. */
function parse(src: string): Parsed | null {
  const order: string[] = [] // ids in first-seen order
  const display = new Map<string, string>()
  const idx = (id: string): number => {
    if (!order.includes(id)) {
      order.push(id)
      if (!display.has(id)) display.set(id, id)
    }
    return order.indexOf(id)
  }
  const events: Event[] = []
  for (const raw of src.split("\n")) {
    const line = raw.trim()
    if (line === "" || /^sequencediagram$/i.test(line) || line.startsWith("%%") || /^autonumber$/i.test(line)) continue
    const p = PARTICIPANT_RE.exec(line)
    if (p) {
      const id = p[1]!
      idx(id)
      display.set(id, (p[2] ?? id).trim())
      continue
    }
    const n = NOTE_RE.exec(line)
    if (n) {
      const a = idx(n[2]!)
      const b = n[3] ? idx(n[3]) : a
      events.push({ kind: "note", from: Math.min(a, b), to: Math.max(a, b), label: n[4]!.trim() })
      continue
    }
    if (/^end$/i.test(line)) {
      events.push({ kind: "end" })
      continue
    }
    const blk = BLOCK_RE.exec(line)
    if (blk && !MSG_RE.test(line)) {
      events.push({ kind: "block", label: `${blk[1]!.toLowerCase()}${blk[2] ? " " + blk[2].trim() : ""}` })
      continue
    }
    const m = MSG_RE.exec(line)
    if (m) {
      const from = idx(m[1]!)
      const to = idx(m[3]!)
      events.push({ kind: "msg", from, to, label: m[4]!.trim(), dashed: m[2]!.startsWith("--") })
    }
  }
  if (order.length === 0 || !events.some((e) => e.kind === "msg")) return null
  return { participants: order.map((id) => display.get(id) ?? id), events }
}

/**
 * Render the parsed diagram into an ANSI string. Returns null when the source has
 * no usable participants/messages (caller omits the section).
 */
export function renderSequenceDiagram(mermaid: string, opts: { color: boolean }): string | null {
  const parsed = parse(mermaid)
  if (!parsed) return null
  const { participants, events } = parsed

  // Column geometry: each participant gets a box; the lifeline sits at its centre.
  const GAP = 4
  const boxW = participants.map((p) => p.length + 2)
  const cx: number[] = []
  let x = 1
  boxW.forEach((bw) => {
    cx.push(x + Math.floor(bw / 2))
    x += bw + GAP
  })
  const W = x + 18 // right margin so notes/labels near the last lifeline aren't clipped
  const rows: { ch: string; c: string | null }[][] = []
  const ensure = (y: number): void => {
    while (rows.length <= y) rows.push(Array.from({ length: W }, () => ({ ch: " ", c: null })))
  }
  const put = (y: number, xp: number, ch: string, c: string | null = null): void => {
    if (xp < 0 || xp >= W) return
    ensure(y)
    rows[y]![xp] = { ch, c }
  }
  const text = (y: number, xp: number, s: string, c: string | null): void =>
    [...s].forEach((ch, i) => put(y, xp + i, ch, c))

  const bd = THEME.dim
  const lbl = THEME.dim
  const arr = "#9aa5b5"
  const box = "#cbd5e1"
  // participant boxes (rows 0-2)
  participants.forEach((name, i) => {
    const c = cx[i]!
    const w = boxW[i]!
    const left = c - Math.floor(w / 2)
    put(0, left, "┌", bd)
    put(0, left + w - 1, "┐", bd)
    for (let k = left + 1; k < left + w - 1; k++) put(0, k, "─", bd)
    put(1, left, "│", bd)
    put(1, left + w - 1, "│", bd)
    text(1, left + 1, name, box)
    put(2, left, "└", bd)
    put(2, left + w - 1, "┘", bd)
    for (let k = left + 1; k < left + w - 1; k++) put(2, k, k === c ? "┬" : "─", bd)
  })

  let y = 3
  const lifelineTo = (yEnd: number): void => {
    for (let yy = 3; yy < yEnd; yy++)
      for (const c of cx) if (rows[yy]?.[c]?.ch === " " || rows[yy]?.[c] === undefined) put(yy, c, "│", "#3f4a5c")
  }
  for (const e of events) {
    ensure(y)
    if (e.kind === "msg") {
      const a = cx[e.from]! // e.from/e.to are valid participant indices by construction
      const b = cx[e.to]!
      if (e.from === e.to) {
        // self-message: a small loop to the right
        put(y, a + 1, "─", arr)
        put(y, a + 2, "╮", arr)
        text(y, a + 4, e.label, lbl)
        y++
        ensure(y)
        put(y, a, "◀", arr)
        put(y, a + 1, "─", arr)
        put(y, a + 2, "╯", arr)
      } else {
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        const mid = e.dashed ? "┄" : "─"
        for (let k = lo + 1; k < hi; k++) put(y, k, mid, arr)
        put(y, b, b > a ? "▶" : "◀", arr)
        const m = Math.max(lo + 1, Math.floor((lo + hi) / 2 - e.label.length / 2))
        text(y, m, e.label, lbl)
      }
      y++
    } else if (e.kind === "note") {
      const a = cx[e.from]!
      text(y, a, `▏ ${e.label}`, THEME.redHi)
      y++
    } else if (e.kind === "block") {
      text(y, cx[0]! - 1, `╭ ${e.label}`, THEME.dim)
      y++
    } else {
      text(y, cx[0]! - 1, "╰ end", THEME.dim)
      y++
    }
  }
  lifelineTo(y)

  return rows
    .map((row) => {
      let line = ""
      let trail = ""
      for (const cell of row) {
        if (cell.ch === " ") {
          trail += " "
          continue
        }
        line += trail
        trail = ""
        line += opts.color && cell.c ? paint(cell.ch, { fg: cell.c }) : cell.ch
      }
      return line
    })
    .join("\n")
    .replace(/\n+$/, "")
}

/** Visible width of the widest rendered row (for box framing). */
export function diagramWidth(rendered: string): number {
  return Math.max(0, ...rendered.split("\n").map((l) => stripAnsi(l).length))
}
