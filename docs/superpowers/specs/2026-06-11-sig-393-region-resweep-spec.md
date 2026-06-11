# SIG-393 — Region re-sweep: effort-gated second pass — engine spec (DRAFT)

**Status:** FINAL — granularity decided by the window-vs-file K=8 comparison (2026-06-11).
**Parent:** SIG-369 / lane SIG-392. **Branch (engine work):** `sig-393-region-resweep`.
**Prototype evidence:** `e2e/fixture-eval-resweep.live.test.ts` on branch `sig-393-resweep-prototype`.

## Evidence base (local harness, K=8 per variant, corrected matchers)

| Variant | pass1 mean | union mean | within-run lift | extra calls/PR | ungated hi-sev FP (8 runs) |
|---|---|---|---|---|---|
| File-level regions | 9.0/20 (45%) | 11.75/20 (59%) | **+2.75 rows** | 8–12 | 76 |
| Window regions (~55 added lines) | 9.0/20 (45%) | 11.38/20 (57%) | +2.38 rows | 20–24 | 113 |

Stable flips across variants: b12 (refund race, 0/8 baseline), b18, b11, b13; b15/b9 stabilized to 8/8. The union reliably reaches ~15/20 distinct rows vs prod's 8.

Key facts the design must honor:
- The lift is real and repeats: +2..+6 rows on every repeat, both variants' pass1 within noise of the committed baseline.
- All stable file-mode wins came from the SMALL flagged file (refunds.ts, 40 added lines); whole-file re-sweeps of the 183-line payments.ts re-saturated. Region size is the binding variable.
- The lever's FP pressure is significant ungated (~9.5 hi-sev/run) but ~⅓ of raw "FPs" were wording-variant true catches; the genuinely-confabulated classes (sign-inversions, claims contradicted by visible code) are exactly what the existing verification/grounding gates target. THE GATES ARE LOAD-BEARING: this lever must never bypass them.
- **Measurement caveats (code-review findings):** (1) the prototype's guidance lists pass-1 headlines verbatim, which can prime pass-2 wording toward matcher keywords — the absolute lift is an UPPER BOUND (both granularity variants share the bias, so the file-vs-window decision stands); the engine version passes finding *categories + line anchors*, not verbatim headlines, partly to de-bias and partly to avoid echo findings. (2) The prototype's union does not dedupe across passes, so a defect reported in both passes double-counts in the precision denominator — union precision reads slightly deflated; row-flips (set-based) are unaffected and remain the verdict metric.
- Cost: +8–20 model calls on a dense PR (regions × 4 roles), pass-2 wall ≈ one fanout (~90–170s parallel).

## Where it lives in the pipeline

After the specialist fanout collects verdicts and BEFORE synth (`ensemble/app/specialists.ts`, between verdict collection and `runSynthPhase`):

1. **Effort gate** (see below) decides re-sweep on/off for this PR.
2. Regions = flagged paths from first-pass findings, split per the granularity rule.
3. Re-sweep fan-out: per region × dispatched role, same `runSpecialist` machinery, prompt = region diff slice + guidance block (first-pass findings in that region + "enumerate every OTHER issue; no repeats; no style nits").
4. Re-sweep verdicts merge into the specialist verdict set with provenance `pass: "resweep"` on each finding (telemetry + renderer-invisible), then flow through the UNCHANGED path: synth → validation gates → grounding → verification → trust ledger. **No new posting surface, no gate bypass.**

## Effort gate (the lane allocator's first concrete trigger)

Fire re-sweep only when ALL of:
- effort score ≥ 5/5 (the existing effort computation; the dense fixture scores 5/5), OR ≥2 distinct regions each carrying ≥2 first-pass findings (clustered-findings trigger from the epic);
- diff touches ≥1 high-risk surface (auth/billing/payments/webhooks/data-scope — the epic's list) OR reviewable added lines ≥ 150;
- total re-sweep calls capped: ≤ `RESWEEP_MAX_REGIONS` (default 6) × dispatched roles, and per-region diff slice ≤ the slice budget. Overflow = drop lowest-finding-count regions, emit telemetry.

Small PRs never fire it. The decision + reasons emit as `resweep-gate-decision` (lane telemetry for SIG-369 Phase 5).

## Flags / rollout (shadow → on, the epic's guardrail)

- `OPENCLAW_RESWEEP_MODE`: `off` (default) | `shadow` | `on`.
- `shadow`: re-sweep runs, candidates are scored/logged (`resweep-shadow-summary`: candidates, would-survive-gates count, per-region counts, elapsed) but NOT merged into the synth input. Zero posted-output change.
- `on`: candidates merge pre-synth as §pipeline above.
- Promotion bar (from the epic): material recall lift on the frozen fixture via `score --pr` on a re-reviewed clone, high-sev FP flat post-gates, default-lane p50 unmoved (gate keeps small PRs out), deep-lane latency reported.

## Telemetry

`resweep-gate-decision` (fired/skipped + reasons), `resweep-summary` (regions, calls, candidates, post-gate kept/demoted/dropped, elapsedMs), per-finding `pass:"resweep"` provenance through the validation events. All additive, follows ensemble-perf-telemetry conventions.

## Granularity rule — DECIDED: file-level regions

Window granularity delivered equal lift (+2.38 vs +2.75 rows, within noise) at ~2× the call cost and more ungated FPs (113 vs 76 across 8 runs). **Regions = whole flagged files.** The hard tail (b4, b8, b16, b19, b20) did not flip at either granularity — even with the webhook/charge code isolated in dedicated ~55-line windows — so those misses are NOT saturation (re-asking smaller doesn't help): they are lens blind spots (status-code semantics, type-cast contract drift, the unused event-type arm, HMAC byte semantics) and are **explicitly deferred to SIG-395 (invariant lens)**, with SIG-394 per-unit fanout now looking low-value for recall (the windowed re-sweep approximates it and added nothing). The prototype's `splitSectionIntoRegions` stays in the harness for future experiments; the engine does NOT port it.

## Tests

- Pure: gate decision table (effort/cluster/risk/cap branches); region splitting (port the prototype's splitter tests); guidance builder; provenance threading.
- Golden: shadow-mode emits summary without changing posted output (validation-matrix pattern).
- Live ruler: the prototype test itself, kept as the lever's regression harness (key-gated).
- Promotion evidence: `evals score --pr ... --baseline ... --label sig-393-shadow` Δ block in the enforce PR.

## Non-goals

- No synth changes (b14/b15 prod-miss investigation is separate — context-ablation experiment, not this lever).
- No per-unit full fanout (SIG-394) and no invariant lens (SIG-395).
- No model/prompt changes to the first pass.
