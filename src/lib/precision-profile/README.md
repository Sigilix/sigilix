# Precision profile (SIG-147)

Per-repo **accepted/dismissed finding outcome** feedback loop that tunes review
precision over time. Implicit behavioral signal — distinct from SIG-104's
explicit `/remember` facts — fed back into a compact per-repo `PrecisionProfile`
so repeatedly-dismissed **patterns** get suppressed and repeatedly-accepted
**categories** get boosted.

This module is the **schema + aggregation + review-time consumption** core. The
richer signal *capture* (reactions, top-level PR replies, formal
`pull_request_review.dismissed`) is **SIG-185** and feeds the same
`recordOutcome` API.

## Data flow

```
review outcome ──recordOutcome──▶ PrecisionProfile (KV, per repo) ──EMA──┐
  (dismissed / stale / accepted)                                         │
                                                                         ▼
                              review planner (ensemble gate) ◀──loadPrecisionProfile
                                         │
                          applyPrecisionProfile  → suppress dismissed patterns
                                                  (recall-safe: never a P0/P1)
```

## Schema (`types.ts`)

- `OutcomeEvent { repoId, category, patternHash, outcome }` — one observation.
  - `patternHash` = `computeContentFingerprint(category, path, body[0:80])` (SIG-217) — the **suppression** key.
  - `category` = `FindingCategory` — the **boost** key.
- `PrecisionProfile` — per-repo KV value at `precision-profile:repo:<repoId>`:
  - `patterns: { [patternHash]: { suppress, n, lastTs } }` — EMA in `[0,1]`, FIFO-capped at `MAX_PATTERNS`.
  - `categories: { [category]: { boost, n, lastTs } }`.

## Aggregation (`ema.ts`)

An exponential moving average (`EMA_ALPHA = 0.3`) per key keeps the signal
adaptive without a retrain. Targets per outcome:

| outcome     | pattern.suppress → | category.boost → |
|-------------|--------------------|------------------|
| `dismissed` | 1                  | 0                |
| `accepted`  | 0                  | 1                |
| `stale`     | 0 (relax)          | — (no signal)    |

A key acts only past `MIN_OBSERVATIONS` (3) and `SUPPRESS_THRESHOLD` /
`BOOST_THRESHOLD` (0.6).

## Review-time consumption (`apply.ts`)

`applyPrecisionProfile(findings, profile, { enforce })` at the ensemble soften
gate (`triage-pr-review-ensemble.ts`, alongside withdrawal filtering):

- **Suppression** is concrete: a finding whose pattern crossed the threshold is
  dropped (`enforce`) before posting. **Recall-safety hard floor**: a P0/P1
  (score ≥ 4) is **never** suppressed (`SUPPRESS_FLOOR_TIER`).
- **Boost** is *computed + surfaced* here but **applied at the SIG-104 prompt
  gate** (see below) — a blind post-synthesis score bump risks over-escalation,
  so we don't mutate scores at this gate.

## Rollout

`OPENCLAW_PRECISION_PROFILE_MODE`: `off` (default) → `shadow` (compute +
telemeter would-suppress, **no output change**) → `enforce` (filter). Mirrors
the review-memory `shadow → enforce` flag so the signal bakes before a flip.

## Outcome sources today

- **dismissed** — `@sigilix dismiss <reason>` / model concede (`github-mention.ts`), pattern-keyed on the finding fingerprint.
- **stale** — a dismissal whose SIG-217 decay window lapsed (`decayExpired`), relaxing the pattern.
- **accepted** — exposed via `recordOutcome(..., "accepted")`; capture is **SIG-185** (reactions / resolved threads / merged-survival).

## Integration points

### SIG-104 (`/remember` learnings) — boost application
SIG-104's explicit per-repo facts are injected into the specialist/synth
prompts. When that prompt gate lands, the **boost** dimension here ("categories
with high boost get priority in the suggestion prompt") should be applied at the
SAME gate — co-locate `profile.categories` (boosted set) with SIG-104's fact
injection. The two stores share the repo-scoped namespace but stay separate
(implicit behavioral signal vs. explicit facts).

### SIG-114 (systemic FP-rate) — FP-reduction telemetry
Each suppressed finding is an avoided false positive. The gate emits a
`precision-profile-decision` log (`suppressed` count) per review, and
`GET /metrics/precision?repo=<owner/repo>` exposes the rolling
`fpReduction.suppressingPatterns` count + boosted categories for the health
dashboard. This is computed from the SAME dismissal outcome data SIG-114's
`/metrics/fp-rate` reads, so FP-rate and FP-*reduction* trend on one signal.
