#!/usr/bin/env -S npx tsx
// SIG-70 — Sigilix vs CodeRabbit head-to-head measurement CLI.
//
// Thin shell: argument parsing + filesystem + the `gh` fetch (github.ts).
// All judgment logic — normalization, worksheet parse/validate, the summary
// tally — lives in the pure modules and is unit-tested in
// `tests/compare-reviewers.test.ts`.
//
//   npm run compare-reviewers -- collect --repo OWNER/REPO --pr 123
//   # …fill in the `## Labels` table in the generated worksheet…
//   npm run compare-reviewers -- label   --repo OWNER/REPO --pr 123
//   npm run compare-reviewers -- summary [--out compare-reviewers/REPORT.md]
//
// See compare-reviewers/README.md for the full workflow.

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { fetchPrUrl, fetchReviewComments } from "./github"
import { comparisonBasename, mergeComparison, parseTarget } from "./io"
import { normalizeFindings } from "./normalize"
import { formatSummaryMarkdown, summarize } from "./summary"
import { buildWorksheet, parseWorksheet } from "./worksheet"
import type { ComparisonFile } from "./types"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = join(HERE, "data")
const DEFAULT_REPORT = join(HERE, "REPORT.md")

function die(msg: string): never {
  console.error(`error: ${msg}`)
  process.exit(1)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readComparison(path: string): Promise<ComparisonFile | null> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null
    throw err
  }
  const parsed = JSON.parse(raw) as ComparisonFile
  if (parsed.schemaVersion !== 1) {
    die(`${path}: unsupported schemaVersion ${String(parsed.schemaVersion)}`)
  }
  return parsed
}

async function writeJson(path: string, file: ComparisonFile): Promise<void> {
  await writeFile(path, JSON.stringify(file, null, 2) + "\n", "utf8")
}

// ─── collect ─────────────────────────────────────────────────────

async function cmdCollect(opts: { repo?: string; pr?: string; dataDir: string }): Promise<void> {
  const { owner, repo, pr } = parseTarget({ repo: opts.repo ?? "", pr: opts.pr ?? "" })
  await mkdir(opts.dataDir, { recursive: true })
  const base = comparisonBasename(owner, repo, pr)
  const jsonPath = join(opts.dataDir, `${base}.json`)
  const worksheetPath = join(opts.dataDir, `${base}.worksheet.md`)

  console.error(`[collect] ${owner}/${repo}#${pr} — fetching reviews…`)
  const [prUrl, comments] = await Promise.all([
    fetchPrUrl(owner, repo, pr),
    fetchReviewComments(owner, repo, pr),
  ])
  const findings = normalizeFindings(comments)

  const prev = await readComparison(jsonPath)
  const file = mergeComparison(prev, {
    owner,
    repo,
    pr,
    prUrl,
    collectedAt: new Date().toISOString(),
    findings,
  })
  await writeJson(jsonPath, file)

  console.error(
    `[collect] Sigilix: ${findings.sigilix.length} finding(s), ` +
      `CodeRabbit: ${findings.coderabbit.length} finding(s) → ${jsonPath}`,
  )

  if (await fileExists(worksheetPath)) {
    console.error(`[collect] worksheet exists, left as-is: ${worksheetPath}`)
    console.error("[collect] (delete it to regenerate against the refreshed findings.)")
  } else {
    await writeFile(worksheetPath, buildWorksheet(file), "utf8")
    console.error(`[collect] wrote worksheet: ${worksheetPath}`)
  }
  console.error(`[collect] next: fill the "## Labels" table, then run \`label --repo ${owner}/${repo} --pr ${pr}\``)
}

// ─── label ───────────────────────────────────────────────────────

async function cmdLabel(opts: { repo?: string; pr?: string; dataDir: string }): Promise<void> {
  const { owner, repo, pr } = parseTarget({ repo: opts.repo ?? "", pr: opts.pr ?? "" })
  const base = comparisonBasename(owner, repo, pr)
  const jsonPath = join(opts.dataDir, `${base}.json`)
  const worksheetPath = join(opts.dataDir, `${base}.worksheet.md`)

  const file = await readComparison(jsonPath)
  if (!file) die(`no comparison file at ${jsonPath} — run \`collect\` first`)
  let worksheet: string
  try {
    worksheet = await readFile(worksheetPath, "utf8")
  } catch {
    return die(`no worksheet at ${worksheetPath} — run \`collect\` first`)
  }

  const { items, errors, notes } = parseWorksheet(worksheet, file)
  for (const n of notes) console.error(`[label] note: ${n}`)
  if (errors.length > 0) {
    for (const e of errors) console.error(`[label] error: ${e}`)
    die(`worksheet has ${errors.length} problem(s); JSON left unchanged`)
  }

  file.items = items
  await writeJson(jsonPath, file)
  console.error(`[label] recorded ${items.length} labeled issue(s) → ${jsonPath}`)
}

// ─── summary ─────────────────────────────────────────────────────

async function cmdSummary(opts: { out?: string; dataDir: string }): Promise<void> {
  let names: string[]
  try {
    names = await readdir(opts.dataDir)
  } catch {
    return die(`no data directory at ${opts.dataDir} — run \`collect\` + \`label\` first`)
  }
  const jsonNames = names.filter((n) => n.endsWith(".json")).sort()
  if (jsonNames.length === 0) die(`no comparison files in ${opts.dataDir}`)

  const files: ComparisonFile[] = []
  for (const name of jsonNames) {
    const file = await readComparison(join(opts.dataDir, name))
    if (file) files.push(file)
  }

  const report = summarize(files)
  const md = formatSummaryMarkdown(report, { generatedIso: new Date().toISOString() })

  const out = opts.out ? resolve(opts.out) : DEFAULT_REPORT
  await writeFile(out, md + "\n", "utf8")
  console.error(`[summary] ${files.length} PR(s), ${report.totalItems} labeled issue(s) → ${out}`)
  console.log(md)
}

// ─── entry ───────────────────────────────────────────────────────

const USAGE = `compare-reviewers — Sigilix vs CodeRabbit head-to-head

  collect  --repo OWNER/REPO --pr N    fetch both bots' findings + write a worksheet
  label    --repo OWNER/REPO --pr N    parse the filled worksheet into the JSON
  summary  [--out path.md]             aggregate all data/*.json into a report

  --data-dir <path>   override the data directory (default: compare-reviewers/data)`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      out: { type: "string" },
      "data-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  })

  const command = positionals[0]
  if (values.help || !command) {
    console.log(USAGE)
    return
  }

  const dataDir = values["data-dir"] ? resolve(values["data-dir"]) : DEFAULT_DATA_DIR
  // A positional after the command is treated as OWNER/REPO[#PR] when --repo is absent.
  const repo = values.repo ?? positionals[1]

  switch (command) {
    case "collect":
      await cmdCollect({ repo: repo ?? "", pr: values.pr ?? "", dataDir })
      break
    case "label":
      await cmdLabel({ repo: repo ?? "", pr: values.pr ?? "", dataDir })
      break
    case "summary":
      await cmdSummary({ out: values.out ?? "", dataDir })
      break
    default:
      console.error(USAGE)
      die(`unknown command "${command}"`)
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)))
