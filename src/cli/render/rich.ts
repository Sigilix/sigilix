// SIG-304 (review CLI) Phase 1b — the `rich` truecolor review panel. One outer frame
// (single width W) with titled dividers (├─ TITLE ─┤) and per-finding cards inset
// inside it, so the left edge is ONE continuous line (no floating labels / mismatched
// widths — the alignment fix). Each finding card carries Greptile-depth: a header line
// (Comment N · severity/category/trust pills · line range), the file anchor, a
// line-numbered + diff-colored + syntax-highlighted CODE PANEL sliced from the diff the
// engine already had (finding.codeContext), the full body, and a suggestion diff.
//
// Alignment invariant: EVERY rendered row is exactly W visible columns. Width is always
// measured via stripAnsi (never raw ANSI). On a non-TTY / NO_COLOR run the caller passes
// color:false and we delegate to renderPlain so piped output stays ANSI-free.

import { paint, stripAnsi, clipAnsi } from "@/src/cli/ansi/ansi"
import { SEVERITY_HEX, CATEGORY_HEX, CATEGORY_FALLBACK, THEME } from "@/src/cli/ansi/palette"
import { type FindingView, viewsFor } from "./finding-view"
import { renderSequenceDiagram } from "./sequence-diagram"
import { renderPlain } from "./plain"
import { tokenize, langForPath } from "./syntax"
import { exitCodeForFindings } from "@/src/cli/app/exit-code"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import type { CodeContext } from "@/src/shared/domain/pr-review-finding"
import type { PrOverviewVerdict } from "@/src/lib/triage-pr-overview"

export interface RichOptions {
  color: boolean
  /** terminal width for the frame (clamped to [64,120]). */
  width?: number
  /** e.g. "acme/app#128" — shown in the header title. */
  subject?: string
}

type Trust = FindingView["trust"]

// ── colors ───────────────────────────────────────────────────────────────────
const OUTER = "#9c4555" // outer frame border
const CARDB = "#b5697a" // per-finding card border (lighter → reads as nested)
const ACCENT = "#f0b3b3" // divider titles
const TITLE = "#f2f2f2"
const CODE_FG = "#c9d1d9"
const GUT = "#6e7681" // gutter line numbers
const SEP = "#30363d" // gutter separator
const ADD_BG = "#10271b"
const DEL_BG = "#2a1414"
const CTX_BG = "#0d1117"
const ADD_MK = "#7ee787"
const DEL_MK = "#ff7b72"
const SEV_TEXT = "#0a0a0a"
const TRUST_PILL: Record<Trust, { bg: string; fg: string }> = {
  VERIFIED: { bg: "#0E4F5C", fg: "#67E8F9" },
  REPRODUCED: { bg: "#1E3A8A", fg: "#93C5FD" },
  GROUNDED: { bg: "#14533B", fg: "#86EFAC" },
  MODEL: { bg: "#3B2F5E", fg: "#C4B5FD" },
}

// ── primitives ─────────────────────────────────────────────────────────────────
const dim = (t: string): string => paint(t, { fg: THEME.dim })
const vis = (s: string): number => stripAnsi(s).length
const pillOf = (txt: string, bg: string, fg: string, bold = false): string => paint(` ${txt} `, { bg, fg, bold })
const sevPill = (s: FindingView["severity"]): string => pillOf(s, SEVERITY_HEX[s], SEV_TEXT, true)
const catPill = (c: string): string => {
  const k = CATEGORY_HEX[c] ?? CATEGORY_FALLBACK
  return pillOf(c, k.bg, k.fg)
}
const trustPill = (t: Trust): string => pillOf(t, TRUST_PILL[t].bg, TRUST_PILL[t].fg)

function wrap(s: string, w: number): string[] {
  const words = s.split(/\s+/)
  const lines: string[] = []
  let cur = ""
  for (const word of words) {
    if (cur === "") cur = word
    else if ((cur + " " + word).length <= w) cur += " " + word
    else {
      lines.push(cur)
      cur = word
    }
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : [""]
}

const verdictWord = (all: FindingView[]): { word: string; color: string } => {
  if (all.some((v) => v.severity === "P0" || v.severity === "P1"))
    return { word: "CHANGES REQUESTED", color: THEME.red }
  if (all.length > 0) return { word: "ADVISORY", color: "#f59e0b" }
  return { word: "LOOKS GOOD", color: THEME.diffPlus }
}

const byScoreThenLoc = (a: FindingView, b: FindingView): number =>
  b.score - a.score || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0)

export function renderRich(review: DryRunReview, overview: PrOverviewVerdict | null, opts: RichOptions): string {
  if (!opts.color) return renderPlain(review)
  const W = Math.min(120, Math.max(64, opts.width ?? 100))
  const IW = W - 4 // outer inner content width: "│ " + IW + " │"
  const INSET = 3
  const CW = IW - INSET // card outer width
  const CIW = CW - 4 // card inner content width: "│ " + CIW + " │"
  const ob = (s: string): string => paint(s, { fg: OUTER })
  const cb = (s: string): string => paint(s, { fg: CARDB })
  const padTo = (html: string, w: number): string => html + " ".repeat(Math.max(0, w - vis(html)))

  // outer-frame row builders — each returns exactly W visible cols.
  const out: string[] = []
  const row = (inner: string): void => {
    out.push(ob("│") + " " + padTo(inner, IW) + " " + ob("│"))
  }
  const blank = (): void => row("")
  const top = (titleHtml: string): void => {
    out.push(ob("┌─ ") + titleHtml + " " + ob("─".repeat(Math.max(0, W - 5 - vis(titleHtml))) + "┐"))
  }
  const divider = (title: string): void => {
    out.push(
      ob("├─ ") +
        paint(title, { fg: ACCENT, bold: true }) +
        " " +
        ob("─".repeat(Math.max(0, W - 5 - title.length)) + "┤"),
    )
  }
  const bottom = (): void => {
    out.push(ob("└" + "─".repeat(W - 2) + "┘"))
  }
  // card row builders — wrapped in the outer frame (inset INSET cols).
  const cardTop = (titleHtml: string): void =>
    row("   " + cb("╭─ ") + titleHtml + " " + cb("─".repeat(Math.max(0, CW - 5 - vis(titleHtml))) + "╮"))
  const cardRow = (content: string): void => row("   " + cb("│") + " " + padTo(content, CIW) + " " + cb("│"))
  const cardBottom = (): void => row("   " + cb("╰" + "─".repeat(CW - 2) + "╯"))

  const { inline, body } = viewsFor(review.verdict.findings, review.unanchoredFindings)
  const all = [...inline, ...body].sort(byScoreThenLoc)
  const vw = verdictWord(all)

  // ── HEADER (title embedded in the top border) ──
  const subj = opts.subject ? dim("  ·  " + opts.subject) : ""
  top(
    paint("❖", { fg: THEME.red }) + // the Sigilix sigil — same mark as the splash stamp
      " " +
      paint("sigilix review", { fg: TITLE, bold: true }) +
      subj +
      dim("  ·  ") +
      paint(vw.word, { fg: vw.color, bold: true }),
  )
  blank()

  // ── OVERVIEW ──
  divider("OVERVIEW")
  const confidence = overview?.confidence ?? review.verdict.confidence
  const summary = (overview?.summary ?? review.verdict.summary ?? "").trim() || "No summary."
  const sw = wrap(summary, IW - 6)
  // clipAnsi every wrapped line: wrap() can't break a single over-long token (a URL /
  // path / blob), so without the clip such a line would overflow the frame border.
  row(
    paint(`${confidence}/5`, { fg: THEME.redHi, bold: true }) +
      "  " +
      clipAnsi(paint(sw[0] ?? "", { fg: THEME.text }), IW - 6),
  )
  for (const ln of sw.slice(1)) row(clipAnsi(paint(ln, { fg: THEME.text }), IW))
  if (review.incomplete) {
    blank()
    for (const ln of wrap(
      `⚠ Partial review — ${review.incomplete.rolesMissing.join(", ")} specialist(s) unavailable; NOT a full sign-off.`,
      IW - 2,
    ))
      row(paint(ln, { fg: SEVERITY_HEX.P1, bold: true }))
  }
  if (overview?.files?.length) {
    blank()
    for (const f of overview.files.slice(0, 6)) {
      const sev = f.score >= 5 ? "P0" : f.score >= 4 ? "P1" : f.score >= 3 ? "P2" : "P3"
      row(
        paint(sev, { fg: SEVERITY_HEX[sev], bold: true }) +
          " " +
          clipAnsi(paint(f.path, { fg: THEME.text }) + dim(` — ${f.overview}`), IW - 4),
      )
    }
  }
  blank()
  const tally = (t: Trust): number => all.filter((v) => v.trust === t).length
  row(
    paint(`✓ ${all.length} finding${all.length === 1 ? "" : "s"}`, { fg: THEME.diffPlus }) +
      dim("   ") +
      (["VERIFIED", "REPRODUCED", "GROUNDED", "MODEL"] as Trust[]).map((t) => trustPill(t) + " " + tally(t)).join("  "),
  )
  blank()

  // ── ARCHITECTURE (sequence diagram, clipped to the frame) ──
  if (overview?.mermaidDiagram) {
    const diagram = renderSequenceDiagram(overview.mermaidDiagram, { color: opts.color })
    if (diagram) {
      divider("ARCHITECTURE")
      for (const ln of diagram.split("\n")) row(clipAnsi(ln, IW))
      blank()
    }
  }

  // ── FINDINGS (per-finding cards) ──
  divider(`FINDINGS (${all.length})`)
  blank()
  if (all.length === 0) {
    row(paint("  ✓ No findings.", { fg: THEME.diffPlus }))
    blank()
  }
  all.forEach((v, i) => {
    const range = v.startLine !== undefined && v.startLine !== v.line ? `L${v.startLine}-L${v.line}` : `L${v.line}`
    cardTop(
      dim(`Comment ${i + 1} `) +
        dim("· ") +
        sevPill(v.severity) +
        " " +
        catPill(v.category) +
        " " +
        trustPill(v.trust) +
        dim("  " + range),
    )
    cardRow(
      clipAnsi(
        paint("↳ " + v.path, { fg: THEME.diffPlus }) + dim(v.anchorSide === "LEFT" ? "  (deleted)" : "  (added)"),
        CIW,
      ),
    )
    cardRow("")
    renderCodePanel(v.codeContext, v.path).forEach(cardRow)
    cardRow("")
    cardRow(clipAnsi(paint(v.headline, { fg: TITLE, bold: true }), CIW))
    for (const ln of wrap(v.body.trim(), CIW)) cardRow(clipAnsi(paint(ln, { fg: THEME.text }), CIW))
    renderSuggestion(v).forEach(cardRow)
    cardBottom()
    blank()
  })

  // ── LEGEND + footer ──
  divider("LEGEND")
  row(
    ["P0", "P1", "P2", "P3"].map((s) => sevPill(s as FindingView["severity"])).join(" ") +
      dim("  severity   ") +
      (["VERIFIED", "REPRODUCED", "GROUNDED", "MODEL"] as Trust[]).map(trustPill).join(" ") +
      dim("  proof"),
  )
  blank()
  const code = exitCodeForFindings(all, review.incomplete != null)
  row(
    dim(`exit `) +
      paint(String(code), { fg: code === 0 ? THEME.diffPlus : THEME.redHi, bold: true }) +
      dim(`  (${vw.word.toLowerCase()})`),
  )
  bottom()
  return out.join("\n") + "\n"

  // ── code panel: line-numbered, diff-tinted, syntax-highlighted; CIW wide ──
  function renderCodePanel(ctx: CodeContext | undefined, path: string): string[] {
    if (!ctx || ctx.lines.length === 0) return [dim("  (no source context)")]
    const lang = langForPath(path)
    const maxN = Math.max(1, ...ctx.lines.map((l) => l.newNumber ?? l.oldNumber ?? 0))
    const g = String(maxN).length
    const textBudget = Math.max(8, CIW - (g + 5)) // gutter + " │ " + marker + " "
    return ctx.lines.map((l) => {
      const lineBg = l.kind === "add" ? ADD_BG : l.kind === "del" ? DEL_BG : CTX_BG
      const n = l.kind === "del" ? l.oldNumber : l.newNumber
      const gut = paint((n !== undefined ? String(n) : "").padStart(g), { fg: GUT, bg: lineBg })
      const sep = paint(" │ ", { fg: SEP, bg: lineBg })
      const mk =
        l.kind === "add"
          ? paint("+", { fg: ADD_MK, bg: lineBg })
          : l.kind === "del"
            ? paint("-", { fg: DEL_MK, bg: lineBg })
            : paint(" ", { bg: lineBg })
      const text = l.text.length > textBudget ? l.text.slice(0, textBudget - 1) + "…" : l.text
      const painted = tokenize(text, lang)
        .map((t) => paint(t.text, { fg: t.color ?? CODE_FG, bg: lineBg }))
        .join("")
      const lineHtml = gut + sep + mk + paint(" ", { bg: lineBg }) + painted
      const fillN = Math.max(0, CIW - vis(lineHtml))
      return lineHtml + paint(" ".repeat(fillN), { bg: lineBg })
    })
  }

  // ── suggestion diff (− current / + new), shown when a fix is present ──
  function renderSuggestion(v: FindingView): string[] {
    const repl = v.suggestedReplacement
    if (typeof repl !== "string" || repl.length === 0) return []
    const lang = langForPath(v.path)
    const rows: string[] = ["", dim("Suggestion")]
    for (const raw of repl.split("\n").slice(0, 6)) {
      const text = raw.length > CIW - 2 ? raw.slice(0, CIW - 3) + "…" : raw
      const painted = tokenize(text, lang)
        .map((t) => paint(t.text, { fg: t.color ?? CODE_FG, bg: ADD_BG }))
        .join("")
      const lineHtml = paint("+ ", { fg: ADD_MK, bg: ADD_BG }) + painted
      rows.push(lineHtml + paint(" ".repeat(Math.max(0, CIW - vis(lineHtml))), { bg: ADD_BG }))
    }
    return rows
  }
}
