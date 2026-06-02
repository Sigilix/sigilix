# SIG-44 + SIG-45 — hybrid lexical retrieval + multi-corpus retrieval

Parent epic: **SIG-46** (customer-ready indexing pipeline). Tier-1 sub-tickets
already shipped; this branch tackles the two open Tier-2 retrieval-quality
sub-tickets together since both build on the same indexer/retrieval seams.

Both features ship **dark** (flags default off, no behavior change until flipped).

---

## SIG-45 — Hybrid lexical (BM25) retrieval — ✅ wired end-to-end

**Why:** retrieval was pure-vector, so it missed exact identifier matches, error
strings, and log lines that lexical search catches reliably.

| Concern | Implementation |
|---|---|
| Lexical backend | `src/lib/lexical-index.ts` — Cloudflare D1 + FTS5 (BM25). Standalone FTS5 table, `unicode61` tokenizer, `namespace` as an `=` filter alongside `MATCH`. Schema bootstrapped lazily (`ensureLexicalSchema`), no separate migration. |
| Indexer dual-write | `src/lib/indexer.ts` — `dualWriteLexical()` writes each batch to D1 beside the Vectorize upsert. Gated on the **binding** (not the read flag) so the corpus can be populated before the A/B. Soft-fail: never blocks the GDPR delete-coverage ledger. |
| Parallel query + RRF | `src/lib/retrieval.ts` — vector + lexical run in parallel; results fused via reciprocal-rank fusion (`reciprocalRankFusion`, k=60), deduped by chunk id (same `chunkId` scheme on both backends). Degrades to lexical-only if Vectorize errors. The surfacing signal + RRF score are cited in the prompt block. |
| FTS5 query safety | `buildFtsQuery()` tokenizes to alnum/underscore runs and double-quotes each term so identifiers like `user-id` or stray quotes/`AND` can't become FTS5 operators. |
| GDPR cleanup | `src/lib/index-delete.ts` — uninstall/repos-removed fan-out purges the lexical namespace (unguarded, like the graph delete; the namespace embeds the owner). New `DeleteResult.lexicalRows`. |
| Config | Flag `OPENCLAW_RETRIEVAL_HYBRID` + D1 binding `OPENCLAW_LEXICAL_INDEX` (`wrangler.toml`, both default off/unbound). |

**Deploy step:** `wrangler d1 create sigilix-lexical-index`, paste the
`database_id` into `wrangler.toml`, deploy, let the indexer populate, then flip
`OPENCLAW_RETRIEVAL_HYBRID=on` for the A/B.

**Not done (needs a live deploy — can't be produced from code):**
- The A/B over 30 PRs (precision/recall vs hand-graded ground truth) and the
  resulting on/off default decision. Flag is left **off**, which is exactly the
  ticket's "if no meaningful lift, leave behind a flag" fallback.

---

## SIG-44 — Multi-corpus retrieval (merged PRs + Linear issues) — ✅ wired end-to-end

**Why:** retrieval only sees code, so the bot can't say "this looks like the same
regression we fixed in PR #234" or cite a Linear decision.

**Core (`src/lib/multi-corpus.ts`):**
- `pr:<owner>/<repo>` and `issue:<owner>/<repo>` namespace helpers (prefixes on
  the code namespace, well under Vectorize's 64-byte cap, same 768-dim bge
  embeddings).
- Embed-text builders + stable doc ids (`pr-234`, `issue-arc-42`) so refresh
  overwrites rather than duplicates.
- `upsertPrDoc` / `upsertIssueDoc` — embed + upsert write helpers with metadata.
- `retrieveMultiCorpus` — queries `pr:` + `issue:` in parallel, soft-fails per
  leg, emits `pr-review-retrieval-multicorpus` telemetry with per-namespace hit
  counts + top scores.
- `formatMultiCorpusForPrompt` — labeled blocks
  (`--- past PR #234 (verdict: changes_required) ---`), bounded per-block/total.
- `deriveVerdictLabel` — maps persisted review findings to the verdict label
  (the manifest stores only per-finding `score`; we reuse the pipeline's own
  score≥4 = changes_required floor; empty findings = approved; no manifest =
  undefined so we never assert a false "approved").

**Plumbing (now wired):**
| Piece | Where |
|---|---|
| **Read injection** | `triage-pr-review-ensemble.ts` — `retrieveMultiCorpus` runs concurrently with preflight; the `[PRIOR PRS & ISSUES]` section is appended to the shared + perf snapshots *after* the branch-aware merge so it can't be clobbered. Gated on `OPENCLAW_MULTICORPUS_RETRIEVAL`. |
| **Merged-PR refresh** | `index.ts` `pull_request` handler — `closed && merged` enqueues `corpus-pr-upsert` (waitUntil, flag-gated). |
| **Linear-issue refresh** | `index.ts` `handleLinearWebhook` — `Issue` create/update enqueues `corpus-issue-upsert` (waitUntil, flag-gated). |
| **90-day backfill** | `index.ts` install/repos-added handler enqueues `corpus-pr-backfill` per repo; consumer uses the GitHub Search API (`GitHubClient.searchMergedPullRequests`, `is:pr is:merged merged:>=DATE`) to embed the last 90 days. |
| **Consumers** | `src/lib/multi-corpus-jobs.ts` — `handleCorpusPrUpsert` / `handleCorpusPrBackfill` / `handleCorpusIssueUpsert`, dispatched from the `queue()` switch via 3 new `JobMessage` variants. |
| **Linear → repo map** | issue consumer maps `team.key` → owner/repo via the existing `OPENCLAW_TEAM_GITHUB_REPO_MAP` (`listTeamRepoMappings`); unmapped teams no-op (inert for non-Linear repos). |

All producers gate on `multiCorpusEnabled(env)` and are best-effort (waitUntil +
per-call catch) so a corpus failure never affects code indexing or PR review.

**Known limitation:** the Linear webhook payload carries no issue identifier/state,
so the issue consumer does one `LinearClient.getIssue` fetch to resolve
`identifier`/`title`/`description`. Issue `status` isn't in the `LinearIssue`
projection, so the issue blocks render without a status label (the PR verdict
label is present). Adding `state` to the Linear GraphQL projection is a small
follow-up.

---

## Tests & verification
- New: `tests/lexical-index.test.ts` (13), `tests/hybrid-retrieval.test.ts` (4),
  `tests/multi-corpus.test.ts` (12), +5 in `tests/retrieval.test.ts`;
  `tests/_shims/d1-sqlite-shim.ts` (node:sqlite-backed D1 shim, FTS5-capable).
- `tsc --noEmit` clean, `eslint` clean.
- Existing `indexer-consumer` + `index-delete` suites still green.
- Pre-existing failures `badge-assets-version-mirror` + `bakeoff-report-cli` are
  Windows-only environment issues, unrelated to this change (verified on base).
