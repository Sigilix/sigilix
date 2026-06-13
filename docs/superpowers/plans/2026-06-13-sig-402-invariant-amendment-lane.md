# SIG-402 Invariant Amendment Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `pending-check-amendment` to detach invariant-lens work from the default synth path only when a merge-gated follow-up review lane is available.

**Architecture:** Keep default synth inputs unchanged while the lens promise continues in parallel. Return amendment work from the specialists phase, then after the initial review posts, await the amendment work before completing the dispatcher-owned check. A new focused app module validates high-severity lens findings with `validateForSubmission`, posts an idempotent native follow-up review when survivors exist, and skips stale heads.

**Tech Stack:** TypeScript, Cloudflare Worker app-layer modules, Vitest, existing GitHub client/review renderer/validation domain.

---

### Task 1: Scheduler Contract

**Files:**
- Modify: `src/lib/ensemble/domain/invariant-lens.ts`
- Modify: `src/lib/ensemble/domain/invariant-lens.test.ts`
- Modify: `src/lib/ensemble/app/invariant-lens.ts`
- Modify: `src/lib/ensemble/app/invariant-lens-scheduler.ts`
- Modify: `src/lib/ensemble/app/invariant-lens-scheduler.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests asserting that `pending-check-amendment` remains blocking without lane support and schedules amendment work with lane support.

- [ ] **Step 2: Run red tests**

Run: `npm test -- src/lib/ensemble/domain/invariant-lens.test.ts src/lib/ensemble/app/invariant-lens-scheduler.test.ts`

Expected: FAIL because the decision and scheduler do not yet expose an amendment lane.

- [ ] **Step 3: Implement minimal scheduler support**

Add an amendment decision kind, support `executionLane: "amendment"`, return passthrough synth input plus a promise for `applyInvariantLens`.

- [ ] **Step 4: Run green tests**

Run: `npm test -- src/lib/ensemble/domain/invariant-lens.test.ts src/lib/ensemble/app/invariant-lens-scheduler.test.ts`

Expected: PASS.

### Task 2: Amendment Posting Module

**Files:**
- Create: `src/lib/ensemble/app/invariant-lens-amendment.ts`
- Create: `src/lib/ensemble/app/invariant-lens-amendment.test.ts`

- [ ] **Step 1: Write failing tests**

Cover high-severity survivor posting, stale-head skip, existing-marker idempotence, no-op when no score>=4 lens findings survive, and post failure surfacing.

- [ ] **Step 2: Run red tests**

Run: `npm test -- src/lib/ensemble/app/invariant-lens-amendment.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the module**

Await the lens result, collect only `lensFindingIds` with `score >= 4`, validate them with synthetic logic provenance, render a native follow-up review, verify persistence, log telemetry, and use prior-review marker detection for idempotence.

- [ ] **Step 4: Run green tests**

Run: `npm test -- src/lib/ensemble/app/invariant-lens-amendment.test.ts`

Expected: PASS.

### Task 3: Orchestrator And Dispatcher Gate

**Files:**
- Modify: `src/lib/ensemble/app/specialists.ts`
- Modify: `src/lib/ensemble/app/orchestrator.ts`
- Modify: `src/lib/ensemble/app/session.ts`
- Modify: `src/lib/ensemble/app/orchestrator-types.ts`
- Modify: `src/index-dispatch.ts`
- Modify: `e2e/dispatch-job-check-run-lifecycle.test.ts`

- [ ] **Step 1: Write failing dispatcher/orchestrator tests**

Assert posted review result with amendment work delays `completeCheckRun` until the work resolves and maps amendment failure to a non-green internal conclusion.

- [ ] **Step 2: Run red tests**

Run: `npm test -- e2e/dispatch-job-check-run-lifecycle.test.ts`

Expected: FAIL because `EnsembleResult` cannot carry post-review work yet.

- [ ] **Step 3: Thread amendment work**

Return amendment work from specialists, wrap posted ensemble results with post-review work, and make dispatcher await it before check completion.

- [ ] **Step 4: Run green targeted tests**

Run: `npm test -- src/lib/ensemble/app/invariant-lens-scheduler.test.ts src/lib/ensemble/app/invariant-lens-amendment.test.ts e2e/dispatch-job-check-run-lifecycle.test.ts`

Expected: PASS.

### Task 4: Final Verification And Review

**Files:**
- No additional code files.

- [ ] **Step 1: Run compliance checks**

Run: `npm run compliance:line-budget`

Expected: PASS; especially no growth over the 1k line budget for hot app files.

- [ ] **Step 2: Run full build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 3: Request model sign-off**

Run the repo `agent code-reviewer` helper with the final diff and the explicit question: "Can this ever suppress or drop a real score>=4 invariant-lens bug?"

- [ ] **Step 4: Fix valid review findings and rerun affected tests**

Run the targeted tests plus `npm run build` again after any fixes.
