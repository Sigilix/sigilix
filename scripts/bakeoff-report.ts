#!/usr/bin/env -S npx tsx
// SIG-86 (ARC-283 B1c) — operator CLI for the shadow bake-off
// decision report.
//
// Usage:
//   npm run bakeoff-report -- \
//     --input <path-to-ndjson-or-dir> \
//     --since <ISO-date> \
//     --until <ISO-date> \
//     [--out <output-dir>] \
//     [--print-only]
//
// Reads Logpush NDJSON output (one event per line, the standard CF
// Logs export shape), filters to shadow-bake-off events in the
// requested window, runs the aggregator, and writes
// `<out>/bakeoff-report-<YYYY-MM-DD>.json` + `.md`.
//
// Defaults:
//   --since  → 30 days before --until
//   --until  → now (UTC)
//   --out    → docs/bakeoff-reports
//
// R2 integration is deferred — for now, the operator runs
// `wrangler r2 object get` (or equivalent) to materialize NDJSON files
// locally, then points `--input` at the directory. The full
// `wrangler r2` → DuckDB-over-the-network pipeline can land in a
// follow-up PR once we have ≥ 1 week of B1b data to validate against.

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises"
import { join, resolve, basename } from "node:path"

import {
  buildDecisionReport,
  renderDecisionReportMarkdown,
  type ShadowEvent,
} from "@/src/lib/bakeoff-report"
import { unwrapLogpushEnvelope } from "@/src/lib/bakeoff-logpush-unwrap"

const KNOWN_EVENTS = new Set([
  "shadow-verdict-comparison",
  "shadow-model-attempt-completed",
  "shadow-cut-short",
  "shadow-run-failed",
])

interface CliArgs {
  input: string
  since: string
  until: string
  out: string
  printOnly: boolean
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Partial<CliArgs> & { printOnly?: boolean } = { printOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--input" || arg === "-i") {
      args.input = required(argv[++i], "--input")
    } else if (arg === "--since") {
      args.since = required(argv[++i], "--since")
    } else if (arg === "--until") {
      args.until = required(argv[++i], "--until")
    } else if (arg === "--out" || arg === "-o") {
      args.out = required(argv[++i], "--out")
    } else if (arg === "--print-only") {
      args.printOnly = true
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else {
      console.error(`unknown arg: ${arg}`)
      printHelp()
      process.exit(2)
    }
  }
  if (!args.input) {
    console.error("missing required --input <path>")
    printHelp()
    process.exit(2)
  }
  const until = args.until ?? new Date().toISOString()
  const since = args.since ?? thirtyDaysBefore(until)
  // CR Major on PR review: explicit ISO strings weren't validated, so
  // a malformed `--until 2026-13-99` or an inverted `--since > --until`
  // window would silently produce a misleading report. Validate both
  // bounds here.
  const sinceMs = Date.parse(since)
  if (!Number.isFinite(sinceMs)) {
    console.error(`bad --since: ${since} is not a valid ISO date`)
    process.exit(2)
  }
  const untilMs = Date.parse(until)
  if (!Number.isFinite(untilMs)) {
    console.error(`bad --until: ${until} is not a valid ISO date`)
    process.exit(2)
  }
  if (sinceMs > untilMs) {
    console.error(`--since (${since}) is after --until (${until})`)
    process.exit(2)
  }
  return {
    input: args.input,
    since,
    until,
    out: args.out ?? "docs/bakeoff-reports",
    printOnly: args.printOnly === true,
  }
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.startsWith("--")) {
    console.error(`${flag} requires a value`)
    process.exit(2)
  }
  return value
}

function thirtyDaysBefore(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    console.error(`bad --until: ${iso}`)
    process.exit(2)
  }
  return new Date(ms - 30 * 24 * 60 * 60 * 1000).toISOString()
}

function printHelp(): void {
  console.error(`bakeoff-report — Shadow bake-off decision report (SIG-86).

Usage:
  npm run bakeoff-report -- --input <path> [--since <ISO>] [--until <ISO>] [--out <dir>] [--print-only]

  --input <path>     NDJSON file or directory of .ndjson / .jsonl files
  --since <ISO>      Window start (default: 30 days before --until)
  --until <ISO>      Window end   (default: now, UTC)
  --out <dir>        Output dir   (default: docs/bakeoff-reports)
  --print-only       Skip writing files; print JSON + Markdown to stdout
  --help / -h        Show this help
`)
}

async function* collectFiles(input: string): AsyncIterableIterator<string> {
  const st = await stat(input)
  if (st.isFile()) {
    yield input
    return
  }
  if (st.isDirectory()) {
    const entries = await readdir(input, { withFileTypes: true })
    for (const e of entries) {
      const path = join(input, e.name)
      if (e.isDirectory()) {
        yield* collectFiles(path)
      } else if (e.isFile() && (e.name.endsWith(".ndjson") || e.name.endsWith(".jsonl") || e.name.endsWith(".log"))) {
        yield path
      }
    }
    return
  }
  console.error(`input is neither file nor directory: ${input}`)
  process.exit(2)
}

interface ParseStats {
  files: number
  lines: number
  parsedEvents: number
  skippedNonShadowEvents: number
  badLines: number
}

async function loadEvents(inputPath: string): Promise<{ events: ShadowEvent[]; stats: ParseStats }> {
  const events: ShadowEvent[] = []
  const stats: ParseStats = { files: 0, lines: 0, parsedEvents: 0, skippedNonShadowEvents: 0, badLines: 0 }
  for await (const file of collectFiles(inputPath)) {
    stats.files++
    const content = await readFile(file, "utf-8")
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      stats.lines++
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        stats.badLines++
        continue
      }
      const obj = unwrapLogpushEnvelope(parsed)
      if (obj === null) {
        stats.badLines++
        continue
      }
      const event = (obj as { event?: unknown }).event
      if (typeof event !== "string" || !KNOWN_EVENTS.has(event)) {
        stats.skippedNonShadowEvents++
        continue
      }
      if (typeof (obj as { ts?: unknown }).ts !== "string") {
        // Some emitters omit `ts` on the inner object when Logpush
        // stamps it on the envelope; we already unwrap, so any `ts`
        // missing here means the line is genuinely undated.
        stats.badLines++
        continue
      }
      events.push(obj as ShadowEvent)
      stats.parsedEvents++
    }
  }
  return { events, stats }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.error(`[bakeoff-report] reading: ${args.input}`)
  console.error(`[bakeoff-report] window:  ${args.since} → ${args.until}`)

  const { events, stats } = await loadEvents(args.input)
  console.error(
    `[bakeoff-report] parsed ${stats.parsedEvents} shadow events (` +
      `${stats.files} files, ${stats.lines} lines, ` +
      `${stats.skippedNonShadowEvents} non-shadow skipped, ${stats.badLines} bad lines)`,
  )

  const report = buildDecisionReport({
    events,
    since: args.since,
    until: args.until,
    now: new Date().toISOString(),
  })

  const json = JSON.stringify(report, null, 2)
  const md = renderDecisionReportMarkdown(report)

  if (args.printOnly) {
    process.stdout.write(json + "\n")
    process.stdout.write("\n---\n\n")
    process.stdout.write(md)
  } else {
    const stamp = new Date().toISOString().slice(0, 10)
    const outDir = resolve(args.out)
    await mkdir(outDir, { recursive: true })
    const jsonPath = join(outDir, `bakeoff-report-${stamp}.json`)
    const mdPath = join(outDir, `bakeoff-report-${stamp}.md`)
    await writeFile(jsonPath, json + "\n")
    await writeFile(mdPath, md)
    console.error(`[bakeoff-report] wrote ${basename(jsonPath)} + ${basename(mdPath)} to ${outDir}`)
  }

  // Exit non-zero on any role overall verdict of `fail` so CI / cron
  // callers can detect regression-flag conditions without parsing JSON.
  // Runs after both write modes so --print-only doesn't accidentally
  // swallow the fail signal when piped through another tool.
  const anyFail = report.roles.some((r) => r.overallVerdict === "fail")
  if (anyFail) {
    console.error(`[bakeoff-report] EXIT 1: at least one role overall verdict is FAIL`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
