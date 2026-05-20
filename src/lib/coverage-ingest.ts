// SIG-118: coverage-diff ingestion.
//
// Reads an LCOV coverage artifact from the PR head's GitHub Actions run,
// parses the uncovered lines, intersects them with the PR's ADDED lines
// (the `+` new-side lines from `buildChangedLines`), and feeds the
// resulting coverage-gap facts to the tests specialist as a pre-LLM
// authoritative block.
//
// SAFETY CONTRACT (non-negotiable):
//   - Best-effort + non-fatal. ANY failure — no run, no artifact, head
//     SHA mismatch, expired artifact, oversized payload, fetch/parse
//     error — returns `null`. A coverage failure must NEVER break a
//     review. `ingestCoverage` never throws.
//   - GATED OFF by default. The orchestrator only calls this when
//     `resolveCoverageConfig(config).source !== "off"`.
//   - Size caps: the artifact's COMPRESSED size (`size_in_bytes` from
//     the artifact metadata) is checked BEFORE download against
//     COMPRESSED_CAP; the download itself is byte-capped; the
//     UNCOMPRESSED LCOV entry is capped at ENTRY_CAP both in the unzip
//     filter (via `originalSize`) and verified after extraction.
//   - The signed-URL token-leak guard lives in
//     `GitHubClient.downloadArtifactZip` (manual redirect, no auth on the
//     signed request, https-only).
//
// The pure pieces (`parseLcov`, `normalizeSfPath`, `resolveToChangedFile`,
// `intersectAddedUncovered`, `renderCoverageGapBlock`) are exported and
// unit-tested; the fetch orchestration (`ingestCoverage`) is impure.

import { unzipSync } from "fflate"
import type { GitHubClient } from "./github"
import { buildChangedLines } from "./sarif-evidence/diff-lines"

/** COMPRESSED artifact size cap, checked against `size_in_bytes` BEFORE download. */
const COMPRESSED_CAP = 5 * 1024 * 1024
/** UNCOMPRESSED LCOV entry cap, enforced in the unzip filter + verified after. */
const ENTRY_CAP = 15 * 1024 * 1024
/** Parse-time bounds (Codex OOM review): cap the accumulated maps so an
 *  adversarial-but-byte-cap-passing LCOV can't blow the 128 MB isolate.
 *  Generous enough for whole-repo coverage of large repos; exceeding
 *  either stops accumulation and returns the bounded partial map. */
const MAX_LCOV_FILES = 20000
const MAX_LCOV_UNCOVERED = 500000

/** A coverage gap: a changed file plus its added-and-uncovered line numbers. */
export interface CoverageGap {
  path: string
  lines: number[]
}

export interface CoverageResult {
  coverageGaps: CoverageGap[]
  meta: {
    runId: number
    artifactName: string
    entry: string
  }
}

export interface IngestCoverageArgs {
  client: GitHubClient
  owner: string
  repo: string
  headSha: string
  /** Unified diff for the PR (used to derive the added-line set). */
  diff: string
  config: {
    source: "off" | "github-actions-artifact"
    artifactName: string
    entry: string
  }
}

/**
 * Parse an LCOV `text` into a `SF:<file>` → uncovered-line[] map.
 *
 * LCOV records:
 *   - `SF:<path>` opens a record for a source file.
 *   - `DA:<line>,<hits>` is a line-coverage datum. UNCOVERED means the
 *     line was instrumented but never executed — `hits === 0`. A line
 *     with NO `DA` entry is NOT counted as uncovered (it was never
 *     instrumented; treating it as a gap would flag non-executable lines
 *     like blank lines, comments, and type-only declarations).
 *   - `end_of_record` closes the current `SF:` record.
 *
 * Branch/function coverage (`BRDA:`/`FN:`/`FNDA:`) is ignored — this
 * channel is line-coverage only. Malformed `DA:` lines are skipped.
 * Multiple records for the same `SF:` accumulate (LCOV may emit per-run
 * records for the same file).
 */
export function parseLcov(text: string): Map<string, number[]> {
  const out = new Map<string, number[]>()
  if (typeof text !== "string" || text.length === 0) return out

  let currentFile: string | null = null
  // Per-file uncovered set to dedupe lines within a record run.
  let uncovered: Set<number> | null = null

  const flush = (): void => {
    if (currentFile !== null && uncovered !== null) {
      const existing = out.get(currentFile)
      if (existing) {
        const merged = new Set(existing)
        for (const l of uncovered) merged.add(l)
        out.set(currentFile, [...merged].sort((a, b) => a - b))
      } else {
        out.set(currentFile, [...uncovered].sort((a, b) => a - b))
      }
    }
    currentFile = null
    uncovered = null
  }

  // Codex review (HIGH, OOM): scan line-by-line via indexOf rather than
  // `text.split("\n")` — a 15 MiB LCOV of tiny `DA:x,0` records would
  // otherwise materialize ~millions of substrings at once. slice() here
  // allocates ONE line at a time (GC'd between iterations). Plus hard
  // caps on files + total uncovered lines bound the accumulated Sets, so
  // an adversarial (but byte-cap-passing) artifact can't OOM the 128 MB
  // Worker. Exceeding a cap stops accumulation and returns the bounded
  // partial map — a missed gap means fewer facts, never a false one.
  let totalUncovered = 0
  let start = 0
  const len = text.length
  while (start < len) {
    let end = text.indexOf("\n", start)
    if (end === -1) end = len
    const line = text.slice(start, end).trim()
    start = end + 1
    if (line.length === 0) continue
    if (line.startsWith("SF:")) {
      flush() // a new SF: without an intervening end_of_record
      if (out.size >= MAX_LCOV_FILES) return out // bounded — stop scanning
      currentFile = line.slice("SF:".length).trim()
      uncovered = new Set<number>()
      continue
    }
    if (line === "end_of_record") {
      flush()
      continue
    }
    if (line.startsWith("DA:") && currentFile !== null && uncovered !== null) {
      // `DA:<line>,<hits>[,<checksum>]` — only the first two fields matter.
      const parts = line.slice("DA:".length).split(",")
      if (parts.length < 2) continue
      const lineNo = Number(parts[0])
      const hits = Number(parts[1])
      if (!Number.isInteger(lineNo) || lineNo <= 0) continue
      if (!Number.isFinite(hits)) continue
      if (hits === 0) {
        uncovered.add(lineNo)
        totalUncovered++
        if (totalUncovered > MAX_LCOV_UNCOVERED) {
          flush()
          return out // bounded — stop accumulating
        }
      }
      continue
    }
    // BRDA / FN / FNDA / LF / LH / TN etc. — ignored.
  }
  // Trailing record with no `end_of_record`.
  flush()
  return out
}

// The GitHub Actions runner workspace prefix. LCOV `SF:` paths produced
// on a hosted runner are typically absolute and rooted here; we strip
// down to the repo-relative path. The repo segment is doubled
// (`<repo>/<repo>`) in the standard checkout layout.
const RUNNER_WORKSPACE_RE = /^\/(?:home|Users)\/[^/]+\/work\/[^/]+\/[^/]+\//

/**
 * Normalize an LCOV `SF:` path to a repo-relative path.
 *   - strips a `file://` scheme prefix
 *   - strips the GitHub Actions runner workspace prefix
 *     (`/home/runner/work/<repo>/<repo>/`)
 *   - strips a leading `./`
 *   - normalizes backslashes to forward slashes
 *   - collapses a leading `/`
 *
 * Pure + best-effort: returns the slash-normalized remainder even when no
 * known prefix matched (the resolver then tries an exact/suffix match
 * against the changed set). Does NOT resolve `..` segments — traversal is
 * rejected downstream in `resolveToChangedFile`.
 */
export function normalizeSfPath(sf: string): string {
  if (typeof sf !== "string") return ""
  let p = sf.trim()
  if (p.length === 0) return ""
  // file:// scheme (with or without host).
  if (p.startsWith("file://")) {
    p = p.slice("file://".length)
    // file:///abs/path → /abs/path ; file://host/path → host/path. Keep
    // the leading slash from the triple-slash form for the runner-prefix
    // and leading-slash strips below.
  }
  // Backslash → forward slash (Windows-style runner paths).
  p = p.replace(/\\/g, "/")
  // Runner workspace prefix → repo-relative.
  p = p.replace(RUNNER_WORKSPACE_RE, "")
  // Leading ./ and / collapse.
  while (p.startsWith("./")) p = p.slice(2)
  while (p.startsWith("/")) p = p.slice(1)
  return p
}

/**
 * Resolve a normalized LCOV path to a changed file in the PR.
 *   - EXACT match against the changed set wins immediately.
 *   - else a UNIQUE suffix match (the normalized path is a path-segment
 *     suffix of exactly one changed file) wins. Segment-aligned to avoid
 *     `foo/bar.ts` matching `xfoo/bar.ts`.
 *   - AMBIGUOUS (>1 suffix match) → null (can't safely attribute).
 *   - TRAVERSAL / absolute-shaped input → null (defense in depth; the
 *     normalizer doesn't resolve `..`).
 *
 * Pure. `changedPaths` is the set of repo-relative paths the PR touched.
 */
export function resolveToChangedFile(
  normalizedSf: string,
  changedPaths: ReadonlySet<string>,
): string | null {
  if (typeof normalizedSf !== "string" || normalizedSf.length === 0) return null
  // Reject traversal / still-absolute shapes.
  if (normalizedSf.startsWith("/")) return null
  if (normalizedSf.split("/").some((seg) => seg === "..")) return null
  // Defense-in-depth (Sigilix review): reject percent-encoded traversal /
  // separators so an encoded `%2e%2e` / `%2f` can't slip past the literal
  // `..` check above. (Impact is already bounded — the path is only used
  // as a key matched against the changed-file set, never a filesystem
  // read — but a real source path never contains these.)
  if (/%2[ef]/i.test(normalizedSf)) return null

  if (changedPaths.has(normalizedSf)) return normalizedSf

  // Unique segment-aligned suffix match: `<changed>` ends with
  // `/<normalizedSf>` (or equals it, already handled above).
  const needle = "/" + normalizedSf
  let match: string | null = null
  for (const candidate of changedPaths) {
    if (candidate.endsWith(needle)) {
      if (match !== null) return null // ambiguous
      match = candidate
    }
  }
  return match
}

/**
 * Intersect the LCOV uncovered-line map with the PR's ADDED-line set.
 *
 * For each LCOV `SF:` file that resolves to a changed file, keep only the
 * uncovered lines that are also in the PR's added-line set for that file
 * (the `buildChangedLines` `+` new-side set). Files / lines with no
 * intersection are dropped — a coverage gap is only interesting on a line
 * THIS PR added.
 *
 * `changedLines` is the `path → addedLineSet` map from `buildChangedLines`.
 * Output is sorted (by path, then line) for stable rendering. Pure.
 */
export function intersectAddedUncovered(
  uncoveredByFile: Map<string, number[]>,
  changedLines: Map<string, Set<number>>,
): CoverageGap[] {
  const changedPaths = new Set(changedLines.keys())
  // Merge by resolved path so two LCOV `SF:` records resolving to the
  // same changed file don't emit two gaps.
  const byResolved = new Map<string, Set<number>>()
  for (const [sf, uncovered] of uncoveredByFile) {
    const normalized = normalizeSfPath(sf)
    const resolved = resolveToChangedFile(normalized, changedPaths)
    if (resolved === null) continue
    const added = changedLines.get(resolved)
    if (!added || added.size === 0) continue
    let bucket = byResolved.get(resolved)
    if (!bucket) {
      bucket = new Set<number>()
      byResolved.set(resolved, bucket)
    }
    for (const ln of uncovered) {
      if (added.has(ln)) bucket.add(ln)
    }
  }

  const gaps: CoverageGap[] = []
  for (const [path, lines] of byResolved) {
    if (lines.size === 0) continue
    gaps.push({ path, lines: [...lines].sort((a, b) => a - b) })
  }
  gaps.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return gaps
}

/**
 * Render the coverage gaps as a single authoritative-fact block for the
 * tests specialist's prompt. Returns the empty string when there are no
 * gaps so callers can join it into a combined fact block without
 * conditional logic.
 *
 * Each gap line carries a citable `coverageGap:<path>:<line>` ref the
 * specialist may cite — the citation gates parse the line from the LAST
 * colon so paths containing colons stay intact.
 */
/**
 * Strip characters that could break the prompt block's structure
 * (Sigilix review — prompt-injection): backticks (close a code span),
 * CR/LF/tab, and C0 control chars. Paths are already constrained to real
 * changed-file paths (`resolveToChangedFile`), so a normal source path is
 * unaffected; this only neutralizes a pathologically-named PR file. A
 * path altered here won't round-trip as a `coverageGap:` citation, which
 * is the correct trade — we drop a coverage fact on a hostile filename
 * rather than let it inject.
 */
function sanitizePromptPath(p: string): string {
  return p.replace(/[\u0000-\u001f\u007f\u0060]/g, "")
}

export function renderCoverageGapBlock(gaps: readonly CoverageGap[]): string {
  if (!Array.isArray(gaps) || gaps.length === 0) return ""
  const lines: string[] = [
    "[COVERAGE GAPS — pre-LLM, LCOV]",
    "",
    "This is authoritative: the lines below are added in THIS PR and uncovered by the CI coverage run.",
    "",
  ]
  for (const gap of gaps) {
    const safePath = sanitizePromptPath(gap.path)
    const lineList = gap.lines.join(", ")
    lines.push(`- \`${safePath}\`: ${lineList}`)
    for (const ln of gap.lines) {
      lines.push(`  - cite as \`coverageGap:${safePath}:${ln}\``)
    }
  }
  return lines.join("\n")
}

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}

/**
 * Orchestrate the coverage ingest. Best-effort + non-fatal: returns
 * `null` on EVERY failure mode (and never throws). The caller treats a
 * `null` as "no coverage block".
 *
 * Pipeline:
 *   1. listRunsForSha → pick the latest completed run whose
 *      `head_sha === headSha` and conclusion is `success`. (A mismatched
 *      head SHA means the artifact is for a different commit — skip.)
 *   2. listArtifacts(runId, artifactName) → the first non-expired
 *      artifact whose COMPRESSED `size_in_bytes <= COMPRESSED_CAP`.
 *   3. downloadArtifactZip (manual-redirect token-leak guard inside).
 *   4. unzipSync with a filter for `config.entry` + the ENTRY_CAP via
 *      `originalSize`; verify the extracted byte length.
 *   5. parseLcov → intersectAddedUncovered against `buildChangedLines`.
 */
export async function ingestCoverage(args: IngestCoverageArgs): Promise<CoverageResult | null> {
  const { client, owner, repo, headSha, diff, config } = args
  const ctx = { owner, repo, headSha: headSha.slice(0, 7) }

  if (config.source === "off") return null

  try {
    // 1. Locate the producing run.
    const runs = await client.listRunsForSha(owner, repo, headSha)
    // Prefer the latest-created successful run on the EXACT head SHA.
    const candidate = runs
      .filter((r) => r.head_sha === headSha && r.conclusion === "success")
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))[0]
    if (!candidate) {
      emit("coverage-ingest-skipped", { ...ctx, reason: "no-success-run" })
      return null
    }
    const runId = candidate.id

    // 2. Locate the coverage artifact.
    const artifacts = await client.listArtifacts(owner, repo, runId, config.artifactName)
    const artifact = artifacts.find(
      // Codex MED: require a finite, positive reported size — a missing /
      // non-number `size_in_bytes` must NOT coerce to 0 and slip past the
      // pre-download cap.
      (a) =>
        a.name === config.artifactName &&
        !a.expired &&
        Number.isFinite(a.size_in_bytes) &&
        a.size_in_bytes > 0 &&
        a.size_in_bytes <= COMPRESSED_CAP,
    )
    if (!artifact) {
      const present = artifacts.find((a) => a.name === config.artifactName)
      const reason = !present
        ? "no-artifact"
        : present.expired
          ? "artifact-expired"
          : "artifact-too-large"
      emit("coverage-ingest-skipped", { ...ctx, runId, artifactName: config.artifactName, reason })
      return null
    }

    // 3. Download (token-leak guard inside the client method). The
    // downloaded payload is the COMPRESSED zip, so cap it at COMPRESSED_CAP
    // (Codex MED) — not ENTRY_CAP, which bounds the UNCOMPRESSED entry.
    const zipBytes = await client.downloadArtifactZip(owner, repo, artifact.id, COMPRESSED_CAP)

    // 4. Extract just the configured entry, capping the uncompressed size.
    const entry = config.entry
    let extracted: Uint8Array | undefined
    try {
      // First-match-only filter (code-review LOW): a ZIP may carry several
      // central-directory entries with the same name; matching every one
      // would inflate ~ENTRY_CAP per duplicate before the map collapses to
      // the last write. Inflate exactly the first matching entry.
      let matched = false
      const files = unzipSync(zipBytes, {
        filter: (f) => {
          if (matched || f.name !== entry || f.originalSize > ENTRY_CAP) return false
          matched = true
          return true
        },
      })
      extracted = files[entry]
    } catch {
      emit("coverage-ingest-skipped", { ...ctx, runId, artifactName: config.artifactName, reason: "unzip-failed" })
      return null
    }
    if (!extracted) {
      emit("coverage-ingest-skipped", { ...ctx, runId, artifactName: config.artifactName, entry, reason: "entry-not-found" })
      return null
    }
    // Verify the extracted size against the cap (defense in depth — the
    // filter relies on `originalSize` from the central directory).
    if (extracted.byteLength > ENTRY_CAP) {
      emit("coverage-ingest-skipped", { ...ctx, runId, artifactName: config.artifactName, entry, reason: "entry-too-large" })
      return null
    }

    // 5. Parse + align.
    const text = new TextDecoder().decode(extracted)
    const uncoveredByFile = parseLcov(text)
    const changedLines = buildChangedLines(diff)
    const coverageGaps = intersectAddedUncovered(uncoveredByFile, changedLines)

    emit("coverage-ingest-ran", {
      ...ctx,
      runId,
      artifactName: config.artifactName,
      entry,
      lcovFiles: uncoveredByFile.size,
      gaps: coverageGaps.length,
    })

    return {
      coverageGaps,
      meta: { runId, artifactName: config.artifactName, entry },
    }
  } catch (err) {
    // Best-effort: ANY error → null. Never break a review.
    emit("coverage-ingest-skipped", {
      ...ctx,
      reason: "error",
      errMessage: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
