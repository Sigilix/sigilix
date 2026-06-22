// SIG-304 (review CLI) Phase 1b — the `rich` truecolor review panel: a PR-style
// terminal render. Header → OVERVIEW (confidence + summary + file table + the real
// mermaid SEQUENCE DIAGRAM from the overview pass + a proof tally) → CRITICAL
// ISSUES (findings with severity / category / trust pills + a red/green diff for
// suggested fixes) → LEGEND. RED theme (founder-approved). Reuses the canonical
// finding-view + the PR1 palette; the only presentation-specific bits are the
// pill chrome here. On a non-TTY / NO_COLOR run the caller passes color:false and
// we delegate to renderPlain so piped output stays clean + ANSI-free.

import { paint, stripAnsi, clipAnsi } from "@/src/cli/ansi/ansi"
import { SEVERITY_HEX, CATEGORY_HEX, CATEGORY_FALLBACK, THEME } from "@/src/cli/ansi/palette"
import { type FindingView, viewsFor } from "./finding-view"
import { renderSequenceDiagram, diagramWidth } from "./sequence-diagram"
import { renderPlain } from "./plain"
import { exitCodeForFindings } from "@/src/cli/app/exit-code"
import type { DryRunReview } from "@/src/lib/ensemble/app/session"
import type { PrOverviewVerdict } from "@/src/lib/triage-pr-overview"

export interface RichOptions {
  color: boolean
  /** terminal width for wrapping/box sizing (default 76). */
  width?: number
  /** e.g. "acme/app#128" — shown in the header bar. */
  subject?: string
}

type Trust = FindingView["trust"]

// Trust-pill chrome (dark bg + bright tier text → quieter than the solid severity
// pills, so the severity hierarchy reads first). Text colors mirror TRUST_HEX hues.
const TRUST_PILL: Record<Trust, { bg: string; fg: string }> = {
  VERIFIED: { bg: "#0E4F5C", fg: "#67E8F9" },
  REPRODUCED: { bg: "#1E3A8A", fg: "#93C5FD" },
  GROUNDED: { bg: "#14533B", fg: "#86EFAC" },
  MODEL: { bg: "#3B2F5E", fg: "#C4B5FD" },
}
const SEV_TEXT = "#0A0A0A" // near-black on the bright severity fill (matches the badge spec)

const pill = (txt: string, bg: string, fg: string, bold = false): string => paint(` ${txt} `, { bg, fg, bold })
const sevPill = (s: FindingView["severity"]): string => pill(s, SEVERITY_HEX[s], SEV_TEXT, true)
const catPill = (c: string): string => {
  const k = CATEGORY_HEX[c] ?? CATEGORY_FALLBACK
  return pill(c, k.bg, k.fg)
}
const trustPill = (t: Trust): string => pill(t, TRUST_PILL[t].bg, TRUST_PILL[t].fg)

const BORDER = "#5b2530"
const head = (t: string): string => "\n  " + paint(t, { fg: THEME.red, bold: true }) + "\n"
const dim = (t: string): string => paint(t, { fg: THEME.dim })

function box(contentLines: string[], w: number): string {
  const bd = (s: string): string => paint(s, { fg: BORDER })
  let o = "  " + bd("┌" + "─".repeat(w + 2) + "┐") + "\n"
  for (const raw of contentLines) {
    const ln = clipAnsi(raw, w) // never let a long line (e.g. a wide diagram row) overflow the frame
    const pad = Math.max(0, w - stripAnsi(ln).length)
    o += "  " + bd("│") + " " + ln + " ".repeat(pad) + " " + bd("│") + "\n"
  }
  return o + "  " + bd("└" + "─".repeat(w + 2) + "┘") + "\n"
}

// wrap plain text to width (no ANSI inside — callers paint after).
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
  return lines
}

const verdictWord = (all: FindingView[]): { word: string; color: string } => {
  if (all.some((v) => v.severity === "P0" || v.severity === "P1"))
    return { word: "CHANGES REQUESTED", color: THEME.red }
  if (all.length > 0) return { word: "ADVISORY", color: "#f59e0b" }
  return { word: "LOOKS GOOD", color: THEME.diffPlus }
}

const byScoreThenLoc = (a: FindingView, b: FindingView): number =>
  b.score - a.score || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0)

function findingBlock(v: FindingView): string {
  let o = ""
  // red/green diff for a concrete suggested fix (the approved diff-bar motif, made real).
  if (typeof v.suggestedReplacement === "string" && v.suggestedReplacement.length > 0) {
    o += "  " + paint(" − ", { bg: THEME.diffMinus, fg: SEV_TEXT, bold: true }) + " " + dim("(current)") + "\n"
    for (const ln of v.suggestedReplacement.split("\n").slice(0, 4))
      o +=
        "  " +
        paint(" + ", { bg: THEME.diffPlus, fg: SEV_TEXT, bold: true }) +
        " " +
        paint(ln, { fg: THEME.diffPlus }) +
        "\n"
  }
  const loc = v.anchorSide === "LEFT" ? `${v.path}:${v.line} (del)` : `${v.path}:${v.line}`
  o +=
    "  " +
    sevPill(v.severity) +
    " " +
    catPill(v.category) +
    " " +
    trustPill(v.trust) +
    "  " +
    paint(v.headline, { fg: THEME.white, bold: true }) +
    "\n"
  o += "       " + dim(loc) + "\n"
  return o
}

/**
 * Render the rich review panel. `overview` is the dry-run PR-overview verdict
 * (summary + file table + mermaidDiagram); pass null to render review-only.
 */
export function renderRich(review: DryRunReview, overview: PrOverviewVerdict | null, opts: RichOptions): string {
  if (!opts.color) return renderPlain(review)
  // Floor the width so a narrow / transiently-0 terminal never drives "─".repeat() negative.
  const w = Math.max(20, (opts.width ?? 88) - 4)
  const { inline, body } = viewsFor(review.verdict.findings, review.unanchoredFindings)
  const all = [...inline, ...body].sort(byScoreThenLoc)

  const subject = opts.subject ? `  ·  ${opts.subject}` : ""
  const vw = verdictWord(all)
  let o = "  " + paint("┌" + "─".repeat(w + 2) + "┐", { fg: BORDER }) + "\n"
  o +=
    "  " +
    paint("│", { fg: BORDER }) +
    " " +
    paint("⬢", { fg: THEME.red }) +
    " " +
    paint("sigilix review", { fg: THEME.white, bold: true }) +
    dim(subject + "  ·  ") +
    paint(vw.word, { fg: vw.color, bold: true })
  const headerLen = stripAnsi(` ⬢ sigilix review${subject}  ·  ${vw.word}`).length
  o += " ".repeat(Math.max(0, w - headerLen)) + " " + paint("│", { fg: BORDER }) + "\n"
  o += "  " + paint("└" + "─".repeat(w + 2) + "┘", { fg: BORDER }) + "\n"

  // OVERVIEW
  const confidence = overview?.confidence ?? review.verdict.confidence
  const summary = (overview?.summary ?? review.verdict.summary ?? "").trim()
  o += head("OVERVIEW")
  const ovLines: string[] = []
  const summaryWrapped = wrap(summary || "No summary.", w - 6)
  ovLines.push(
    paint(`${confidence}/5`, { fg: THEME.redHi, bold: true }) +
      "  " +
      paint(summaryWrapped[0] ?? "", { fg: THEME.text }),
  )
  for (const ln of summaryWrapped.slice(1)) ovLines.push(paint(ln, { fg: THEME.text }))
  // RECALL-SAFETY: a partial review (a specialist was unavailable) is flagged loudly so
  // a clean-looking panel is never mistaken for a full sign-off.
  if (review.incomplete) {
    ovLines.push("")
    for (const ln of wrap(
      `⚠ Partial review — ${review.incomplete.rolesMissing.join(", ")} specialist(s) unavailable; NOT a full sign-off.`,
      w - 6,
    )) {
      ovLines.push(paint(ln, { fg: SEVERITY_HEX.P1, bold: true }))
    }
  }
  // file table (from the overview pass)
  if (overview?.files?.length) {
    ovLines.push("")
    for (const f of overview.files.slice(0, 6)) {
      const sev = f.score >= 5 ? "P0" : f.score >= 4 ? "P1" : f.score >= 3 ? "P2" : "P3"
      ovLines.push(
        paint(sev, { fg: SEVERITY_HEX[sev], bold: true }) +
          " " +
          paint(f.path, { fg: THEME.text }) +
          dim(` — ${f.overview}`.slice(0, Math.max(0, w - f.path.length - 8))),
      )
    }
  }
  // proof tally
  const tally = (t: Trust): number => all.filter((v) => v.trust === t).length
  ovLines.push("")
  ovLines.push(
    paint(`✓ ${all.length} finding${all.length === 1 ? "" : "s"}`, { fg: THEME.diffPlus }) +
      dim("  ·  ") +
      [
        trustPill("VERIFIED") + " " + tally("VERIFIED"),
        trustPill("REPRODUCED") + " " + tally("REPRODUCED"),
        trustPill("GROUNDED") + " " + tally("GROUNDED"),
        trustPill("MODEL") + " " + tally("MODEL"),
      ].join("  "),
  )
  o += box(ovLines, w)

  // SEQUENCE DIAGRAM (real mermaid → ASCII)
  if (overview?.mermaidDiagram) {
    const diagram = renderSequenceDiagram(overview.mermaidDiagram, { color: opts.color })
    if (diagram) {
      o += head("SEQUENCE DIAGRAM")
      const dw = Math.max(diagramWidth(diagram), 1)
      o += box(diagram.split("\n"), Math.min(Math.max(dw, w), 200))
    }
  }

  // CRITICAL ISSUES
  if (all.length > 0) {
    o += head(all.some((v) => v.severity === "P0" || v.severity === "P1") ? "CRITICAL ISSUES CAUGHT" : "FINDINGS")
    o += all.map((v) => findingBlock(v)).join("\n")
  } else {
    o += head("FINDINGS") + "  " + paint("No findings.", { fg: THEME.diffPlus }) + "\n"
  }

  // LEGEND
  o += head("LEGEND")
  o +=
    "  " +
    ["P0", "P1", "P2", "P3"].map((s) => sevPill(s as FindingView["severity"])).join(" ") +
    dim("   severity") +
    "\n"
  o += "  " + ["security", "logic", "error-handling", "performance"].map(catPill).join(" ") + dim("   category") + "\n"
  o +=
    "  " +
    (["VERIFIED", "REPRODUCED", "GROUNDED", "MODEL"] as Trust[]).map(trustPill).join(" ") +
    dim("   proof — most → least") +
    "\n"

  // Pass `incomplete` so the displayed code matches the REAL process exit code — a
  // degraded zero-finding review must not print "exit 0" under its own partial banner.
  const code = exitCodeForFindings(all, review.incomplete != null)
  o +=
    "\n  " +
    paint(`exit ${code}`, { fg: code === 0 ? THEME.diffPlus : THEME.redHi, bold: true }) +
    dim(`  (${vw.word.toLowerCase()})`) +
    "\n"
  return o
}
