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
| `storage.ts` | (Task 4) `buildKey` / `readMemory` / `appendSignal` / `pruneStaleSignals`. KV-backed via existing `OPENCLAW_STATE`. |
| `lookup.ts` | (Task 5) `runReviewMemoryLookup({...}) → findings`. Reads category + path-category KV records, applies activation thresholds, caps + sorts. |
| `render.ts` | (Task 6) `renderReviewMemoryForPrompt(memories) → string`. Empty-string when no active memories (omit-empty contract). |
| `capture.ts` | (Task 9) `captureReviewFeedback(...)`. Webhook-side capture pipeline; runs via `ctx.waitUntil()`. |

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
- `src/lib/sigilix-config.ts` — adds the `reviewMemory` config block (Task 7) and `resolveReviewMemoryConfig` resolver.
