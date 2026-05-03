// Extract GitHub PR references from a Linear @-mention comment.
//
// Two reference forms supported:
//   - Full URL:    https://github.com/<owner>/<repo>/pull/<n>[/files|/commits|#anchor|?query]
//   - Bare PR #N:  "PR #162" / "pull request #162" — only resolved when
//                  inferRepo() returns a non-null mapping for the current
//                  Linear team.
//
// Bare `#NNN` (without `PR ` prefix) is intentionally NEVER matched —
// too ambiguous with Linear issue IDs.
//
// Refs are deduped by `owner/repo/number` and capped at 2 per call to
// defend against link-spam comments.

const URL_PATTERN =
  /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g

// Negative lookbehind for "word char" so we match `PR #N`, `(PR #N)`,
// `[PR #N]`, `,PR #N`, etc., but NOT `MyPR #N` / `aPR #N`. Catches
// realistic comment punctuation users actually type.
const BARE_PR_PATTERN = /(?<![A-Za-z0-9_])(?:PR|pull\s+request)\s*#(\d+)/gi

const MAX_REFS = 2

export interface PrRef {
  owner: string
  repo: string
  number: number
  source: "url" | "bare-pr-n"
}

export function extractPullRequestRefs(
  text: string,
  inferRepo: () => { owner: string; repo: string } | null
): PrRef[] {
  if (!text) return []

  const out: PrRef[] = []
  const seen = new Set<string>()

  const push = (ref: PrRef): void => {
    const key = `${ref.owner}/${ref.repo}#${ref.number}`
    if (seen.has(key)) return
    seen.add(key)
    if (out.length < MAX_REFS) out.push(ref)
  }

  // Reset lastIndex defensively — these regexes are module-level globals
  // and would otherwise carry state between calls.
  URL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const owner = match[1]
    const repo = match[2]
    const numStr = match[3]
    if (!owner || !repo || !numStr) continue
    const number = Number.parseInt(numStr, 10)
    if (Number.isFinite(number) && number > 0) {
      push({ owner, repo, number, source: "url" })
    }
  }

  // Bare PR #N requires a repo mapping. We resolve `inferRepo()` lazily
  // — if there's no bare match, we never call it.
  BARE_PR_PATTERN.lastIndex = 0
  let bareMatch: RegExpExecArray | null
  let inferred: { owner: string; repo: string } | null | undefined
  while ((bareMatch = BARE_PR_PATTERN.exec(text)) !== null) {
    if (inferred === undefined) inferred = inferRepo()
    if (!inferred) break
    const numStr = bareMatch[1]
    if (!numStr) continue
    const number = Number.parseInt(numStr, 10)
    if (Number.isFinite(number) && number > 0) {
      push({ owner: inferred.owner, repo: inferred.repo, number, source: "bare-pr-n" })
    }
  }

  return out
}
