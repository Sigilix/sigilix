# Sigilix believability baseline & competitive positioning

_Measured 2026-06-08. Methodology: **K=12** repeated runs through the **real review
specialists on the live prod path** (Ollama Turbo, `deepseek-v4-pro:cloud` logic
primary). Corpora: the subtle-logic recall ruler (`tests/logic-recall-corpus.ts`)
+ the per-specialist over-fire corpora. K≥12 because the specialists are
non-deterministic run-to-run (a single pass is noise; K=4 swung ~8pp recall / ~12pp FP)._

## Per-specialist results (curated corpora)

| Specialist | Recall | FP-rate (post-gate) |
| --- | --- | --- |
| Logic | 94% | 10% |
| Security | 100% | 0% |
| Performance | 100% | 0% |
| Tests | 100% | 0% |
| Synthesizer (dedup / retention) | 100% | FP-filter 100% |

Logic is the hardest specialist (subtle semantic bugs). The SIG-328 **await-aware
refutation** fix took its FP from ~21% → ~10% **recall-safely** — the real
missing-`await` bug stays caught (7/12, was 1/12 under the un-tuned gate). The
residual ~10% is the subtle-semantic tail (caller-convention ambiguity — e.g.
0- vs 1-based pagination — and noise), which is a **model** problem, not a gate
problem; deterministic floors there are FP-prone and intentionally not chased.

## Competitive snapshot (external comparison, 2026-06-08)

| Metric | CodeRabbit | Greptile | **Sigilix (estimate)** |
| --- | --- | --- | --- |
| Bug-catch rate (recall) | ~44% | ~82% | **~80–88%** (ensemble + deep cross-file context) |
| Precision (true positives) | ~36% | ~45–66% | **~75–90%** (high recall × low FP) |
| False-positive noise | very low (~2/run) | high (~11/run, ~60% of comments) | **low** (logic ~10% worst, others ~0%) |
| Primary strength | minimal review fatigue | deep cross-file detection | both: recall **and** quiet |

**The moat:** CodeRabbit trades recall for quiet; Greptile trades quiet for
recall. Sigilix targets the quadrant neither occupies — **high recall AND low
FP** — via the believability layer (refutation gates + synth dedup + verification
+ grounding + deep cross-file/graph context). The synth and gates only *reduce*
FP downstream of the specialists, so the overall posted-review FP is ≤ the worst
specialist's.

## ⚠️ Honest caveat — do not overclaim

These numbers are from **curated adversarial corpora**, not a broad real-world
bug sample like the CodeRabbit/Greptile figures. The 94–100% recall is on the bug
*classes* the specialists target; the FP is the adversarial over-fire rate on
deliberately hard look-alikes. The Sigilix competitive column is an **informed
estimate**, not a measured real-world result.

The **defensible, apples-to-apples** numbers to quote to partners are:

- **Real-world FP** — the live dogfood `GET /metrics/fp-rate` + the **SIG-245**
  bar (zero P0/P1 false positives over a rolling 7-day window).
- **Real-world recall** — a broad real-world bug eval (**SIG-114**) is the
  remaining piece needed to state real-world recall honestly.

Until those land, present believability as: _"on our adversarial believability
corpus, 94–100% recall / ≤10% FP, recall-safe; real-world measurement via the
live dogfood, in progress."_
