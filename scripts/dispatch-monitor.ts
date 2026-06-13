#!/usr/bin/env -S npx tsx
// SIG-224 — operator CLI for dynamic-dispatcher savings telemetry.
//
// Usage:
//   npm run dispatch-monitor -- --input logs.ndjson [--format md|json]
//
// Input may be a local `wrangler tail --format json` capture, a Workers
// Logpush NDJSON export, or a directory containing .json/.jsonl/.ndjson/.log
// files. The report is offline by design: no Worker endpoint, no prod
// state mutation, and no extra Cloudflare read cost.

import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"

import {
  buildDispatchMonitorReport,
  formatDispatchMonitorMarkdown,
  parseDispatchMonitorJsonl,
  type DispatchMonitorEvent,
} from "@/src/lib/dispatch-monitor"

interface CliArgs {
  input: string
  format: "md" | "json"
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: Partial<CliArgs> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--input" || arg === "-i") {
      out.input = required(argv[++i], "--input")
    } else if (arg === "--format") {
      const v = required(argv[++i], "--format")
      if (v !== "md" && v !== "json") die("--format must be md or json")
      out.format = v
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else {
      die(`unknown arg: ${arg}`)
    }
  }
  if (!out.input) die("missing required --input <path>")
  return { input: out.input, format: out.format ?? "md" }
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.startsWith("--")) die(`${flag} requires a value`)
  return value
}

function die(message: string): never {
  console.error(`error: ${message}`)
  printHelp()
  process.exit(2)
}

function printHelp(): void {
  console.error(`dispatch-monitor — Dynamic dispatcher CLI monitor.

Usage:
  npm run dispatch-monitor -- --input <path> [--format md|json]

  --input, -i    JSON/JSONL/NDJSON/log file or directory
  --format       md (default) or json
  --help, -h     Show this help
`)
}

async function* collectFiles(input: string): AsyncIterableIterator<string> {
  const st = await stat(input)
  if (st.isFile()) {
    yield input
    return
  }
  if (!st.isDirectory()) die(`input is neither file nor directory: ${input}`)
  const entries = await readdir(input, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(input, entry.name)
    if (entry.isDirectory()) {
      yield* collectFiles(path)
    } else if (entry.isFile() && /\.(json|jsonl|ndjson|log)$/u.test(entry.name)) {
      yield path
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const events: DispatchMonitorEvent[] = []
  let badLines = 0
  let skippedLines = 0
  let files = 0
  for await (const file of collectFiles(args.input)) {
    files++
    const parsed = parseDispatchMonitorJsonl(await readFile(file, "utf8"))
    events.push(...parsed.events)
    badLines += parsed.badLines
    skippedLines += parsed.skippedLines
  }
  const report = buildDispatchMonitorReport(events)
  if (args.format === "json") {
    console.log(JSON.stringify({ files, badLines, skippedLines, report }, null, 2))
  } else {
    console.error(`[dispatch-monitor] files=${files} parsed=${events.length} bad=${badLines} skipped=${skippedLines}`)
    console.log(formatDispatchMonitorMarkdown(report))
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
