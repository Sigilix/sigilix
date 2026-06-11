# SIG-395 — Cross-cutting invariant lens — engine spec

**Status:** FINAL (evidence-based; prototype merged in #479).
**Parent:** SIG-369 / lane SIG-392. **Branch:** `sig-395-invariant-lens`.
**Inherits the SIG-393 architecture wholesale** (spec `2026-06-11-sig-393-region-resweep-spec.md`): pre-synth candidate merge, candidates through the UNCHANGED gate stack, `off|shadow|on` flag shipped dark, telemetry-first rollout. This spec documents only what differs.

## Evidence (prototype, two K=8 iterations, 17 live runs — PR #479)

- ONE whole-diff consistency call FAILS (re-saturates like a regular pass). **Six single-charge auditors** — units, data-scoping, discriminant-totality, error-contracts, crypto-integrity, wire-contracts — each sweeping exactly one invariant family, crack the re-sweep-resistant tail: **b19 0/8→8/8, b4 0/8→7/8, b16 4/8, b20 4/8** (b8 true miss — parked for SIG-286 / a type-aware AST rule).
- Union pass1+lens 11.8/20 (59%) on rows COMPLEMENTARY to re-sweep. The totality auditor is near-surgical (~1 finding/run).
- The lens needs **no pass-1 input** → runs concurrent with the specialist fanout → **~zero added wall-clock** (vs re-sweep's ~78s). The latency-cheap recall lever.

## What differs from SIG-393

### Placement: concurrent with the fanout, not after it

`runInvariantLensPhase` is **started** in `ensemble/app/specialists.ts` immediately after the specialist fan-out dispatches (the lens promise runs alongside the role promises) and **awaited** after verdict collection / the coverage gate, where its candidates merge (mode `on`) or telemeter (mode `shadow`). Zero wall-clock when the lens finishes before the slowest specialist (it's one `logic`-config call per dispatched family; the fanout's long pole is ~110s+).

### Dispatch: family-selective, precondition-gated (not effort-gated)

The re-sweep's effort gate doesn't fit — cross-cutting bugs need *breadth*, not density. The lens fires when:

- the diff has **≥2 changed files OR ≥150 added lines** (an invariant needs a "rule site" and a "violation site"; single-small-file diffs have nowhere to cross), AND
- **per family**, a cheap textual precondition matches the diff (pure, `domain/invariant-lens.ts`):
  - `units`: money/quantity tokens (`cents|dollars|price|amount|currency|total`)
  - `data-scoping`: ownership keys + route handlers (`customer_id|tenant|user_id|owner` AND `.get(|.post(|.put(|.delete(`)
  - `discriminant-totality`: union/enum/type-discriminant shapes (`"type"` unions, `enum `, `switch (`)
  - `error-contracts`: status-code surfaces (`status(|statusCode|404|400`)
  - `crypto-integrity`: `hmac|signature|secret|crypto|timingSafe|digest`
  - `wire-contracts`: `interface |as unknown as| as [A-Z]|snake|camel`

  Preconditions are deliberately PERMISSIVE (a false dispatch wastes one cheap call; a missed family loses a bug class). Typical PRs dispatch 0–3 families; the dense fixture dispatches all 6. Decision telemetry per family.

### Merge target

Lens candidates merge into the **logic role's** verdict (the lens runs the logic model config; logic is the never-cancelled protected role, so its verdict always exists when the coverage gate passes... when logic itself failed, fall back to the first succeeded role). Positional stable-ID rule identical to re-sweep (pass-1 ids unchanged). Provenance via id-set in telemetry (`invariant-lens-summary.addedFindingIds`), no finding-shape change.

### Candidate guard

No region guard (the lens legitimately sees the whole diff); instead an **anchored-to-diff guard**: a candidate whose `path` is not a changed file in the diff is dropped (`outOfDiffDropped` in telemetry).

## Flags / config

- `OPENCLAW_INVARIANT_LENS_MODE`: `off` (default) | `shadow` | `on` — same contract as resweep (off = inert passthrough by reference; shadow = run + telemeter, never merge).
- No tunables (families are a fixed set of 6; the per-family call is one model call).
- Prompts: `INVARIANT_FAMILIES` (id + charge) + `familyPrompt()` move from the prototype test into `src/prompts/specialists/invariant-lens.ts`, composed from `SHARED_NEGATIVE_CONSTRAINTS` + `SHARED_OUTPUT_INSTRUCTIONS` exactly as prototyped. The e2e test imports from there (single source — the harness measures the shipped prompts).

## Telemetry

`invariant-lens-decision` (fired, families dispatched + skipped with precondition results), `invariant-lens-{shadow-,}summary` (perFamily: {findings, errored}, candidates, outOfDiffDropped, merged, elapsedMs). Conventions per ensemble-perf-telemetry.

## Tests

- Domain: precondition matcher table per family (positive/negative diffs); family selection breadth gate; prompt builder (charge present, empty-result instruction present, no fixture coaching).
- App: mode contract (off inert by reference / shadow never merges / on merges into logic verdict with stable ids), anchored-to-diff guard, logic-failed fallback target, concurrent-start ordering (lens promise created before fanout await).
- Config equality lists updated.

## Rollout

Dark (`off`) → prod `shadow` alongside SIG-393's soak (both levers' shadow telemetry accumulates together) → **joint promotion**: one enforce flip for both levers, one fresh fixture-clone Δ, one fresh head-to-head benchmark (the Len-package trigger).

## Non-goals

- b8-class (cross-file type drift) — needs SIG-286 context or an AST rule; explicitly out.
- Prompt-tuning the unstable auditors (b16/b20 at 4/8) — a follow-up harness iteration, not a blocker for shadow.
- No deterministic-floor port of the totality auditor yet (tempting given 8/8 — revisit after shadow data).
