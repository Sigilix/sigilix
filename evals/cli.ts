#!/usr/bin/env -S npx tsx
// SIG-70/SIG-326 — reviewer head-to-head measurement CLI.
//
// Thin shell: argument parsing + filesystem + the `gh` fetch (github.ts).
// All judgment logic — normalization, worksheet parse/validate, the summary
// tally — lives in the pure modules and is unit-tested in
// `tests/compare-reviewers.test.ts`.
//
//   npm run evals -- collect --repo OWNER/REPO --pr 123
//   # …fill in the `## Labels` table in the generated worksheet…
//   npm run evals -- label   --repo OWNER/REPO --pr 123
//   npm run evals -- summary [--out evals/REPORT.md]
//
// See evals/README.md for the full workflow.

import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { greptileLoginsFromEnv } from "./env"
import { fetchPrUrl, fetchReviewComments } from "./github"
import { comparisonBasename, mergeComparison, parseTarget } from "./io"
import { normalizeFindings, normalizeFixtureFindings } from "./normalize"
import { formatDeltaMarkdown, formatScoreMarkdown, scoreFixture } from "./scorer"
import { formatSummaryMarkdown, summarize } from "./summary"
import { buildWorksheet, parseWorksheet } from "./worksheet"
import type { FixtureFinding, FixtureGroundTruth, FixtureScore } from "./fixture-types"
import type { ComparisonFile, Tool } from "./types"
import { TOOLS } from "./types"

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DATA_DIR = join(HERE, "data")
const DEFAULT_REPORT = join(HERE, "REPORT.md")
const FIXTURES_DIR = join(HERE, "fixtures")

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
  if (parsed.schemaVersion !== 2) {
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
  const [prUrl, comments] = await Promise.all([fetchPrUrl(owner, repo, pr), fetchReviewComments(owner, repo, pr)])
  const findings = normalizeFindings(comments, {
    greptileLogins: greptileLoginsFromEnv(process.env, console.warn),
  })

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
      `CodeRabbit: ${findings.coderabbit.length} finding(s), ` +
      `Greptile: ${findings.greptile.length} finding(s) → ${jsonPath}`,
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

// ─── score (SIG-397) ─────────────────────────────────────────────

async function readJson<T>(path: string, what: string): Promise<T> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    die(`no ${what} at ${path}`)
  }
  return JSON.parse(raw) as T
}

function isTool(s: string): s is Tool {
  return (TOOLS as readonly string[]).includes(s)
}

/**
 * Score a tool's findings against a frozen fixture's ground truth.
 * Default input is the committed snapshot; `--pr` re-collects live from
 * GitHub (the re-runnable path used to A/B a SIG-392 lever after the
 * fixture PR is re-reviewed); `--findings` scores an arbitrary saved file.
 */
async function cmdScore(opts: {
  fixture?: string
  tool: string
  pr?: string
  findingsPath?: string
  baseline?: string
  label?: string
  out?: string
  saveFindings?: string
}): Promise<void> {
  if (!opts.fixture) die("score requires --fixture <name> (a directory under evals/fixtures/)")
  if (!isTool(opts.tool)) die(`--tool must be one of ${TOOLS.join(", ")} (got ${JSON.stringify(opts.tool)})`)
  const fixtureDir = join(FIXTURES_DIR, opts.fixture)
  const truth = await readJson<FixtureGroundTruth>(join(fixtureDir, "ground-truth.json"), "ground truth")

  let findings: FixtureFinding[]
  if (opts.pr) {
    const { owner, repo, pr } = parseTarget({ repo: opts.pr, pr: "" })
    console.error(`[score] fetching live review comments for ${owner}/${repo}#${pr}…`)
    const comments = await fetchReviewComments(owner, repo, pr)
    findings = normalizeFixtureFindings(comments, {
      greptileLogins: greptileLoginsFromEnv(process.env, console.warn),
    })[opts.tool]
    if (opts.saveFindings) {
      await writeFile(opts.saveFindings, JSON.stringify(findings, null, 2) + "\n", "utf8")
      console.error(`[score] saved findings → ${opts.saveFindings}`)
    }
  } else if (opts.findingsPath) {
    findings = await readJson<FixtureFinding[]>(resolve(opts.findingsPath), "findings file")
  } else {
    findings = await readJson<FixtureFinding[]>(join(fixtureDir, `findings.${opts.tool}.json`), "frozen snapshot")
  }

  const score = scoreFixture(truth, opts.tool, findings)
  let md = formatScoreMarkdown(score)
  if (opts.baseline) {
    const baseline = await readJson<FixtureScore>(resolve(opts.baseline), "baseline score")
    md += "\n\n" + formatDeltaMarkdown(baseline, score, opts.label ?? "(unlabeled run)")
  }
  if (opts.out) {
    const outPath = resolve(opts.out)
    await writeFile(outPath, JSON.stringify(score, null, 2) + "\n", "utf8")
    console.error(`[score] full score JSON → ${outPath}`)
  }
  console.log(md)
}

// ─── entry ───────────────────────────────────────────────────────

const USAGE = `evals — reviewer head-to-head

  collect  --repo OWNER/REPO --pr N    fetch tool findings + write a worksheet
  label    --repo OWNER/REPO --pr N    parse the filled worksheet into the JSON
  summary  [--out path.md]             aggregate all data/*.json into a report
  score    --fixture NAME [--tool sigilix]   score against a frozen fixture (SIG-397)
           [--pr OWNER/REPO#N]               …re-collect live instead of the frozen snapshot
           [--findings path.json]            …or score a saved findings file
           [--baseline score.json --label x] emit a Δ block vs a baseline score
           [--out score.json]                write the full score JSON
           [--save-findings path.json]       with --pr: persist the fetched findings

  --data-dir <path>   override the data directory (default: evals/data)

  COMPARE_REVIEWERS_GREPTILE_LOGINS=login1,login2 overrides Greptile app logins`

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      out: { type: "string" },
      "data-dir": { type: "string" },
      fixture: { type: "string" },
      tool: { type: "string", default: "sigilix" },
      findings: { type: "string" },
      baseline: { type: "string" },
      label: { type: "string" },
      "save-findings": { type: "string" },
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
    case "score": {
      const scoreOpts: Parameters<typeof cmdScore>[0] = { tool: values.tool ?? "sigilix" }
      if (values.fixture) scoreOpts.fixture = values.fixture
      // Live re-collect accepts both forms: a positional / --repo OWNER/REPO[#N]
      // (optionally split across --pr), or --pr alone carrying OWNER/REPO#N.
      if (repo) scoreOpts.pr = values.pr ? `${repo}#${values.pr}` : repo
      else if (values.pr?.includes("/")) scoreOpts.pr = values.pr
      if (values.findings) scoreOpts.findingsPath = values.findings
      if (values.baseline) scoreOpts.baseline = values.baseline
      if (values.label) scoreOpts.label = values.label
      if (values.out) scoreOpts.out = values.out
      if (values["save-findings"]) scoreOpts.saveFindings = values["save-findings"]
      await cmdScore(scoreOpts)
      break
    }
    default:
      console.error(USAGE)
      die(`unknown command "${command}"`)
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)))
