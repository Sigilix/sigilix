#!/usr/bin/env -S npx tsx
// SIG-45 — operator CLI for the pure-vector vs hybrid retrieval A/B decision.
//
// Reads two JSONL inputs and prints/writes the precision/recall/F1 comparison
// + the ship decision (hybrid becomes default only on a >10% relative F1 lift).
// Pure + offline; the logic lives in the unit-tested core
// (src/lib/retrieval-ab/eval.ts).
//
// Inputs:
//   --findings <path>  JSONL, one finding per line, each tagged with its arm:
//                      {"pr":"123","arm":"vector"|"hybrid","file":"src/a.ts","line":42,"category":"security"}
//   --truth <path>     JSONL, one hand-graded real finding per line:
//                      {"pr":"123","file":"src/a.ts","line":42,"category":"security"}
//
// Usage:
//   npm run retrieval-ab-report -- --findings=runs/findings.jsonl --truth=runs/truth.jsonl
//   [--format=csv|md|both] [--out=dir] [--line-tolerance=3] [--min-prs=30]
//
// Collecting the arms (the measurement step): run the same ~30 sigilix-repo PRs
// through review twice — once with OPENCLAW_RETRIEVAL_HYBRID unset (arm
// "vector"), once with it "on" (arm "hybrid") — and record each posted finding
// as a line in findings.jsonl. Hand-label the genuinely-real findings per PR
// into truth.jsonl. Then run this report.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import {
  computeAbReport,
  formatAbCsv,
  formatAbMarkdown,
  parseArmFindingsJsonl,
  parseGroundTruthJsonl,
} from "@/src/lib/retrieval-ab/eval"

const VALID_FORMATS: ReadonlySet<string> = new Set(["csv", "md", "both"])
const ALLOWED_ARGS: ReadonlySet<string> = new Set(["findings", "truth", "format", "out", "line-tolerance", "min-prs"])

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

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

function intArg(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) die(`--${name} must be a non-negative integer`)
  return n
}

const args = parseArgs(process.argv.slice(2))
if (!args.findings) die("--findings=<path> is required (arm-tagged findings JSONL)")
if (!args.truth) die("--truth=<path> is required (ground-truth JSONL)")
const format = (args.format ?? "both").toLowerCase()
if (!VALID_FORMATS.has(format)) die("--format must be one of: csv | md | both")

const findings = parseArmFindingsJsonl(readFileSync(args.findings, "utf8"))
const truth = parseGroundTruthJsonl(readFileSync(args.truth, "utf8"))
if (findings.dropped > 0) console.error(`warning: dropped ${findings.dropped} unparseable findings line(s)`)
if (truth.dropped > 0) console.error(`warning: dropped ${truth.dropped} unparseable truth line(s)`)

const opts: { lineTolerance?: number; minPrs?: number } = {}
const lt = intArg(args["line-tolerance"], "line-tolerance")
if (lt !== undefined) opts.lineTolerance = lt
const mp = intArg(args["min-prs"], "min-prs")
if (mp !== undefined) opts.minPrs = mp

const report = computeAbReport(findings.rows, truth.rows, opts)
const md = formatAbMarkdown(report)
const csv = formatAbCsv(report)

if (args.out) {
  const stamp = report.prCount
  try {
    mkdirSync(args.out, { recursive: true })
  } catch (err) {
    die(`could not create --out directory "${args.out}": ${err instanceof Error ? err.message : String(err)}`)
  }
  if (format === "md" || format === "both") writeFileSync(`${args.out}/retrieval-ab-${stamp}prs.md`, md)
  if (format === "csv" || format === "both") writeFileSync(`${args.out}/retrieval-ab-${stamp}prs.csv`, csv)
  console.error(`wrote report to ${args.out}/`)
} else {
  if (format === "md" || format === "both") console.log(md)
  if (format === "both") console.log("")
  if (format === "csv" || format === "both") console.log(csv)
}

// Non-zero exit when the data is too thin to decide, so CI/automation can gate.
process.exit(report.decision.underpowered ? 2 : 0)
