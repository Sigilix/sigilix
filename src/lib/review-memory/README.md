# `src/lib/review-memory/`

Cross-PR review memory feature (ARC-189). Sigilix tracks dismissal-shaped reviewer replies on its own past inline comments and uses those signals to soften (downgrade `score` by one tier) similar findings on future PRs in the same repo.

Spec: `docs/superpowers/specs/2026-05-07-arc-189-cross-pr-review-memory-design.md`
Plan: `docs/superpowers/plans/2026-05-07-arc-189-cross-pr-review-memory.md`

## Modules

| File | Purpose |
|---|---|
| `types.ts` | Pure types — `ReviewMemoryCategory`, `ReviewMemoryRecord`, `ReviewMemoryFinding`, `SigilixCommentMarker`, `ResolvedReviewMemoryConfig`, etc. |
| `marker.ts` | `buildSigilixMarker` / `extractSigilixMarker` (sha16 fid / sha12 path); `computeFid` / `computePathSha256` (Web-Crypto SHA-256 helpers shared with `storage.ts`); `categoryFromRoleHint` (1:1 internal-to-public mapping decoupled for future renames); `markerSeverityFromScore` (numeric score → tier banding for emission). Null `ruleId` canonicalizes to literal `"none"` sentinel. |
| `parse-dismissal.ts` | `parseDismissalSignal(body) → { kind: "dismissed-textual" } | null`. Keyword set: `not relevant`, `false positive`, `ignore`, `noise`/`noisy`, `dismiss`, `won't fix`, `wontfix`. `nit` is BARE-ONLY (entire trimmed reply equals `nit`/`nit.`/`nit!`); prefix-style `nit: ...` is NOT a dismissal because reviewers use it for their own self-flagged nits. Triple-backtick code blocks are stripped before scanning so keywords inside code samples don't trip the parser. |
| `storage.ts` | KV layer over existing `OPENCLAW_STATE` namespace. `buildKey` derives `review-memory:<owner>/<repo>:cat:<category>` (category scope) or `review-memory:<owner>/<repo>:path:<sha256>:cat:<category>` (path scope; FULL SHA-256 in key). `readMemory` returns null on missing / corrupt / schema-mismatch with telemetry. `appendSignal` is read-modify-write: prune-then-append, FIFO-cap at 50, 90d TTL refresh, never throws (capture-failed telemetry on KV write throw). `pruneStaleSignals` is a pure helper; defaults 180d hard retention. Best-effort under KV no-CAS — concurrent appends can lose one signal; threshold-3 absorbs the loss per spec §4.2. |
| `lookup.ts` | `runReviewMemoryLookup({...}) → findings`. Gates on env + sigilix.json (default OFF on both). Reads category-scope + path-category-scope KV records via `Promise.allSettled`. Applies §4.5 activation: ≥3 dismissal signals in trailing 90d for category-scope; same plus ≥1 signal in trailing 30d for path-scope. Caps at `maxInjectedMemories` (default 5). Sort: `(lastSignalTs desc, signalCount desc, category asc)`. Pure helpers `isMemoryActive` + `selectTopMemories` exposed for testing. Never throws. |
| `render.ts` | `renderReviewMemoryForPrompt(memories) → string`. Empty-string when no active memories (omit-empty contract). Header (~55 tokens) + per-record lines (≤25 tokens each, ellipsis-truncated on overrun) under a global 200-token cap. Whole-record inclusion: if the 5th record would push over the cap, drop it entirely rather than truncate mid-record. Header carries the `provenance.softened[]` instruction the synth uses to downgrade matching findings (Task 10b). pathSha12 rendered only — never raw repo-relative paths (privacy contract spec §9). |
| `capture.ts` | `captureReviewFeedback(...)`. Webhook-side capture pipeline; runs via `ctx.waitUntil()` so KV+GH I/O never blocks the webhook response. Pipeline: ID resolution (parent must exist via `in_reply_to_id`) → gate-check → seen-marker dedupe → parent fetch via `client.getPullRequestReviewComment` → `extractSigilixMarker` → `parseDismissalSignal` → seen-marker write → parallel `appendSignal` for category-scope + path-category-scope. Path-scope KV key uses full SHA-256 of `replyComment.path` so the keyspace matches `lookup.ts`. Best-effort under no-CAS: concurrent same-commentId deliveries can record up to 2 signals (threshold-3 absorbs). Never throws. |

## Privacy contract

- No raw repo-relative paths anywhere — keys, values, or rendered prompts.
- No reviewer login persisted.
- No PR title or body.
- No `evidenceQuote` (free-text would have been hard to redact safely; deferred to v2 with a real PII bundle).
- KV TTLs at 90 days on key writes; per-signal pruning at 180 days hard cap.

## Marker emission on posted comments (Task 2.5)

Markers are appended to every Sigilix-authored inline comment body via the `findingMarkers?: ReadonlyArray<string | null>` field on `BuildReviewArgs`. The ensemble pre-computes them in `src/lib/triage-pr-review-ensemble.ts` immediately before calling `buildReviewSubmission`:

```ts
const findingMarkers = await Promise.all(
  validated.verdict.findings.map(async (f, i) => {
    const sourceSpec = validated.cleanFindingProvenance[i]?.sourceSpecialists?.[0]
    if (!sourceSpec) return null
    return await buildSigilixMarker({
      ruleId: null,
      path: f.path, line: f.line, headline: f.headline,
      category: categoryFromRoleHint(sourceSpec),
      severity: markerSeverityFromScore(f.score),
    })
  }),
)
```

Why provenance and not `f.category`: the rendered `FindingCategory` has 9 values (logic / security / performance / error-handling / testing / complexity / style / syntax / docs); `ReviewMemoryCategory` has 4. The right category source is the SPECIALIST that produced the finding, captured in `provenance.findings[i].sourceSpecialists[0]`. `validateForSubmission` now emits a parallel `cleanFindingProvenance` array aligned by index with `verdict.findings` for this purpose.

Findings with no source specialist (defensive — shouldn't happen post-hallucination guard) emit `null` and skip the marker. The fallback (anchorless body) submission path does NOT emit markers in v1 — `pull_request_review` events aren't subscribed (deferred to v2 alongside `issue_comment.created` capture).

## Related modules

- `src/lib/triage-pr-review-ensemble.ts` — wires the synth-prompt block injection (Task 10a) and the `provenance.softened[]` score-decrement renderer (Task 10b). Also emits sigilix markers on posted comments (Task 2.5).
- `src/lib/triage-pr-review.ts` — `buildReviewSubmission` accepts the per-finding `findingMarkers` array and appends each non-null entry to the inline comment body with a blank-line separator.
- `src/lib/triage-pr-stale-mark.ts` — wires the `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE` deploy-time stale-mark suppression (Task 11), which is logically part of the ARC-189 deploy story since the PROMPT_VERSION bump lands in Task 10b.
- `src/lib/sigilix-config.ts` — adds the `reviewMemory` config block + `resolveReviewMemoryConfig` resolver. Strict-bool `enabled` + `captureOnly` (literal `true` only opts in). Clamps `maxInjectedMemories ∈ [1,10]` (default 5), `minSignalThreshold ∈ [2,20]` (default 3), `maxSignalAgeDays ∈ [7,365]` (default 90). `categories` array filtered + deduped against the 4-value literal union; empty array resolves to all 4.
