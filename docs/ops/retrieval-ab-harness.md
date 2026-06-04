# SIG-45 — Hybrid retrieval A/B harness

Decides whether hybrid retrieval (vector + BM25/RRF) should become the default
by comparing it against pure-vector on **findings quality** (precision / recall
/ F1) over ~30 PRs, vs hand-graded ground truth. Hybrid ships as default only on
a **>10% relative F1 lift**; otherwise it stays behind `OPENCLAW_RETRIEVAL_HYBRID`.

- Decision logic (pure, unit-tested): `src/lib/retrieval-ab/eval.ts`
- CLI: `scripts/retrieval-ab-report.ts` → `npm run retrieval-ab-report`

## 1. Collect the two arms (the measurement step)

Pick ~30 representative merged PRs from the `sigilix` repo. Review each **twice**
against the same head SHA:

- **vector arm** — `OPENCLAW_RETRIEVAL_HYBRID` unset/`off`
- **hybrid arm** — `OPENCLAW_RETRIEVAL_HYBRID=on` (requires the D1 lexical index
  provisioned + populated; see `docs/setup/automatic-indexing.md` and the
  `[[d1_databases]]` block in `wrangler.toml`)

Record every posted finding as one line in `findings.jsonl`, tagged with its arm:

```jsonl
{"pr":"482","arm":"vector","file":"src/lib/retrieval.ts","line":142,"category":"logic"}
{"pr":"482","arm":"hybrid","file":"src/lib/retrieval.ts","line":142,"category":"logic"}
```

## 2. Hand-grade the ground truth

For each PR, label the findings that are **genuinely real** (one line each) in
`truth.jsonl`:

```jsonl
{"pr":"482","file":"src/lib/retrieval.ts","line":142,"category":"logic"}
```

`category` is optional; when present on both a finding and a truth item it must
match. Lines within `--line-tolerance` (default 3) count as the same location.

## 3. Run the report

```bash
npm run retrieval-ab-report -- --findings=runs/findings.jsonl --truth=runs/truth.jsonl
# options: --format=csv|md|both  --out=dir  --line-tolerance=3  --min-prs=30
```

Output: precision / recall / F1 per arm (with Wilson 95% CIs) and the decision.
Exit code `2` when underpowered (`< --min-prs`), so CI/automation can gate on it.

## 4. Apply the decision

- **SHIP** → set `OPENCLAW_RETRIEVAL_HYBRID = "on"` in `wrangler.toml` `[vars]`
  as the default; record the report under `.claude/research/retrieval/`.
- **KEEP behind flag** → leave the flag default-off; the harness output is the
  documented justification (closes SIG-45's "A/B completed" + "default decision"
  items).

> Note: this harness is the *decision tool*. *Collecting* the arms requires an
> online deploy (the D1 lexical index populated) plus a hand-graded PR set —
> that step can't be run offline. Once `findings.jsonl` and `truth.jsonl` exist,
> *generating the report* (the `retrieval-ab-report` step) runs fully offline.
> The pure core + CLI are tested offline.
