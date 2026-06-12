# SIG-392 — deterministic near-duplicate collapse (post-synth)

## Problem

The synth posts near-duplicate findings: probe #28 (gpt-oss) posted one
finding twice verbatim; probe #31 (gemma) posted two wordings of b6
(s11/s12, same path:line) and a second wording of the already-caught b1
(s3). Prompt-side DEDUPE rules demonstrably don't bind (the 3-strikes
lesson). Near-dups are the ONLY remaining hi-sev "FP" class on the
benchmark — collapsing them deterministically takes bench FP to 0 and
protects the higher finding volume the lens promotion brings.

## Change — pure domain pass at the end of applyRecallFloors

New pure function `collapseNearDuplicateFindings(findings, provenanceFindings)`
in `domain/` (new leaf), called as the LAST stage of `applyRecallFloors`
(app/recall-floors.ts) — after restoration, before validation, so dups never
reach gates/posting. It owns the same index-aligned findings+provenance
rebuild contract the floors already maintain.

Two findings collapse iff ALL of:
- same `path`
- |line difference| ≤ 5
- same `category`
- AND (shared provenance `sourceFindingId` OR headline token-Jaccard ≥ 0.25
  after lowercasing, backtick/punctuation strip, stopword removal)

Collapse action (recall-safe by construction):
- keep the HIGHER-score finding (tie → the earlier index, deterministic)
- merged provenance row = union of both rows' sourceFindingIds (ascending) —
  every source stays accounted for downstream validation
- **floor-interaction guarantee (Kimi sign-off condition): the no-resurrection
  property comes from ORDERING, not the union — the collapse is the FINAL
  stage of applyRecallFloors, running AFTER the SIG-351 source floor, and no
  floor pass executes downstream (validate/post follow). The floor's key is
  id-membership PLUS a mechanism-preservation text check
  (preservesSourceMechanism), so the union alone would not suffice; ordering
  makes it airtight. Pinned by a chained floor→collapse unit test.**
- per-collapse telemetry: a `pr-review-near-dup-collapsed` event logs
  (keptId, droppedHeadline, jaccard, sharedSource) for threshold sweeps
  (Kimi condition — observable without code change)
- the collapsed finding's body is NOT merged into the kept one (kept finding
  unchanged — no text surgery)
- transitive: collapse pairwise left-to-right in one pass (A~B, B~C → one
  survivor)

## Calibration (real probe cases pinned as unit tests)

MUST collapse: probe-4 s8/s10 (N+1 pair, same line, Jaccard ~0.31);
probe-31 s11/s12 (b6 dollars/cents pair, same line, shared mechanism tokens).
MUST NOT collapse: probe-4 s1/s13 (b2 stale-read vs b17 validation — same
path:line:category but different bugs, Jaccard ~0.12, disjoint sources).

## Measurement

Next fixture-clone probe: 0 hi-sev FPs expected (the near-dup was the only
one); recall unchanged (collapse keeps one of each pair). Unit tests pin the
three real cases above + provenance-union + transitivity + the no-pair
identity (returns inputs by reference when nothing collapses).

## Out of scope

LLM/embedding similarity; cross-file dedup; body merging; prompt changes.
