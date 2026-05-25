# SIG-161 — Confidence-threshold verdict gate: design + labeling protocol

**Status:** design draft, 2026-05-23
**Issue:** [SIG-161](https://linear.app/sigilix/issue/SIG-161)
**Related:** [SIG-160](https://linear.app/sigilix/issue/SIG-160) (verdict flap defect this addresses), [SIG-101](https://linear.app/sigilix/issue/SIG-101) (prior `confidence: 1-5` per-finding work)
**Prior research:** `.claude/handoff/sig-160-research-codex.md`, `.claude/handoff/sig-160-research-deepseek.md`

---

## 1. What we're actually shipping

The customer-visible behavior change is small and load-bearing:

> Every emitted finding carries a 0–1 gate score. Sigilix posts
> `REQUEST_CHANGES` only when at least one finding clears a calibrated
> threshold. Findings in the borderline band post as `COMMENT` (a real
> GitHub review event, no verdict change). Findings below the floor
> are suppressed pre-emit.

Three implementation pieces:

1. **Schema:** a new per-finding `gateScore` field that carries 0–1 resolution.
2. **Verdict gate:** `chooseReviewEvent` becomes threshold-aware (four events: `REQUEST_CHANGES` from blocking findings or open Sigilix items, `COMMENT` from borderline findings, `APPROVE` from no findings).
3. **Calibration:** a labeled dataset selects the threshold. **Two stages**: stage-1 ships N=200 + 90% CI + FPR ≤ 10% (statistically supportable); stage-2 expands to N≈600 + 95% CI + FPR ≤ 5% (the SIG-161 headline target, supportable only at the larger sample).

> **Current state (2026-05-25):** the committed corpus is **76 findings**, **underpowered** vs. the planned N=200. Stage-1 calibration is therefore **provisional** and enforcement gating (`OPENCLAW_GATE = "enforce"`) is **blocked** until the sample is expanded.

Everything else (prompt rubric, temperature lock, suppression telemetry, feature flag, KV-backed runtime config) supports these three.

The PR is split into PR 4a (schema + gate plumbing, no behavior change), PR 4b (prompt rubric + temperature + flag to `shadow`), PR 4c (calibration artifact + flag to `enforce`). See §11.

## 2. Why the existing `confidence: 1-5` (SIG-101) is not enough

SIG-101 added a per-finding `confidence?: number` in the 1–5 integer range. It's used for:
- Renderer suffix (`_confidence: N/5_`)
- `<details>` collapsing at `≤ 2`
- Committable-suggestion floor (`HIGH_CONFIDENCE_FLOOR = 4`)

It is **not** used by the verdict gate. `chooseReviewEvent` is still `findings.length > 0 → REQUEST_CHANGES` (`src/lib/triage-pr-review.ts:979`).

Why we can't just promote the existing 1–5 to drive the gate:

- **Resolution.** DeepSeek's analysis hinges on distinguishing 0.85 from 0.90 — that resolution is meaningful at FPR ≤5%. An integer 1–5 scale collapses everything in the [0.75, 1.0] range into the single value `5`. We cannot calibrate.
- **Semantics.** The 1–5 field is **self-reported confidence in the finding's domain fit** (originally `confidenceInLens`, then conflated into `confidence` by SIG-101). It is *not* a calibrated probability of correctness. Self-reported LLM confidence at category-coarse granularity correlates weakly with TP/FP at best.
- **Calibration evidence.** LLM self-report is famously overconfident at the high end and underconfident at the low end (cf. Lin et al. 2022, "Teaching Models to Express Their Uncertainty in Words"). The labeling exercise is what decides whether to keep raw self-report or replace it with a structurally synthesized confidence.

## 3. Schema decision — two fields, not one

We keep `confidence: 1-5` (self-reported, display-facing, drives existing renderer behavior). We add a new field that is the **gate score driving `chooseReviewEvent`**:

```typescript
interface PrReviewFinding {
  // existing
  confidence?: number  // 1-5, self-reported, drives renderer (KEEP)

  // SIG-161 NEW
  gateScore?: number   // 0-1, post-hoc, drives chooseReviewEvent
}
```

Naming: `gateScore` (revised on Codex review). Earlier draft used `calibratedScore` — Codex correctly noted that overclaims during the placeholder phase (the v1 blend is hand-tuned, not calibrated). `gateScore` describes what the field DOES (drives the gate), not what method produced it; it stays accurate before AND after labeling. Other candidates rejected:

- `confidence01` — reads like a v2 of `confidence`; invites the wrong mental model.
- `calibratedConfidence` — verbose, duplicates "confidence" everywhere.
- `probTruePositive` — most precise but lands as jargon in code-review threads.
- `reviewGateScore` — accurate but verbose; `gateScore` shadows fine in the `PrReviewFinding` namespace.

`gateScore` is **not emitted by the LLM**. It is computed by a deterministic post-processing step (see §5) from signals the orchestrator already collects:

- Self-reported `confidence` (1–5, rescaled)
- Specialist agreement (how many specialists' source findings merged into this synth finding via `provenance.sourceFindingIds`)
- Evidence-citation presence (`cweId`, `evidenceId`, `complexityEstimate`, `hotPathIdentifier`, `inspectedTestFiles`, `evidenceRefs` populated)
- Severity (`score` 1–5)
- Validation-gate outcomes (passed/wouldDrop in SIG-119 shadow telemetry)

The blending formula is **learned from the labeled dataset**, not designed up front. The shipped PR scaffolds the field + the gate + a placeholder hand-blend (§5); the calibration step (§8c) replaces the blend with a logistic regression once labels exist.

### Why deterministic blending beats raw self-report

A finding with all five evidence citations present, severity 5, three-way specialist agreement, and self-reported confidence 5/5 is meaningfully different from a finding with self-reported 5/5 alone. The structural signals are noise-free; the self-report is noisy. Blending them shifts the threshold's operating point toward signals that aren't gameable by an overconfident model.

## 4. Verdict-gate bands

The gate is a **four-event** decision (not three), because `COMMENT` is now a real GitHub review event we emit — not just "post inline without verdict."

| Condition | Verdict event |
| --- | --- |
| At least one finding has `gateScore >= chosenThreshold` | `REQUEST_CHANGES` |
| No blocking findings, AND any Sigilix-authored open items exist | `REQUEST_CHANGES` |
| No blocking findings, AND any finding has `gateScore ∈ [FLOOR_SUPPRESS, chosenThreshold)` | `COMMENT` |
| No findings (everything below `FLOOR_SUPPRESS` suppressed) | `APPROVE` |

Constants:

- `chosenThreshold` — set by calibration; ship time = `0.85` (DeepSeek's starting point), revised after labeling.
- `FLOOR_SUPPRESS` = `0.60` (per the SIG-161 spec — fixed, not calibrated).

Gate logic (options-object API; revised on Codex review — the earlier positional API `(findings, threshold, openItems)` was a misuse footgun because existing call sites pass `(findings, openItems)`):

```typescript
type MissingScorePolicy = "block" | "permit" | "throw"

export interface ChooseReviewEventArgs {
  findings: PrReviewFinding[]
  threshold: number
  openItems?: ReadonlyArray<AuthoredItem>
  missingScorePolicy: MissingScorePolicy
}

export function chooseReviewEvent(args: ChooseReviewEventArgs): ReviewEvent {
  const { findings, threshold, openItems = [], missingScorePolicy } = args

  // Treat a finding with no gateScore per the policy:
  //   "block"  — score it as 1.0 (rollout fail-open; behaves like today)
  //   "permit" — score it as 0.0 (post-calibration: missing score = trust suppression)
  //   "throw"  — pipeline invariant: gate should never see a finding without a score
  const effectiveScore = (f: PrReviewFinding): number => {
    if (typeof f.gateScore === "number") return f.gateScore
    if (missingScorePolicy === "block") return 1.0
    if (missingScorePolicy === "permit") return 0.0
    throw new Error(`gateScore missing on finding ${f.path}:${f.line}; pipeline invariant`)
  }

  const blocking = findings.filter((f) => effectiveScore(f) >= threshold)
  if (blocking.length > 0) return "REQUEST_CHANGES"

  const sigilixOpenItems = filterToSigilixAuthored(openItems)
  if (sigilixOpenItems.length > 0) return "REQUEST_CHANGES"

  // No blocking finding, no open Sigilix items — distinguish empty (APPROVE)
  // from "had findings, none blocking" (COMMENT). The latter is the new event
  // SIG-161 introduces.
  if (findings.length > 0) return "COMMENT"

  return "APPROVE"
}
```

`missingScorePolicy` is the explicit hook for the rollout vs post-calibration regime:
- **Flag `off` / `shadow`:** caller passes `"block"`. Findings without a score block like today; nothing changes for customer-visible behavior.
- **Flag `enforce` (was `post` — see §9):** caller passes `"throw"`. A missing score is a pipeline invariant failure, not silent block. We want loud failures once the gate is the law.
- **`"permit"`** is reserved for offline replay / backfill scripts that intentionally synthesize verdicts on findings that pre-date the field.

`ReviewEvent` widens from `"APPROVE" | "REQUEST_CHANGES"` to `"APPROVE" | "REQUEST_CHANGES" | "COMMENT"`. The renderer (`buildReviewSubmission`) needs to handle the new event — when emitting `COMMENT`, the review body uses the existing "approve-style" copy (the finding bodies make the point; the summary doesn't claim a verdict change). Renderer changes live in `src/lib/triage-pr-review.ts` and are tested per §10.

Suppression at `< FLOOR_SUPPRESS` happens in the ensemble's pre-emit filter (alongside review-memory softening, withdrawal suppression, structural-glue suppression), not in `chooseReviewEvent`. The gate only sees findings that already survived suppression — so when a finding does reach the gate, the gate just classifies it into one of the bands.

## 5. The `gateScore` blend (initial form)

The shipped formula is intentionally simple. Calibration replaces coefficients with values fitted on labels (§7), or replaces the formula entirely with a learned model (§8) if labeling supports it.

```typescript
function computeGateScore(f: PrReviewFinding, p: Provenance): number {
  // Rescale self-reported 1-5 to 0-1, conservative on the high end
  // (avoids collapsing the model's overconfident "5/5" claims to 1.0).
  const confRaw = f.confidence ?? 3        // missing self-report = neutral
  const conf = ({ 1: 0.10, 2: 0.30, 3: 0.50, 4: 0.75, 5: 0.90 } as const)[
    Math.max(1, Math.min(5, Math.round(confRaw))) as 1 | 2 | 3 | 4 | 5
  ]

  // Structural signals — each is a 0-1 boost
  const evidence = hasRequiredEvidence(f) ? 0.10 : 0
  const agreement = Math.min(0.10, 0.05 * (p.sourceSpecialists.length - 1))
  const severity = ({ 1: -0.10, 2: -0.05, 3: 0, 4: 0.05, 5: 0.10 } as const)[
    Math.max(1, Math.min(5, Math.round(f.score))) as 1 | 2 | 3 | 4 | 5
  ]

  // Blend, clamp to [0, 1]
  return Math.max(0, Math.min(1, conf + evidence + agreement + severity))
}
```

`hasRequiredEvidence(f)`:

- `security` with `score >= 4` → `cweId` present AND `evidenceId` present (per SIG-108 contract)
- `performance` with `score >= 4` → at least one of `complexityEstimate`, `hotPathIdentifier`
- `testing` → at least one of `inspectedTestFiles`, `evidenceRefs`
- other categories → `true` (no per-category requirement today)

Two properties this formula has by design:

- **Weakly monotone in every input.** Higher self-report, more specialist agreement, evidence present, higher severity — none push the score down. The clamp at `1.0` makes monotonicity weak (saturated; further increases in inputs don't change the output) rather than strict, which DeepSeek flagged. Acceptable for v1; documented so a reader of `computeGateScore` isn't surprised that two distinct input vectors map to the same `1.0`.
- **Bounded in `[0, 1]`** without saturating at the extremes prematurely. A self-report 5/5 with no evidence and no agreement caps at `0.90`. With full evidence + 3-way agreement, the raw sum reaches `1.05` clamped to `1.0`. Score 1 with no evidence and no agreement floors at `0.0`.

After labeling, this v1 hand-blend is **replaced**, not tuned. DeepSeek's recommendation (which we adopt): once labels exist, fit a logistic regression on the same feature vector (rescaled-confidence, evidence flag, agreement count, severity) to predict the TP/FP label. The logistic's `predict_proba` becomes the new `computeGateScore`. The hand-blend stays in the codebase only as the fallback when the calibration model artifact is unavailable (e.g. a redeploy that loses the model file). The fallback's coefficients are never re-tuned by hand — once labels exist, we either have the model or we don't.

## 6. Specialist-side changes — prompt + temperature

Two changes per the SIG-161 acceptance criteria:

### 6a. `temperature: 0` at the specialist level

The ensemble currently runs at the specialist's default temperature (Ollama-router default). Force `temperature: 0` for the four specialists and the synth so two reviews of the same `(prNumber, headSha)` produce identical output modulo network-level non-determinism.

Touch points:
- `src/lib/ensemble-router.ts` — wherever specialist completions are dispatched
- `src/lib/triage-pr-review-ensemble.ts` — synth dispatch

Expected effect on the open SIG-160 verdict-flap defect: combined with PR 1 (atomic DO claim gate, already merged), re-reviews of the same head SHA should produce 0% verdict flap on the same finding set.

### 6b. Prompt rubric — what does the specialist actually emit?

The specialist already emits `confidence: 1-5` (SIG-101). We keep that and tighten the rubric so the labeled dataset has something with non-trivial calibration to work against:

```text
[FINDING CONFIDENCE — 1 (low) to 5 (high)]

Confidence is your assessment of the probability that an expert
reviewer would label this finding a true positive. NOT your confidence
in your own reasoning. NOT severity (use `score` for that).

- 5: A senior engineer reading this finding would agree without
  needing to check the code. The bug is reproducible from the diff
  alone.
- 4: An engineer would likely agree after checking the cited line(s).
  The claim is concrete, named, and falsifiable.
- 3: Borderline — depends on intent or context not visible in the
  diff. Reasonable engineers might disagree on whether to fix it.
- 2: You see a pattern that often indicates a problem but can't
  rule out that the surrounding code handles it.
- 1: Speculative or stylistic. You would not stake credibility on
  this being a real bug.

Do NOT emit findings at confidence 1 unless the score is also 1
(taste-level advisory). Drop them instead. The orchestrator may
suppress score-1 advisories.

Do NOT round up. A finding you would describe to a teammate as "I
think there's something here, want to look?" is confidence 2-3, not
4-5.
```

This rubric is explicit, falsifiable, and tied to the labeling protocol's TP/FP definition (§7). It does not ask the model to do calibration math — it asks the model to map its uncertainty to a small ordinal scale.

The rubric is added to `SHARED_OUTPUT_INSTRUCTIONS` (so it reaches all four specialists + synth). PROMPT_VERSION bumps `5 → 6`.

## 7. Labeling protocol — the 200-finding dataset

This is the part the design hinges on. A threshold without labels is theater.

### 7a. What counts as a "finding" for labeling

A row in the labeled set is **one finding emitted by the synth that reached `buildReviewSubmission`** — whether or not it was suppressed downstream by the structural-glue gate / withdrawal / review-memory. We label **after** synth, **before** suppression, so:

- The label answers "is this a true positive?" not "is this a true positive given suppression?"
- Suppression's effect on FPR is measured separately (§8) — the threshold gate runs on what suppression lets through.

Each row has:

| Field | Source | Purpose |
| --- | --- | --- |
| `findingId` | KV key from `pr-review-finding-emitted` log | Stable handle, joinable to telemetry |
| `prNumber`, `headSha`, `repo` | Same | Reproducibility |
| `category`, `score`, `path`, `line`, `headline`, `body` | Synth verdict | The thing being labeled |
| `confidence` | Synth verdict (self-reported) | Calibration input |
| `cweId`, `evidenceId`, `complexityEstimate`, `hotPathIdentifier`, `inspectedTestFiles`, `evidenceRefs` | Synth verdict | Evidence-presence signal |
| `sourceSpecialists` | `provenance.findings[i]` | Agreement signal |
| `wouldDropGates` | ValidationMetricsDO | Which gates would have dropped this in shadow mode |
| `label` | Human | `TP` / `FP` / `borderline` |
| `labelReason` | Human (1 sentence) | Audit + spot-check |

### 7b. Where the 200 findings come from

> **Current state (2026-05-25):** the committed corpus is **76 findings**, **underpowered** vs. the planned N=200. Stage-1 calibration is therefore **provisional** and enforcement gating (`OPENCLAW_GATE = "enforce"`) is **blocked** until the sample is expanded.

Source mix (target counts; rebalance if sourcing is bottlenecked):

| Source | Target count | Why |
| --- | --- | --- |
| Inline-posted findings on Sigilix dogfood PRs (last 60 PRs) | ~120 | Real customer-visible output. 79 findings/23 PRs ≈ 3.4/PR observed; 60 PRs gives ~200 candidates, sample down to 120 weighted toward high-severity. |
| Validation-gate-rejected findings (from `ValidationMetricsDO`) | ~40 | Almost-certainly FPs — these are findings the SIG-108/110/113 gates caught. Calibrates the low end of `confidence`. |
| Findings demoted to summary body (out-of-diff anchors, SIG-127 walk-back failures) | ~25 | Calibrates the band where the model claimed a real bug but the structural anchor was off. |
| Rubberfit production PR reviews (last 30 PRs) | ~15 | Cross-tenant generalization check — calibrating only on Sigilix-dogfood overfits to our own codebase shape. |

Total: 200 findings, biased toward inline-posted (the customer-visible class) but with FP-rich sources mixed in so the threshold isn't fit on a TP-heavy distribution.

### 7c. Stratification

Within the 200, stratify by:
- **Specialist:** logic 30%, security 15%, performance 15%, tests 25%, mixed/synth 15% (matches roughly the dogfood emission distribution).
- **Severity:** score 5 ≥ 30%, score 4 ≥ 30%, score 3 ≥ 25%, score ≤2 ≤ 15%.
- **Self-reported confidence:** at least 25 findings in each of the 5 confidence bins. Pad with rejected-gate findings if `confidence ≤ 2` is under-represented in inline emissions.

Stratification matters because calibrating on a distribution heavily skewed toward (logic, score-5, confidence-5) findings produces a threshold that fails on (security, score-3, confidence-4) findings even if the aggregate FPR looks fine.

### 7d. Label definition — TP / FP / borderline

These definitions are committed to the labeling dataset so a future relabel reproduces.

**True positive (TP):**
- The finding identifies a real defect (correctness, security, performance, missing test) AND
- The reviewer (you) would either (a) fix it before merging on a real PR, or (b) write a follow-up issue tracking it.

**False positive (FP):**
- The finding describes behavior that is correct as-is, OR
- The finding asserts a property the code does not actually exhibit (e.g. "this is O(n²)" on linear code), OR
- The finding's claim cannot be verified from the cited line(s) + reasonable code context.

**Borderline:**
- Reserved for "depends on intent" cases where the same finding might be TP in one codebase and FP in another.
- Labeled separately so we can decide later whether to include them as TP, FP, or exclude from calibration.
- Target ≤ 10% of the set. If labeling produces >15% borderline, the labeling guide needs sharpening before continuing.

**Who labels:** founder labels alone. Rationale: (a) the founder is the source of truth for "would I have wanted this finding"; (b) a second labeler would require an inter-rater agreement pass we don't have time for; (c) the labels are committed to git so disagreement can be re-litigated later by anyone reading the diff. If founder time is the bottleneck, Claude can pre-label with a rationale and the founder reviews-not-labels (faster), but the founder's mark is the law.

**Time budget:** at ~30 seconds/finding (read diff, read finding, decide, write 1-sentence reason), 200 findings is ≈ 100 minutes of focused labeling. Realistically 3 hours across 2-3 sittings with breaks.

### 7e. Format on disk

```text
.claude/research/sig-161-labeling/
├── DESIGN.md                            (this file)
├── LABELING_GUIDE.md                    (the protocol, separately referenceable)
├── findings.csv                         (one row per finding)
├── findings-source.jsonl                (raw synth verdicts pulled from KV/DO logs, immutable)
├── labels.csv                           (findingId → label,labelReason — the human output)
└── calibration.ipynb                    (or .ts — the precision-recall pass; see §8)
```

`findings.csv` is generated by an offline script `scripts/collect-sig-161-findings.ts`. `labels.csv` is hand-edited (or Claude-pre-labeled + founder-reviewed). `calibration` runs against the joined view of the two.

## 8. Calibration math — two-stage protocol

> **Current state (2026-05-25):** the committed corpus is **76 findings**, **underpowered** vs. the planned N=200. Stage-1 calibration is therefore **provisional** and enforcement gating (`OPENCLAW_GATE = "enforce"`) is **blocked** until the sample is expanded.

DeepSeek's second-voice review (`.claude/handoff/sig-161-design-deepseek-response.md`) flagged a load-bearing power problem with the original single-stage N=200 / FPR≤5% / 95% CI design:

> Assume ~60 FPs in the labeled set (30% of 200). To claim "FPR ≤ 5%" with 95%
> confidence (Wilson upper bound ≤ 0.05), the observed number of FPs above the
> threshold must be **zero**. If the true FPR is 2%, the probability of
> observing 0 FPs is `(0.98)^60 ≈ 0.30`. The design cannot reliably demonstrate
> FPR ≤ 5% at N=200.

The fix is a **two-stage calibration**:

- **Stage 1 (this PR's calibration target):** N=200, **90% CI**, **FPR ≤ 10%**. Statistically supportable. Gives us a defensible threshold for shadow rollout.
- **Stage 2 (follow-up after shadow + customer-PR accumulation):** N≈600 (or N=200 + the dogfood + customer findings that accumulate during shadow), **95% CI**, **FPR ≤ 5%**. Delivers the SIG-161 issue's headline target with statistical backing.

Both stages run the same algorithm with different parameters. The threshold lives in runtime config (KV, see §9), so a stage-2 retune is a `wrangler secret put` not a redeploy.

### 8a. What we're computing

Given the labeled set with each finding's `gateScore` (from §5) and label, find `chosenThreshold ∈ [0.60, 1.00]` minimizing FPR subject to a recall constraint.

Definitions on the labeled set:
- **TP** = label is `TP` AND `gateScore >= chosenThreshold`
- **FP** = label is `FP` AND `gateScore >= chosenThreshold`
- **FN** = label is `TP` AND `gateScore < chosenThreshold`
- **TN** = label is `FP` AND `gateScore < chosenThreshold`
- **FPR** = `FP / (FP + TN)` — fraction of false positives we promoted to `REQUEST_CHANGES`
- **TPR / recall** = `TP / (TP + FN)` — fraction of real bugs still producing a verdict change

Borderline findings excluded from the FPR + recall computation; reported separately as "borderline-in-band" (informational, not gating).

### 8b. Selection algorithm (stage-parameterized)

```python
# Stage configuration (caller picks):
#   stage 1:  CI_LEVEL = 0.90,  FPR_BOUND = 0.10
#   stage 2:  CI_LEVEL = 0.95,  FPR_BOUND = 0.05
threshold_candidates = [0.60, 0.62, ..., 0.98, 1.00]   # 0.02 grid

# Pre-flight power check (fails fast if calibration is statistically impossible)
n_fp_total = count(labels == "FP")
n_tp_total = count(labels == "TP")
min_detectable_fpr = compute_min_detectable_fpr(n_fp_total, CI_LEVEL, FPR_BOUND)
if min_detectable_fpr > FPR_BOUND:
  log "calibration underpowered: N=%d FPs cannot demonstrate FPR <= %.2f at CI=%.2f"
  log "minimum detectable FPR at this N is %.3f"
  emit recommendation: "expand labeled set or relax stage parameters"
  exit with WARNING (do not block; ship with threshold = 0.85, flag = off)

# Main loop
for each t in threshold_candidates:
  compute FPR(t), recall(t) on labeled set
  compute Wilson upper bound for FPR(t) at CI_LEVEL  (n = FP+TN)

choose smallest t such that:
  Wilson_upper(FPR(t)) <= FPR_BOUND
  AND recall(t) >= 0.70

if no t satisfies both:
  emit calibration-failed report; ship with threshold = 0.85, flag = off
```

Pre-flight power check — Codex flagged the need to fail fast when the math is statistically impossible, and DeepSeek's recommendation #4 is identical. `compute_min_detectable_fpr` answers: "given `n_fp_total` FPs and observing zero of them above threshold, what's the tightest Wilson upper bound I can achieve?" If that minimum exceeds the stage's `FPR_BOUND`, calibration is unwinnable at this N and the script emits a diagnostic recommending expansion or relaxation rather than silently producing a misleading threshold.

Why a 0.02 grid not continuous optimization: with N≤600 the per-candidate FP/TN counts are integer-quantized, so sub-percent threshold differences move at most one finding between buckets. Grid alignment is a regularizer — it prevents the algorithm from picking a threshold that just happens to fall between two adjacent integer steps of an inherently discrete optimization.

Why Wilson CI (not Clopper-Pearson, Jeffreys, Agresti-Coull): all four behave similarly at our sample sizes. Wilson is the de-facto choice in proportion-CI software (statsmodels, scipy.stats.binomtest under default), so picking it minimizes the "why didn't you use the canonical one" question. Clopper-Pearson is more conservative (would push the threshold higher); we don't want that conservatism at stage 1 where the goal is "ship something defensible" not "ship the tightest possible bound."

Why recall ≥ 0.70 not 0.95: this is a code-review bot, not a safety-critical alarm. Missing 30% of real bugs at the verdict gate is acceptable because (a) borderline-band findings still post as `COMMENT` (the reviewer sees them, just no verdict change), (b) the precision is what makes us trust the bot, (c) recall improves at stage 2 when more labels stabilize the blend.

### 8c. Post-labeling blend replacement — logistic regression

Per DeepSeek's recommendation #3, once labels exist the hand-blend in §5 is replaced with a logistic regression on the same features:

```python
# Features: [conf_rescaled, evidence_present, agreement_count, severity]
# Target: 1 if label == "TP", 0 if label == "FP"
model = sklearn.linear_model.LogisticRegression(
    penalty="l2",
    C=1.0,
    class_weight="balanced",   # handle TP/FP imbalance in labels
).fit(X, y)

# Per-finding gate score at inference:
gate_score = model.predict_proba(features)[1]   # P(TP | features)
```

The model artifact (coefficients + intercept) lands in `wrangler.toml` as a JSON string, read once at Worker init. Replacing the hand-blend takes one diff line in `computeGateScore`. The hand-blend in §5 stays as the fallback when the model artifact is malformed (which would otherwise break the gate entirely).

Why logistic regression and not something fancier (XGBoost, MLP):
- **Interpretability:** the coefficients tell you which signal is doing the work. The founder + Codex can audit them.
- **Sample size:** at N=200 (stage 1) or N=600 (stage 2), logistic regression is already in its preferred operating range. A tree ensemble would overfit aggressively.
- **Latency:** inference is one dot product. No model-loading overhead.
- **Calibration:** logistic regression is well-calibrated by construction at the loss minimum. No post-hoc isotonic/Platt step needed (per DeepSeek note #3 caveat).

### 8d. Failure modes (revised post-DeepSeek)

1. **Pre-flight underpower** — stage's `FPR_BOUND` is statistically impossible at the observed `n_fp_total`. Ship with `threshold = 0.85`, flag = `off`, recommend expansion. The most likely outcome at stage 1 if the labeled set is ≤30 FPs.

2. **No threshold meets both criteria.** Recall collapses below 0.70 at any FPR-safe threshold. Indicates the blend (logistic-regression coefficients OR hand-blend) doesn't discriminate well. Stage 1 mitigation: revisit feature engineering (probably need cross-features like `confidence * agreement`). Stage 2 mitigation: this is a real model-quality problem, not a labeling problem.

3. **Borderline-band fraction > 15%.** Labeling-guide problem, not model problem. Pause calibration; sharpen `LABELING_GUIDE.md` §2 definitions; relabel a stratified sample of 50 findings; rerun.

4. **Threshold sits at 1.00.** Either the blend's structural signals are overshadowing self-report (rebalance, larger self-report weight), or the labeling skewed FP-heavy and there's literally no high-precision band. Investigate label distribution before changing the model.

5. **Severe class imbalance** (e.g. 80% TP / 20% FP) — DeepSeek's open question. Mitigation: `class_weight="balanced"` in the logistic regression handles this; for the hand-blend fallback, monitor and document but no algorithmic fix in v1.

All five modes ship the schema + gate-with-flag-off, then iterate. None of them block the PR itself.

### 8e. Per-category thresholds — explicitly out of scope at this stage

The original design considered per-category thresholds (`chosenThreshold_security`, `_logic`, etc.). DeepSeek's analysis shows these are **statistically unsupportable at N=200**:

> Per-category sample sizes (30–60) are too small to estimate FPR with any
> useful precision. Even with zero observed FPs, the Wilson upper bound is
> >0.05. Per-category thresholds would require at least 200 labels per category
> (i.e., N≥800 total) to be statistically meaningful.

We file per-category thresholds as a stage-2-or-later follow-up (a future "stage 3" once we have ≥200 labels per category). Until then, ship the single global threshold.

## 9. Ship strategy — split PRs + feature flag + KV-backed threshold

The Monday plan options were:
- (a) "design + start the labeling protocol"
- (b) "ship the schema + threshold logic feature-flag-off and calibrate later"

**Revised recommendation (post-Codex): split PR 4 into PR 4a + PR 4b.** Codex correctly noted that the prompt rubric (§6b) and the `temperature: 0` change immediately affect what specialists emit, even with the gate flag `off`. The "flag-off = identical behavior" claim of the original single-PR design was wrong — flag-off would still produce *different finding confidence distributions* on dogfood PRs the day after merge.

### PR 4a — Schema + gate plumbing only

- New field `gateScore` (optional in schema; renderer ignores it; gate respects flag).
- `chooseReviewEvent` widened to four-event with `missingScorePolicy`.
- `ReviewEvent` widened to include `COMMENT`.
- `computeGateScore` hand-blend lands as code but is **not yet called** in production — the call site reads the flag and bypasses scoring when `off`.
- Flag: `OPENCLAW_GATE` = `"off"` (default).
- No prompt change. No temperature change. No customer-visible difference.

This PR can ship without labels.

### PR 4b — Prompt rubric + temperature + flag move to `shadow`

- `SHARED_OUTPUT_INSTRUCTIONS` adds the confidence rubric from §6b.
- `PROMPT_VERSION` bumps 5 → 6.
- `temperature: 0` at specialist + synth.
- Flag flipped: `OPENCLAW_GATE` = `"shadow"`. Gate computes the would-be verdict and logs divergence to ValidationMetricsDO; the legacy `findings.length > 0` verdict still ships.

This is where finding-emission characteristics change. Shadow-mode telemetry then drives the stage-1 calibration (§8) on real post-rubric findings rather than pre-rubric ones, which is the right denominator.

### PR 4c — Calibration artifact + flag flip to `enforce`

- `labels.csv` populated (or close to it; can land iteratively).
- Logistic-regression model artifact in KV (`config:gate-model:v1`).
- `OPENCLAW_GATE` flipped to `"enforce"`. Gate now ships its verdict.
- `missingScorePolicy` flips from `"block"` to `"throw"` — see §4.

This is the stage-1 "shipped" milestone. The threshold is the stage-1 value (FPR ≤ 10% at 90% CI). The customer-visible behavior change is bounded by the threshold's calibration — measurable, reversible.

### Flag values + naming

- `off` (default) — gate is bypassed entirely; verdict is the legacy `findings.length > 0`.
- `shadow` — gate runs but ships the legacy verdict; divergence logged.
- `enforce` (was `post` — Codex suggestion) — gate ships its verdict. `enforce` reads more clearly operationally; matches the naming Sigilix uses elsewhere (`OPENCLAW_GRAPH_RETRIEVAL = "off" | "shadow" | "post"` is the prior pattern, but `enforce` describes the user-facing effect better).

### Storage — KV, not `wrangler.toml`

Original draft said "`wrangler.toml` env var, tunable without redeploy via `wrangler secret put`." Codex correctly flagged that `wrangler.toml` vars require a redeploy to change; only KV / Secrets Manager / Durable Object state is genuinely tunable at runtime.

Revised storage:
- `OPENCLAW_GATE` — `wrangler.toml` env var. Changes rarely (one flip per stage); a redeploy is acceptable.
- `OPENCLAW_GATE_THRESHOLD` — **KV-backed** at key `config:gate-threshold:v1`. Read at request time (cached for 60s via the existing config-cache pattern). Updated via `wrangler kv:key put`. A calibration retune writes a new key and the cache picks it up within 60s.
- `OPENCLAW_GATE_MODEL` — **KV-backed** at key `config:gate-model:v1`. Stores the logistic-regression coefficients + intercept as a JSON string. Same cache semantics. Replacing the model is a KV write.

Both KV configs have hardcoded fallbacks (`threshold = 1.01` = never block; `model = null` = use hand-blend) so a KV miss never breaks production.

## 10. Test coverage

Codex's review correctly noted that the original §10 mixed unit-level tests with live-ensemble integration runs in a way that wouldn't be tractable in CI. The revised approach: **golden snapshot fixtures, not live model calls.**

### Golden PR fixtures

Pre-recorded synth-verdict + provenance + diff + open-items snapshots for two PRs:
- `tests/fixtures/sig-161/pr-138-snapshot.json` — the canonical SIG-128 over-fire case.
- `tests/fixtures/sig-161/pr-120-snapshot.json` — a normal multi-finding dogfood PR (PR #120 had 9 inline findings).

Each fixture is captured once via `scripts/snapshot-pr-for-fixture.ts` and checked in. Re-snapshotting requires deliberate intent (the script is invoked manually, never in CI).

### Unit tests (`tests/triage-pr-review.test.ts`)

- `chooseReviewEvent` produces `REQUEST_CHANGES` when any `gateScore >= threshold` (covers band 1).
- `chooseReviewEvent` produces `REQUEST_CHANGES` when no blocking finding but Sigilix open items exist (covers band 2).
- `chooseReviewEvent` produces `COMMENT` when findings are in the `[FLOOR_SUPPRESS, threshold)` band and no open items (covers band 3 — Codex's critical-issue fix).
- `chooseReviewEvent` produces `APPROVE` when zero findings and zero open items (covers band 4).
- `chooseReviewEvent` with `missingScorePolicy: "block"` treats missing `gateScore` as 1.0 (rollout regime).
- `chooseReviewEvent` with `missingScorePolicy: "throw"` throws on missing `gateScore` (post-calibration regime).
- `chooseReviewEvent` with `missingScorePolicy: "permit"` treats missing `gateScore` as 0.0 (offline replay).
- `computeGateScore` weakly monotone in each input (4 property tests; the clamp at 1.0 is the documented departure from strict monotonicity per §5).
- `computeGateScore` clamped to `[0, 1]` at extremes.
- `hasRequiredEvidence` returns true/false per category contract (5 tests, one per category).
- Prompt rubric is included verbatim in `SHARED_OUTPUT_INSTRUCTIONS` (string-equality test; catches accidental edits).

### Fixture-driven tests (`tests/triage-pr-review-ensemble.fixture.test.ts`)

These run the post-LLM pipeline (gate scoring, withdrawal lookup, suppression, verdict choice, renderer) against the snapshotted synth verdicts. No live model calls.

- PR #138 fixture + flag `off` → produces today's verdict + comment shape (back-compat).
- PR #138 fixture + flag `shadow` → produces today's verdict, but the shadow-divergence log entry shows the new verdict would have been `COMMENT` (gate scored the finding into the borderline band).
- PR #138 fixture + flag `enforce` + threshold `0.85` + the SIG-128 withdrawal record loaded → produces `APPROVE` because the withdrawal suppresses the only finding before it reaches the gate.
- PR #138 fixture + flag `enforce` + threshold `0.85` + NO withdrawal record → produces `COMMENT` (the gate's secondary suppression: §10 acceptance-evidence layer 2).
- PR #120 fixture + flag `enforce` + threshold `0.85` → produces `REQUEST_CHANGES` (at least one of PR #120's 9 findings clears the threshold; this is the "the gate is working" case).
- PR #120 fixture + flag `enforce` + threshold `1.01` → produces `APPROVE` (all findings suppressed by the dead threshold; sanity check on flag wiring).

### Re-review acceptance evidence per SIG-161 "Done when"

The issue says re-review on PR #138 produces 0 findings. The fixture-driven test above asserts the canonical version: PR #138 + withdrawal record + flag `enforce` → APPROVE. Layered evidence:

- **Confirmed from PR #138's actual review history:** the SIG-128 over-fire was `confidence: 3/5` (verified via `gh api repos/Sigilix/sigilix/pulls/138/comments`), and the bot's own mention-reply conceded the finding ("Withdrawing the finding").
- **Primary suppression:** PR #142's withdrawal-persistence record drops the finding before it reaches the gate. `gateScore` is irrelevant once withdrawn.
- **Secondary suppression:** even absent the withdrawal record, the v1 blend maps `confidence: 3` (rescale 0.50) + `score: 4` (severity +0.05) + tests-specialist evidence (+0.10) + single-specialist (no agreement boost) = `gateScore ≈ 0.65`. Lands in the COMMENT band — no `REQUEST_CHANGES`. Not literally zero findings, but no verdict change.
- The acceptance criterion's strict reading ("0 findings") is satisfied by layer 1. Layer 2 backstops the withdrawal record being missing or expired. Both layers are tested per the fixture tests above.

## 11. PR scope — split into 4a / 4b / 4c

### PR 4a — Schema + gate plumbing (no customer-visible change)

1. `src/lib/triage-pr-review.ts` — `PrReviewFinding.gateScore?: number` field, parser reads it.
2. `src/lib/triage-pr-review.ts` — `computeGateScore` + `hasRequiredEvidence` helpers (callable but not called in prod when flag = `off`).
3. `src/lib/triage-pr-review.ts` — `chooseReviewEvent` rewritten to options-object API + `missingScorePolicy` + four-event widening; `ReviewEvent` includes `COMMENT`.
4. `src/lib/triage-pr-review.ts` — renderer (`buildReviewSubmission` / body builders) handles the new `COMMENT` event.
5. `src/lib/triage-pr-review-ensemble.ts` — call site reads `OPENCLAW_GATE`; when `off`, passes legacy verdict semantics (`missingScorePolicy: "block"`, threshold = 1.01).
6. `src/lib/schemas.ts` — `PR_REVIEW_SCHEMA.findings.items.properties.gateScore` added (optional).
7. `wrangler.toml` — `OPENCLAW_GATE` env var (default `"off"`); `OPENCLAW_GATE_THRESHOLD_KV_KEY` + `OPENCLAW_GATE_MODEL_KV_KEY` references.
8. `src/lib/gate-config.ts` (new) — KV-backed config reader with 60s cache + hardcoded fallbacks (`threshold = 1.01`, `model = null`).
9. `tests/triage-pr-review.test.ts` — unit tests per §10.
10. `tests/triage-pr-review-ensemble.fixture.test.ts` (new) — fixture-driven tests per §10.
11. `tests/fixtures/sig-161/pr-138-snapshot.json` + `pr-120-snapshot.json` — golden fixtures.
12. `scripts/snapshot-pr-for-fixture.ts` (new) — one-shot fixture generator.
13. `.claude/research/sig-161-labeling/DESIGN.md` + `LABELING_GUIDE.md` — this design + guide.

This PR can ship without any labels. It is the foundation.

### PR 4b — Prompt rubric + temperature + flag → `shadow`

1. `src/prompts/pr-review-specialists.ts` — `SHARED_OUTPUT_INSTRUCTIONS` adds the confidence rubric from §6b; PROMPT_VERSION 5 → 6.
2. `src/lib/ensemble-router.ts` — specialist + synth dispatch sets `temperature: 0`.
3. `wrangler.toml` — `OPENCLAW_GATE = "shadow"` (the production env vars get a one-line bump too).
4. `scripts/collect-sig-161-findings.ts` (new) — pulls findings from KV/DO + GitHub API into `findings-source.jsonl`.

This PR is the behavior-changing one. Labels for stage-1 calibration are sourced from shadow-mode output, so this is the PR that **starts producing the labeling corpus**.

### PR 4c — Calibration artifact + flag → `enforce`

> **Current state (2026-05-25):** the committed corpus is **76 findings**, **underpowered** vs. the planned N=200. Stage-1 calibration is therefore **provisional** and the `OPENCLAW_GATE = "enforce"` flip is **blocked** until the sample is expanded.

1. `.claude/research/sig-161-labeling/findings-source.jsonl` — committed (immutable; reproducible from `collect-sig-161-findings.ts`).
2. `.claude/research/sig-161-labeling/labels.csv` — committed (the human-labeled file).
3. `scripts/calibrate-sig-161.ts` (new) — runs the §8 algorithm, fits the logistic model, emits `calibration-report.md`.
4. `.claude/research/sig-161-labeling/calibration-report.md` — committed (the report).
5. Migration / runbook for the founder: `wrangler kv:key put` of the threshold and model artifacts.
6. `wrangler.toml` — `OPENCLAW_GATE = "enforce"` flip; ensemble call site flips `missingScorePolicy` from `"block"` to `"throw"`.

### Not in any PR 4 sub-PR (follow-ups)

- Stage-2 expansion to ~600 labels + retune (a separate ticket once shadow + customer-PR accumulation gets us there).
- Per-category thresholds (§8e — explicitly out of scope at any N ≤ 600).
- Renderer copy polish for the new `COMMENT` body (filed if shadow telemetry shows the placeholder copy needs work).
- Auto-relabeling when the labeling guide tightens (§7 of `LABELING_GUIDE.md` — not auto, just documented).

## 12. Open questions for founder

1. **Single labeler vs hybrid.** §7d defaults to founder-labels-alone. Hybrid (Claude pre-labels with rationale, founder reviews) cuts founder time ~50%; the rationale column makes founder-override auditable. Recommended: hybrid.

2. **Two-stage calibration acceptance.** §8: stage-1 (N=200, 90% CI, FPR ≤ 10%) is the only statistically supportable target right now. The headline SIG-161 issue says FPR ≤ 5% at 95% CI — that's stage 2 (N≈600). Is the founder OK shipping stage-1 first, with stage-2 as a follow-up issue? Recommended: yes — the alternative is delaying ship indefinitely.

3. **PR split into 4a / 4b / 4c.** §11. Codex correctly flagged that the prompt rubric change breaks the "flag-off = identical behavior" claim. The split is more PRs but each is safer. Founder may prefer a single PR with the disclaimer documented. Recommended: split.

4. **Rubberfit cross-tenant sample.** §7b allocates 15 findings to Rubberfit. If founder prefers Sigilix-only calibration (purer dogfood signal), the 15 spots redistribute to inline + rejected-gate. Adds a known overfit risk we'd close in a follow-up. Recommended: keep Rubberfit slice; the overfit risk on Sigilix-only is worse than the noise from a small cross-tenant sample.

## 13. Risks + mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Self-report stays uncalibrated even after the §6b rubric tightening | Medium | The logistic-regression blend (§8c) uses structural signals that don't depend on self-report quality. Worst case: self-report's coefficient is near-zero and the gate operates on agreement + evidence + severity. |
| Labeled set takes longer than 3 hours of founder time | Medium | Hybrid pre-labeling (Claude rationales + founder review) cuts time ~50%. Stage-1 calibration also tolerates incomplete labels — partial datasets just produce wider Wilson CIs. |
| Stage-1 threshold causes recall to drop visibly on customer PRs once flipped to `enforce` | Medium | Shadow mode runs for ≥1 week before the flip. Divergence telemetry catches a bad threshold before customers see it. Rollback is one `wrangler.toml` change. |
| Gate-score blend overfits to Sigilix dogfood codebase shape | Medium-High | Rubberfit sample (§7b) is the first cross-tenant signal. Customer PRs accumulated during shadow add more. Stage-2 expansion (N≈600) sources from broader install base. |
| Specialists ignore the rubric and emit confidence-5 for everything | Low-Medium | Telemetry on confidence distribution catches this in the first shadow week. The rubric's "do not round up" instruction + the labeling protocol's penalty for confident-but-wrong findings give backpressure over time. |
| Codex's "missingScorePolicy: throw" fires in production due to a code-path that bypasses scoring | Medium | The fixture tests in §10 enforce that every pre-emit code path either scores or filters; defense-in-depth via a `gateScore == null` log + Sentry alert in the throw branch (PR 4c includes the alert wiring). |
| Pre-flight underpower check passes but the true FPR is much higher than the labeled estimate | Medium | This is the canonical reason stage-2 exists. Shadow mode also catches it pre-`enforce` flip. |
| KV-backed threshold update silently fails (KV write succeeds, cache doesn't expire) | Low | 60s cache TTL bounds the worst-case staleness. PR 4a's `gate-config.ts` includes a `force-refresh` admin endpoint for the founder to invalidate manually. |
| `wrangler.toml` `OPENCLAW_GATE` typo (vs `OPENCLAB` in my original handoff brief — Codex catch) | Low | Compile-time guard in `gate-config.ts` validates the env var name against a const; CI catches typos. |

## 14. Acceptance criteria mapping (back to the Linear issue)

| SIG-161 criterion | Where addressed |
| --- | --- |
| Finding schema extended with `confidence: number` (0–1) emitted by each specialist | §3 — implemented as `gateScore: number 0-1` (deterministic, post-LLM computed; not model-emitted), distinct from existing `confidence: 1-5`. Justification in §2. The SIG-161 issue's "emitted by each specialist" wording is read flexibly here — what reaches the gate is a 0-1 score per finding, computed from signals that include the specialist's self-report. |
| `temperature: 0` set at specialist level | §6a (lands in PR 4b) |
| 200-finding labeled set collected from recent dogfood PRs; each labeled TP / FP | §7 — protocol + source + format (labels land in PR 4c). **As of 2026-05-25 the committed corpus is 76 findings — underpowered; sample expansion required before enforce.** |
| Measured FPR at the chosen threshold is ≤5% | §8 — stage 1 ships FPR ≤ 10% at 90% CI (statistically supportable at N=200); stage 2 ships FPR ≤ 5% at 95% CI (N≈600). Founder decision in §12 Q2. **Stage-1 calibration is provisional at the current N=76 corpus; `OPENCLAW_GATE = "enforce"` is blocked until the sample is expanded.** |
| Threshold logic: 3 bands | §4 (revised to 4 verdict events: `REQUEST_CHANGES`, `REQUEST_CHANGES`-via-open-items, `COMMENT`, `APPROVE`) |
| Verdict flap rate measured on re-runs of the same `(prNumber, headSha)` (should be 0% after PR 1 + PR 4 land) | §6a + fixture test in §10 |
| Labeling protocol + 200-finding labeled set checked into the repo | §7e + `LABELING_GUIDE.md` sibling file (labels land in PR 4c) |
| Threshold + calibration math committed | §8 — `scripts/calibrate-sig-161.ts` (lands in PR 4c) |
| Unit tests cover the three threshold bands | §10 (four bands now, but covered) |
| Re-review on PR #138 produces 0 findings | §10 — fixture test asserts: PR #138 + withdrawal record + flag `enforce` → APPROVE. |

## 15. Reviewer round log

### DeepSeek-v4-pro (calibration math, 2026-05-23)

Verdict: **partially sound, critical underpower problem**. Full report at `.claude/handoff/sig-161-design-deepseek-response.md`. Acted on:

- §8 rewritten as two-stage calibration (stage 1 = N=200/90% CI/FPR ≤ 10%; stage 2 = N≈600/95% CI/FPR ≤ 5%).
- Pre-flight power check added to §8b.
- Per-category thresholds explicitly dropped (§8e) — not viable at N=200.
- Logistic regression added as the post-labeling blend replacement (§8c).
- Failure modes (§8d) revised to add the underpower case + class-imbalance handling.

### Codex (architecture + ship sequence, 2026-05-23)

Verdict: **REQUEST-CHANGES**. Full report at `.claude/handoff/sig-161-design-codex-response.md`. Acted on:

- `calibratedScore` → `gateScore` rename (overclaim fix; §3).
- `chooseReviewEvent` rewritten with the missing `COMMENT` event band (§4 — critical issue).
- API switched to options-object with `missingScorePolicy` (§4 — should-fix).
- `?? 1.0` documented as rollout-only; `"throw"` mode added for post-calibration enforcement (§4 — should-fix).
- PR split into 4a / 4b / 4c so the prompt rubric change is in its own behavior-changing PR (§11 — should-fix).
- Storage moved from `wrangler.toml` to KV with 60s cache (§9 — should-fix).
- Flag renamed `post` → `enforce` (§9 — nit, accepted).
- Testing strategy switched to golden fixtures (§10 — should-fix).
- PR #138 acceptance evidence updated (already fixed pre-Codex review; verified `confidence: 3/5`, not 4/5).

### Open feedback not acted on

- Codex suggested a separate alerting hook for the `"throw"` path firing — added to risks (§13) instead of design body. Will land as code in PR 4c.
- DeepSeek's recommendation #1 Option B (90% CI / FPR ≤ 10%) is what stage 1 ships. Options A (N=500–800) and C (Bayesian credible interval) are stage-2 candidates documented but not in stage-1 scope.
- Codex's "Consider `enforce` instead of `post`" — accepted; `enforce` is the canonical name in this design now.
