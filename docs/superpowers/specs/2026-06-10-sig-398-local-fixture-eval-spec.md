# SIG-398 — Local fixture eval harness — implementation spec

**Status:** spec / pre-implementation. Parent: SIG-392 (deep recall lane), under SIG-369.
**Branch:** `sig-398-local-fixture-eval`. **Touches:** `e2e/` (the live driver) + `evals/` (adapter + baseline) — no engine/Worker behavior change, no new prod code paths.

## Goal

A local A/B loop for the SIG-392 levers: run the review specialists (and later the full ensemble) from plain Node against the frozen `evals/fixtures/fullstack-pr20-dense` diff via Ollama Turbo (the prod model path), K times, and score every run with the SIG-397 scorer — minutes per iteration instead of a GitHub round-trip per sample.

## Architecture decision: compose the two existing tools, don't entangle them

- `evals/` stays **offline by contract** (its README: "nothing here touches the Worker or production"). It gains only a pure adapter + the committed local baselines.
- The **live driver follows the `logic-recall-eval` convention**: `e2e/fixture-eval.live.test.ts` + an npm script, gated on `OLLAMA_API_KEY` (skips without — CI stays green), K-repeats via env. This is the proven home for "spend real model calls" code.
- The bridge artifact is a **findings JSON file** in the scorer's `FixtureFinding[]` shape: the driver writes it; scoring happens both in-process (the test prints the score) and reproducibly offline via the existing `npm run evals -- score --fixture … --findings <file>`.

## Deliverables

### 1. `evals/local-adapter.ts` — pure adapter (unit-tested)

`shadowFindingsToFixtureFindings(role, rawFindings) : FixtureFinding[]` mapping `runShadowSpecialist`'s `rawFindings` (path, line, score, category, headline, body) into the scorer's shape:

- `ref`: `${role}-${i+1}` (e.g. `logic-3`) — refs are per-run, not stable across runs (unlike comment-id refs); fine because scoring is per-run.
- `severity`: score→P mapping (5→P0, 4→P1, 3→P2, 1-2→P3) — REUSE the exported mapping logic with `normalize.ts`'s `sigilixSeverity` semantics (extract a shared `severityLabelForScore`-style helper in evals, NOT an import from engine render code).
- `excerpt`: headline (what the scorer's `scope:"excerpt"` clauses match).
- `bodyText`: headline + "\n" + body (full-text clause scope).
- `botCategory`: the raw category verbatim — REQUIRED so the dense fixture's `outOfScope` testing-coverage carve-out (botCategories-gated) behaves identically to posted-review scoring.
- `commentId`: `i+1`, `url`: `"local"`, `tool`: `"sigilix"`.

### 2. `e2e/fixture-eval.live.test.ts` + `e2e/fixture-eval-lib.ts` — the driver (Phase A)

Per the `logic-recall-eval.live.test.ts` pattern:

- Gated: `describe.skipIf(!OLLAMA_API_KEY)`; key read like the other live tests.
- Loads `evals/fixtures/<name>/pr.diff` + `ground-truth.json` (fixture name via `FIXTURE_EVAL_FIXTURE`, default `fullstack-pr20-dense`).
- Builds the specialist message with `buildSpecialistInitialMessage` — same minimal-context construction as logic-recall-eval (`prNumber: 0`, title from the fixture, `retrievalSnapshot: ""`), per role.
- Runs the four roles **per repeat** via `runShadowSpecialist` with the PROD `SPECIALIST_CONFIGS[role]` and `SPECIALIST_PROMPTS[role]` (no model overrides by default; `FIXTURE_EVAL_MODEL_<ROLE>` env overrides for bake-offs).
- **Union scoring per repeat:** adapt all roles' findings → one `FixtureFinding[]` → `scoreFixture`. (Phase A has no synth — union is the upper bound the synth can pass through; labeled as such in output.)
- K-repeats: `FIXTURE_EVAL_REPEATS` (default 1; ≥5 recommended, K≥12 for numbers you act on — same ruler discipline). Per-row stability table: for each ground-truth row, `caught k/K`; flag rows that flip.
- Writes per-repeat findings JSON + a run summary (markdown table: per-repeat recall/precision/high-sev-FP + per-row stability) to `e2e/.fixture-eval-out/` (gitignored), printing the path.
- **Context-gap labeling (the fidelity rule):** every report header carries `context: minimal (no retrieval / graph / AST evidence blocks) — compare against the LOCAL baseline, never the prod 8/20`.
- npm script: `"fixture-eval": "vitest run e2e/fixture-eval.live.test.ts"`.

### 3. Committed local baseline

After implementation, run K=8 on the dense fixture + K=4 on `fullstack-low-density` with the shipped prompts/configs; commit:

```
evals/fixtures/fullstack-pr20-dense/baseline.local-minimal.json   # per-row k/K + aggregate metrics + K + date + context label
evals/fixtures/fullstack-low-density/baseline.local-minimal.json
```

Schema (new in `evals/fixture-types.ts`): `LocalBaseline { schemaVersion: 1; fixture; context: "minimal"; repeats; perRow: Record<rowId, caughtCount>; aggregate: { recallMean; precisionMean; highSevFpTotal }; generatedAt; }`. This is SIG-393's Δ reference: a lever's local K-run is compared row-by-row against it (flips, not means).

### 4. Phase B — full ensemble path (in this PR only if the seams hold; else follow-up PR on the same ticket)

Drive `runSpecialistsAndSynthesize` from the driver with: stub `GitHubClient` (`getFileContent` served from a pre-loaded map of the fixture's head files — fetched once via `gh` at build time and committed under `evals/fixtures/fullstack-pr20-dense/files/`), `env` carrying only `OLLAMA_API_KEY`/`OLLAMA_CHAT_ENABLE`, router hardcoded to all four roles, empty retrieval/graph blocks, real AST/deterministic scans over the pre-loaded files, recall floors on. Score `effectiveSynthVerdict.findings` (adapter gains a verdict-findings mapping). Risk: the args surface is large (~20 fields) — if any field demands Worker-bound infra that can't be stubbed honestly, Phase B stops and documents the blocker rather than faking fidelity.

## Tests (offline, CI-green without the key)

- Adapter unit tests: severity mapping, botCategory passthrough (outOfScope carve-out works on adapted findings), excerpt/bodyText scoping, ref assignment.
- Driver lib pure parts (fixture loading, stability-table math, baseline serialization) unit-tested with synthetic ShadowRunResults.
- The live test itself skips without the key (assert skip behavior like other `.live.` suites).

## Non-goals

- NOT the product CLI (SIG-304 — review parity + coding agent; separate scope; it may later lift the diff→input constructor).
- No GitHub posting, no Worker changes, no prompt/model changes, no new gates.
- No CI model spend: live path is key-gated and never runs in `npm run build`.

## Done when (mirrors Linear AC)

- `OLLAMA_API_KEY=… npm run fixture-eval` (with `FIXTURE_EVAL_REPEATS=K`) emits per-repeat scores + the per-row stability table for both fixtures, labeled with the context gap.
- Findings JSONs replay through `evals score --findings` byte-consistently.
- `baseline.local-minimal.json` committed for both fixtures.
