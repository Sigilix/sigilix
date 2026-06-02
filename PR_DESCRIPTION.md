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

## SIG-44 — Multi-corpus retrieval (merged PRs + Linear issues) — 🟡 review-time core built & tested

**Why:** retrieval only sees code, so the bot can't say "this looks like the same
regression we fixed in PR #234" or cite a Linear decision.

**Built & tested (`src/lib/multi-corpus.ts`):**
- `pr:<owner>/<repo>` and `issue:<owner>/<repo>` namespace helpers (prefixes on
  the code namespace, well under Vectorize's 64-byte cap, same 768-dim bge
  embeddings).
- Embed-text builders + stable doc ids (`pr-234`, `issue-arc-42`) so refresh
  overwrites rather than duplicates.
- `upsertPrDoc` / `upsertIssueDoc` — embed + upsert write helpers with metadata
  (`kind`, `ref`, `title`, `verdict`/`status`, `content`).
- `retrieveMultiCorpus` — queries `pr:` + `issue:` in parallel, soft-fails per
  leg, emits `pr-review-retrieval-multicorpus` telemetry with per-namespace hit
  counts + top scores.
- `formatMultiCorpusForPrompt` — labeled blocks
  (`--- past PR #234 (verdict: changes_required) ---`), bounded per-block/total.
- Flag `OPENCLAW_MULTICORPUS_RETRIEVAL` reserved for the ensemble injection seam.

**Remaining integration (follow-up — the plumbing, not the logic):**
1. **Backfill:** on new-repo onboarding, fetch last 90 days of merged PRs via the
   GitHub Search API and `upsertPrDoc` them (hook in the indexer queue consumer).
2. **Refresh webhooks:** `pull_request closed+merged` → `upsertPrDoc`; Linear
   `Issue` webhook → `upsertIssueDoc` (new handlers in `src/index.ts`).
3. **Read injection:** call `retrieveMultiCorpus` + append
   `formatMultiCorpusForPrompt` in the ensemble preflight
   (`triage-pr-review-ensemble.ts`), gated on `OPENCLAW_MULTICORPUS_RETRIEVAL`.

These were deliberately left out of this PR: they touch the budget-tuned ensemble
hot path and the 8.4k-line webhook router, and would be runtime no-ops until the
write path populates the corpora. Splitting keeps this PR reviewable and the core
logic independently verified.

---

## Tests & verification
- New: `tests/lexical-index.test.ts` (13), `tests/hybrid-retrieval.test.ts` (4),
  `tests/multi-corpus.test.ts` (12), +5 in `tests/retrieval.test.ts`;
  `tests/_shims/d1-sqlite-shim.ts` (node:sqlite-backed D1 shim, FTS5-capable).
- `tsc --noEmit` clean, `eslint` clean.
- Existing `indexer-consumer` + `index-delete` suites still green.
- Pre-existing failures `badge-assets-version-mirror` + `bakeoff-report-cli` are
  Windows-only environment issues, unrelated to this change (verified on base).
