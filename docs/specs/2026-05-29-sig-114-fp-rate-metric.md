# SIG-114 — Per-specialist false-positive-rate metric (PR 1: offline harness)

Status: shipped in PR 1 (offline harness). First of the SIG-114 epic.
Date: 2026-05-29.

## What this is

A measured false-positive rate per specialist (logic / security / performance /
tests) and for the synthesizer, computed from data Sigilix already persists in
KV. It is the "ruler" for the believability roadmap (SIG-114 → SIG-184 →
SIG-285 → SIG-286): you cannot prove verification-by-execution (SIG-285) or
agentic multi-hop (SIG-286) reduce false positives without first measuring the
rate.

## The honest statistical contract (read this before citing a number)

The label source is **dismissals** (`/sigilix dismiss`, captured as
`review-memory` `dismissed-textual` signals). That makes the metric a
**floor**, not a ceiling:

- **Selection.** Not every false positive is dismissed, so the observed
  dismissal rate ≤ the true FP rate. The point estimate is a **lower bound on
  the true FP rate.**
- **Sampling.** The Wilson 95% interval is uncertainty on the *observed* rate,
  a separate source of conservatism.

This metric therefore supports **"at least this bad" + trend**. It does **not**
support a ceiling claim ("our FP rate is at most Y%"). A defensible ceiling
needs a curated ground-truth eval set — **PR 2 of this epic.**

Wilson (not the Beta(1,9) lower bound used by SIG-280 review-memory soften) is
deliberate: Beta(1,9) is a one-sided *veto-gate* under a pessimistic prior;
Wilson is the right tool for *reporting* an observed proportion's sampling
uncertainty.

## How it works (no prod change required)

The exact join — verified against the persisted shapes — is:

```
dismissal.fid  →  recompute fid over synthesizer.verdict.findings[i]
               →  synthesizer.provenance.findings[i].sourceSpecialists
```

`sourceSpecialists` is **already persisted** in `synthesizer.provenance`, so
the join works on the historical corpus with zero prod hot-path change. fid =
`computeFid({ruleId:null, path, line, headline})` (uniform `ruleId:null`, so
recompute is deterministic).

- **Denominator[role]** = posted synth findings with `score ≥ 4` where
  `role ∈ sourceSpecialists`, per repo, in a rolling window.
- **Numerator[role]** = those that were dismissed.
- **Multi-specialist = full credit** (a finding from logic+security counts in
  both denominators and, if dismissed, both numerators — numerator ⊆
  denominator per role).
- **Hard vs soft FP** (a new taxonomy, orthogonal to SIG-173 softening
  weights): hard = `not-a-bug`, `wrong-context`; soft = `bad-anchor`,
  `already-covered`, `too-minor`; `unlabeled` reported separately. Only hard FP
  counts against the target (<10% specialist, <5% synth).
- **min-n = 30** posted score-4+ findings per role, else `insufficient-n`.
- **Per repo only** (`--repo` mandatory) to avoid Simpson's paradox.
- Excludes guard-skipped non-reviews (`merged_before_fanout` /
  `stale_head_before_fanout`) from the denominator. Unmatched dismissals are
  bucketed (TTL-expired vs not-found), never silently dropped or mis-attributed.

## Files

- `src/lib/fp-rate/{types,attribute,compute,format,window,ingest}.ts` — pure,
  unit-tested core.
- `scripts/fp-rate-report.ts` — thin IO over the Cloudflare KV API
  (`npm run fp-rate-report -- --repo=owner/repo`).
- `tests/fp-rate.test.ts` — 28 tests incl. ingest fixtures from live prod shapes.

## First live baseline — Sigilix/sigilix, 2026-05-29 (200 most-recent reviews)

| Specialist | Posted (4+) | Hard FP | Soft | Unlabeled | Hard-FP rate | Wilson 95% | Meets? |
|---|---:|---:|---:|---:|---:|---|---|
| logic | 5 | 0 | 0 | 0 | 0.0% | [0%, 43.4%] | insufficient-n |
| security | 24 | 0 | 0 | 3 | 0.0% | [0%, 13.8%] | insufficient-n |
| performance | 2 | 0 | 0 | 0 | 0.0% | [0%, 65.8%] | insufficient-n |
| tests | 32 | 0 | 0 | 0 | 0.0% | [0%, 10.7%] | yes |
| synth | 63 | 0 | 0 | 3 | 0.0% | [0%, 5.7%] | yes |

- 170 fanout reviews; **127 (75%) posted zero score-4+ findings** — the SIG-287
  bare-approve epidemic, quantified.
- 7 dismissal signals; 6 matched the join (all security-sourced), 1 not-found.
  The 6 matched events collapse to **3 distinct dismissed findings** (the
  numerator dedups by fid — a finding dismissed twice is one false positive).
  All 3 are `unlabeled` (the textual-dismissal pipeline does not emit a reason
  yet), so 0 hard FPs today.
- Takeaway: the live rate is **insufficient-n** for most specialists — exactly
  why PR 2 (the curated eval set) is the near-term defensible number.

## Known limitations (PR 1)

- **Denominator uses `synthesizer.verdict.findings`**, which is the synth output
  before post-validation drops / withdrawal / softening. Some score-4+ findings
  there may never have been posted (so can never be dismissed), slightly
  inflating `posted_n` and biasing the rate downward. The numerator is
  unaffected (only posted findings get dismissed). A follow-up will narrow the
  denominator to the final submitted set with aligned provenance.
- **Role attribution** unions `sourceSpecialists` with `sourceFindingIds`
  prefixes (the production-authoritative signal); a finding with neither is
  counted only in the synth aggregate, not any specialist.

## Deferred to follow-on PRs

- **PR 2 — curated eval set** (the ceiling number, from known-FP tickets).
- Live `/metrics/fp-rate` endpoint.
- Persist `score` + `dismissReason` on `ReviewMemorySignal` at capture (so
  hard/soft + score-gate work on the live corpus going forward).
- Founder-review queue for shadow score-4+ findings; the "3 windows trending
  down" close-out.
