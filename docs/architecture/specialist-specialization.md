# SIG-97 — Specialist specialization through code: architecture

**Status**: Shipped. All four children merged to `main`.
**Linear**: [SIG-97](https://linear.app/sigilix/issue/SIG-97) (epic) — children
[SIG-108](https://linear.app/sigilix/issue/SIG-108) (security),
[SIG-109](https://linear.app/sigilix/issue/SIG-109) (logic),
[SIG-110](https://linear.app/sigilix/issue/SIG-110) (performance),
[SIG-111](https://linear.app/sigilix/issue/SIG-111) (tests).
**Date**: 2026-06-06
**Owners**: Sigilix Engine team
**Inputs**: Codex research `feature_gap_research_2026-05-19.md` — "Agent specialization
via code" (per-specialist leverage ranking: security #1).

---

## Executive summary

The PR-review ensemble runs four specialists — **logic / security / performance /
tests** — in parallel, then a synthesizer dedupes their verdicts into one posted
review. Each specialist routes to a capable closed-source model, but a generic LLM
"asked to think about security" is not a SAST engineer. SIG-97 closes that gap **in
code** — without model fine-tuning, which stays out of scope until training infra
exists — across four layers:

1. **Role-scoped deterministic facts** — each specialist's prompt carries only its own
   domain's pre-computed facts (secret-scan/dep-vuln/SARIF for security; AST-correctness
   for logic; perf-budgets for performance; coverage facts for tests). No cross-domain
   leak.
2. **Per-domain retrieval** — logic retrieves by changed *symbol*, performance by
   perf-keyword + anti-pattern bias, instead of generic PR-text retrieval.
3. **Versioned few-shot libraries** — `logic-examples.json`, `perf-examples.json`,
   `tests-examples.json` are checked in and rendered into the matching specialist prompt.
   Security's exemplars are the CWE-Top-25 bucket list plus required-field constraints.
4. **Per-specialist validation gates** — each domain has a hand-rolled validator that
   drops (or, recall-safely, demotes) malformed high-severity findings *before* they
   reach the synth, emitting `pr-review-finding-rejected-validation` telemetry. Every
   gate ships **shadow-first** and graduates to **enforce** only after its bake-off bar
   clears.

The guiding invariant is **recall-safety**: no gate may suppress or downgrade a real
P0/P1. Validators are severity-gated (they only constrain `score >= 4` findings) and
prefer **demote-to-body** over hard-drop, and the security gate carries an explicit
exemption for findings no scanner can corroborate (IDOR/authz).

---

## The four specialists

`SpecialistRole = "logic" | "security" | "performance" | "tests"`
(`src/lib/ensemble-router.ts`). The fan-out contract is a `Set<SpecialistRole>`; the
orchestrator builds one initial message per role via `buildSpecialistInitialMessage`
(`src/prompts/pr-review-specialists.ts`) and reconciles the verdicts in
`src/lib/triage-pr-review-ensemble.ts`.

| Specialist | Behaves like | Domain tools / facts | Few-shots | Validation gate |
|---|---|---|---|---|
| **Security** | a SAST engineer | secret-scan, dep-vuln, AST-security rules, SARIF, security-evidence manifest | CWE-25 bucket list + required `cweId`/`evidenceId` | `validate-security-finding.ts` (+ grounding, usage) |
| **Logic** | a static analyzer | AST-correctness rules, regex deterministic-checks, asymmetry/TOCTOU hints | `logic-examples.json` | `validate-logic-finding.ts` (+ refutation, window-blindness) |
| **Performance** | a perf reviewer | perf AST rules, `perfBudgets` hot-paths | `perf-examples.json` | `validate-perf-finding.ts` |
| **Tests** | a coverage engineer | sibling-test map, LCOV coverage-gap facts | `tests-examples.json` | `validate-test-finding.ts` |

---

## Decision flow

```
  diff + scans (secret-scan, dep-vuln, AST rules, SARIF, coverage, perf-budgets)
                                   │
                                   ▼
                 buildFactsByRole()  ── role-scoped-facts.ts
        ┌────────────────┬───────────────┬────────────────┐
        ▼                ▼               ▼                ▼
   securityFacts     logicFacts      perfFacts        testsFacts
   (secret/dep/      (AST-correct/   (perf AST/       (docs-coverage/
    AST-sec/SARIF/    determ-checks/  perfBudgets)     coverage-gap)
    manifest)         asymmetry)
        │                │               │                │
        ▼                ▼               ▼                ▼
  ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────┐
  │ SECURITY  │   │  LOGIC    │   │   PERF    │   │  TESTS    │   each prompt =
  │ specialist│   │ specialist│   │ specialist│   │ specialist│   role facts ONLY
  │ +CWE-25   │   │ +symbol   │   │ +perf-kw  │   │ +few-shot │   + retrieval
  │  prompt   │   │  retrieval│   │  retrieval│   │  +sibling │   + few-shots
  └─────┬─────┘   └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
        │ verdict       │ verdict       │ verdict       │ verdict
        ▼               ▼               ▼               ▼
   validate-       validate-       validate-       validate-
   security-       logic-          perf-           test-
   finding         finding         finding         finding      ◄── per-domain gate
        │               │               │               │           (shadow|enforce)
        └───────────────┴───────┬───────┴───────────────┘           drop/demote +
                                ▼                                    telemetry event
                          synthesizer  ──► one posted review
```

Shared diff topology (the SIG-91 file-classification block, the ARC-182 stack block) is
**not** routed per role — it is ambient context every specialist receives. Only the
*domain* facts are scoped.

---

## Layer 1 — role-scoped deterministic facts

`buildFactsByRole(inputs)` (`src/lib/role-scoped-facts.ts`) is a pure function that
returns a `Record<SpecialistRole, string>`: each role's block is the omit-empty join of
its own domain's deterministic facts.

- **security** ← secret-scan + dep-vuln + AST-security findings + SARIF + the
  security-evidence manifest (`src/lib/security-evidence-manifest.ts`).
- **logic** ← AST-correctness findings + regex deterministic-checks + cross-function
  asymmetry/TOCTOU hints.
- **performance** ← AST-performance findings + the `perfBudgets` hot-path block.
- **tests** ← docs-coverage check + LCOV coverage-gap facts.

`buildSpecialistInitialMessage` reads `args.role` and injects only the matching block as
the prompt's `deterministicChecksBlock`. The result: the logic specialist's prompt
contains **no** secret-scan output, and vice-versa. Because the orchestrator is too large
to exercise in isolation, this "no cross-domain leak" contract is proven directly by the
pure-function unit test `tests/role-scoped-facts.test.ts`.

---

## Layer 2 — per-domain retrieval

Generic PR-text retrieval is replaced per domain:

- **Logic — symbol-based** (`src/lib/symbol-retrieval.ts`, SIG-121/SIG-109). Retrieval
  queries are derived from the *changed symbols* in the diff rather than the PR's prose,
  surfacing the call-sites and definitions a correctness reviewer actually needs.
- **Performance — perf-keyword** (`src/lib/perf-retrieval.ts`, SIG-110). Queries bias
  toward perf vocabulary ("hot path", "timeout", "rate limit", "batch", "cache", "N+1")
  plus changed function names, weighted toward known perf-anti-pattern chunks.

Both are additive to, and differentiated from, the default retrieval path; security and
tests retrieve through the shared corpus, weighted by their role facts.

---

## Layer 3 — few-shot example libraries

Versioned, diff-reviewable exemplar files are imported and rendered into a compact prompt
block per specialist (`src/prompts/pr-review-specialists.ts`):

| File | Specialist | Rendered block |
|---|---|---|
| `src/prompts/logic-examples.json` | logic | `LOGIC_EXAMPLES_BLOCK` |
| `src/prompts/perf-examples.json` | performance | `PERF_EXAMPLES_BLOCK` |
| `src/prompts/tests-examples.json` | tests | `TESTS_EXAMPLES_BLOCK` |

The **security** specialist has no separate JSON file by design: its domain priming is
the **CWE-Top-25 bucket list** embedded in its prompt (not the full CWE catalog) plus the
hard requirement that every `score >= 4` security finding carry a `cweId` and an
`evidenceId`. Those constraints, combined with the security-evidence manifest, are the
security specialist's "few-shot" equivalent.

---

## Layer 4 — per-specialist validation gates

Each domain has a hand-rolled (not Zod) validator that runs on the specialist's verdict
*before* synthesis. A gate's job is to reject malformed **high-severity** findings —
missing CWE code, missing complexity/hot-path evidence, un-cited missing-coverage claims
— so the synth never sees a finding the system can't stand behind. Every rejection emits
a `pr-review-finding-rejected-validation` event with a structured reason.

### Mode and rollout

Each gate parses an `OPENCLAW_*_VALIDATOR_MODE` env var (`parse*ValidatorMode`), defaulting
to **`shadow`** for anything other than the literal `"enforce"`. In shadow the verdict is
counted/telemetered but **nothing is dropped**; in enforce the gate acts. Current prod
posture (`wrangler.toml`):

| Validator | Module | Entry | Env var | Prod mode |
|---|---|---|---|---|
| Security evidence | `validate-security-finding.ts` | `evaluateSecurityFinding` | `OPENCLAW_SECURITY_VALIDATOR_MODE` | **enforce** |
| Security grounding | `validate-security-grounding.ts` | `evaluateSecurityGrounding` | `OPENCLAW_SECURITY_GROUNDING_VALIDATOR_MODE` | **enforce** |
| Security usage | `validate-security-usage.ts` | `evaluateSecurityUsage` | `OPENCLAW_SECURITY_USAGE_VALIDATOR_MODE` | shadow |
| Tests specificity | `validate-test-finding.ts` | `evaluateTestFinding` | `OPENCLAW_TESTS_VALIDATOR_MODE` | **enforce** |
| Logic evidence | `validate-logic-finding.ts` | `evaluateLogicFinding` | `OPENCLAW_LOGIC_VALIDATOR_MODE` | shadow |
| Logic refutation | `validate-logic-refutation.ts` | `evaluateLogicRefutation` | `OPENCLAW_LOGIC_REFUTATION_MODE` | shadow |
| Window-blindness | `validate-window-blindness.ts` | `evaluateWindowBlindness` | `OPENCLAW_WINDOW_BLINDNESS_VALIDATOR_MODE` | shadow |
| Perf anchoring | `validate-perf-finding.ts` | `evaluatePerfFinding` | `OPENCLAW_PERF_VALIDATOR_MODE` | shadow |
| Absence claim | `validate-absence-grounding.ts` | `evaluateAbsenceGrounding` | `OPENCLAW_ABSENCE_CLAIM_VALIDATOR_MODE` | shadow |

Shadow would-drop counters are surfaced at `GET /metrics/validation`
(`src/lib/metrics-validation-route.ts`) so a gate's effect can be measured before it is
promoted to enforce.

### Security evidence gate — the recall-safe core

`evaluateSecurityFinding` is the canonical example (`validate-security-finding.ts`). For a
`score >= 4` security finding it requires either (a) an `evidenceId` resolving to a real
deterministic security fact whose path/line sits within ±10 lines of the finding, or (b)
— for the **AuthN/Access-Control bucket only** — `evidenceId: "NONE"` plus a body
justification, because real IDOR/authz bugs have no scanner fact to cite. Its
recall-safety machinery:

- **Auto-enrich** — if the model forgot the `cweId`/`evidenceId` but a manifest fact sits
  at the finding's path within ±10 lines, the gate adopts that fact's id and **keeps** the
  finding. A corroborated finding is never lost to a missing copy-paste.
- **Authz exemption** — the `authn-access-control` bucket (CWE-639/285/284/306/… IDOR
  family) may pass on `evidenceId: "NONE"` + justification alone.
- **Hard-drop only** fabricated (non-resolving) or non-linking (out-of-range) evidence, or
  an unsupported `score >= 4` finding in a scanner-covered bucket after auto-link fails.

A confirmed security finding's remediation is **deterministic per CWE bucket**
(`REMEDIATION_BY_BUCKET`, SIG-282) — system-supplied, reviewed text rather than
LLM-authored prose. `score < 4` findings are never touched by the gate.

The logic/perf/tests gates follow the same shape: severity-gated, evidence-requiring,
shadow-first, telemetered. Perf requires a `complexityEstimate` or `hotPathIdentifier`;
tests requires a resolvable sibling-mapping or coverage-gap citation; logic requires an
independent assessment / refutation survival.

---

## Supporting machinery

- **Perf budgets** (`src/lib/perf-budgets.ts`; schema in `src/lib/sigilix-config.ts`) —
  `sigilix.json::perfBudgets` declares `{ p50LatencyBudgetMs, p95LatencyBudgetMs,
  bundleSizeBudgetKb, hotPaths: string[] }`. A PR touching a declared hot path injects a
  fact that primes the performance specialist (it does not itself emit a finding). The
  perf **AST rules** (N+1 call-in-loop, sync I/O in request path, allocation-in-loop,
  await-in-loop, spread-accumulator-in-loop) fire deterministically and are the
  performance specialist's observable floor.
- **Coverage ingestion** (`src/lib/coverage-ingest.ts`, SIG-118) — gated by
  `sigilix.json::coverage.source: "github-actions-artifact" | "off"` (default `off`). When
  enabled, an LCOV artifact is fetched, intersected with the PR's added lines, and emitted
  as `coverageGap:<path>:<line>` facts to the tests specialist. The deterministic
  sibling-test-missing signal fires without LCOV.
- **Per-specialist bake-off bar** (`src/lib/shadow-bakeoff-*.ts`, extends SIG-86) — the
  A/B aggregator records per-domain before/after metrics so a validator's `score >= 4`
  precision/recall delta is measured before it is defaulted to enforce.

---

## Recall-safety (the sacred rule)

Specialization adds precision filters; it must never cost recall. The guarantees, by
construction:

1. Gates are **severity-gated** — only `score >= 4` findings are constrained; lower-severity
   hardening notes pass untouched.
2. Gates prefer **demote-to-body** over hard-drop, so a rejected high-severity finding is
   relocated, not deleted.
3. The security gate's **authz NONE-exemption** + **auto-enrich** specifically protect the
   class of real findings (IDOR, missing object-level authz) that no deterministic scanner
   emits.
4. Every gate ships **shadow-first** and is promoted only after its bake-off bar clears.

---

## Verification

The shipped specialization was independently QA-verified (see the SIG-97 Linear thread):
164/164 engine unit tests green across `role-scoped-facts`, `validate-security-finding`,
`validate-test-finding`, `perf-ast-rules`, and `perf-budgets`; and four single-issue e2e
probes confirmed the perf (N+1), tests (sibling-gap), and security (CWE-639 IDOR)
specialists fire on real PRs with no real P0/P1 dropped, and the deterministic
per-bucket remediation rendered verbatim in production output.

---

## References

- `src/lib/ensemble-router.ts` — `SpecialistRole`, fan-out contract
- `src/lib/role-scoped-facts.ts` — `buildFactsByRole` (no cross-domain leak)
- `src/prompts/pr-review-specialists.ts` — `buildSpecialistInitialMessage`, few-shot blocks, CWE-25 prompt
- `src/lib/validate-security-finding.ts` — `evaluateSecurityFinding`, `REMEDIATION_BY_BUCKET`
- `src/lib/validate-logic-finding.ts` · `validate-perf-finding.ts` · `validate-test-finding.ts` — domain gates
- `src/lib/security-evidence-manifest.ts` — security fact manifest
- `src/lib/symbol-retrieval.ts` · `src/lib/perf-retrieval.ts` — per-domain retrieval
- `src/lib/perf-budgets.ts` · `src/lib/sigilix-config.ts` — `perfBudgets` / `coverage` schema
- `src/lib/coverage-ingest.ts` — LCOV coverage-gap facts (SIG-118)
- `src/lib/shadow-bakeoff-runner.ts` · `shadow-bakeoff-telemetry.ts` · `shadow-bakeoff-config.ts` — per-specialist bake-off (SIG-86)
- `src/lib/metrics-validation-route.ts` — `GET /metrics/validation` shadow counters
- `src/prompts/logic-examples.json` · `perf-examples.json` · `tests-examples.json` — few-shot libraries
- Codex research: `feature_gap_research_2026-05-19.md` — "Agent specialization via code"
