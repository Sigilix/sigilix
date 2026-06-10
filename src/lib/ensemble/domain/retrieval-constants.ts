// SIG-318 (PR 12g-2): the retrieval tunable the branch-aware merge feeds. Was
// god-file-private in `triage-pr-review-ensemble.ts`; its only caller (the
// `branchAwareMerge` per-pass closure) moved to ensemble/app/context/gather-evidence,
// so it relocated to the domain (the inward dependency direction). It was private →
// relocated without re-export (surface unchanged). Never imports the orchestrator.

// SIG-129: branch chunks to consider per pass before merge dedup/re-rank.
// Matches retrieval.ts TOP_K (6) so a pass can be fully branch-sourced.
export const TOP_K_BRANCH = 6
