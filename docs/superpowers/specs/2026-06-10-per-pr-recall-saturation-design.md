# Per-PR recall: closing the multi-bug saturation gap — design

**Status:** design / local (uncommitted). Founder-requested 2026-06-10.
**Problem owner:** Sigilix Engine. Distinct axis from SIG-285 (verification/precision) and SIG-286 (cross-file context).

---

## 1. The problem, precisely

Each specialist (logic/security/performance/tests) is individually optimized at K=12 and posts high-precision, low-FP findings. Yet whole-system recall on a deliberately dense benchmark PR (sigilix-e2e-fullstack #20: **20 genuine bugs in 281 lines**, blind) was **8/20 = 40%** — co-competitive with Greptile (9/20) and CodeRabbit's published ~43%, far ahead on precision (89–92% vs CR ~36%), with 1 soft P0 false alarm.

The run telemetry **rules out a pipeline leak**: `coverage: logic · security · performance · tests` (all four lenses ran — dispatcher didn't skip), `16 findings · 16 grounded` with **no suppressed count** (validation gates demoted/dropped nothing), and synth posted everything it received. So the gates/dispatcher/synth did not eat recall. The loss is structural, in the specialists themselves under load.

### Root causes (ranked)
1. **Multi-bug saturation (dominant).** K=12 measures per-*fixture* recall (one bug, find it). A 20-bug PR asks for per-*PR* recall (emit all 20 in one structured response). The lens surfaces the loudest few per region and "feels done." Per-bug recall does NOT compose to per-PR recall; the gap widens with bug density.
   - **Evidence — the miss pattern is region-local.** `refunds.ts`: caught the float dollars→cents bug (loudest), **missed** over-refund (no clamp), the refund-path race, and the refund-endpoint IDOR — 1 of 4. Webhook: caught SQLi + idempotency, **missed** `event.type`-ignored + fail-open secret. Charge: caught IDOR + missing-await + paid-predicate, **missed** `amountCents` validation. List: caught N+1 + off-by-one, **missed** the list-IDOR. Every region: 1–2 loud catches, quiet siblings dropped.
2. **Cross-hop / invariant tail.** refund-IDOR and list-IDOR require noticing OTHER endpoints don't scope by `customer_id`; the model anchored on the one IDOR it found (charge) and stopped. `event.type`-ignored needs reasoning over an unused discriminated-union arm. These need whole-feature / multi-hop sight a single-pass file-local lens lacks (the SIG-286 frontier).
3. **Synth caps recall at the union — it cannot amplify.** It's structurally barred from inventing non-specialist findings (a believability guardrail). System recall ≤ union of specialist recalls; it can only lose from there.
4. **Low cross-lens overlap = no reinforcement.** Only 2/15 findings were multi-specialist. When the one responsible lens saturates, nothing else recovers the bug.
5. **Precision tuning trims the tail under load.** Conservative lenses drop their lowest-confidence candidates first — exactly the subtle siblings. The discipline that gives 89–92% precision is what cuts the 3rd-most-confident finding per region.

## 2. The strategy (the one sentence)

**The bottleneck is "the lens quits early and can't see across regions," not "the lens can't find the bug." Sigilix has an asset almost no competitor has — strong downstream believability gates (grounding, verification/receipts, demote, IDOR floor). That asset means we can run an aggressive recall pass and let the gates clean up precision.** CodeRabbit cannot crank recall without drowning in FPs (their ~36% precision / ~15% FP); Sigilix can, because precision is enforced downstream. So: **move precision enforcement off the lens and onto the gates, then let the lens enumerate hard — gated by effort so latency stays bounded.**

## 3. The levers (ranked by ROI)

### L1 — Region re-sweep (highest ROI; attacks saturation = cause #1)
After the first pass, for each region (file/function/endpoint) that already has ≥1 finding, fire a **scoped** follow-up: *"You flagged X here. List every OTHER issue in this same region — assume there are more."* Converts per-bug recall into per-region recall; directly fixes "found the float bug and stopped." Cheap (scoped to already-flagged regions), and the FPs it produces are exactly what the existing gates kill — so recall climbs without a precision cost. **Build first.**
- Effort-gated: only fires on high-effort/large diffs (we already compute an effort score; #20 was 5/5).
- Composes with SIG-285 (receipts verify the new candidates) and the grounding gate (ungrounded re-sweep finds get demoted, not posted).

### L2 — Effort-gated per-unit review fan-out for dense diffs (attacks saturation structurally; cause #1)
20 bugs in one prompt saturates; the same 20 across ~6 units of ~3 bugs each puts each unit back in the low-density regime where K=12 numbers hold. Fan out the review by file/hunk/endpoint for high-effort PRs; single-pass stays for small PRs. Rides the SIG-224 dispatcher's existing conditional-fan-out machinery and effort scoring. Cost: more model calls → latency/budget; hence effort-gated.

### L3 — Cross-cutting consistency / invariant lens (attacks cross-hop tail #2 + no-reinforcement #4)
A diff-spanning lens that asks invariant questions instead of reviewing file-by-file: *"every money value should be integer cents — find the inconsistency," "every endpoint touching customer data should scope by customer_id — find the ones that don't," "every event handler should be idempotent."* Catches exactly the class per-region lenses drop (the two extra IDORs, the unit-drift). Encodes the deterministic floors (we already have an IDOR floor) as reasoning prompts over the whole diff. Bonus: deliberately re-examines what other lenses found → the reinforcement low overlap currently lacks. Overlaps SIG-286 — sequence together.

### L4 — Completeness critic pre-synth (attacks #1 + the union-cap #3)
A pass that sees the diff + the N findings so far and asks *"what real bug is NOT in this list?"*, then routes each gap back to the relevant specialist to ground it (synth cannot invent by design, so the critic must feed a specialist, not synth). Recovers the tail saturated lenses dropped while preserving "every finding grounded." Build after L1–L3 are measured.

### L5 — Recall regression harness (validation instrument, NOT exploratory benchmarking)
Freeze sigilix-e2e-fullstack #20 (20-bug ground truth + the 4 traps) as a **fixed** regression fixture + a scorer that reports per-PR recall / precision / high-sev-FP. This is the saturation regime in a bottle — the test bed to A/B L1–L4. We do NOT need new PRs to diagnose (the shape is known); we need ONE frozen fixture to prove a fix moves recall. Plug into SIG-114's metric surface. Also add a low-density control (3–4 bugs/PR) to confirm recall climbs back toward K=12 when bugs don't compete.

## 4. Sequencing
L1 (re-sweep, effort-gated, lean on gates) → L5 (freeze the harness, in parallel — needed to measure L1) → L3 (consistency lens, with SIG-286) → L2 (per-unit fan-out for dense PRs) → L4 (completeness critic) last.

## 5. Tradeoffs / risks
- **Latency.** Every lever adds model calls; prod is Ollama-Turbo cost-gated with the 895s/900s budget and the Greptile-parity ambition (SIG-369). Mitigation: **effort-gate the expensive recall passes** — small PRs stay fast, dense/high-effort PRs get deepening, which is also where recall matters most.
- **Precision.** More candidates = more FP pressure. Mitigation: the existing gates are the precision backstop; measure FP on L5's harness before any enforcement; never hard-drop P0/P1 (recall-safety).
- **Recall-safety invariant unchanged:** never suppress/downgrade a real P0/P1 to look clean.

## 6. Linear
Epic + 5 sub-issues under Sigilix Engine. Related to SIG-286 (cross-hop), SIG-224 (effort-gating/dispatcher), SIG-114 (measurement), SIG-285 (gates compose), SIG-287 (timeout-kills-recall failure mode).
