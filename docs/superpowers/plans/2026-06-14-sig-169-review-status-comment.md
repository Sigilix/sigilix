# SIG-169 Review Status Comment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one sticky PR status block that tracks Sigilix review progress from queued through final posting.

**Architecture:** Reuse the existing overview sticky comment and insert a bounded `sigilix:review-run-status` block into that body. `PrReviewRunDO` stores the latest monotonic status snapshot and emits transition telemetry; a queue-consumer reporter patches the overview comment best-effort without blocking recall-critical review work. Pure rendering and GitHub/DO update code live in new leaf modules so near-1k files stay under budget.

**Tech Stack:** TypeScript, Cloudflare Workers Durable Objects, Vitest, existing GitHub REST adapter.

---

### Task 1: Pure Status Renderer

**Files:**
- Create: `src/lib/pr-review-status-render.ts`
- Test: `src/lib/pr-review-status-render.test.ts`
- Modify: `src/lib/pr-overview-stub.ts`

- [ ] Write failing renderer tests for queued, specialists, synth, posted, degraded, skipped, dropped files, graph coverage, and ASCII footer rotation.
- [ ] Run `npx vitest run src/lib/pr-review-status-render.test.ts` and confirm the missing module failure.
- [ ] Implement phase types, status block markers, block upsert, and many ASCII footer variants.
- [ ] Update `buildPrOverviewStubBody` to insert the queued status block into the existing overview sticky.
- [ ] Run the renderer and overview-stub tests.

### Task 2: Durable Status State

**Files:**
- Create: `src/do/pr-review-status-route.ts`
- Modify: `src/do/types.ts`
- Modify: `src/do/pr-review-run.ts`
- Test: `src/do/do-pr-review-run-routes.test.ts`

- [ ] Write failing DO tests for `/status-progress`, stale run rejection, monotonic phase ordering, and `pr-review-status-comment-state` telemetry.
- [ ] Run `npx vitest run src/do/do-pr-review-run-routes.test.ts`.
- [ ] Add status snapshot fields to `RunState`.
- [ ] Add a small route handler leaf and wire `POST /status-progress` from `PrReviewRunDO`.
- [ ] Re-run the DO route tests.

### Task 3: Reporter And Comment Updater

**Files:**
- Create: `src/lib/pr-review-status-reporter.ts`
- Test: `src/lib/pr-review-status-reporter.test.ts`
- Modify: `src/do/consumer-wrapper.ts`
- Modify: `src/do/do-consumer-wrapper.test.ts`

- [ ] Write failing reporter tests proving it posts to DO first, patches the existing overview marker in order, skips stale DO updates, and does not create duplicate comments when the overview marker is missing.
- [ ] Run `npx vitest run src/lib/pr-review-status-reporter.test.ts src/do/do-consumer-wrapper.test.ts`.
- [ ] Implement the reporter with a serialized promise chain and `ctx.waitUntil` support.
- [ ] Thread the reporter through `runPrReviewWithDoCallback`.
- [ ] Re-run reporter and consumer-wrapper tests.

### Task 4: Phase Hooks

**Files:**
- Modify: `src/lib/ensemble/app/orchestrator-types.ts`
- Modify: `src/index-dispatch.ts`
- Modify: `src/lib/ensemble/app/context/fetch-and-pack.ts`
- Modify: `src/lib/ensemble/app/specialists.ts`
- Modify: `src/lib/ensemble/app/publish.ts`
- Test: focused existing ensemble tests that cover router skip and publish paths.

- [ ] Write failing tests that capture retrieval, specialists, synth, final posted, skipped, and degraded updates.
- [ ] Add optional status reporter threading through the phase seams.
- [ ] Emit dropped-file, graph-coverage, specialist progress, and final-review metadata.
- [ ] Re-run focused tests.

### Task 5: Verification And PR

**Files:**
- No new files unless review feedback requires them.

- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Request external `code-reviewer` sign-off.
- [ ] Fix valid review findings and re-run affected tests plus `npm run build`.
- [ ] Push PR with `@sigilix ignore` and `@coderabbitai ignore` in the body.
