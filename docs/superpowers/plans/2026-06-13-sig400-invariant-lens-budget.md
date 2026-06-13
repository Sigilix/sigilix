# SIG-400 Invariant Lens Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a recall-safe invariant-lens lane contract that preserves current `on` behavior while allowing only telemetry-only shadow lens work to move off the synth critical path.

**Architecture:** Keep the recall-affecting invariant lens blocking by default and fail closed to blocking for `OPENCLAW_INVARIANT_LENS_MODE=on`. Add a small app-layer scheduler beside `invariant-lens.ts`; it may background only `shadow` mode because shadow candidates never merge into the posted review today. Add explicit telemetry fields so monitor queries can separate default-lane blocking work from background shadow measurement.

**Tech Stack:** TypeScript, Cloudflare Worker queue `ctx.waitUntil`, Vitest, existing Sigilix ensemble config parser.

---

### Task 1: Contract Parser

**Files:**
- Modify: `src/lib/ensemble/domain/invariant-lens.ts`
- Modify: `src/lib/ensemble/domain/invariant-lens.test.ts`
- Modify: `src/lib/ensemble/domain/config.ts`
- Modify: `src/lib/ensemble/config.ts`
- Modify: `src/lib/ensemble/ensemble-config.test.ts`

- [x] **Step 1: Write the failing parser/config tests**

```ts
expect(parseInvariantLensRecallContract(undefined)).toBe("blocking")
expect(parseInvariantLensRecallContract("shadow-background")).toBe("shadow-background")
expect(parseInvariantLensRecallContract("detached")).toBe("blocking")
expect(parseEnsembleConfig({}).flags.invariantLensRecallContract).toBe("blocking")
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/ensemble/domain/invariant-lens.test.ts src/lib/ensemble/ensemble-config.test.ts`
Expected: FAIL because `parseInvariantLensRecallContract` and `invariantLensRecallContract` do not exist.

- [x] **Step 3: Add the minimal parser and config plumbing**

Add `InvariantLensRecallContract = "blocking" | "shadow-background"` and parse unknown values to `"blocking"`. Thread `OPENCLAW_INVARIANT_LENS_RECALL_CONTRACT` through `parseEnsembleConfig`.

- [x] **Step 4: Run tests to verify green**

Run: `npm test -- src/lib/ensemble/domain/invariant-lens.test.ts src/lib/ensemble/ensemble-config.test.ts`
Expected: PASS.

### Task 2: Scheduler

**Files:**
- Create: `src/lib/ensemble/app/invariant-lens-scheduler.ts`
- Create: `src/lib/ensemble/app/invariant-lens-scheduler.test.ts`
- Modify: `src/lib/ensemble/app/invariant-lens.ts`

- [x] **Step 1: Write failing scheduler tests**

```ts
it("blocking on awaits and merges before synth")
it("shadow-background shadows return pass-through immediately and register waitUntil")
it("shadow-background refuses to detach mode=on and logs fail-closed")
it("background failures log and do not fail synth")
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/ensemble/app/invariant-lens-scheduler.test.ts`
Expected: FAIL because the scheduler module does not exist.

- [x] **Step 3: Implement the scheduler**

Create `scheduleInvariantLensForSynth`, `invariantLensResultForSynth`, and a result union. For `"blocking"`, call `applyInvariantLens`. For `"shadow-background"` + `mode="shadow"`, schedule `applyInvariantLens` in background and return pass-through. For `"shadow-background"` + `mode="on"`, log `invariant-lens-background-refused` and call `applyInvariantLens` inline.

- [x] **Step 4: Add lane telemetry fields**

Extend `applyInvariantLens` args with optional `executionLane` and `recallContract`; summary logs should include `executionLane`, `recallContract`, and `mergedIntoSynth`.

- [x] **Step 5: Run tests to verify green**

Run: `npm test -- src/lib/ensemble/app/invariant-lens.test.ts src/lib/ensemble/app/invariant-lens-scheduler.test.ts`
Expected: PASS.

### Task 3: Wire Through Specialists

**Files:**
- Modify: `src/lib/ensemble/app/specialists.ts`

- [x] **Step 1: Write or update failing seam coverage**

Update scheduler tests to cover the exact synth-input helper, and keep specialist edits minimal because `specialists.ts` is already near the 1,000-line cap.

- [x] **Step 2: Replace direct lens apply with scheduler**

In `runSpecialistsAndSynthesize`, call `scheduleInvariantLensForSynth` with `ensembleConfig.flags.invariantLensRecallContract` and optional `backgroundWaitUntil`, then feed `invariantLensResultForSynth(...)` into synth.

- [x] **Step 3: Verify file-size cap**

Run: `wc -l src/lib/ensemble/app/specialists.ts src/lib/ensemble/app/invariant-lens*.ts`
Expected: every file <= 1,000 lines.

### Task 4: Validation

**Files:**
- No additional files.

- [x] **Step 1: Run focused tests**

Run: `npm test -- src/lib/ensemble/domain/invariant-lens.test.ts src/lib/ensemble/ensemble-config.test.ts src/lib/ensemble/app/invariant-lens.test.ts src/lib/ensemble/app/invariant-lens-scheduler.test.ts`
Expected: PASS.

- [x] **Step 2: Run frozen scorer baseline**

Run: `npm run evals -- score --fixture fullstack-pr20-dense --baseline evals/fixtures/fullstack-pr20-dense/baseline.sigilix.score.json --label sig-400-no-recall-behavior-change`
Expected: baseline delta is zero because this PR does not alter scored findings.

- [x] **Step 3: Run full gate**

Run: `npm run build`
Expected: typecheck, lint, format, dependency-cruiser, and Vitest all pass.

- [x] **Step 4: Request code review**

Ask the `code-reviewer` agent: can this ever suppress or drop a real score >= 4 finding? Expected verdict: SHIP or fix valid findings before PR.
