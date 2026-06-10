// SIG-318 (PR 12g-1): the diff-line counter the legacy router decision feeds.
// Pure (a unified-diff string in, an added+removed line count out). Was
// god-file-private in `triage-pr-review-ensemble.ts`; its only caller (the
// router-decision `decideSpecialists` call) moved to ensemble/app/context/
// fetch-and-pack, so it relocated to the domain (the inward dependency
// direction). Never imported by the orchestrator god-file.

export function countLines(diff: string): number {
  let n = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) n++
    else if (line.startsWith("-") && !line.startsWith("---")) n++
  }
  return n
}
