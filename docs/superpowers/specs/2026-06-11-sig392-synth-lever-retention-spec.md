# SIG-392 — Synth retention of lever-recovered findings (spec, rev 2)

Rev 2 after Kimi K2.6 design review (FAIL → redesigned): origin marker moved
from the domain type to the synth-input boundary; threshold raised to score≥4
on fixture evidence; measurement and prod-safety language tightened.

## Problem (K=12 evidence, 2026-06-11, post-#483)

With the parser cap removed, the synth is the active recall limiter and its
drop pattern is precise: it systematically kills the **lever-recovered tail**
while keeping loud pass-1 rows. K=12 uncapped replay (gpt-oss synth, both
unions):

- killed: b18 11→0 (never survives), b20 9→1, b4 9→1, b17 11→3, b13 11→6, b11 20→8
- kept: b1/b6 20/20, b2/b3 19/20

b4/b18/b20 are exactly the invariant-lens wins; b11/b17 the re-sweep wins.

**The killed rows already qualify for protection on paper.** The captured
lever candidates are P0/P1-dominant (verified in
`e2e/.fixture-eval-out/*.union.json`: 20+ of 24 lever rows are P0/P1 = score
4-5), and SYNTHESIZER_PROMPT already says single-source score≥4 findings are
admissible and must not be dropped for being single-source. The model
under-honors that text rule under 61-finding load. Code trace confirms it has
no structural signal to honor it WITH: both levers append into the role
verdict, `assignStableFindingIds` re-mints plain `${role}-${i}` ids
(`app/resweep.ts:195-213`, `app/invariant-lens.ts:177-193`,
`domain/findings.ts:24-28`), and `renderSpecialistVerdictsForSynth`
JSON.stringifies the verdict with no provenance field. Lever findings are
indistinguishable from pass-1 findings in the synth input.

## Change A — origin marker at the SYNTH-INPUT BOUNDARY only

**No domain-type change.** `PrReviewFinding` is untouched; nothing new is
persisted, posted, logged, or visible to any consumer other than the synth's
input message.

The merge sites already compute exactly which appended ids are lever-sourced
(`resweepFindingIds` / `lensFindingIds`, tracked today for telemetry). Thread
those id sets to synth-input construction and annotate there:

- `buildSynthInputVerdicts` (`domain/synth.ts`) gains an optional
  `leverOrigins?: ReadonlyMap<string, "resweep" | "lens">` (finding id →
  origin).
- While building the synth input verdicts, findings whose id is in the map get
  `origin` spread onto the **synth-input copy only** (a local extended shape,
  not `PrReviewFinding`).
- Orchestrator passes the map built from the two merge results. Absent/empty
  map → byte-identical synth input to today (shadow mode and unlevered runs
  unchanged).

Synth OUTPUT shape unchanged: `parsePrReviewResponse` does not read `origin`;
posted findings never carry it.

**Prod safety:** both levers run `shadow` in prod and shadow never merges, so
the map is empty in prod until promotion — the mechanical gate is the existing
lever mode flags (`OPENCLAW_RESWEEP_MODE` / lens mode), whose flip IS the
promotion act with its own checklist. Residual risk while inert: the new
prompt section text rides in prod immediately, describing a field that never
appears; it is self-conditional ("a finding carrying an `origin` field") and
inert by content, but this is prompt-noise risk, not zero risk — the next
organic probe doubles as the regression check.

## Change B — prompt: protected-recovery rule in SYNTHESIZER_PROMPT

New section after the DEDUPE rules (`src/prompts/specialists/synthesizer.ts`):

```
# LEVER-RECOVERED FINDINGS (origin: "resweep" | "lens")

A finding carrying an `origin` field was recovered by a targeted second-pass
review (region re-sweep or invariant audit) — single-source is EXPECTED for
these; do not treat one-specialist support as evidence against them.

- Do NOT drop an origin-tagged score>=4 finding via ranking, ordering, or
  summary-level judgment.
- Merge an origin-tagged finding into another finding ONLY when one concrete
  fix resolves both (the existing merge bar); when merge status is ambiguous,
  KEEP SEPARATE and emit it.
- The ONLY drop path for an origin-tagged score>=4 finding is
  DETECTED-IMPOSSIBLE with quoted evidence (the existing mechanism rule),
  recorded in provenance.dropped[].
- Score honestly — protection is from silent dropping, not from severity
  judgment. Do not inflate scores to keep findings, and do not lower a score
  to make a finding droppable.
```

Threshold **score≥4** (Kimi objection 3 adopted): fixture evidence shows the
target rows are P0/P1, so ≥4 covers them while keeping the P2 advisory tail
droppable (input FP on the resweep union is 22 — protection must not blanket
the noise). If post-measurement per-row analysis shows real score-3 losses,
relaxing to ≥3 is a measured follow-up iteration, not a starting point.

## Change C — harness: replay the marker

`e2e/replay-shared.ts` `toPrFinding`/`rebuildSpecialistVerdicts` populate the
`leverOrigins` map from captured ref prefixes (`resweep-*` → "resweep",
`inv-*` → "lens") and the synth-load harness passes it through
`buildSynthInputVerdicts`, so the offline replay exercises the exact
promoted-mode input shape. Unit tests extended (map construction + annotation
presence in built synth input).

## Measurement gate (before PR merge)

Same synth-load replay, both unions, gpt-oss, **K≥12 VALID runs per union**
(re-run aborted attempts until 12 valid — the 17% gpt-oss abort rate must not
shrink the sample). Judged by the repo noise rule: per-row 0/K and K/K flips
are signal; mid-band swings are not.

Ship bar:
- b18: 0/11 → ≥6/12 valid runs; b4 and b20 each ≥4/12 (from ~1/11)
- mean posted recall ≥10/20 (from 8.6)
- hi-sev FP out mean ≤6.5 (from 4.3); if exceeded, the iteration lever is
  tightening protection scope (e.g. require origin AND score 5 for security
  category), re-measured before ship
- pass-1 stable rows (b1/b2/b3/b6) unharmed: each ≥18/20 across valid runs

PROMPT_VERSION bumped with the prompt change; the harness measures the shipped
prompt (single-sourced — the SIG-395 lesson), so replay results pin to the
version under review.

If retention is unmoved at K=12 (model ignores the marker), the fallback is a
deterministic post-synth re-append of dropped origin-tagged score≥4 rows —
explicitly OUT of scope for this PR; prompt-first.

Kimi rev-2 PASS conditions (adopted):
- **Abort-inclusive reporting:** the replay summary reports BOTH strata —
  valid-run metrics AND the raw attempt count with aborts-as-failures — so
  retry-until-12-valid cannot silently paint rosier retention than
  operational reality.
- **Negative test:** unit test pinning that `parsePrReviewResponse` ignores an
  `origin` field if a model ever echoes it (no crash, no propagation into the
  parsed verdict).
- **Threshold relaxation (≥4 → ≥3) requires a fresh design review**, never
  auto-applied from a measurement script.

## Out of scope

- Lever promotion / enforce flip (separate, after this + FP soak)
- gpt-oss capacity attrition (17% aborts) — separate reliability lever
- Specialist-side changes; gates; posting path
- Domain-model `origin` field (rejected in review — boundary-only)

## Addendum (same branch) — coverage-stamp aggregation (posted-noise)

Probe #27 posted FOUR separate "no test coverage" findings (s8/s13/s14/s15 —
module, auth middleware, refund logic, route mount). Correctly out-of-scope
for benchmark scoring, but 4 stamps of the same observation is posted noise
on every real dense PR (the founder's self-repo complaint class).

New SYNTHESIZER_PROMPT rule: when MULTIPLE category:"testing" source findings
are pure coverage observations (the "ships without/has no test coverage"
class — no concrete failure mechanism, no specific missed-bug claim), merge
them into ONE finding (scope:"pr") whose body lists every affected file/area;
keep the highest source score; provenance = one row citing ALL merged
sourceFindingIds. NEVER aggregate a testing finding that names a concrete
failure mechanism or cites a specific behavioral gap — those stay separate.
A single coverage observation stays as-is.

Recall-safe by construction (the class is out-of-scope in ground truth; the
merge keeps the content, drops nothing). Measured by the next fixture-clone
probe: coverage stamps 4 → 1, bug recall unchanged.
