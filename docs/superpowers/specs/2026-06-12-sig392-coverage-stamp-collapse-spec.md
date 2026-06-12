# SIG-392 — deterministic coverage-stamp collapse (post-synth, cross-file)

## Problem (third-party evidence: PR #494's 13-PR batch)

The real-world batch measured 12 tests-category findings / 0 real — almost
all "ships without tests" stamps on small new endpoints — "the entire
precision gap" (41% measured precision, capped-era engine). On the current
stack this class still posts: the tests gate is enforce-but-DEMOTE-not-drop
(SIG-245, Jun 1), so cited coverage observations pass demoted; the #492
near-dup collapse requires same path+line so cross-FILE stamps never match;
and the prompt-side aggregation rule (v30) binds only as well as the synth
model obeys it (gemma: partially; observed 2-3 stamps still posted).

## Change — second deterministic stage at the recall-floors seam

Pure function `collapseCoverageStamps(findings, provenanceFindings)` in a
new domain leaf (`domain/coverage-stamp-collapse.ts`), called in
applyRecallFloors immediately AFTER collapseNearDuplicateFindings (same
no-resurrection-by-ordering guarantee; nothing downstream re-restores).

Classification — a finding is a "pure coverage stamp" iff ALL of:
- category === "testing"
- headline matches the coverage-observation class:
  /(without (any |a single )?(unit )?tests?|no test coverage|test coverage|untested|lacks (unit )?tests?)/i
- headline does NOT contain mechanism tokens (conservative negative gate):
  /(race|incorrect|wrong|fails?|breaks?|bug|overflow|injection|missing await|off.by.one|regression)/i

Collapse action — fires ONLY when 2+ stamps classify (singletons untouched):
- keep the highest-score stamp (tie → earliest index), retitle is NOT done
  (headline untouched)
- append one deterministic body line: "Also uncovered: `<path1>`, `<path2>`…"
  (the other stamps' paths, ascending, deduped)
- set scope to "pr" on the survivor (it now speaks for the PR)
- merged provenance row = ascending union of all collapsed rows'
  sourceFindingIds (every source stays accounted)
- telemetry event `pr-review-coverage-stamps-collapsed` with
  (keptHeadline, collapsedCount, paths) per collapse

Recall-safe by construction: the class is out-of-scope in benchmark ground
truth and the content is preserved (one finding, all paths listed). Identity
fast path: 0-1 stamps → inputs returned by reference.

**Known measurement caveat (code review, recorded):** the eval scorer matches
findings to ground-truth rows by `finding.path` — collapsed stamps' paths
live in the survivor's BODY, which the matcher never reads. If a fixture
ever plants 2+ separately-tracked coverage bugs on DIFFERENT files, the
collapse would leave only the survivor's path matchable (a measurement
recall loss). All current fixtures carry at most one tests-category GT row,
verified against both frozen corpora; add a guard (or scorer body-path
fallback) before authoring such a fixture.

## Calibration (real findings pinned as tests)

MUST collapse: probe #28's three stamps ("Entire payments module ships
without any test coverage" / "Auth middleware ships without any test
coverage" / "Refund module ships without any test coverage" — different
files). MUST NOT touch: a testing finding naming a mechanism ("Sibling test
only covers the single FINAL case, not multiple matches" — cites a behavior
gap); a single lone stamp; non-testing categories.

## Measurement

Next fixture-clone probe: exactly ≤1 coverage finding posted. The #494
batch re-run (planned) measures the real-world effect: his arithmetic says
the class removal alone lifts capped-era precision 41%→~63%; current stack
should land higher.

## Out of scope

Body rewriting beyond the one appended line; dropping stamps entirely
(demote-not-drop philosophy stands); prompt changes; the inline-anchoring
(summary-vs-inline) issue — separate morning item.
