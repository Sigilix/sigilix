# `src/lib/review-memory/`

Cross-PR review memory feature (ARC-189). Sigilix tracks dismissal-shaped reviewer replies on its own past inline comments and uses those signals to soften (downgrade `score` by one tier) similar findings on future PRs in the same repo.

Spec: `docs/superpowers/specs/2026-05-07-arc-189-cross-pr-review-memory-design.md`
Plan: `docs/superpowers/plans/2026-05-07-arc-189-cross-pr-review-memory.md`

## Modules

| File | Purpose |
|---|---|
| `types.ts` | Pure types — `ReviewMemoryCategory`, `ReviewMemoryRecord`, `ReviewMemoryFinding`, `SigilixCommentMarker`, `ResolvedReviewMemoryConfig`, etc. |
| `marker.ts` | `buildSigilixMarker` / `extractSigilixMarker` (sha16 fid / sha12 path); `computeFid` / `computePathSha256` (Web-Crypto SHA-256 helpers shared with `storage.ts`); `categoryFromRoleHint` (1:1 internal-to-public mapping decoupled for future renames); `markerSeverityFromScore` (numeric score → tier banding for emission). Null `ruleId` canonicalizes to literal `"none"` sentinel. |
| `parse-dismissal.ts` | `parseDismissalSignal(body) → { kind: "dismissed-textual" } \| null` plus SIG-185 `parseReviewFeedbackSignal(body) → dismissed \| accepted \| null`. Dismissal keyword set: `not relevant`, `false positive`, `ignore`, `noise`/`noisy`, `dismiss`, `won't fix`, `wontfix`. `nit` is BARE-ONLY (entire trimmed reply equals `nit`/`nit.`/`nit!`); prefix-style `nit: ...` is NOT a dismissal because reviewers use it for their own self-flagged nits. Triple-backtick code blocks are stripped before scanning so keywords inside code samples don't trip the parser. Accepted feedback is intentionally narrow (`good catch`, `fixed`, `addressed`, etc.) and only used after the caller has verified the comment is responding to a Sigilix finding. |
| `storage.ts` | KV layer over existing `OPENCLAW_STATE` namespace. `buildKey` derives `review-memory:<owner>/<repo>:cat:<category>` (category scope) or `review-memory:<owner>/<repo>:path:<sha256>:cat:<category>` (path scope; FULL SHA-256 in key). `readMemory` returns null on missing / corrupt / schema-mismatch with telemetry. `appendSignal` is read-modify-write: prune-then-append, FIFO-cap at 50, 90d TTL refresh, never throws (capture-failed telemetry on KV write throw). `pruneStaleSignals` is a pure helper; defaults 180d hard retention. Best-effort under KV no-CAS — concurrent appends can lose one signal; threshold-3 absorbs the loss per spec §4.2. |
| `lookup.ts` | `runReviewMemoryLookup({...}) → findings`. Gates on env + sigilix.json (default OFF on both). Reads category-scope + path-category-scope KV records via `Promise.allSettled`. Applies §4.5 activation: ≥3 dismissal signals in trailing 90d for category-scope; same plus ≥1 signal in trailing 30d for path-scope. Caps at `maxInjectedMemories` (default 5). Sort: `(lastSignalTs desc, signalCount desc, category asc)`. Pure helpers `isMemoryActive` + `selectTopMemories` exposed for testing. Never throws. |
| `render.ts` | `renderReviewMemoryForPrompt(memories) → string`. Empty-string when no active memories (omit-empty contract). Header (~55 tokens) + per-record lines (≤25 tokens each, ellipsis-truncated on overrun) under a global 200-token cap. Whole-record inclusion: if the 5th record would push over the cap, drop it entirely rather than truncate mid-record. Header carries the `provenance.softened[]` instruction the synth uses to downgrade matching findings (Task 10b). pathSha12 rendered only — never raw repo-relative paths (privacy contract spec §9). |
| `capture.ts` | `captureReviewFeedback(...)`, `captureTopLevelReviewFeedback(...)`, and `captureDismissedReviewFeedback(...)`. Webhook-side capture pipeline; runs via `ctx.waitUntil()` so KV+GH I/O never blocks the webhook response. Inline replies still use `in_reply_to_id` to fetch and author-gate the parent Sigilix comment. Top-level PR comments require explicit marker/fingerprint correlation and verification against a Sigilix-authored PR comment/review comment; no timeline-order heuristic is trusted. Dismissed formal reviews record SIG-147 `stale` outcomes only when the dismissed Sigilix review was posted against an older commit than the current PR head and contains mappable finding fingerprints. Review-memory dismissal signals write category scope plus path-category scope when the trusted source has a raw path. Precision-profile outcomes write only when a hidden finding fingerprint is available. Best-effort under no-CAS: concurrent same-commentId deliveries can record up to 2 signals (threshold-3 absorbs). Never throws. |

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

## SIG-276 — structured claims (Phases 2–3)

A finding carries 0–3 enum-bounded **claims** classifying the *pattern it asserts*
(`ReviewMemoryClaimType`, 4 values). The goal: generalize memory on the specific
pattern a team rejects, not just `(category)` / `(path, category)`.

**Phase 2 (capture, shipped):** a write-time classifier (`claim-extractor.ts`,
gated `OPENCLAW_REVIEW_MEMORY_CLAIMS`) tags each finding; claims ride the marker's
optional `:claims:type~confPct~ver` segment (`marker.ts`); on dismissal,
`capture.ts` hydrates each `id = sha16("extractorVersion:type")` (`hydrateClaimIds`)
onto `ReviewMemorySignal.claims[]`, stored on BOTH the category- and path-scope
records. Raw (uncalibrated) confidence is stored deliberately so a later phase can
calibrate it *before* it ever drives softening.

**Phase 3 (SHADOW-ONLY lookup, this work):** observation-only claim matching that
emits a telemetry corpus for Phase-4 calibration. **It changes no softening** — the
posting path is byte-identical to pre-Phase-3.

- **Three-flag gate.** The shadow pass is a no-op unless ALL of
  `OPENCLAW_REVIEW_MEMORY_ENABLED`, `OPENCLAW_REVIEW_MEMORY_CLAIMS`, and the new
  `OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW` (default off) are `"on"`. Off ⇒ zero added
  latency, byte-identical behavior. The literal `"render"`/`"soften"` values of the
  shadow flag are RESERVED for Phase 4 and not wired.
- **Two sites — and WHY it must split.** `runReviewMemoryLookup` runs *before* the
  synth prompt is assembled, but an incoming finding's claims (`claimsPerFinding`)
  only exist *after* synth + consensus ranking. So matching cannot be one call:
  - **Site 1 (`lookup.ts` `aggregateShadowClaims`)** aggregates the stored signals'
    claims onto a telemetry-only `shadowClaims?` field on `ReviewMemoryFinding`
    (only when the shadow flag is on, only on already-active memories).
  - **Site 2 (`shadow-match.ts` `shadowMatchReviewMemoryClaims`, called from the
    ensemble post-synth)** matches the incoming finding's claim types against those
    `shadowClaims` and emits ONE `review-memory-claim-shadow` event per review.
    Its output is block-scoped and consumed by NOTHING (a test asserts this).
- **Match on `claim.type`, NOT `claim.id`.** `computeClaimId` folds `extractorVersion`
  into the id, so id-matching would silently false-negative across an extractor
  bump. We match on the stable enum and flag `version_mismatch` when the incoming
  version is not in the stored set, so Phase 4 can measure the id-match's would-be
  false-negative rate. (`version_mismatch` is uniformly false until the extractor
  bumps past v1.)
- **Counting rule:** `distinctPrCount` counts DISTINCT `signal.prNumber`, never raw
  signal rows — one noisy thread cannot teach a repo-wide claim. Per-repo only
  (inherited from the keyspace); never pooled across tenants.
- **`wouldSoftenAtFloor`** (distinct-PR floor, default 2) is a Phase-4-tunable
  telemetry LABEL — it GATES NOTHING in Phase 3.
- **Architecture-category dead-zone (documented, not a bug).** `SpecialistRole` has
  no `architecture`, so incoming findings never carry `category=architecture`; a
  stored architecture-scope memory can never type-match. This benignly undercounts
  the architecture corpus — Phase 4 must interpret architecture coverage with this
  in mind.
- **Lookup-output-type constraint.** `aggregateShadowClaims` MUST stay inside
  `lookup.ts` over `record.signals` — it cannot move to the match site because
  `ReviewMemoryFinding` does not carry `signals[]` forward.

**Deferred to Phase 4:** calibrating raw confidence (isotonic/Platt) BEFORE any
aggregation, a learned label model over dismissal outcomes, empirically picking the
distinct-PR floor from the shadow corpus, and wiring the reserved `"render"`/
`"soften"` activation modes. Phase 3 only generates the corpus.
