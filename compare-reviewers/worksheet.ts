// SIG-70 — labeling worksheet: build it, parse it back.
//
// The worksheet is the markdown surface the reviewer fills in. `collect`
// writes it; the reviewer groups each real-world issue into one row of the
// `## Labels` table (pairing a Sigilix + a CodeRabbit finding into one
// `both_*` row when both bots caught the same thing); `label` parses it back
// into validated `LabeledItem[]`. Pure — no IO.

import {
  CATEGORIES,
  CR_LABELS,
  isCategory,
  isLabel,
  LABELS,
  SIGILIX_LABELS,
  type ComparisonFile,
  type LabeledItem,
  type NormalizedFinding,
} from "./types"

const LABELS_HEADING = "## Labels"

/** Render one finding as a worksheet bullet the reviewer reads. */
function findingLine(f: NormalizedFinding): string {
  const loc = f.path ? `${f.path}${f.line == null ? "" : `:${f.line}`}` : "(file-level)"
  const cat = f.botCategory ? ` _[${f.botCategory}]_` : ""
  return `- \`${f.ref}\` ${loc}${cat} — ${f.excerpt}`
}

function findingSection(title: string, findings: NormalizedFinding[]): string {
  if (findings.length === 0) return `### ${title}\n\n_(none)_\n`
  return `### ${title}\n\n${findings.map(findingLine).join("\n")}\n`
}

/**
 * Build the full labeling worksheet for a freshly-collected comparison file.
 * The reviewer edits only the `## Labels` table; everything above it is a
 * read-only reference listing of what each bot flagged.
 */
export function buildWorksheet(file: ComparisonFile): string {
  const { owner, repo, pr, prUrl, findings } = file
  const lines: string[] = []
  lines.push(`# Reviewer worksheet — ${owner}/${repo}#${pr}`)
  lines.push("")
  lines.push(prUrl)
  lines.push("")
  lines.push(
    `Sigilix flagged **${findings.sigilix.length}**; CodeRabbit flagged ` +
      `**${findings.coderabbit.length}**.`,
  )
  lines.push("")
  lines.push(
    "Label each *real-world issue* once in the table at the bottom. If both " +
      "bots flagged the same issue, put both refs in one row and use a " +
      "`both_*` label. Leave a finding out of the table only if it is a pure " +
      "duplicate of a row you already wrote.",
  )
  lines.push("")
  lines.push(findingSection("Sigilix findings", findings.sigilix))
  lines.push(findingSection("CodeRabbit findings", findings.coderabbit))
  lines.push(LABELS_HEADING)
  lines.push("")
  lines.push(`<!-- label    ∈ ${LABELS.join(" | ")} -->`)
  lines.push(`<!-- category ∈ ${CATEGORIES.join(" | ")} -->`)
  lines.push("<!-- findings: comma-separated refs, e.g. s1,c3 -->")
  lines.push("")
  lines.push("| findings | label | category | note |")
  lines.push("|----------|-------|----------|------|")
  lines.push("| | | | |")
  lines.push("")
  return lines.join("\n")
}

export interface ParseResult {
  items: LabeledItem[]
  /** Blocking problems — when non-empty the CLI must not persist `items`. */
  errors: string[]
  /** Informational (e.g. findings left unlabeled); never blocks the write. */
  notes: string[]
}

/** Split a markdown table row into trimmed cells (drops the outer pipes). */
function splitRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((c) => c.trim())
}

function isSeparatorRow(cells: string[]): boolean {
  const isDash = (c: string): boolean => /^:?-{2,}:?$/.test(c)
  // A real separator has at least one dash cell; an all-empty row is the
  // placeholder, handled separately (so we don't skip a partly-filled row).
  return cells.some(isDash) && cells.every((c) => isDash(c) || c === "")
}

/**
 * Parse the `## Labels` table from a filled worksheet into validated items.
 * Returns every error found (never throws) so the CLI can print them all and
 * leave the persisted JSON untouched when anything is wrong — a half-applied
 * label set is worse than none.
 */
export function parseWorksheet(md: string, file: ComparisonFile): ParseResult {
  const errors: string[] = []
  const notes: string[] = []
  const items: LabeledItem[] = []

  const headingIdx = md.indexOf(LABELS_HEADING)
  if (headingIdx === -1) {
    return { items, errors: [`worksheet has no "${LABELS_HEADING}" section`], notes }
  }

  // ref -> which bot owns it, taken from the finding set (not inferred from
  // the ref's first letter — robust if the ref scheme ever changes).
  const refBot = new Map<string, "sigilix" | "coderabbit">()
  for (const f of file.findings.sigilix) refBot.set(f.ref, "sigilix")
  for (const f of file.findings.coderabbit) refBot.set(f.ref, "coderabbit")
  const knownRefs = new Set<string>(refBot.keys())
  const usedRefs = new Map<string, number>() // ref -> first row that used it

  const section = md.slice(headingIdx + LABELS_HEADING.length)
  const rows = section.split("\n")
  let sawHeaderRow = false
  let rowNum = 0

  for (const raw of rows) {
    const line = raw.trim()
    if (!line.startsWith("|")) continue // skips prose, comments, blank lines
    const cells = splitRow(line)
    // Skip the markdown header row + its `---` separator.
    if (!sawHeaderRow) {
      sawHeaderRow = true
      continue
    }
    if (isSeparatorRow(cells)) continue
    // A wholly-empty placeholder row (the `| | | | |` template line) is skipped.
    if (cells.every((c) => c === "")) continue

    rowNum += 1
    const where = `Labels row ${rowNum}`
    if (cells.length < 3) {
      errors.push(`${where}: expected at least 3 columns (findings | label | category), got ${cells.length}`)
      continue
    }
    const [findingsCell, labelCell, categoryCell] = cells
    // Take the note from the RAW (untrimmed) split past the 3rd cell, so a note
    // containing a literal `|` (e.g. "use a || b") keeps both its text and its
    // internal spacing instead of being truncated at the first pipe.
    const note = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .slice(3)
      .join("|")
      .trim()

    const refs = (findingsCell ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0)
    if (refs.length === 0) {
      errors.push(`${where}: no finding refs`)
    }
    for (const ref of refs) {
      if (!knownRefs.has(ref)) {
        errors.push(`${where}: unknown finding ref "${ref}"`)
      } else {
        const prev = usedRefs.get(ref)
        if (prev !== undefined) {
          errors.push(`${where}: finding "${ref}" already labeled in row ${prev}`)
        } else {
          usedRefs.set(ref, rowNum)
        }
      }
    }

    const label = labelCell ?? ""
    if (!isLabel(label)) {
      errors.push(`${where}: invalid label "${label}" (expected one of ${LABELS.join(", ")})`)
    }
    const category = categoryCell ?? ""
    if (!isCategory(category)) {
      errors.push(`${where}: invalid category "${category}" (expected one of ${CATEGORIES.join(", ")})`)
    }

    // Cross-check label against which bots' refs are present — catches the
    // common mislabel (a `both_*` row with only one bot's finding, or a
    // `sigilix_only_*` row that lists a CodeRabbit ref).
    if (isLabel(label) && refs.every((r) => knownRefs.has(r))) {
      const hasS = refs.some((r) => refBot.get(r) === "sigilix")
      const hasC = refs.some((r) => refBot.get(r) === "coderabbit")
      const expectsS = (SIGILIX_LABELS as readonly string[]).includes(label)
      const expectsC = (CR_LABELS as readonly string[]).includes(label)
      const isBoth = expectsS && expectsC
      if (isBoth && !(hasS && hasC)) {
        errors.push(`${where}: label "${label}" needs both a Sigilix (s*) and a CodeRabbit (c*) ref`)
      }
      if (!isBoth && expectsS && hasC) {
        errors.push(`${where}: label "${label}" is Sigilix-only but lists a CodeRabbit (c*) ref`)
      }
      if (!isBoth && expectsC && hasS) {
        errors.push(`${where}: label "${label}" is CodeRabbit-only but lists a Sigilix (s*) ref`)
      }
    }

    if (isLabel(label) && isCategory(category)) {
      items.push({ id: rowNum, findings: refs, label, category, note })
    }
  }

  // Surface findings the reviewer never labeled — informational, not blocking
  // (they may be intentional duplicates), but worth reporting so nothing is
  // silently lost.
  const unlabeled = [...knownRefs].filter((r) => !usedRefs.has(r))
  if (unlabeled.length > 0) {
    notes.push(
      `${unlabeled.length} finding(s) left unlabeled (${unlabeled.join(", ")}); ` +
        "add them to the table or confirm they are duplicates",
    )
  }

  return { items, errors, notes }
}
