// SIG-70/SIG-326 — pure path / merge / argument helpers.
//
// Kept separate from `cli.ts` (which does the actual fs reads/writes) so the
// naming + merge rules are unit-testable without touching disk.

import type { ComparisonFile, NormalizedFinding } from "./types"

/** Filesystem-safe-ish slug for an owner/repo segment. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_")
}

/** Basename (no extension) for a PR's artifacts: `{owner}-{repo}-{pr}`. */
export function comparisonBasename(owner: string, repo: string, pr: number): string {
  return `${slug(owner)}-${slug(repo)}-${pr}`
}

/**
 * Resolve a collect/label target from CLI input. `repo` is `OWNER/REPO` and
 * may carry the PR inline as `OWNER/REPO#123`; otherwise `pr` supplies it.
 * Throws (with a usable message) on anything malformed.
 */
export function parseTarget(input: { repo?: string; pr?: string }): {
  owner: string
  repo: string
  pr: number
} {
  const repoRaw = (input.repo ?? "").trim()
  let prRaw = (input.pr ?? "").trim()
  let repoSlug = repoRaw
  const hash = repoRaw.indexOf("#")
  if (hash !== -1) {
    repoSlug = repoRaw.slice(0, hash)
    if (prRaw === "") prRaw = repoRaw.slice(hash + 1)
  }
  const m = /^([^/\s]+)\/([^/\s#]+)$/.exec(repoSlug)
  if (!m) {
    throw new Error(`--repo must be OWNER/REPO (got ${JSON.stringify(repoRaw)})`)
  }
  const pr = Number(prRaw)
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error(`--pr must be a positive integer (got ${JSON.stringify(prRaw)})`)
  }
  return { owner: m[1]!, repo: m[2]!, pr }
}

/**
 * Build the comparison record for a freshly-collected PR, preserving any
 * labels the reviewer already recorded on a prior collect. Findings are always
 * taken from the fresh fetch (the bot may have edited its review); `items` are
 * carried over verbatim so a re-collect never discards labeling work. (If the
 * refresh changed the finding set, re-run `label` to re-validate the items
 * against the new refs.)
 */
export function mergeComparison(
  prev: ComparisonFile | null,
  fresh: {
    owner: string
    repo: string
    pr: number
    prUrl: string
    collectedAt: string
    findings: {
      sigilix: NormalizedFinding[]
      coderabbit: NormalizedFinding[]
      greptile: NormalizedFinding[]
    }
  },
): ComparisonFile {
  return {
    schemaVersion: 2,
    owner: fresh.owner,
    repo: fresh.repo,
    pr: fresh.pr,
    prUrl: fresh.prUrl,
    collectedAt: fresh.collectedAt,
    findings: fresh.findings,
    items: prev?.items ?? [],
  }
}
