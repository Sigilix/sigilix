# `src/lib/review-memory/`

Cross-PR review memory feature (ARC-189). Sigilix tracks dismissal-shaped reviewer replies on its own past inline comments and uses those signals to soften (downgrade `score` by one tier) similar findings on future PRs in the same repo.

Spec: `docs/superpowers/specs/2026-05-07-arc-189-cross-pr-review-memory-design.md`
Plan: `docs/superpowers/plans/2026-05-07-arc-189-cross-pr-review-memory.md`

## Modules

| File | Purpose |
|---|---|
| `types.ts` | Pure types — `ReviewMemoryCategory`, `ReviewMemoryRecord`, `ReviewMemoryFinding`, `SigilixCommentMarker`, `ResolvedReviewMemoryConfig`, etc. |
| `marker.ts` | `buildSigilixMarker` / `extractSigilixMarker` (sha16 fid / sha12 path); `computeFid` / `computePathSha256` (Web-Crypto SHA-256 helpers shared with `storage.ts`); `categoryFromRoleHint` (1:1 internal-to-public mapping decoupled for future renames); `markerSeverityFromScore` (numeric score → tier banding for emission). Null `ruleId` canonicalizes to literal `"none"` sentinel. |
| `parse-dismissal.ts` | (Task 3) `parseDismissalSignal(body) → { kind: "dismissed-textual" } | null`. Keyword regex over reply text; bare-`nit` only. |
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

## Related modules

- `src/lib/triage-pr-review-ensemble.ts` — wires the synth-prompt block injection (Task 10a) and the `provenance.softened[]` score-decrement renderer (Task 10b).
- `src/lib/triage-pr-stale-mark.ts` — wires the `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE` deploy-time stale-mark suppression (Task 11), which is logically part of the ARC-189 deploy story since the PROMPT_VERSION bump lands in Task 10b.
- `src/lib/sigilix-config.ts` — adds the `reviewMemory` config block (Task 7) and `resolveReviewMemoryConfig` resolver.
