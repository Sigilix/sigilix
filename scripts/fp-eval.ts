// SIG-114 PR 2 — ground-truth FP-rate / precision over the labeled corpus.
//
// Reads the committed SIG-161 corpus (findings-source.jsonl) + labels CSV,
// joins by findingId, and prints precision / FP-rate overall + per-category
// with Wilson CIs. Fully offline + reproducible (no network) — the corpus is
// an immutable, committed snapshot. The logic lives in the pure, unit-tested
// core (src/lib/fp-rate/eval.ts).
//
// Usage:
//   npm run fp-eval                       # defaults to the committed SIG-161 corpus
//   npm run fp-eval -- --findings=path.jsonl --labels=path.csv [--format=both] [--out=path]

import { readFileSync, writeFileSync } from "node:fs"
import {
  computeEvalReport,
  formatEvalCsv,
  formatEvalMarkdown,
  joinFindingsToLabels,
  parseFindingsJsonl,
  parseLabelCsv,
} from "@/src/lib/fp-rate/eval"

const LABEL_DIR = ".claude/research/sig-161-labeling"
const DEFAULT_FINDINGS = `${LABEL_DIR}/findings-source.jsonl`
const DEFAULT_LABELS = `${LABEL_DIR}/labels-claude.csv`
const VALID_FORMATS: ReadonlySet<string> = new Set(["csv", "md", "both"])
const ALLOWED_ARGS: ReadonlySet<string> = new Set(["findings", "labels", "format", "out"])

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

/**
 * Parse `--key=value` args. Fails fast on a malformed shape, an unknown flag,
 * or an empty value (CodeRabbit) — silently dropping a typo'd `--findings`
 * would quietly fall back to the default corpus and produce wrong results.
 */
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/)
    if (!m) die(`unrecognized argument "${a}" (expected --key=value)`)
    const key = m[1]!
    const value = m[2]!
    if (!ALLOWED_ARGS.has(key)) {
      die(`unknown flag --${key} (allowed: ${[...ALLOWED_ARGS].map((k) => "--" + k).join(", ")})`)
    }
    if (value === "") die(`--${key} requires a non-empty value`)
    out[key] = value
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const findingsPath = args.findings ?? DEFAULT_FINDINGS
const labelsPath = args.labels ?? DEFAULT_LABELS
const format = (args.format ?? "both").toLowerCase()
if (!VALID_FORMATS.has(format)) die("--format must be one of: csv | md | both")

function main() {
  const findings = parseFindingsJsonl(readFileSync(findingsPath, "utf8"))
  const labels = parseLabelCsv(readFileSync(labelsPath, "utf8"))
  if (findings.rows.length === 0) die(`no findings parsed from ${findingsPath}`)
  if (labels.rows.length === 0) die(`no labels parsed from ${labelsPath}`)
  // Surface silently-unparseable rows so a corpus edit can't quietly shrink N.
  if (findings.dropped > 0) console.error(`warn: ${findings.dropped} unparseable line(s) in ${findingsPath} (skipped)`)
  if (labels.dropped > 0) console.error(`warn: ${labels.dropped} unparseable row(s) in ${labelsPath} (skipped)`)

  const join = joinFindingsToLabels(findings.rows, labels.rows)
  const report = computeEvalReport(join)

  const md = formatEvalMarkdown(report, {
    corpus: `${findingsPath} (${findings.rows.length} findings) × ${labelsPath} (${labels.rows.length} labels)`,
    generatedIso: new Date().toISOString(),
  })
  const csv = formatEvalCsv(report)

  if (args.out) {
    writeFileSync(`${args.out}.md`, md + "\n")
    writeFileSync(`${args.out}.csv`, csv + "\n")
    console.error(`wrote ${args.out}.md and ${args.out}.csv`)
  }
  if (format === "csv") console.log(csv)
  else if (format === "md") console.log(md)
  else console.log(md + "\n\n```csv\n" + csv + "\n```")
}

main()
