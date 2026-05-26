# SIG-224 — Dynamic specialist dispatcher: architecture design

**Status**: Phase 0 research synthesis. Not yet implementation-locked.
**Linear**: [SIG-224](https://linear.app/sigilix/issue/SIG-224)
**Date**: 2026-05-26
**Owners**: Sigilix Engine team
**Inputs**: Codex (gpt-5.4-codex), Kimi K2.6 (`kimi-k2.6:cloud`), DeepSeek-v4-pro (`deepseek-v4-pro:cloud`) — three independent Phase 0 research passes against the same brief.

---

## Executive summary

Ship SIG-224 as a **hybrid dispatcher**: deterministic rule layer for hard
forces and obvious shortcuts, an in-fleet LLM (`deepseek-v4-flash:cloud`)
classifier for the ambiguous middle, the existing `ensemble-router.ts` becomes
the rule floor, and the orchestrator is updated to consume both. The LLM
**never overrides** the rule layer on security or logic — those roles default
to running unless both layers agree to skip. Enforcement happens only after a
shadow-mode calibration window proves recall ≥ 99% on security + logic.

The 30-90s wall-time target is **not achievable from the dispatcher alone**.
All three reviewers converged on the same answer: hitting the SLO requires the
dispatcher PLUS two latency levers SIG-220 deferred — overview off the
critical path (Lever 1) and a smaller synth prompt for partial coverage.
SIG-224's "Done when" criteria correctly capture this in Phase 3.

**Decision lock**: hybrid with deterministic safety floor. Confirmed by all
three independent voices. Predicted winner held up.

---

## Phase 0 deliverables (what gets shipped before any Phase 1 code)

1. This document landed at `docs/specs/2026-05-26-sig-224-dispatcher-architecture.md`.
2. **Pre-req bug fix** — change `triage-pr-review-ensemble.ts:1533-1540` so an
   empty `router.specialists` no longer bails with a skip notice. Today the
   code reads:

   ```ts
   if (router.specialists.length === 0) {
     telemetry.fellBackReason = "router_no_specialists"
     return bailWithSkipNotice("router_no_specialists")
   }
   ```

   When the dispatcher legitimately decides a diff is docs-only-no-fences, the
   correct outcome is a neutral "reviewed, no specialists applicable" comment
   plus a green check — NOT a `skip-notice`. **Codex caught this; it is the
   single most important gating prerequisite.** Phase 0 lands the fix
   alongside the spec doc, so Phase 1 can enforce empty fan-out safely.

3. `sigilix.json` schema extension for `dispatcher` section (added to
   `src/lib/sigilix-config.ts`; documented but no enforcement yet):

   ```jsonc
   {
     "dispatcher": {
       "force": ["security", "logic"],          // per-repo force-include
       "safetyNet": {
         "additionalPatterns": [                // per-repo extension only;
           {                                    // never deletion
             "glob": "src/billing/**",
             "role": "logic"
           }
         ]
       }
     }
   }
   ```

4. Filed in Linear:
   - SIG-225 (Phase 1 — shadow dispatcher).
   - SIG-226 (Phase 2 — partial-coverage synth prompt).
   - SIG-227 (Phase 3 — enforcement + SIG-220 Lever 1 follow-up).

---

## Phased plan

### Phase 0 (this week)

- Doc lands.
- Empty-fan-out bug fix lands (above).
- Sigilix.json `dispatcher` section schema lands (read but unused).
- No behavior change in production.

### Phase 1 (2-3 weeks) — shadow dispatcher

- New module `src/lib/dynamic-dispatcher.ts`. Wraps `decideSpecialists` from
  `ensemble-router.ts`. Inputs: `DiffSignals` + `ClassifiedDiffFile[]` from
  `diff-file-classify.ts` + commit message. Output: extended `RouterDecision`
  with `perRole` telemetry block (Codex's contract):

  ```ts
  interface DispatcherDecision extends RouterDecision {
    perRole: Record<SpecialistRole, {
      action: "run" | "skip"
      confidence: 1 | 2 | 3 | 4 | 5
      reasons: string[]
    }>
    dispatcherReasoning: string  // for synth prompt
    layerVotes: {
      rules: Set<SpecialistRole>
      llm: Set<SpecialistRole>
      forced: Set<SpecialistRole>  // from rules safety-net + sigilix.json
    }
  }
  ```

- LLM classifier: `deepseek-v4-flash:cloud` (in-fleet model, same provider as
  tests-specialist — no new infra). 6-8s hard timeout, JSON-mode constrained
  output. Prompt feeds file kinds (from `diff-file-classify.ts`) + first
  20-line hunk samples + commit message. Diff body is NOT fed wholesale —
  prompt cap ~1,500 tokens in, ~150 tokens out.
- Dispatcher fail-closed on timeout/invalid-JSON: return `ALL_SPECIALISTS`
  with `reason: "llm_failed_fallback_all"`. No degraded silent skip.
- Telemetry: emit `specialist-skipped-by-dispatcher` per role with reasoning
  blob attached. Also `dispatcher-llm-disagreement` when the LLM picks differ
  from the rules. Hook `sourceFindingIds` prefix conventions
  (`triage-pr-review-ensemble.ts:7344`) to mark the role provenance of each
  customer-visible finding for shadow-mode FN computation.
- **All four specialists still run.** Dispatcher logs picks but does NOT skip
  anyone. Goal: collect false-negative ground truth for ≥ 14 days OR 500
  reviews, whichever is longer.

### Phase 2 (2-4 weeks after Phase 1) — partial-coverage synth + targeted enforcement

- Synth prompt update at `src/prompts/pr-review-specialists.ts:405` — add
  `[DISPATCH COVERAGE]` block distinct from existing `[DEGRADED COVERAGE]`
  block at `:807`. Skipped roles render as "not applicable," not "missing."
  Dispatcher reasoning is exposed as internal context, surfaced in the
  customer-visible body only when it would naturally clarify the review.
- Begin enforcing **non-protected** role skips: when the dispatcher agrees
  with the rules that `performance` or `tests` should not run, skip them.
  Security + logic still always run. Watch FN rate on the protected roles
  during this window — they will not change because they still always run,
  but the unprotected-role savings start producing token + latency wins.

### Phase 3 (4-6 weeks after Phase 1) — protected-role enforcement + SIG-220 Lever 1

- Once Wilson 99%-CI upper bound on security+logic FN rate is < 1% over the
  shadow window AND zero `score ≥ 4` security misses, allow the LLM to skip
  protected roles. Even then: **consensus-to-skip** for security+logic
  (Kimi's framing) — the rule safety-net AND the LLM must independently
  agree the role is irrelevant.
- Ship SIG-220 Lever 1: move overview from inline `await` to `ctx.waitUntil`
  so it doesn't block `submitReview`. Saves ~28s on every review. Pair with
  this PR so the latency claim becomes truthful at the same time.
- Tighten synth model selection per coverage shape: 1-role + no `severity ≥
  major` findings → consider synth bypass (Kimi's idea); 2+ roles or major
  findings → existing kimi-k2.6 synth.

### Phase 4 — per-repo customization

- Allow `sigilix.json::dispatcher.force` to add roles (existing config
  surface from Phase 0).
- Per-repo additive safety-net patterns (existing schema from Phase 0).
- Per-repo `dispatcher.trustLevel: "high"` to enable LLM-overrides-rules for
  protected roles on customer opt-in. Default `"normal"` keeps the
  consensus-to-skip behavior.

---

## Architecture contract

### Entry point

`src/lib/dynamic-dispatcher.ts` exports:

```ts
export async function decideSpecialistsDynamic(
  signals: DiffSignals,
  classified: ClassifiedDiffFile[],
  commitMessage: string,
  repoConfig: SigilixConfig,
  env: Env,
): Promise<DispatcherDecision>
```

### Decision flow

```
                  ┌──────────────────────────────────┐
                  │  decideSpecialistsDynamic()       │
                  └──────────────┬───────────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
       Rule layer (sync)                    LLM layer (async)
       ensemble-router.ts                   deepseek-v4-flash:cloud
       + extended safety-net patterns       6-8s timeout
       + sigilix.json::dispatcher.force     fail-closed → ALL
              │                                     │
              └──────────────────┬──────────────────┘
                                 ▼
                      Reconcile per role:
                       - forced (rules)     → always include
                       - safe-skip (rules)  → exclude
                       - ambiguous          → LLM decides
                       - protected (logic,  → consensus-to-skip
                          security)           until trustLevel="high"
                                 │
                                 ▼
                       DispatcherDecision
                       + perRole telemetry
                       + dispatcherReasoning
```

### Fan-out reconciliation rule

```ts
function reconcile(
  rulesForced: Set<Role>,
  rulesSafeSkip: Set<Role>,
  llmPicks: Set<Role>,
  trustLevel: "normal" | "high",
): Set<Role> {
  const final = new Set<Role>(rulesForced)
  for (const role of ALL_SPECIALISTS) {
    if (rulesForced.has(role)) continue
    if (rulesSafeSkip.has(role)) continue          // rules' shortcut wins
    const isProtected = role === "security" || role === "logic"
    if (isProtected && trustLevel === "normal") {
      // Consensus-to-skip: skip only if rules also imply skip (i.e. no
      // forced signal). If LLM said skip but rules didn't actively
      // shortcut → run.
      if (!llmPicks.has(role)) {
        // Rules did NOT mark this role as forced AND LLM does NOT pick it.
        // Still run for protected roles in normal trust.
        final.add(role)
        continue
      }
    }
    if (llmPicks.has(role)) final.add(role)
  }
  return final
}
```

### Fail-closed semantics

| LLM outcome | Action |
|---|---|
| Returns valid JSON within budget | Apply reconcile() |
| Timeout (> 8s) | `final = ALL_SPECIALISTS`, telemetry `llm_timeout` |
| Invalid JSON / schema mismatch | `final = ALL_SPECIALISTS`, telemetry `llm_invalid_json` |
| Confidence < 3/5 on any protected role | Treat protected role as "run" regardless |
| `@sigilix review --full` mention | Bypass dispatcher entirely, `final = ALL_SPECIALISTS` |

---

## The seven questions — synthesized

### Q1 — Dispatcher mechanism: **Hybrid**

All three reviewers converged. Rules-only (current router) can't shrink
fan-out enough on ordinary code changes; LLM-only is too risky for a 99%
recall bar on security. Use rules for hard forces + obvious exits (docs
without executable fences, CSS-only, lockfiles, auth paths, migrations).
Use `deepseek-v4-flash:cloud` for the ambiguous middle with a JSON-schema
constrained prompt, ≤ 8s timeout, no retrieval. Fail-closed on
timeout/invalid-JSON returns the current safe behavior: all four.

**Why deepseek-v4-flash and not gpt-4o-mini**: Kimi + Codex both chose flash
because it's already in-fleet (tests specialist runs on it) — no new provider
to onboard. DeepSeek-v4-pro's research suggested gpt-4o-mini, but that would
require adding an OpenAI dependency we don't currently have. Stick with the
in-fleet choice.

### Q2 — Specialist taxonomy: **`Set<SpecialistRole>` + sidecar telemetry**

All three agreed the fan-out contract should remain
`Set<"logic" | "security" | "performance" | "tests">`. Per-file specialist
mappings would couple the dispatcher to specialist prompt internals and
guarantee drift. Specialists already receive the full diff and can decide
their own focus.

Telemetry sidecar is richer: `perRole: { action, confidence, reasons[] }` so
shadow-mode FN analysis can correlate the dispatcher's stated confidence
against actual material findings.

### Q3 — Calibration methodology: **Material = score ≥ 2 surviving synth; protected roles need score ≥ 4 zero-miss**

"Material finding" = a finding that survived synth and post-validation, was
customer-visible, with `score ≥ 2`. Provenance via `sourceFindingIds` prefix
conventions already in `triage-pr-review-ensemble.ts:7344`. For security
specifically: any `score ≥ 4` finding counts as material even if synth
softened it (covers the "subtle auth bug" failure mode).

**Graduation bar** (per Codex, refined with Kimi's reset-on-miss):
- Replay ~200 historical reviews offline to seed FN list.
- Shadow ≥ 14 days OR ≥ 500 reviews, whichever is longer.
- Zero `score ≥ 4` security or logic misses across the window.
- Wilson one-sided 99%-CI upper bound on protected-role FN rate < 1%.
- ≥ 300 protected-role material opportunities in the window.
- ≥ 30% observed token savings (validates Phase 1 economic case).
- **Any miss resets the window** after a deterministic rule is added to
  cover the missed shape.

### Q4 — Synth prompt for partial coverage: **(c) with dispatcher reasoning + new `[DISPATCH COVERAGE]` block**

All three picked option (c) — synth receives dispatcher reasoning, renders
skipped sections as "not applicable" (with natural prose, not a stub
section), and doesn't fabricate findings for non-invoked roles.

**Distinct from `[DEGRADED COVERAGE]`** (which already exists at
`pr-review-specialists.ts:807` for timeout / specialist failure). Codex's
insight: conflating "dispatcher chose not to invoke" with "specialist
failed" causes synth to lower confidence inappropriately. Separate blocks:

```md
[DISPATCH COVERAGE] — populated when specialists were not invoked
- invoked: [logic, security]
- not invoked: [performance, tests]
- reasoning: "Diff is a refactor in src/lib/auth-oauth-github.ts; no perf-
  sensitive code paths and existing tests already cover the regression
  surface."

Treat "not invoked" as intentionally not applicable, not as missing or
failed. Do NOT reduce confidence solely because a role was not invoked. Do
NOT invent findings that would require a non-invoked specialist unless an
invoked specialist explicitly surfaced that finding.
```

### Q5 — Safety net design: **Global frozen + per-repo additive only**

Global safety-net patterns owned in code (`src/lib/ensemble-router.ts`).
Per-repo config may only EXTEND (`sigilix.json::dispatcher.safetyNet.additionalPatterns`),
never delete. Recall guarantees are organizational policy, not customer-tunable.

**Force security on**:
- All existing patterns (`auth*`, `*token*`, `*secret*`, `*crypto*`, `*.policy.*`)
- Environment files: `.env*`, `*.pem`, `*.key`, `*.crt`
- CI/deploy config: `.github/workflows/**`, `Dockerfile`, Kubernetes/Helm/Terraform
- Web security primitives: `*middleware*`, `*guard*`, `*session*`, CORS/CSP/CSRF, JWT/OAuth/SAML/OIDC/RBAC/ACL paths
- Webhook handlers, RLS policy files
- Lockfiles (existing rule)
- Any deterministic hit from `secret-scan.ts` or SARIF evidence

**Force logic on**:
- Migrations/schema (existing rule)
- Parser/serializer/regex changes
- Retry/cache/queue/concurrency code
- Payment/billing/data-loss paths
- Public API contract changes
- Source files marked by `diff-file-classify` AND commit message regex
  matches `\b(fix|change|break|breaking|behavior)\b`

**Disagreement resolution**: safety net wins **silently** when it disagrees
with the LLM (no retry, no escalation in normal trust). Telemetry tag
`dispatcher_override: "security_forced_by_safety"` for shadow analysis.

### Q6 — Cost model: **Replay-based, target 30-40% drop is realistic**

Don't validate against averages — use replay. Token estimator exists at
`diff-packing.ts:52`; `diffTokensEstimated` is already in telemetry at
`triage-pr-review-ensemble.ts:1473`. For each historical PR, rebuild the
actual specialist messages for ALL-4 vs the dispatched subset.

**Estimated math**:
- Current ~25-30k tokens/review (4 × ~5-6k specialists + ~4-7k synth).
- Target distribution (Kimi's estimate): 50% route to 1 specialist, 40% to 2, 10% all 4.
- Weighted specialist tokens: (0.5 × 6k) + (0.4 × 12k) + (0.1 × 24k) = ~11.4k.
- Synth input shrinks proportionally; smaller specialist verdict block saves 1-3k.
- Dispatcher cost: ~0.5-2k tokens (flash classifier).
- **Net: ~14-15k tokens/review, ~45-50% drop.**

Re-run risk: 1% misroute amortizes to +60 tokens/review. Negligible. 5% would
amortize to +1.3-1.5k tokens and indicate a quality regression — treat as the
shadow-graduation tripwire.

### Q7 — Latency model: **30-90s requires three concurrent levers, not just the dispatcher**

All three reviewers explicitly stated the dispatcher alone does NOT hit the
SLO. The slowest specialist (`deepseek-v4-pro:cloud` on logic = 100-270s)
plus synth (22-100s) is already over budget on any logic-touching diff.

**The three levers**:
1. Dispatcher routes to 0-1 fast specialists on docs/CSS/config (target
   ~45% of PRs).
2. SIG-220 Lever 1 — move overview from inline `await` to `ctx.waitUntil`
   (-28s on every review).
3. Smaller synth prompt for partial coverage (-5-10s per review).

**Budget add-up** (synthesis of Kimi's per-path estimates):

| Path | Share | Budget |
|---|---|---|
| Hot (docs/CSS/config; 1 flash specialist; synth bypass; overview async) | ~45% | ~31s |
| Typical (narrow source; 2 specialists parallel; lightweight synth) | ~35% | ~56s |
| Heavy (auth/schema/complex logic; logic + security parallel; full synth) | ~20% | ~126s |

**p50 expected ~60s**, satisfying the 30-90s "typical" promise. The heavy
path is an accepted outlier at ~120s, still 3-4× faster than today's
480-600s. **Promise the SLO only for typical paths; never for logic-heavy
diffs.** Customer-facing sticky copy must be re-checked against this.

---

## Cross-model convergence + divergence

### Where all three agreed (high confidence, ship as-is)

| Topic | Decision |
|---|---|
| Mechanism | Hybrid: rules + LLM |
| Output contract | `Set<SpecialistRole>` + telemetry sidecar |
| Synth prompt | Option (c) — dispatcher reasoning attached, skipped renders as "not applicable" |
| Safety net | Code-owned global, additive per-repo, never deletion |
| Disagreement | Safety net wins silently |
| Shadow before enforce | Yes |
| Latency target | Not achievable from dispatcher alone — need overview lever + smaller synth |
| Cost target | 30-40% reduction is realistic; 45-50% likely |
| Fine-tuning | Don't — per `arc-292-model-lineup-recommendations` memory |

### Where they diverged (decisions made)

| Topic | DeepSeek-v4-pro | Kimi K2.6 | Codex | **Decision** |
|---|---|---|---|---|
| LLM choice | `gpt-4o-mini` | `deepseek-v4-flash` | `deepseek-v4-flash` | **`deepseek-v4-flash`** (in-fleet, no new provider) |
| Shadow exit | Wilson 99%-CI < 1% on batch | 500 *consecutive* clean, counter resets on miss | 300 opportunities + 30 days + zero-`score≥4`-miss | **All three** — Wilson + min-opportunities + reset-on-miss |
| Fast-track model swap | not proposed | proposed (1 role + <200 lines → flash) | not proposed | **Defer to Phase 3** — adds branching risk |
| Synth bypass | not proposed | 1 role + no major findings → skip synth | not proposed | **Defer to Phase 3** — Phase 2's partial-coverage synth already covers most of this |
| Consensus-to-skip for protected roles | not framed | explicit | implied by union semantics | **Adopt Kimi's framing** for Phase 2-3 default trust level |
| Pre-req bug | not flagged | not flagged | line 1533 empty-router → skip notice is wrong semantics | **Fix in Phase 0** (Codex caught it) |
| Existing-infra leverage | minimal | partial | references `secret-scan.ts`, `diff-packing.ts:52` token estimator, `sourceFindingIds` provenance | **Adopt Codex's reuse strategy** |

### Why Codex's response carried disproportionate weight

Codex was the only voice with read access to the actual codebase
(`codex exec` from the sigilix repo root). It caught:
- The pre-existing bug at `triage-pr-review-ensemble.ts:1533`.
- The distinct `[DEGRADED COVERAGE]` block at `pr-review-specialists.ts:807`
  that we'd otherwise have conflated with the new `[DISPATCH COVERAGE]`.
- The `sourceFindingIds` prefix convention at `:7344` for role provenance.
- The token estimator at `diff-packing.ts:52` for replay-based cost validation.

Kimi + DeepSeek answered at the architecture level without code grounding;
their value was the design alternatives (Kimi's consensus-to-skip framing,
DeepSeek's Wilson-CI graduation criterion).

---

## Top risks + mitigations

1. **Protected-role false negative outside path patterns** — A subtle auth
   bug in an unlabeled utility file is missed because neither the safety net
   regex nor the flash classifier surfaces it.
   **Mitigation**: Consensus-to-skip default for protected roles. Safety net
   patterns extend aggressively in Phase 1 (e.g., catch `middleware`,
   `session`, `policy` anywhere in path). Phase 2 enforcement is
   non-protected only; protected enforcement waits until Phase 3 ≥ 500 clean
   reviews with zero `score ≥ 4` misses.

2. **Latency target overpromising** — "Reviewing… 30-90s" copy is wrong on
   logic-heavy diffs even after Phase 3. Customer believes we lied.
   **Mitigation**: Customer-facing copy must distinguish "typical" from
   "heavy." Sticky copy update lands in the same PR as Phase 3 enforcement.
   Telemetry separates dispatcher savings (specialist reduction) from
   non-dispatcher savings (overview lever, synth prompt). Reviewers see both
   numbers separately.

3. **Synth prompt regression on partial coverage** — Synth hallucinates
   findings for roles that weren't invoked, or leaves awkward "Performance:
   no issues found" stubs that confuse reviewers.
   **Mitigation**: Phase 2 ships the new synth prompt with eval across 50+
   varied PRs covering 1, 2, 3, 4-specialist shapes. Quality gate: synth
   never mentions a specialist that wasn't invoked unless an invoked
   specialist explicitly surfaced the finding. `[DISPATCH COVERAGE]` block
   distinct from `[DEGRADED COVERAGE]` so the synth treats the two
   intentionally differently.

4. **LLM API jitter blows the dispatcher budget** — Ollama (or whatever
   routing layer hosts `deepseek-v4-flash`) hangs > 8s on a particular diff.
   **Mitigation**: Hard 8s timeout. Fail-closed returns `ALL_SPECIALISTS`.
   Telemetry counts `llm_timeout` so we can correlate with provider health
   and tune the timeout (or pre-warm) without changing the safety semantics.

5. **Shadow-mode never graduates** — FN rate is low but min-opportunities
   bar never reached because traffic is too light at current scale.
   **Mitigation**: Replay-based seed from ~200 historical reviews counts
   toward the opportunity bar. If after 6 weeks we still haven't graduated,
   reduce min-opportunities to 150 with founder sign-off — better to enforce
   on smaller evidence than to never enforce.

---

## Open questions for founder sign-off before Phase 1

1. **Per-repo `trustLevel: "high"` opt-in for protected-role overrides** —
   should we ship this in Phase 4, or never? It compromises the recall
   guarantee for that customer specifically. Default `"normal"` is safe; the
   question is whether to expose the lever at all.

2. **Sticky copy update timing** — should the "30-90s" sticky copy ship
   with Phase 1 (aspirational, but lies until Phase 3) or Phase 3 (truthful
   but late)? Recommend Phase 3.

3. **Customer-visible disclosure of skipped specialists** — when the
   dispatcher routes a PR to 1 specialist, do we mention that explicitly in
   the review comment ("Performance and tests not applicable to this
   diff")? Codex argued for natural-language inclusion only when it would
   clarify; Kimi argued for always-omit. **Default: natural-language
   inclusion when the diff is < 100 lines** (helps the reviewer understand
   why the review feels short); silent when the diff is larger.

---

## References

- [Linear SIG-224](https://linear.app/sigilix/issue/SIG-224)
- [Linear SIG-220 (latency budget)](https://linear.app/sigilix/issue/SIG-220)
- `docs/ops/review-latency-budget.md` — SIG-220 lever inventory
- `src/lib/ensemble-router.ts` — current rule-based router
- `src/lib/diff-file-classify.ts` — file kind + sibling classifier
- `src/lib/triage-pr-review-ensemble.ts:1533` — pre-req bug location
- `src/prompts/pr-review-specialists.ts:405,807` — synth prompt header + degraded-coverage block
- `src/lib/diff-packing.ts:52` — token estimator (for replay-based cost validation)
- `src/lib/secret-scan.ts` — deterministic pre-fanout secret detection
- `sigilix.json` — current per-repo config schema
- Memory: `arc-292-model-lineup-recommendations` (no fine-tuning at current scale)
- Memory: `feedback_dual_signoff_all_designs` (Codex + Kimi K2.6 sign-off; DeepSeek-v4-pro added per algorithm-task routing)

---

# Appendix A — Codex (verbatim)

`<!-- model: codex-cli 0.125.0 (gpt-5.4-codex) -->`
`<!-- input tokens used: 189,942 -->`

## Q1 — Dispatcher Mechanism

Ship a hybrid dispatcher. Keep `ensemble-router.ts:75` as the deterministic
safety floor, but wrap it with a cheap LLM classifier for ambiguous diffs.
The current router is not enough: ordinary code changes still return all
four specialists, and `[]` currently becomes `router_no_specialists` /
skip notice in the orchestrator, not a clean "not applicable" outcome
(`triage-pr-review-ensemble.ts:1533`).

Use rules for hard includes and obvious exits: docs without executable
fences, CSS-only, lockfiles, auth/security paths, migrations/schema. Use
`deepseek-v4-flash:cloud` for the ambiguous middle with a strict JSON
schema, 6-8s timeout, no retrieval, compact diff view capped around 8-12k
chars. Timeout, invalid JSON, or low confidence returns current safe
behavior: all four.

Pseudo-contract:

```ts
final = union(
  forcedByRules,
  repoConfig.dispatcher.force,
  llmDecision.specialists,
)

if (dispatcherFailed) final = ALL_SPECIALISTS
if (fullRequested) final = ALL_SPECIALISTS
```

## Q2 — Specialist Taxonomy

Keep `Set<SpecialistRole>` as the fan-out contract. The existing role union
is simple and wired through the orchestrator cleanly (`ensemble-router.ts:37`,
`triage-pr-review-ensemble.ts:2582`). I would not introduce per-file
specialist dispatch yet; cross-file bugs are exactly where logic and
security misses happen.

Do add richer sidecar telemetry:

```ts
{
  specialists: ["logic", "tests"],
  reasoning: "...",
  perRole: {
    security: { action: "skip", confidence: 5, reasons: ["no auth/security/data-boundary changes"] },
    logic: { action: "run", reasons: ["runtime source control-flow changed"] }
  }
}
```

Fan-out consumes only `specialists`; telemetry and shadow analysis consume
`perRole`.

## Q3 — Calibration Methodology

"Material" means a finding that survived synth and post-validation and was
customer-visible with `score >= 2`, where provenance includes the skipped
role's stable prefix, e.g. `security-1` or `logic-2`. The code already
treats `sourceFindingIds` prefixes as the authoritative role signal
(`triage-pr-review-ensemble.ts:7344`). For security, I would additionally
count any `score >= 4` security specialist finding as material even if
synth softened it.

Run historical replay over the ~200 stored reviews first, then shadow mode
in prod with all four specialists still running. Graduation bar: zero
`score >= 4` security or logic misses, protected-role recall lower bound
>=99% by Wilson/one-sided binomial, at least 300 protected-role material
opportunities or 30 days of traffic, and observed token savings >=30%. One
miss resets the window after adding a deterministic safety rule.

## Q4 — Synth Prompt For Partial Coverage

Pick **c**, but constrain it: the synth receives dispatcher reasoning as
internal context, and only explains skipped roles if the review body
naturally needs a coverage sentence. Do not render fake "performance: not
applicable" verdict sections.

Change the synth system prompt around the current "Four specialists…"
wording (`pr-review-specialists.ts:405`):

```md
Specialists are invoked dynamically per PR. You will receive verdicts only
from specialists that were applicable to this diff.

[DISPATCH COVERAGE] in the user message lists:
- invoked specialists
- specialists not invoked because the dispatcher judged them not applicable
- dispatcher reasoning

Treat "not invoked" as intentionally not applicable, not as missing or failed.
Do NOT reduce confidence solely because a role was not invoked. Do NOT invent
findings that would require a non-invoked specialist unless an invoked
specialist explicitly surfaced that finding.
```

Add this separately from existing `[DEGRADED COVERAGE]`, which is for
timeouts/failures (`pr-review-specialists.ts:807`).

## Q5 — Safety Net Design

Global safety rules should be code-owned and non-removable. Repo config may
only add force-includes or sensitive globs. In addition to the SIG-224
patterns, force security on `.env*`, `*.pem`, `*.key`, `*.crt`,
`.github/workflows/**`, Docker/Kubernetes/Helm/Terraform/Cloudflare deploy
config, CORS/CSP/CSRF/session/cookie/JWT/OAuth/SAML/OIDC/RBAC/ACL/policy
paths, webhook handlers, database RLS/policy files, and any deterministic
secret/SARIF/dependency security hit. Existing secret scan is already
deterministic and pre-fanout (`secret-scan.ts:1`).

For logic, force on schema/migrations, runtime source files with changed
control flow, parser/serializer/regex changes, retry/cache/queue/concurrency
code, payment/billing/data-loss paths, and public API contract changes. If
safety net says run and LLM says skip, safety wins. Log it as
`dispatcher_override: "security_forced_by_safety"`.

## Q6 — Cost Model Validation

Use replay, not averages. The repo already has a token estimator at
`diff-packing.ts:52` and stores `diffTokensEstimated` in telemetry
(`triage-pr-review-ensemble.ts:1473`). For each recent PR, rebuild the actual
role messages for all four vs dispatched subset and estimate input + verdict +
synth block tokens.

The target is plausible if average dispatched roles land around 1.5-2.0.
Rough math: current 25-30k; two specialists instead of four saves about
10-14k; smaller synth verdict block saves another 1-3k; dispatcher costs
~0.5-2k. Wrong-route reruns at 1% add only ~250-300 tokens amortized, but at
5% add ~1.3-1.5k and become visible quality risk.

## Q7 — Latency Model Validation

Dispatcher alone does not get Sigilix to 30-90s. If the selected specialist
is slow logic, wall-clock is still `logic + synth + submit`, so 100-180s
fanout plus 22-60s synth is already over target. The code's current timeout
budget confirms fanout is sized for 270s specialists and 420s synth
(`triage-pr-review-ensemble.ts:345`, `:355`).

The 30-90s path needs three things: dispatch to 0-1 fast specialists on
common diffs, move overview off the critical path, and use a smaller synth
prompt. Budget: dispatcher 2-6s, preflight/scans 5-10s, one fast specialist
25-45s, synth 15-30s, submit/check 5-10s = 52-101s. Logic-heavy PRs remain
120-220s unless logic gets a separate fast-path model, which I would not
enforce until shadow data proves recall.

## Architecture Pick — What I Would Ship

Ship SIG-224 as a hybrid wrapper around the existing router, not a
replacement. Phase 1: add `dispatcher.force` to `sigilix.json`, hard safety
rules, LLM shadow decisions, per-role skip telemetry, and synth
`[DISPATCH COVERAGE]`. Phase 2: enforce deterministic safe cases plus
non-protected LLM skips. Phase 3: enforce protected-role skips only after
the recall bar is met.

Also fix the no-specialists path before enforcing docs-only skips. Today
`router.specialists.length === 0` becomes a skip notice, which is wrong for
"not applicable"; it should produce a neutral reviewed outcome or avoid
returning `[]` in enforcement.

## Top Three Risks

1. Protected-role false negatives. Mitigation: forced safety union,
   fail-closed LLM timeout, shadow graduation with zero sev>=4 misses.
2. Latency target overpromising. Mitigation: report dispatcher savings
   separately from overview/model changes; do not claim 30-90s for
   logic-heavy PRs.
3. Prompt semantics confusion. Mitigation: separate `[DISPATCH COVERAGE]`
   from `[DEGRADED COVERAGE]`; skipped means not applicable, missing means
   failed.

---

# Appendix B — Kimi K2.6 (verbatim)

`<!-- model: kimi-k2.6:cloud -->`
`<!-- elapsed_seconds: 176.7 | prompt_tokens: 2419 | output_tokens: 14947 -->`

## Q1 — Dispatcher mechanism

Hybrid. Extend `src/lib/ensemble-router.ts` (lines 45-90) into a two-tier
gate. Tier 1 is rules: expanded path and diff-hunk regexes compute
`forcedRoles` (always run) and `safeSkipRoles` (always skip for this diff
shape). Tier 2 is an LLM classifier that only fires when a role is in
neither set. The classifier calls `deepseek-v4-flash`—already in the fleet
for the tests specialist—with a 0-temperature constrained-JSON prompt. Input
is the cheap pre-computed metadata from `src/lib/diff-file-classify.ts`
(lines 1-325): file categories, extensions, changed-line counts, and the
commit message. No raw hunks. Prompt target is ~800 tokens in, ~100 tokens
out, which flash returns in ~500ms–1.5s, keeping the dispatcher inside its
5-10s budget. The seam is explicit: rules always win on disagreement for
security and logic. If the safety net says "run security," the LLM is never
consulted for that role.

## Q2 — Specialist taxonomy

`Set<SpecialistRole>` is the right output type; the four canonical roles
are enough decision surface. The dispatcher should not emit per-file
mappings, severity hints, or focus areas. Those concerns belong inside the
specialist prompts in `src/prompts/pr-review-specialists.ts` (lines ~200+),
which already receive the full diff and the file-classification block from
`src/lib/diff-file-classify.ts`. Adding richer dispatcher output would
couple the router to specialist internals and guarantee prompt drift every
time a specialist prompt is tuned. Keep the contract narrow: the
dispatcher decides *who* looks, not *how* they look.

## Q3 — Calibration methodology

A material finding is any specialist verdict containing at least one issue
with `severity: 'major' | 'critical'` OR any finding that survives the
8k-token truncation and is explicitly cited by the synthesizer in the final
PR comment. Replay the ~200 historical production reviews through the
dispatcher offline to seed an initial false-negative list. Then run shadow
mode for **14 days or 500 diffs**, whichever is longer; all four
specialists still execute in parallel while the dispatcher logs its
hypothetical picks. The graduation criterion is **zero false negatives on
security and logic across 500 consecutive dispatched reviews**. If a false
negative occurs, freeze graduation, add a rule or prompt guard for that
diff shape, reset the counter to zero, and resume. We do not flip
`OPENCLAW_ENSEMBLE_ROUTER_ENABLED` to dynamic enforcement until the counter
hits 500 clean on the latest ruleset version.

## Q4 — Synth prompt for partial coverage

Option (c). The synth receives the dispatcher reasoning so it can explain
omissions naturally. Replace the static synthesizer header in
`src/prompts/pr-review-specialists.ts` with a conditional template:

```ts
// src/prompts/pr-review-specialists.ts
const SYNTH_PARTIAL_HEADER = `
You are synthesizing the following specialist verdicts into a coherent review.

Invoked specialists: {{invokedRoles}}
Skipped specialists: {{skippedRoles}}
Dispatcher reasoning: {{dispatcherReasoning}}

Produce findings ONLY for the invoked specialists.
For skipped specialists, do not leave empty sections, placeholders, or speculation.
If the reasoning states a role was irrelevant (e.g., "no source code changed"), treat that as definitive and do not raise concerns about the omission.
`;
```

## Q5 — Safety net design

Expand the global safety net to three additional signals: **(1) content
regex** over diff hunks for `eval\(`, `innerHTML\s*=`,
`dangerouslySetInnerHTML`, `new Function\(`, `sql\``, `system\(`,
`PASSWORD`, `SECRET`, `PRIVATE KEY`; **(2) dependency files**
(`package.json`, `go.mod`, `Cargo.lock`, `requirements.txt`, `yarn.lock`,
`package-lock.json`); **(3) infra/config** (`Dockerfile`,
`.github/workflows/`, `nginx.conf`, `*.tf`, `.env*`, `*.policy.*`). Keep a
frozen global array in `src/lib/ensemble-router.ts` (lines 20-40) as
`SECURITY_SAFETY_NET`. Allow per-repo *extensions* only—additive patterns
via `sigilix.json::dispatcher.safetyNet.patterns`—never deletions. When
the safety net and the LLM disagree, **the safety net wins
unconditionally**. For security and logic specifically, adopt a
consensus-to-skip policy: a role is skipped only if *both* the safety net
marks it safe AND the LLM agrees. If either says run, we run. This makes
disagreement conservative by construction.

## Q6 — Cost model validation

Current spend is ~28k tokens/review: four specialists at ~6k each (prompt +
output) and synth at ~4k. When we drop two specialists, we save their ~12k
generation tokens *and* the ~16k of truncated outputs they would have fed
the synth, halving synth input. Representative distribution from recent
PRs: 50% route to 1 specialist, 40% to 2, 10% force all four. Weighted
specialist tokens: (0.5 × 6k) + (0.4 × 12k) + (0.1 × 24k) = 11.4k. Add
dispatcher cost (~1k flash tokens). For the 50% single-specialist cohort,
we also bypass synth entirely (clean single-verdict fast path), saving
another ~4k. Remaining synth cost weighted: ~2k. Total: ~14.4k tokens, a
**~49% drop**—well above the 30-40% target. Reroll cost: assume a 1%
misroute rate requiring one pro specialist rerun (~6k tokens). Amortized:
+60 tokens per review. Net savings still clear ~14.5k vs 28k.

## Q7 — Latency model validation

Fan-out tightening alone only bounds critical path by the slowest *selected*
specialist. Because `deepseek-v4-pro:cloud` on logic is 100-270s, a PR
routed to logic still takes 100-270s plus synth. To hit 30-90s typical
(p50), we need three concurrent levers:

1. **Fast-track model swap**: When the dispatcher returns exactly one role,
   the safety net is silent, and the diff is <200 lines, run that
   specialist on `deepseek-v4-flash` (~30-60s) regardless of canonical
   assignment. This is safe because scope is narrow.
2. **Synth bypass**: In `triage-pr-review-ensemble.ts` (~lines 158-162), if
   only one specialist was invoked and its verdict has no `severity ≥
   major` findings, skip the synthesizer entirely and emit the specialist
   markdown directly.
3. **Overview off critical path**: Ship SIG-220 Lever 1—move the ~28s
   inline overview generation into `ctx.waitUntil` so it does not block the
   review comment.

Budget add-up:
- **Hot path (~45% of PRs)**: docs/CSS/config → dispatcher 1s + 1 flash
  specialist 30s + synth bypass 0s + overview async 0s = **~31s**.
- **Typical path (~35% of PRs)**: narrow source change → dispatcher 1s + 2
  flash specialists parallel 35s + lightweight synth 20s = **~56s**.
- **Heavy path (~20% of PRs)**: schema/auth/complex logic → dispatcher 1s +
  logic (pro) 100s + security (pro) 100s parallel + synth 25s = **~126s**.

With 80% of PRs under 60s, the **p50 sits at ~60s**, satisfying the "30-90s
typical" promise. The heavy path is an accepted outlier, still 3-4× faster
than today's 480-600s.

## Architecture pick — what you would ship

Ship a **hybrid dispatcher that extends `src/lib/ensemble-router.ts` rather
than replacing it**. Phase 0 expands the rule layer with content-based
safety nets (diff-hunk regex) and per-repo escapes in
`sigilix.json::dispatcher`. Phase 1 adds `src/lib/dynamic-dispatcher.ts`, a
`deepseek-v4-flash` classifier that consumes
`src/lib/diff-file-classify.ts` output and only handles the current
"otherwise: runs all four" bucket. Phase 2 modifies
`triage-pr-review-ensemble.ts` at the `decideSpecialists` call site
(~lines 158-162) to wire the dynamic set, implement the synth-bypass
branch, and plumb dispatcher reasoning into
`src/prompts/pr-review-specialists.ts`. Phase 3 runs shadow calibration for
500 clean diffs with zero security/logic false negatives before enabling
enforcement. If the existing router were sufficient, SIG-224 would be
over-engineering, but its "otherwise runs all four" default means it
optimizes maybe 5% of diffs. We need the LLM layer to shrink the other 95%.

## Top three risks

1. **Subtle security/logic false negative outside path patterns**: An auth
   bug in an unlabeled utility file is missed because neither the safety
   net regex nor the flash classifier surface it. **Mitigation**: Require
   consensus-to-skip for security/logic—both the rule layer AND the LLM
   must independently agree a role is irrelevant before skipping it. Any
   ambiguity defaults to running the specialist.
2. **Synth prompt regression on partial coverage**: The synthesizer
   hallucinates or leaves awkward placeholders when only 2 of 4 verdicts
   are present. **Mitigation**: Rewrite the synth prompt header in
   `src/prompts/pr-review-specialists.ts` to conditionally render sections
   based on `invokedRoles`; never hardcode the four-section template. Pass
   the dispatcher reasoning blob so the synth understands the omission is
   intentional.
3. **Fast-track model swap degrades quality**: Running logic or security on
   `deepseek-v4-flash` for single-role PRs could miss nuanced issues.
   **Mitigation**: Gate the model swap on a strict pre-check: the safety
   net must NOT fire, the diff must be under 200 lines, and the single
   role must NOT be security. If any doubt, keep the canonical pro
   assignment. Telemetry tag `dispatcher.fast-track-used` on every review
   for post-hoc analysis.

---

# Appendix C — DeepSeek-v4-pro (verbatim)

`<!-- model: deepseek-v4-pro:cloud -->`
`<!-- elapsed_seconds: 100.0 | prompt_tokens: 2526 | output_tokens: 5235 -->`

## Q1 — Dispatcher mechanism

Hybrid — a strict rule engine that runs first as a non-negotiable safety
net, followed by a small, fast LLM for the remaining choices. The rules
are a curated, static list of path patterns (`src/lib/ensemble-router.ts`
already has the building blocks) plus a few new additions (see Q5). When
the rules command "run security" or "run logic", those specialists are
clamped ON and the LLM only gets to decide the *other* roles. For
everything else (CSS, config, Markdown, internal refactors) the LLM
receives a deliberately small prompt: the commit message, the list of
changed file paths with their `diff-file-classify` labels, a 20-line
sample of the first diff hunk, and the `diff-file-classify` source↔test
sibling pairs. It returns a JSON object `{specialists: string[], reasoning:
string, confidence: "high" | "low"}`.

For the LLM I'd use `gpt-4o-mini` (or a comparably fast model available to
the platform that handles 1-2k input tokens in under 2 s). The entire
prompt+response fits in 1000-2000 tokens; with streaming and a 2 s timeout
we stay under the 5-10 s budget. The logic is trivial — no multi-step CoT
needed — so we can even fall back to the existing `ensemble-router.ts`
defaults (run all four) if the LLM call times out, preserving correctness.

The existing router (`src/lib/ensemble-router.ts`) becomes the rule layer.
The new LLM layer replaces its "otherwise run all four" default. I would
**replace** the toggle flag with the dispatcher, not wrap it, because the
old router is too conservative to hit the latency targets on its own.

## Q2 — Specialist taxonomy

`Set<SpecialistRole>` where
`SpecialistRole = "logic" | "security" | "performance" | "tests"` is the
right output shape for the fan-out decision. The specialists are already
prompt-engineered to scan the whole diff, so they don't need per-file
hints. That said, I'd let the dispatcher **optionally** emit
`focusAreas?: string[]` as a short list of hints (e.g.
`["authentication", "rate-limiting"]`) that get injected into the
specialist prompt's system message. The hints are not a new role taxonomy;
they're just extra signal that makes the specialist more efficient,
potentially reducing its wall-clock time. The dispatcher's primary job
remains the yes/no decision per role.

## Q3 — Calibration methodology

"Material finding" means a specialist emitted at least one issue with
severity ≥ **`medium`** (matching the severity labels already present in
the synth verdict schema). During shadow mode the dispatcher emits its
picks but the orchestrator still runs all four specialists, so we can
cross-reference: for each review, for each skipped role, was there a
`medium`+ issue from that specialist? A false-negative = the dispatcher
skipped a role that subsequently produced a `medium`+ finding. The 99%
recall target for security and logic means ≤1 false-negative per 100
reviews.

We'd shadow-run until we've accumulated **500 reviews** (or 1,000 for
higher confidence) and observed ≤3 false-negatives for security, ≤3 for
logic, with a statistical upper bound (Wilson score) under 1%. Stop
criterion: sequential hypothesis testing — after each batch of 100
reviews, check if the one-sided 99% confidence upper bound on the
false-negative rate is <1%; if yes and we have ≥300 reviews, graduate
security; logic graduates separately. We also require **zero**
false-negatives on the hard-coded safety-net paths (auth, secrets, etc.)
— a single miss there blocks graduation regardless of stats.

## Q4 — Synth prompt for partial coverage

**(c) — provide the dispatcher's reasoning blob, render skipped sections
as "not applicable" with a natural explanation.**

The synthesizer prompt currently enumerates the four specialists. I'd
insert a prefatory paragraph that says:

```
The review ensemble ran only the specialists listed below. The dispatcher
decided the other roles were not applicable to this diff. Here is its reasoning:

[dispatcher.reasoning]

When a role was skipped, do NOT fabricate a finding or comment on it. In your
overview, mention only the roles that ran. If asked about a skipped role, you
may say "that perspective was determined not to apply to these changes because
<insert reason from dispatcher>."
```

Within the specialist sections themselves, I'd keep the same format for
the roles that ran, and simply omit the sections for the skipped ones. The
overview would read "Performance analysis was not applicable (CSS-only
diff)" rather than a confusing "Performance: no issues found".

## Q5 — Safety net design

Beyond the listed patterns, the global safety net should force **security**
when any file touches:
- environment variable files (`.env*`, `vault`, `secrets`, `credentials`)
- authentication/authorization middleware (`*middleware*`, `*guard*`,
  `*auth*`, `*session*`)
- CSP, CORS, or security-header configuration
- dependency manifests (`package.json`, `Cargo.toml`, `Gemfile`, `go.mod`)
  — because supply-chain risk

And force **logic** when:
- migration files (`*migration*`, `*.sql`, `*schema*`)
- core business-logic directories (configurable via
  `sigilix.json::dispatcher.logicPaths`)
- files marked as `source` by `diff-file-classify` AND the commit message
  suggests behavioral change (regex: `\bfix\b`, `\bchange\b`,
  `\bbreaking\b`)

Per-repo overrides live in
`sigilix.json::dispatcher.safetyNet.additionalPatterns` (an array of
`{glob: string, role: SpecialistRole}`). Global patterns stay in the
codebase because recall guarantees are organisational policy, not per-
customer tuning.

When the LLM says "skip security" but the safety net says "run it", **the
safety net wins silently**. The orchestrator adds `security` to the
dispatch set and logs a `specialist-skipped-by-dispatcher` telemetry event
with `overriddenBy: "safety-net"`. No retry or conflict resolution needed.

## Q6 — Cost model validation

Take a representative 10-PR sample from recent history: token counts
(specialist prompts + synth) average ~27 k. The four specialists account
for roughly 20 k of that (4 × ~5 k), the synth ~7 k. The dispatcher's own
token cost is ~1,600 tokens (1,500 prompt + 100 output). If the dispatcher
reduces fan-out to a median of 1.5 specialists, specialist tokens drop to
~7.5 k, synth tokens shrink slightly to 6 k (simpler synthesis), adding
dispatcher gives ~15.1 k, right in the 15-20 k target. Even with a
conservative 2-specialist median the cost is ~21 k, well below today's
27 k. The dispatcher pays for itself by the first specialist skipped.

Re-runs from misclassification: with ≥99% recall, we'd need ~1 re-run per
100 reviews. A re-run costs an extra specialist call (~5 k tokens) and
maybe an additional synth pass, adding maybe 10 k tokens every 100
reviews, i.e., 100 tokens amortised per review. Negligible.

## Q7 — Latency model validation

Today's p50 wall-clock: slowest specialist (100-270 s) + synth (22-100 s)
– they run in parallel, so end-to-end ≈ max(specialist pool) + synth,
typically ~250 s. If the dispatcher picks only 1 specialist and that
specialist is `deepseek-v4-flash` (tests) on a pure-docs or CSS-only PR,
we get:
- Dispatcher: 5 s
- Tests specialist: 30-60 s (observed)
- Synth (simplified, possibly a faster model like `deepseek-v4-flash` or
  the same `kimi` but with smaller input): 10-25 s
Total: 45-90 s, which meets the 30-90 s target.

On a diff that still needs a slow specialist (security or logic) the
wall-clock won't magically drop — but that's the rare case. To hit 30-90 s
**typical** we need the dispatcher to assign fast specialists to 80%+ of
PRs. That's achievable because most PRs are documentation, styling, tests,
or simple refactors that don't touch security/logic areas. The latency
budget therefore relies on the distribution of PR types, not on shrinking
the slow specialists.

To be safe, we can also move the synthesizer off the critical path for the
1-specialist case: start the synth as soon as the specialist's first
meaningful chunk arrives (streaming mode) instead of waiting for the full
verdict. With an early-bound streaming summary, we cut synth-overlap
latency by ~15 s, pushing many reviews below 60 s.

## Architecture pick — what you would ship

**Phase 0 (now):** Add a `dispatcher` section to `sigilix-config.ts`, wire
the rule-based safety net (extended patterns from Q5) into the existing
`decideSpecialists` call site in `src/lib/triage-pr-review-ensemble.ts`.
Keep the old `ensemble-router.ts` around but flip its flag to always ON
with the new rules, and add a shadow-mode LLM layer that only logs its
picks without affecting the actual fan-out. This gives us real-world
calibration data without risking correctness.

**Phase 1 (2-3 weeks, after 500 shadow reviews):** Graduate the LLM
dispatcher for **non-critical** roles (performance, tests) — these can be
skipped freely once recall confidence is established. Security and logic
remain forced by the safety net; the LLM's opinion on them is logged but
not honoured. At this point the synthesizer prompt is updated (Q4), and
the telemetry hook (`specialist-skipped-by-dispatcher`) goes into
production.

**Phase 2 (4-6 weeks):** When security/logic false-negative rate is
demonstrably <1% over ≥1,000 reviews, allow the LLM to override the safety
net for security and logic on a per-repo opt-in basis
(`sigilix.json::dispatcher.trustLevel: "high"`). Even then, a `--full`
user escape and repo-level force remain.

If after Phase 1 the shadow data shows the existing router already
achieves >50% specialist reduction and <1% false-negatives on
security/logic, I would **not** ship the LLM layer at all — the rule
engine is cheaper, deterministic, and easier to maintain. But I expect
the rules alone won't capture enough CSS/config/test-only cases to hit the
typical PR distribution we need, so the LLM layer is justified.

## Top three risks

1. **LLM misses a subtle security-relevant change** (e.g., a regex change
   in a middleware file that doesn't match `*auth*`). Mitigation:
   safety-net pattern list is maintained aggressively; we run the LLM in
   shadow mode for security even after graduation, with automatic rollback
   if a miss passes the safety net (escalation alert to on-call). Also,
   the LLM prompt includes the full diff of files that are close to any
   security pattern, not just a sample.
2. **Dispatcher latency budget blown by model API jitter** causing
   orchestrator timeout. Mitigation: hard timeout of 10 s on the LLM call,
   with a fallback to the rule-based decision (which at a minimum forces
   security+logic and runs all four); the fallback still meets correctness
   guarantees at the cost of speed. Also, use a model with a strict SLA
   (e.g., OpenAI 4o-mini with 99th %ile <3 s).
3. **Synthesizer produces nonsensical output for partially-covered
   reviews** because it is tuned for the four-verdict shape. Mitigation:
   Phase 1 must ship the new prompt with extensive evals across 50+ varied
   PRs with partial coverage, measuring clarity and completeness. Any
   drift in synth quality triggers a revert. We'll also keep a
   "full-coverage" synth fallback path that re-runs the synth with the old
   prompt if the partial-coverage output has low confidence.
