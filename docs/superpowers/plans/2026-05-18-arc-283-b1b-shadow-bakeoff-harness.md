# ARC-283 Phase B1b — Shadow-Mode Model Bake-Off Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-prod-impact shadow runner that, when enabled per-role, executes the proposed ARC-292 candidate `ModelConfig` in parallel with the production lineup, never posts its verdict, and emits comparison telemetry rich enough to ratify or reject the swap before any canary.

**Architecture:** Three new pure modules (`shadow-bakeoff-config`, `shadow-bakeoff-telemetry`, `shadow-bakeoff-runner`) sit alongside `ensemble-perf-telemetry.ts`. The orchestrator (`triage-pr-review-ensemble.ts`) gains ~30 lines that fire a shadow `runWithRetryAndFallback` call inside the same `Promise.allSettled` block as prod for each enabled role, then emits a per-role `shadow-verdict-comparison` event after both sides settle. Shadow runs share the orchestrator abort signal so a 900s consumer wall still bounds everything. Outputs are `console.log` only (consistent with B0 telemetry policy) — comparison aggregation happens in the CF Logs pipeline downstream.

**Tech Stack:** TypeScript strict, vitest, Cloudflare Workers runtime, existing `runWithRetryAndFallback` helper, existing `SPECIALIST_CONFIGS` / `SYNTHESIZER_CONFIG` shapes.

---

## File Structure

**New files:**
- `src/lib/shadow-bakeoff-config.ts` — candidate lineup table + env parser + cross-provider invariant assertions. Pure module, no side effects beyond a constant load-time invariant check.
- `src/lib/shadow-bakeoff-telemetry.ts` — emit helpers for `shadow-model-attempt-completed`, `shadow-verdict-comparison`, plus a pure `computeFindingsOverlap` helper.
- `src/lib/shadow-bakeoff-runner.ts` — wraps `runWithRetryAndFallback` for the shadow path, threading the per-attempt emit hook. One specialist runner + one synth runner.
- `tests/shadow-bakeoff-config.test.ts`
- `tests/shadow-bakeoff-telemetry.test.ts`
- `tests/shadow-bakeoff-runner.test.ts`
- `tests/shadow-bakeoff-orchestrator-wire.test.ts` — integration: mocked chat, asserts shadow fires when env enabled, doesn't fire when disabled, never affects prod posting.
- `docs/ops/shadow-bakeoff.md` — operator doc: enable flags, event schema, decision criteria.

**Modified files:**
- `src/lib/triage-pr-review-ensemble.ts` — fan-out wire-up + synth wire-up. ~30 lines added. Also: thread `emitModelAttempt` callback into `runWithRetryAndFallback` for the prod path (it was scaffolded in B0 but never wired — needed now for symmetric prod/shadow analysis).
- `src/lib/ensemble-perf-telemetry.ts` — accept an optional `onAttempt` parameter on `runWithRetryAndFallback` (added via the runner module — the telemetry module itself is unchanged in shape).
- `worker-configuration.d.ts` — add `SHADOW_BAKEOFF_ROLES` to `Env`.
- `wrangler.toml` — document `SHADOW_BAKEOFF_ROLES` env var in the `[vars]` block (unset by default = shadow off everywhere).

**Boundary decisions:**
- Config / telemetry / runner are split because (a) the config is statically analyzable + load-time-asserted, (b) the telemetry module is pure emit helpers (matches `ensemble-perf-telemetry.ts`), (c) the runner imports the existing `runWithRetryAndFallback` + `parsePrReviewResponse` / `parseSynthAnswer` and is the only one with orchestrator-shaped types.
- No new KV / Queue / DO bindings. Aggregation happens downstream in the existing CF Logs → BigQuery (or whatever ops uses) pipeline.

---

## Task 1: Shadow lineup constants + env parser

**Files:**
- Create: `src/lib/shadow-bakeoff-config.ts`
- Test: `tests/shadow-bakeoff-config.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// tests/shadow-bakeoff-config.test.ts
import { describe, it, expect } from "vitest"

import {
  SHADOW_BAKEOFF_LINEUP,
  parseShadowEnabledRoles,
  resolveShadowConfig,
  type ShadowRole,
} from "../src/lib/shadow-bakeoff-config"
import { SPECIALIST_CONFIGS, SYNTHESIZER_CONFIG } from "../src/lib/triage-pr-review-ensemble"

describe("SHADOW_BAKEOFF_LINEUP", () => {
  it("defines a candidate ModelConfig for every shadowable role", () => {
    const roles: ShadowRole[] = ["logic", "security", "performance", "tests", "synth"]
    for (const role of roles) {
      const config = SHADOW_BAKEOFF_LINEUP[role]
      expect(config.primary).toBeTruthy()
      expect(typeof config.retries).toBe("number")
      // fallback may be null but the key must exist.
      expect("fallback" in config).toBe(true)
    }
  })

  it("preserves the cross-provider invariant: primary.family !== fallback.family", () => {
    const familyOf = (model: string): string => {
      // Provider family is everything before the first `-` (deepseek, kimi, glm, qwen, etc).
      const head = model.split(":")[0] ?? ""
      return head.split("-")[0] ?? ""
    }
    for (const [role, config] of Object.entries(SHADOW_BAKEOFF_LINEUP)) {
      if (config.fallback === null) continue
      expect(
        familyOf(config.primary),
        `shadow ${role} primary+fallback are same family`,
      ).not.toBe(familyOf(config.fallback))
    }
  })

  it("differs from the production lineup on at least one role (otherwise shadow is pointless)", () => {
    const differs = (a: { primary: string; fallback: string | null }, b: { primary: string; fallback: string | null }) =>
      a.primary !== b.primary || a.fallback !== b.fallback
    const anyDiffers =
      differs(SHADOW_BAKEOFF_LINEUP.logic, SPECIALIST_CONFIGS.logic) ||
      differs(SHADOW_BAKEOFF_LINEUP.security, SPECIALIST_CONFIGS.security) ||
      differs(SHADOW_BAKEOFF_LINEUP.performance, SPECIALIST_CONFIGS.performance) ||
      differs(SHADOW_BAKEOFF_LINEUP.tests, SPECIALIST_CONFIGS.tests) ||
      differs(SHADOW_BAKEOFF_LINEUP.synth, SYNTHESIZER_CONFIG)
    expect(anyDiffers).toBe(true)
  })
})

describe("parseShadowEnabledRoles", () => {
  it("returns empty set when env var unset or empty", () => {
    expect(parseShadowEnabledRoles(undefined)).toEqual(new Set())
    expect(parseShadowEnabledRoles("")).toEqual(new Set())
    expect(parseShadowEnabledRoles("   ")).toEqual(new Set())
  })

  it("parses comma-separated role names case-insensitively, trimming whitespace", () => {
    expect(parseShadowEnabledRoles("synth")).toEqual(new Set(["synth"]))
    expect(parseShadowEnabledRoles("synth,security")).toEqual(new Set(["synth", "security"]))
    expect(parseShadowEnabledRoles(" SYNTH , Security ")).toEqual(new Set(["synth", "security"]))
  })

  it("ignores tokens that are not valid ShadowRoles (no throw on operator typos)", () => {
    expect(parseShadowEnabledRoles("synth,not-a-role,tests")).toEqual(new Set(["synth", "tests"]))
  })
})

describe("resolveShadowConfig", () => {
  it("returns the candidate config when role is in the enabled set", () => {
    expect(resolveShadowConfig("synth", new Set(["synth"]))).toEqual(SHADOW_BAKEOFF_LINEUP.synth)
    expect(resolveShadowConfig("security", new Set(["synth", "security"]))).toEqual(SHADOW_BAKEOFF_LINEUP.security)
  })

  it("returns null when role is NOT enabled", () => {
    expect(resolveShadowConfig("logic", new Set(["synth"]))).toBeNull()
    expect(resolveShadowConfig("synth", new Set())).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify all fail**

Run: `npx vitest run tests/shadow-bakeoff-config.test.ts`
Expected: FAIL — cannot resolve `../src/lib/shadow-bakeoff-config`.

- [ ] **Step 3: Create the config module**

Create `src/lib/shadow-bakeoff-config.ts`:

```typescript
// ARC-283 Phase B1b — shadow-mode bake-off lineup + env parser.
//
// This module defines the CANDIDATE per-role lineup we want to bake
// off against the production lineup in `SPECIALIST_CONFIGS` /
// `SYNTHESIZER_CONFIG`. The shadow runner (`shadow-bakeoff-runner.ts`)
// fires these in parallel with prod; the comparison-telemetry emitter
// (`shadow-bakeoff-telemetry.ts`) logs the post-hoc diff.
//
// Source of truth for candidate selection: Codex's ARC-292 analysis
// (`.claude/handoff/arc-292-model-lineup-codex-response.md`). Per-role
// rationale is in the inline comment next to each candidate config.
//
// Cross-provider invariant: primary.family !== fallback.family. Same
// rule the prod lineup follows (enforced by a unit test in
// `tests/triage-pr-review-ensemble.test.ts` post-ARC-291). Tested
// independently here so a broken shadow lineup gets caught BEFORE
// prod is touched.

import type { ModelConfig } from "./triage-pr-review-ensemble"

export type ShadowRole = "logic" | "security" | "performance" | "tests" | "synth"

const SHADOW_ROLES: ReadonlySet<ShadowRole> = new Set([
  "logic",
  "security",
  "performance",
  "tests",
  "synth",
])

/**
 * Candidate per-role ModelConfig to bake off vs. production.
 *
 * Codex's bake-off priority order (drives which roles are enabled
 * first via `SHADOW_BAKEOFF_ROLES` env in prod):
 *   1. synth     — most customer-impactful failure mode (PR #97).
 *   2. tests + security — high false-positive risk on coder swap.
 *   3. performance fallback — ARC-167 already defends prod primary.
 *   4. logic fallback — keep prod primary, swap kimi-k2.5 → glm-5.1.
 */
export const SHADOW_BAKEOFF_LINEUP: Record<ShadowRole, ModelConfig> = {
  // Logic: keep deepseek-v4-pro primary (reasoning IS the job), swap
  // the kimi-k2.5 fallback → glm-5.1 (Z.AI infra has better
  // reliability profile in ARC-167 data; same family as performance
  // primary, so we know it's reachable on Ollama Turbo).
  logic: {
    primary: "deepseek-v4-pro:cloud",
    retries: 1,
    fallback: "glm-5.1:cloud",
  },
  // Security: swap deepseek-v4-flash → qwen3-coder-next primary.
  // Coder-model territory: vulnerability patterns are mostly syntax /
  // dataflow recognition, not frontier reasoning. DeepSeek demoted to
  // fallback. Different provider family so cross-provider invariant
  // holds.
  security: {
    primary: "qwen3-coder-next:cloud",
    retries: 1,
    fallback: "deepseek-v4-flash:cloud",
  },
  // Performance: keep glm-5.1 primary (defended by ARC-167: 100%
  // success, +18% findings depth). Swap kimi-k2.5 fallback →
  // qwen3-coder-next so the fallback isn't Moonshot (kimi-k2.5 had
  // poor reliability in fallback role per Codex's analysis).
  performance: {
    primary: "glm-5.1:cloud",
    retries: 1,
    fallback: "qwen3-coder-next:cloud",
  },
  // Tests: same swap as security. Test-gap detection is coder-model
  // territory (missing branches, brittle assertions, coverage holes).
  // qwen primary, DeepSeek fallback.
  tests: {
    primary: "qwen3-coder-next:cloud",
    retries: 1,
    fallback: "deepseek-v4-flash:cloud",
  },
  // Synth: HIGHEST-PRIORITY swap. Remove Moonshot from the critical
  // customer-visible merge step (PR #97 burned 6m16s when kimi-k2.6
  // hit a Moonshot-wide capacity dip). DeepSeek-v4-flash already
  // proven on security + tests specialists in prod. qwen fallback
  // keeps cross-provider invariant.
  synth: {
    primary: "deepseek-v4-flash:cloud",
    retries: 1,
    fallback: "qwen3-coder-next:cloud",
  },
}

/**
 * Parse `SHADOW_BAKEOFF_ROLES` env var into the set of roles whose
 * shadow lineup should fire on this run. CSV, case-insensitive,
 * whitespace-trimmed. Unknown role names are dropped silently — an
 * operator typo shouldn't kill the prod path.
 *
 *   parseShadowEnabledRoles(undefined)          → new Set()
 *   parseShadowEnabledRoles("")                 → new Set()
 *   parseShadowEnabledRoles("synth")            → new Set(["synth"])
 *   parseShadowEnabledRoles(" SYNTH , tests ")  → new Set(["synth","tests"])
 *   parseShadowEnabledRoles("synth,not-a-role") → new Set(["synth"])
 */
export function parseShadowEnabledRoles(raw: string | undefined): Set<ShadowRole> {
  if (!raw) return new Set()
  const out = new Set<ShadowRole>()
  for (const token of raw.split(",")) {
    const candidate = token.trim().toLowerCase()
    if (SHADOW_ROLES.has(candidate as ShadowRole)) {
      out.add(candidate as ShadowRole)
    }
  }
  return out
}

/**
 * Return the candidate `ModelConfig` to shadow for `role`, or null
 * when shadow is disabled for that role on this run. Used by the
 * orchestrator to gate dispatch (no fan-out for null).
 */
export function resolveShadowConfig(
  role: ShadowRole,
  enabled: ReadonlySet<ShadowRole>,
): ModelConfig | null {
  if (!enabled.has(role)) return null
  return SHADOW_BAKEOFF_LINEUP[role]
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/shadow-bakeoff-config.test.ts`
Expected: PASS — 3 describe blocks, 6 it cases.

- [ ] **Step 5: Run tsc + eslint locally on the new file**

Run: `npx tsc --noEmit && npx eslint src/lib/shadow-bakeoff-config.ts tests/shadow-bakeoff-config.test.ts`
Expected: clean (no diagnostics).

- [ ] **Step 6: Commit**

```bash
git add src/lib/shadow-bakeoff-config.ts tests/shadow-bakeoff-config.test.ts
git commit -m "feat(arc-283): shadow-bakeoff lineup table + env parser (no wiring yet)"
```

---

## Task 2: Shadow telemetry emitters + findings-overlap helper

**Files:**
- Create: `src/lib/shadow-bakeoff-telemetry.ts`
- Test: `tests/shadow-bakeoff-telemetry.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// tests/shadow-bakeoff-telemetry.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EnsembleRunCtx } from "../src/lib/ensemble-perf-telemetry"
import {
  emitShadowAttempt,
  emitShadowVerdictComparison,
  computeFindingsOverlap,
  type ShadowAttemptEvent,
  type ShadowVerdictComparison,
} from "../src/lib/shadow-bakeoff-telemetry"

const CTX: EnsembleRunCtx = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 99,
  headSha: "feedface00000000000000000000000000000000",
}

let logSpy: ReturnType<typeof vi.spyOn>

function lastLogged(): Record<string, unknown> {
  const calls = logSpy.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return JSON.parse(calls[calls.length - 1]?.[0] as string) as Record<string, unknown>
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
})

describe("emitShadowAttempt", () => {
  it("emits a shadow-model-attempt-completed event with correlation fields + truncated headSha", () => {
    const info: ShadowAttemptEvent = {
      role: "synth",
      attemptKind: "primary",
      attemptIndex: 1,
      model: "deepseek-v4-flash:cloud",
      timeoutMs: 60_000,
      startedAtMs: 1_000,
      endedAtMs: 1_500,
      elapsedMs: 500,
      outcome: "ok",
    }
    emitShadowAttempt(CTX, info)
    const event = lastLogged()
    expect(event["event"]).toBe("shadow-model-attempt-completed")
    expect(event["owner"]).toBe("Arc-and-Anchor")
    expect(event["headSha"]).toBe("feedfac")
    expect(event["role"]).toBe("synth")
    expect(event["attemptKind"]).toBe("primary")
    expect(event["model"]).toBe("deepseek-v4-flash:cloud")
    expect(event["outcome"]).toBe("ok")
    expect(event).not.toHaveProperty("failureReason")
  })

  it("includes failureReason only when outcome is not ok", () => {
    emitShadowAttempt(CTX, {
      role: "tests", attemptKind: "fallback", attemptIndex: 2,
      model: "deepseek-v4-flash:cloud", timeoutMs: 60_000,
      startedAtMs: 0, endedAtMs: 60_000, elapsedMs: 60_000,
      outcome: "timeout", failureReason: "per_attempt_timeout",
    })
    const event = lastLogged()
    expect(event["outcome"]).toBe("timeout")
    expect(event["failureReason"]).toBe("per_attempt_timeout")
  })
})

describe("emitShadowVerdictComparison", () => {
  it("emits a shadow-verdict-comparison event with all comparison fields", () => {
    const comp: ShadowVerdictComparison = {
      role: "synth",
      prodModel: "kimi-k2.6:cloud",
      shadowModel: "deepseek-v4-flash:cloud",
      prodVerdictOk: true,
      shadowVerdictOk: true,
      prodElapsedMs: 52_000,
      shadowElapsedMs: 41_000,
      prodAttemptsUsed: 1,
      shadowAttemptsUsed: 1,
      prodFindingsCount: 3,
      shadowFindingsCount: 4,
      overlapCount: 2,
      prodOnlyCount: 1,
      shadowOnlyCount: 2,
      prodScoreHistogram: { 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 },
      shadowScoreHistogram: { 1: 0, 2: 1, 3: 2, 4: 1, 5: 0 },
      shadowFailureReason: null,
    }
    emitShadowVerdictComparison(CTX, comp)
    const event = lastLogged()
    expect(event["event"]).toBe("shadow-verdict-comparison")
    expect(event["role"]).toBe("synth")
    expect(event["prodModel"]).toBe("kimi-k2.6:cloud")
    expect(event["shadowModel"]).toBe("deepseek-v4-flash:cloud")
    expect(event["overlapCount"]).toBe(2)
    expect(event["prodOnlyCount"]).toBe(1)
    expect(event["shadowOnlyCount"]).toBe(2)
    expect(event["prodScoreHistogram"]).toEqual({ 1: 0, 2: 1, 3: 1, 4: 1, 5: 0 })
    expect(event["shadowFailureReason"]).toBeNull()
  })
})

describe("computeFindingsOverlap", () => {
  const f = (path: string, line: number, category: string, score: number) =>
    ({ path, line, category, score, headline: "", body: "" })

  it("returns zero overlap when one side has no findings", () => {
    expect(computeFindingsOverlap([], [f("a.ts", 1, "logic", 3)])).toEqual({
      overlapCount: 0, prodOnlyCount: 0, shadowOnlyCount: 1,
    })
    expect(computeFindingsOverlap([f("a.ts", 1, "logic", 3)], [])).toEqual({
      overlapCount: 0, prodOnlyCount: 1, shadowOnlyCount: 0,
    })
  })

  it("matches on (path, line, category) tuple — different category at same line is NOT a match", () => {
    const result = computeFindingsOverlap(
      [f("a.ts", 10, "logic", 4), f("b.ts", 5, "security", 5)],
      [f("a.ts", 10, "logic", 3), f("a.ts", 10, "performance", 4)],
    )
    expect(result.overlapCount).toBe(1) // only a.ts:10:logic matches
    expect(result.prodOnlyCount).toBe(1) // b.ts:5:security
    expect(result.shadowOnlyCount).toBe(1) // a.ts:10:performance
  })

  it("deduplicates by tuple so a model spamming the same line still scores 1 overlap", () => {
    const result = computeFindingsOverlap(
      [f("a.ts", 10, "logic", 4), f("a.ts", 10, "logic", 2)],
      [f("a.ts", 10, "logic", 3)],
    )
    expect(result.overlapCount).toBe(1)
    expect(result.prodOnlyCount).toBe(0)
    expect(result.shadowOnlyCount).toBe(0)
  })

  it("produces a 1..5 score histogram for an array of findings", () => {
    // exposed via the same module for orchestrator use; spec'd alongside overlap.
    const result = computeFindingsOverlap(
      [f("a.ts", 1, "logic", 2), f("a.ts", 2, "logic", 5), f("a.ts", 3, "logic", 5)],
      [],
    )
    expect(result.prodScoreHistogram).toEqual({ 1: 0, 2: 1, 3: 0, 4: 0, 5: 2 })
    expect(result.shadowScoreHistogram).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
  })
})
```

- [ ] **Step 2: Run test to verify all fail**

Run: `npx vitest run tests/shadow-bakeoff-telemetry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the telemetry module**

Create `src/lib/shadow-bakeoff-telemetry.ts`:

```typescript
// ARC-283 Phase B1b — pure emit helpers for shadow-mode bake-off
// events. Mirrors the shape conventions in `ensemble-perf-telemetry.ts`:
//
//   - `console.log(JSON.stringify(...))` with `event` discriminator
//   - `EnsembleRunCtx` correlation fields stamped on every event
//   - headSha truncated to 7 chars at log time
//   - pure helper functions exported for unit testing
//
// Event taxonomy:
//   - `shadow-model-attempt-completed` — one per LLM call inside the
//     shadow runner (primary, retry, fallback). Mirrors prod's
//     `model-attempt-completed` shape so log analyzers can join the
//     two by `(role, attemptKind, attemptIndex)`.
//   - `shadow-verdict-comparison` — one per role with shadow enabled,
//     emitted AFTER both prod + shadow settle. Carries the post-hoc
//     diff: latency, attempts, findings counts, overlap, score
//     histograms, shadow failure reason.

import type { EnsembleRunCtx } from "./ensemble-perf-telemetry"

function correlationFields(ctx: EnsembleRunCtx): Record<string, string | number> {
  return {
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    headSha: ctx.headSha.slice(0, 7),
  }
}

// ─── shadow-model-attempt-completed ───────────────────────────────

export type ShadowAttemptKind = "primary" | "retry" | "fallback"
export type ShadowAttemptOutcome = "ok" | "failed" | "aborted" | "timeout"

export interface ShadowAttemptEvent {
  /** Role being shadowed (`logic` / `security` / `performance` /
   *  `tests` / `synth`). */
  role: string
  attemptKind: ShadowAttemptKind
  /** 1-indexed attempt counter across the entire shadow
   *  `runWithRetryAndFallback` call. */
  attemptIndex: number
  model: string
  timeoutMs: number
  startedAtMs: number
  endedAtMs: number
  elapsedMs: number
  outcome: ShadowAttemptOutcome
  /** Present when outcome ≠ ok. */
  failureReason?: string
}

export function emitShadowAttempt(ctx: EnsembleRunCtx, info: ShadowAttemptEvent): void {
  const { failureReason, ...rest } = info
  const payload: Record<string, unknown> = {
    event: "shadow-model-attempt-completed",
    ...correlationFields(ctx),
    ...rest,
  }
  if (failureReason !== undefined) payload["failureReason"] = failureReason
  console.log(JSON.stringify(payload))
}

// ─── shadow-verdict-comparison ────────────────────────────────────

/** Per-score histogram. Always emits 1..5 keys (zero-filled). */
export type ScoreHistogram = Record<1 | 2 | 3 | 4 | 5, number>

export interface ShadowVerdictComparison {
  role: string
  prodModel: string
  shadowModel: string
  prodVerdictOk: boolean
  shadowVerdictOk: boolean
  prodElapsedMs: number
  shadowElapsedMs: number
  prodAttemptsUsed: number
  shadowAttemptsUsed: number
  prodFindingsCount: number
  shadowFindingsCount: number
  /** Findings present in BOTH prod and shadow (matched on
   *  (path, line, category) tuple). */
  overlapCount: number
  /** Findings in prod but not in shadow. */
  prodOnlyCount: number
  /** Findings in shadow but not in prod. */
  shadowOnlyCount: number
  prodScoreHistogram: ScoreHistogram
  shadowScoreHistogram: ScoreHistogram
  /** Set when shadow failed (no verdict). null on shadow success. */
  shadowFailureReason: string | null
}

export function emitShadowVerdictComparison(
  ctx: EnsembleRunCtx,
  comp: ShadowVerdictComparison,
): void {
  console.log(JSON.stringify({
    event: "shadow-verdict-comparison",
    ...correlationFields(ctx),
    ...comp,
  }))
}

// ─── findings overlap + histogram (pure helper) ───────────────────

/** Minimum shape we need to compare findings. Both
 *  PrReviewVerdict.findings and the synth output's `findings` array
 *  satisfy this — we only depend on `path`/`line`/`category`/`score`. */
export interface FindingForOverlap {
  path: string
  line: number
  category: string
  score: number
}

export interface FindingsOverlapResult {
  overlapCount: number
  prodOnlyCount: number
  shadowOnlyCount: number
  prodScoreHistogram: ScoreHistogram
  shadowScoreHistogram: ScoreHistogram
}

function key(f: FindingForOverlap): string {
  return `${f.path}:${f.line}:${f.category}`
}

function emptyHistogram(): ScoreHistogram {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
}

function buildHistogram(findings: readonly FindingForOverlap[]): ScoreHistogram {
  const h = emptyHistogram()
  for (const f of findings) {
    const s = f.score
    if (s === 1 || s === 2 || s === 3 || s === 4 || s === 5) {
      h[s] = h[s] + 1
    }
  }
  return h
}

/**
 * Compute findings overlap between prod + shadow on the
 * (path, line, category) tuple. Dedup by tuple within each side, so
 * a model that emits two findings on the same line+category still
 * counts as one entry.
 *
 * Histograms are taken from the ORIGINAL (un-deduped) findings array
 * to preserve "this model is spammy on score-1" signal.
 */
export function computeFindingsOverlap(
  prod: readonly FindingForOverlap[],
  shadow: readonly FindingForOverlap[],
): FindingsOverlapResult {
  const prodKeys = new Set(prod.map(key))
  const shadowKeys = new Set(shadow.map(key))
  let overlap = 0
  for (const k of prodKeys) if (shadowKeys.has(k)) overlap++
  return {
    overlapCount: overlap,
    prodOnlyCount: prodKeys.size - overlap,
    shadowOnlyCount: shadowKeys.size - overlap,
    prodScoreHistogram: buildHistogram(prod),
    shadowScoreHistogram: buildHistogram(shadow),
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/shadow-bakeoff-telemetry.test.ts`
Expected: PASS — 3 describes, 8 it cases.

- [ ] **Step 5: tsc + eslint clean**

Run: `npx tsc --noEmit && npx eslint src/lib/shadow-bakeoff-telemetry.ts tests/shadow-bakeoff-telemetry.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shadow-bakeoff-telemetry.ts tests/shadow-bakeoff-telemetry.test.ts
git commit -m "feat(arc-283): shadow-bakeoff telemetry emitters + findings-overlap helper"
```

---

## Task 3: Shadow runner — wraps runWithRetryAndFallback for the shadow path

**Files:**
- Create: `src/lib/shadow-bakeoff-runner.ts`
- Test: `tests/shadow-bakeoff-runner.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
// tests/shadow-bakeoff-runner.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EnsembleRunCtx } from "../src/lib/ensemble-perf-telemetry"
import { runShadowSpecialist, runShadowSynth } from "../src/lib/shadow-bakeoff-runner"

// Mock `chat` so we don't make real HTTP calls. The runner ultimately
// calls runWithRetryAndFallback → attemptChat → chat. We control the
// last hop.
vi.mock("../src/lib/ollama-chat", () => ({
  chat: vi.fn(),
}))

import { chat } from "../src/lib/ollama-chat"

const CTX: EnsembleRunCtx = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 99,
  headSha: "deadbeefcafebabe1234567890abcdef12345678",
}

const VALID_VERDICT_JSON = JSON.stringify({
  verdict: "REQUEST_CHANGES",
  summary: "shadow ran",
  confidence: 4,
  confidenceReason: "high",
  findings: [
    { path: "src/a.ts", line: 1, score: 3, headline: "x", body: "y", category: "logic" },
  ],
})

const VALID_SYNTH_JSON = JSON.stringify({
  verdict: {
    verdict: "REQUEST_CHANGES",
    summary: "shadow synth",
    confidence: 4,
    confidenceReason: "high",
    findings: [
      { path: "src/a.ts", line: 1, score: 3, headline: "x", body: "y", category: "logic" },
    ],
  },
  provenance: {
    findings: [
      { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-1"], action: "kept", verifiedViaRetrieval: false },
    ],
    dropped: [],
    retrievalCallsUsed: 0,
  },
})

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.mocked(chat).mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
})

function shadowAttemptEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .filter((e) => e["event"] === "shadow-model-attempt-completed")
}

describe("runShadowSpecialist", () => {
  it("returns the verdict + emits one shadow-model-attempt-completed event on primary success", async () => {
    vi.mocked(chat).mockResolvedValueOnce({ content: VALID_VERDICT_JSON })
    const result = await runShadowSpecialist({
      role: "security",
      shadowConfig: { primary: "qwen3-coder-next:cloud", retries: 1, fallback: "deepseek-v4-flash:cloud" },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(true)
    expect(result.modelUsed).toBe("qwen3-coder-next:cloud")
    expect(result.attemptsUsed).toBe(1)
    expect(result.findings).toHaveLength(1)
    const events = shadowAttemptEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      role: "security",
      attemptKind: "primary",
      attemptIndex: 1,
      model: "qwen3-coder-next:cloud",
      outcome: "ok",
    })
  })

  it("emits two events + falls back to cross-provider on primary failure", async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error("503 upstream overload")) // primary fails
    vi.mocked(chat).mockRejectedValueOnce(new Error("503 again")) // retry fails
    vi.mocked(chat).mockResolvedValueOnce({ content: VALID_VERDICT_JSON }) // fallback succeeds
    const result = await runShadowSpecialist({
      role: "tests",
      shadowConfig: { primary: "qwen3-coder-next:cloud", retries: 1, fallback: "deepseek-v4-flash:cloud" },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(true)
    expect(result.modelUsed).toBe("deepseek-v4-flash:cloud")
    const events = shadowAttemptEvents()
    expect(events).toHaveLength(3)
    expect(events.map((e) => e["attemptKind"])).toEqual(["primary", "retry", "fallback"])
    expect(events.map((e) => e["outcome"])).toEqual(["failed", "failed", "ok"])
  })

  it("returns verdictOk=false + failureReason when every attempt fails", async () => {
    vi.mocked(chat).mockRejectedValue(new Error("502 bad gateway"))
    const result = await runShadowSpecialist({
      role: "logic",
      shadowConfig: { primary: "deepseek-v4-pro:cloud", retries: 1, fallback: "glm-5.1:cloud" },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(false)
    expect(result.failureReason).toBeTruthy()
    expect(result.findings).toEqual([])
  })

  it("aborts cleanly when the outer signal is already aborted (no chat calls)", async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await runShadowSpecialist({
      role: "logic",
      shadowConfig: { primary: "deepseek-v4-pro:cloud", retries: 1, fallback: null },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: ac.signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(false)
    expect(vi.mocked(chat)).not.toHaveBeenCalled()
  })

  it("returns failureReason='missing_api_key' without calling chat when apiKey is empty", async () => {
    const result = await runShadowSpecialist({
      role: "logic",
      shadowConfig: { primary: "deepseek-v4-pro:cloud", retries: 0, fallback: null },
      apiKey: "",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(false)
    expect(result.failureReason).toBe("missing_api_key")
    expect(vi.mocked(chat)).not.toHaveBeenCalled()
  })
})

describe("runShadowSynth", () => {
  it("returns verdict + findings on synth success", async () => {
    vi.mocked(chat).mockResolvedValueOnce({ content: VALID_SYNTH_JSON })
    const result = await runShadowSynth({
      shadowConfig: { primary: "deepseek-v4-flash:cloud", retries: 1, fallback: "qwen3-coder-next:cloud" },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(true)
    expect(result.findings).toHaveLength(1)
    expect(result.modelUsed).toBe("deepseek-v4-flash:cloud")
    const events = shadowAttemptEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.["role"]).toBe("synth")
  })
})
```

- [ ] **Step 2: Run test to verify all fail**

Run: `npx vitest run tests/shadow-bakeoff-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Verify the chat module path used in the test mock**

Run: `grep -rn "from \"./ollama-chat\"\|from \"\\./.*chat\"" src/lib/triage-pr-review-ensemble.ts | head -5`
Expected: shows the import path the runner module should mirror. If the prod module imports `chat` from a path other than `./ollama-chat`, update the `vi.mock("../src/lib/ollama-chat", ...)` call in the test file to that path BEFORE writing the runner.

- [ ] **Step 4: Create the runner module**

Create `src/lib/shadow-bakeoff-runner.ts` (the `chat` import path on line 1 of the import block MUST match what `triage-pr-review-ensemble.ts` uses):

```typescript
// ARC-283 Phase B1b — shadow-mode runner. Wraps the existing
// `runWithRetryAndFallback` (exported from triage-pr-review-ensemble.ts)
// so the shadow path uses the SAME retry/fallback policy as prod,
// which is what makes the bake-off comparison apples-to-apples.
//
// Two entry points:
//   - `runShadowSpecialist` — for the four specialist roles. Parses
//     the prod PR_REVIEW_SCHEMA-shaped output and returns the
//     finding array directly (no role-specific post-processing —
//     that's prod's job and we explicitly don't want to mutate the
//     comparison surface).
//   - `runShadowSynth` — for the synth role. Parses the synth
//     `{verdict, provenance}` envelope; the comparison telemetry
//     only cares about `verdict.findings`.
//
// Both emit `shadow-model-attempt-completed` events per attempt
// through a wrapper that calls `runWithRetryAndFallback` with an
// `onAttempt` callback (Task 4 adds the callback parameter to
// `runWithRetryAndFallback`).
//
// SAFETY: shadow runners NEVER post to GitHub, NEVER mutate KV /
// queues / DO state. They are pure-observation: parse, log, return.

import {
  parsePrReviewResponse,
  parseSynthAnswer,
  runWithRetryAndFallback,
  type ModelConfig,
  type ChatMessage,
} from "./triage-pr-review-ensemble"
import {
  emitShadowAttempt,
  type ShadowAttemptKind,
  type ShadowAttemptOutcome,
  type FindingForOverlap,
} from "./shadow-bakeoff-telemetry"
import type { EnsembleRunCtx } from "./ensemble-perf-telemetry"

export interface ShadowRunResult {
  /** True when shadow produced a parseable verdict on some attempt. */
  verdictOk: boolean
  /** Final model that produced the verdict (or the one that failed
   *  last when shadow bailed). */
  modelUsed: string
  /** Total attempts across primary retries + fallback. */
  attemptsUsed: number
  /** Findings extracted for comparison telemetry. Empty on failure. */
  findings: readonly FindingForOverlap[]
  /** Wall-clock elapsed (start → finalize). */
  elapsedMs: number
  /** Failure reason from runWithRetryAndFallback, or undefined on success. */
  failureReason?: string
}

export interface SpecialistShadowArgs {
  role: "logic" | "security" | "performance" | "tests"
  shadowConfig: ModelConfig
  apiKey: string
  systemPrompt: string
  userMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  perfCtx: EnsembleRunCtx
}

export interface SynthShadowArgs {
  shadowConfig: ModelConfig
  apiKey: string
  systemPrompt: string
  userMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  perfCtx: EnsembleRunCtx
}

function attemptIndexToKind(i: number, retries: number): ShadowAttemptKind {
  if (i === 1) return "primary"
  if (i <= retries + 1) return "retry"
  return "fallback"
}

function classifyOutcome(verdictOk: boolean, failureReason: string | undefined): ShadowAttemptOutcome {
  if (verdictOk) return "ok"
  const r = failureReason ?? ""
  if (r.includes("timeout") || r.includes("per_attempt")) return "timeout"
  if (r.includes("abort")) return "aborted"
  return "failed"
}

export async function runShadowSpecialist(args: SpecialistShadowArgs): Promise<ShadowRunResult> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return {
      verdictOk: false,
      modelUsed: args.shadowConfig.primary,
      attemptsUsed: 0,
      findings: [],
      elapsedMs: 0,
      failureReason: "missing_api_key",
    }
  }
  if (args.signal.aborted) {
    return {
      verdictOk: false,
      modelUsed: args.shadowConfig.primary,
      attemptsUsed: 0,
      findings: [],
      elapsedMs: 0,
      failureReason: "aborted_before_start",
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userMessage },
  ]
  const outcome = await runWithRetryAndFallback({
    config: args.shadowConfig,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: undefined,
    parseAnswer: parsePrReviewResponse,
    parseFailureLabel: "shadow_specialist_did_not_parse",
    startedAt: t0,
    onAttempt: (info) => {
      emitShadowAttempt(args.perfCtx, {
        role: args.role,
        attemptKind: attemptIndexToKind(info.attemptIndex, args.shadowConfig.retries),
        attemptIndex: info.attemptIndex,
        model: info.model,
        timeoutMs: info.timeoutMs,
        startedAtMs: info.startedAtMs,
        endedAtMs: info.endedAtMs,
        elapsedMs: info.endedAtMs - info.startedAtMs,
        outcome: classifyOutcome(info.verdictOk, info.failureReason),
        ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
      })
    },
  })
  const verdictOk = outcome.verdict !== null
  return {
    verdictOk,
    modelUsed: outcome.modelUsed,
    attemptsUsed: outcome.attemptsUsed,
    findings: verdictOk
      ? outcome.verdict!.findings.map((f) => ({
          path: f.path,
          line: f.line,
          category: f.category,
          score: f.score,
        }))
      : [],
    elapsedMs: outcome.elapsedMs,
    ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
  }
}

export async function runShadowSynth(args: SynthShadowArgs): Promise<ShadowRunResult> {
  const t0 = Date.now()
  if (!args.apiKey) {
    return {
      verdictOk: false,
      modelUsed: args.shadowConfig.primary,
      attemptsUsed: 0,
      findings: [],
      elapsedMs: 0,
      failureReason: "missing_api_key",
    }
  }
  if (args.signal.aborted) {
    return {
      verdictOk: false,
      modelUsed: args.shadowConfig.primary,
      attemptsUsed: 0,
      findings: [],
      elapsedMs: 0,
      failureReason: "aborted_before_start",
    }
  }
  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userMessage },
  ]
  const outcome = await runWithRetryAndFallback({
    config: args.shadowConfig,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: undefined,
    parseAnswer: parseSynthAnswer,
    parseFailureLabel: "shadow_synth_did_not_parse",
    startedAt: t0,
    onAttempt: (info) => {
      emitShadowAttempt(args.perfCtx, {
        role: "synth",
        attemptKind: attemptIndexToKind(info.attemptIndex, args.shadowConfig.retries),
        attemptIndex: info.attemptIndex,
        model: info.model,
        timeoutMs: info.timeoutMs,
        startedAtMs: info.startedAtMs,
        endedAtMs: info.endedAtMs,
        elapsedMs: info.endedAtMs - info.startedAtMs,
        outcome: classifyOutcome(info.verdictOk, info.failureReason),
        ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
      })
    },
  })
  const verdictOk = outcome.verdict !== null
  return {
    verdictOk,
    modelUsed: outcome.modelUsed,
    attemptsUsed: outcome.attemptsUsed,
    findings: verdictOk
      ? outcome.verdict!.verdict.findings.map((f) => ({
          path: f.path,
          line: f.line,
          category: f.category,
          score: f.score,
        }))
      : [],
    elapsedMs: outcome.elapsedMs,
    ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
  }
}
```

- [ ] **Step 5: Re-check imports — `runWithRetryAndFallback` needs `onAttempt` parameter**

The runner depends on `runWithRetryAndFallback` accepting an `onAttempt` callback. That parameter does NOT exist today. Task 4 adds it. **Defer running the tests until Task 4 is complete** — they will fail with a type error otherwise. Move directly to Task 4.

- [ ] **Step 6: (deferred — runs at end of Task 4)**

---

## Task 4: Add `onAttempt` callback to `runWithRetryAndFallback` (also wires `model-attempt-completed` for prod)

The shadow runner needs per-attempt visibility into `runWithRetryAndFallback`. The cleanest way is an optional `onAttempt` callback that fires after every settled attempt (primary, retry, fallback). The same callback shape lets the prod path FINALLY wire up the `model-attempt-completed` event scaffolded in B0 (PR #95) but never connected.

**Files:**
- Modify: `src/lib/triage-pr-review-ensemble.ts` — extend `runWithRetryAndFallback` signature + emit point.
- Modify: `tests/triage-pr-review-ensemble.test.ts` (or the targeted retry-fallback test file) — pin the callback fires once per attempt with the correct shape.

- [ ] **Step 1: Find the right existing test file**

Run: `grep -rln "runWithRetryAndFallback" tests/`
Expected: a file (likely `tests/triage-pr-review-ensemble-retry-fallback.test.ts` or similar). If none specifically targets the retry helper, find any `triage-pr-review-ensemble*.test.ts` that mocks `chat` and add new tests there. Note the exact file path before continuing.

- [ ] **Step 2: Write the failing test (in whichever file Step 1 identifies)**

```typescript
// New describe block in the existing retry-fallback test file:

describe("runWithRetryAndFallback onAttempt callback", () => {
  it("invokes onAttempt once per attempted call with verdictOk + failureReason + timing", async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error("503"))
    vi.mocked(chat).mockResolvedValueOnce({ content: VALID_VERDICT_JSON })
    const attempts: Array<{
      attemptIndex: number
      model: string
      timeoutMs: number
      verdictOk: boolean
      startedAtMs: number
      endedAtMs: number
      failureReason?: string
    }> = []
    const result = await runWithRetryAndFallback({
      config: { primary: "p:cloud", retries: 0, fallback: "f:cloud" },
      apiKey: "k",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      chatEnabled: "on",
      format: undefined,
      parseAnswer: parsePrReviewResponse,
      parseFailureLabel: "did_not_parse",
      startedAt: Date.now(),
      onAttempt: (info) => { attempts.push(info) },
    })
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.model).toBe("p:cloud")
    expect(attempts[0]?.verdictOk).toBe(false)
    expect(attempts[0]?.failureReason).toBeTruthy()
    expect(attempts[1]?.model).toBe("f:cloud")
    expect(attempts[1]?.verdictOk).toBe(true)
    expect(result.verdict).not.toBeNull()
  })

  it("does not invoke onAttempt when signal is already aborted (no attempt happened)", async () => {
    const ac = new AbortController()
    ac.abort()
    const attempts: unknown[] = []
    const result = await runWithRetryAndFallback({
      config: { primary: "p:cloud", retries: 0, fallback: null },
      apiKey: "k",
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal,
      chatEnabled: "on",
      format: undefined,
      parseAnswer: parsePrReviewResponse,
      parseFailureLabel: "did_not_parse",
      startedAt: Date.now(),
      onAttempt: (info) => { attempts.push(info) },
    })
    expect(attempts).toHaveLength(0)
    expect(result.verdict).toBeNull()
  })
})
```

- [ ] **Step 3: Run the new test to verify it fails**

Run: `npx vitest run <test-file-from-step-1>`
Expected: FAIL — `onAttempt` is not a known property on the `runWithRetryAndFallback` args.

- [ ] **Step 4: Extend `runWithRetryAndFallback` in `src/lib/triage-pr-review-ensemble.ts`**

Modify the existing function at `src/lib/triage-pr-review-ensemble.ts:2635`. Add the `onAttempt` field to the args type and call it on every settled attempt (BOTH the primary/retry path and the fallback path):

```typescript
export interface AttemptCallbackInfo {
  attemptIndex: number  // 1-indexed across the entire retry+fallback chain
  model: string
  timeoutMs: number
  startedAtMs: number
  endedAtMs: number
  verdictOk: boolean
  failureReason?: string
}

export async function runWithRetryAndFallback<T>(args: {
  config: ModelConfig
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  format: Record<string, unknown> | undefined
  parseAnswer: (content: string) => T | null
  parseFailureLabel: string
  startedAt: number
  perAttemptTimeoutMs?: number
  /** Optional per-attempt observer. Fires AFTER each settled attempt
   *  (success or failure), BEFORE the next iteration. Used by the
   *  ARC-283 shadow runner to emit shadow-model-attempt-completed
   *  events, and by the prod path (wired below in this PR) to emit
   *  the long-scaffolded model-attempt-completed event. */
  onAttempt?: (info: AttemptCallbackInfo) => void
}): Promise<{
  verdict: T | null
  failureReason?: string
  failureRawAnswer?: string
  elapsedMs: number
  modelUsed: string
  attemptsUsed: number
}> {
  // ... existing logic ...
  // Inside the primary/retry loop, AFTER `withComposedTimeout` returns
  // `outcome`, immediately after `attemptsUsed++` but BEFORE the
  // `if (outcome.verdict !== null) return ...` check, capture:
  //   const attemptEndedAtMs = Date.now()
  //   const attemptStartedAtMs = attemptEndedAtMs - (Date.now() - someStartMark)
  // Better: capture `const attemptStartMs = Date.now()` immediately BEFORE
  // the `withComposedTimeout(...)` call, then emit:
  //   args.onAttempt?.({
  //     attemptIndex: attemptsUsed,
  //     model: config.primary,
  //     timeoutMs: perAttemptCap,
  //     startedAtMs: attemptStartMs,
  //     endedAtMs: Date.now(),
  //     verdictOk: outcome.verdict !== null,
  //     ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
  //   })
  //
  // Mirror the same emit on the fallback branch.
```

Concrete edit — apply these in two places.

Place A (primary loop, inside the `for` body, around line 2680-2700):

Before:
```typescript
    attemptsUsed++
    const outcome = await withComposedTimeout(
      (perAttemptSignal) => attemptChat({ ... }),
      perAttemptCap,
      signal,
    )
    if (outcome.verdict !== null) {
      return { verdict: outcome.verdict, ... }
    }
```

After:
```typescript
    attemptsUsed++
    const attemptStartMs = Date.now()
    const outcome = await withComposedTimeout(
      (perAttemptSignal) => attemptChat({ ... }),
      perAttemptCap,
      signal,
    )
    args.onAttempt?.({
      attemptIndex: attemptsUsed,
      model: config.primary,
      timeoutMs: perAttemptCap,
      startedAtMs: attemptStartMs,
      endedAtMs: Date.now(),
      verdictOk: outcome.verdict !== null,
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
    })
    if (outcome.verdict !== null) {
      return { verdict: outcome.verdict, ... }
    }
```

Place B (fallback branch, around line 2727-2756):

Before:
```typescript
  if (config.fallback && !signal.aborted) {
    const fallbackModel = config.fallback
    attemptsUsed++
    const outcome = await withComposedTimeout(
      (perAttemptSignal) => attemptChat({ model: fallbackModel, ... }),
      perAttemptCap,
      signal,
    )
    if (outcome.verdict !== null) {
      return { verdict: outcome.verdict, ... }
    }
    return wrapFailure(`fallback_failed: ${outcome.failureReason ?? "unknown"}`, ...)
  }
```

After:
```typescript
  if (config.fallback && !signal.aborted) {
    const fallbackModel = config.fallback
    attemptsUsed++
    const attemptStartMs = Date.now()
    const outcome = await withComposedTimeout(
      (perAttemptSignal) => attemptChat({ model: fallbackModel, ... }),
      perAttemptCap,
      signal,
    )
    args.onAttempt?.({
      attemptIndex: attemptsUsed,
      model: fallbackModel,
      timeoutMs: perAttemptCap,
      startedAtMs: attemptStartMs,
      endedAtMs: Date.now(),
      verdictOk: outcome.verdict !== null,
      ...(outcome.failureReason !== undefined ? { failureReason: outcome.failureReason } : {}),
    })
    if (outcome.verdict !== null) {
      return { verdict: outcome.verdict, ... }
    }
    return wrapFailure(`fallback_failed: ${outcome.failureReason ?? "unknown"}`, ...)
  }
```

Also export `AttemptCallbackInfo` and (if not already exported) `ModelConfig` from this module so the runner and tests can import them.

- [ ] **Step 5: Run the Task 4 tests to verify they pass**

Run: `npx vitest run <test-file-from-step-1>`
Expected: PASS — 2 new it cases pass; prior tests in the file unchanged.

- [ ] **Step 6: Wire the prod path to emit `model-attempt-completed` through this callback**

In `src/lib/triage-pr-review-ensemble.ts`, find the `runSpecialist` body (around line 2588) and the `runSynthesizer` body (around line 2966). Pass an `onAttempt` callback to each `runWithRetryAndFallback` call that emits the existing `emitModelAttempt` from `ensemble-perf-telemetry.ts`.

Required imports (top of the file, if not already present):
```typescript
import { emitModelAttempt } from "./ensemble-perf-telemetry"
```

`runSpecialist` change — add a `perfCtx` arg to the `SpecialistRunArgs` interface and thread it through from `handlePrReviewEnsemble`'s fan-out call site:

```typescript
// SpecialistRunArgs gets a new required field:
interface SpecialistRunArgs {
  role: SpecialistRole
  apiKey: string | undefined
  systemPrompt: string
  initialMessage: string
  chatEnabled: "on" | "off"
  signal: AbortSignal
  perfCtx: EnsembleRunCtx  // ARC-283 B1b — for model-attempt-completed emission
}
```

Inside `runSpecialist`:
```typescript
  return runWithRetryAndFallback({
    config,
    apiKey: args.apiKey,
    messages,
    signal: args.signal,
    chatEnabled: args.chatEnabled,
    format: PR_REVIEW_SCHEMA as unknown as Record<string, unknown>,
    parseAnswer: parsePrReviewResponse,
    parseFailureLabel: "specialist_did_not_parse",
    startedAt: t0,
    onAttempt: (info) => {
      emitModelAttempt(args.perfCtx, {
        phase: "specialist",
        role: args.role,
        attemptKind: info.attemptIndex === 1 ? "primary"
          : info.attemptIndex <= config.retries + 1 ? "retry"
          : "fallback",
        attemptIndex: info.attemptIndex,
        model: info.model,
        timeoutMs: info.timeoutMs,
        startedAtMs: info.startedAtMs,
        endedAtMs: info.endedAtMs,
        elapsedMs: info.endedAtMs - info.startedAtMs,
        outcome: info.verdictOk ? "ok"
          : (info.failureReason ?? "").includes("timeout") ? "timeout"
          : (info.failureReason ?? "").includes("abort") ? "aborted"
          : "failed",
        ...(info.failureReason !== undefined ? { failureReason: info.failureReason } : {}),
      })
    },
  })
```

In `handlePrReviewEnsemble` at the fan-out (around line 1117), add `perfCtx` to the `runSpecialist` call:
```typescript
(signal) => runSpecialist({
  role,
  apiKey: env.OLLAMA_API_KEY,
  systemPrompt: SPECIALIST_PROMPTS[role],
  initialMessage: appendRoleRule(baseInitialMessage, role, sigilixConfig),
  chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
  signal,
  perfCtx,  // ARC-283 B1b: thread through for model-attempt-completed
}),
```

Apply the same pattern to `runSynthesizer` (around line 2966) — add `perfCtx` to its args interface, thread from caller, emit through `onAttempt` with `phase: "synth"`, `role: "synth"`.

- [ ] **Step 7: Add a test pinning `model-attempt-completed` fires on the prod path**

In whichever orchestrator-shaped test file already runs `handlePrReviewEnsemble` with mocked chat (find via `grep -rln "handlePrReviewEnsemble" tests/`), add one test:

```typescript
it("ARC-283 B1b: emits model-attempt-completed per specialist + synth attempt", async () => {
  // (build env + mock chat to resolve a valid verdict + valid synth, run handler)
  const logCalls = logSpy.mock.calls
    .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .filter((e) => e["event"] === "model-attempt-completed")
  // 4 specialists + 1 synth = 5 attempts on the happy path
  expect(logCalls.length).toBeGreaterThanOrEqual(5)
  for (const event of logCalls) {
    expect(event).toHaveProperty("attemptKind")
    expect(event).toHaveProperty("model")
    expect(event).toHaveProperty("outcome")
  }
})
```

- [ ] **Step 8: Run all touched tests + full suite**

Run: `npx vitest run`
Expected: PASS — 2203 + new tests, no regressions.

- [ ] **Step 9: tsc + eslint clean**

Run: `npx tsc --noEmit && npx eslint --quiet src/lib/triage-pr-review-ensemble.ts tests/`
Expected: clean.

- [ ] **Step 10: Run Task 3's deferred tests (shadow runner)**

Run: `npx vitest run tests/shadow-bakeoff-runner.test.ts`
Expected: PASS — 6 it cases, all green now that `onAttempt` is wired.

- [ ] **Step 11: Commit**

```bash
git add src/lib/triage-pr-review-ensemble.ts src/lib/shadow-bakeoff-runner.ts tests/shadow-bakeoff-runner.test.ts tests/<modified-orchestrator-test-files>
git commit -m "feat(arc-283): onAttempt callback in runWithRetryAndFallback + shadow runner + prod model-attempt-completed wire-up"
```

---

## Task 5: Orchestrator wire-up — fire shadow specialists + synth, emit comparison telemetry

**Files:**
- Modify: `src/lib/triage-pr-review-ensemble.ts` — fan-out wire-up.
- Modify: `worker-configuration.d.ts` — add `SHADOW_BAKEOFF_ROLES` env field.
- Modify: `wrangler.toml` — document env var in `[vars]`.
- Create: `tests/shadow-bakeoff-orchestrator-wire.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/shadow-bakeoff-orchestrator-wire.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/ollama-chat", () => ({ chat: vi.fn() }))
// Mock GitHub client + webhook signing so handler doesn't try real HTTPs.
// Reuse fixtures from existing orchestrator tests — find a sibling test
// that already stubs these and copy the setup verbatim.

import { chat } from "../src/lib/ollama-chat"
import { handlePrReviewEnsemble } from "../src/lib/triage-pr-review-ensemble"

const VALID_VERDICT_JSON = JSON.stringify({ /* same as shadow-bakeoff-runner.test.ts */ })
const VALID_SYNTH_JSON = JSON.stringify({ /* same */ })

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    // ... copy from existing orchestrator test fixture ...
    SHADOW_BAKEOFF_ROLES: "",
    ...overrides,
  } as Env
}

let logSpy: ReturnType<typeof vi.spyOn>

function logEvents(name: string): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .filter((e) => e["event"] === name)
}

beforeEach(() => {
  vi.mocked(chat).mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  // Default: every chat call returns a valid specialist verdict.
  vi.mocked(chat).mockImplementation(async (args: { model: string }) => {
    // The synth call has a specific system prompt — distinguish by which messages it sends.
    // (Implementation detail: see how existing orchestrator tests differentiate; reuse.)
    return { content: VALID_VERDICT_JSON }
  })
})
afterEach(() => {
  logSpy.mockRestore()
})

describe("ARC-283 B1b: shadow-mode orchestrator wire-up", () => {
  it("does NOT fire shadow runs when SHADOW_BAKEOFF_ROLES is empty", async () => {
    const env = buildEnv({ SHADOW_BAKEOFF_ROLES: "" })
    // ... call handlePrReviewEnsemble with the standard test args ...
    expect(logEvents("shadow-model-attempt-completed")).toEqual([])
    expect(logEvents("shadow-verdict-comparison")).toEqual([])
  })

  it("fires shadow run + emits shadow-verdict-comparison when SHADOW_BAKEOFF_ROLES=synth", async () => {
    const env = buildEnv({ SHADOW_BAKEOFF_ROLES: "synth" })
    // ... call handlePrReviewEnsemble ...
    const comparisons = logEvents("shadow-verdict-comparison")
    expect(comparisons.length).toBe(1)
    expect(comparisons[0]?.["role"]).toBe("synth")
    expect(comparisons[0]?.["prodModel"]).toBe("kimi-k2.6:cloud")
    expect(comparisons[0]?.["shadowModel"]).toBe("deepseek-v4-flash:cloud")
    expect(comparisons[0]?.["prodVerdictOk"]).toBe(true)
    expect(comparisons[0]?.["shadowVerdictOk"]).toBe(true)
  })

  it("never affects prod posting even when shadow fails", async () => {
    // First N chat calls return valid; the LAST one (shadow synth) rejects.
    // Then verify the prod review still posts (the existing GitHub mock would
    // have recorded a `createReview` call).
    const env = buildEnv({ SHADOW_BAKEOFF_ROLES: "synth" })
    // ... rig chat mock so prod synth succeeds + shadow synth rejects ...
    const result = await handlePrReviewEnsemble({ /* args */ })
    expect(result.status).toBe("posted") // prod path unaffected
    const comparisons = logEvents("shadow-verdict-comparison")
    expect(comparisons[0]?.["shadowVerdictOk"]).toBe(false)
    expect(comparisons[0]?.["shadowFailureReason"]).toBeTruthy()
  })

  it("fires shadow for multiple roles when CSV list provided", async () => {
    const env = buildEnv({ SHADOW_BAKEOFF_ROLES: "security,tests" })
    // ... call handler ...
    const comparisons = logEvents("shadow-verdict-comparison")
    const roles = comparisons.map((c) => c["role"]).sort()
    expect(roles).toEqual(["security", "tests"])
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/shadow-bakeoff-orchestrator-wire.test.ts`
Expected: FAIL — `SHADOW_BAKEOFF_ROLES` not on Env type; no shadow events emitted.

- [ ] **Step 3: Extend the worker config types**

Modify `worker-configuration.d.ts` — add inside the `Cloudflare.Env` interface:
```typescript
SHADOW_BAKEOFF_ROLES: string;
```
(In alphabetical-ish place near other `OPENCLAW_*` / `OLLAMA_*` flags.)

Modify `wrangler.toml` — add documentation in the `[vars]` block (or where other feature flags are noted):
```toml
# ARC-283 Phase B1b — shadow-mode bake-off. CSV of role names whose
# CANDIDATE lineup should fire in parallel with prod on every review.
# Unset/empty = shadow off everywhere. Shadow verdicts are NEVER
# posted; comparison telemetry emitted via `shadow-verdict-comparison`
# events. Valid roles: logic, security, performance, tests, synth.
# Recommended rollout: "synth" first (highest customer-impact), then
# "security,tests", then "performance", then "logic".
SHADOW_BAKEOFF_ROLES = ""
```

- [ ] **Step 4: Wire shadow specialists into the fan-out**

In `src/lib/triage-pr-review-ensemble.ts`, find the specialist fan-out around line 1109. Modify as follows.

Add imports at the top:
```typescript
import {
  parseShadowEnabledRoles,
  resolveShadowConfig,
  type ShadowRole,
} from "./shadow-bakeoff-config"
import {
  emitShadowVerdictComparison,
  computeFindingsOverlap,
  type FindingForOverlap,
} from "./shadow-bakeoff-telemetry"
import {
  runShadowSpecialist,
  runShadowSynth,
  type ShadowRunResult,
} from "./shadow-bakeoff-runner"
```

Just BEFORE the existing fan-out block (line 1105 in current file), add:
```typescript
const shadowEnabledRoles = parseShadowEnabledRoles(env.SHADOW_BAKEOFF_ROLES)
const shadowSpecialistPromises = new Map<ShadowRole, Promise<ShadowRunResult>>()
for (const role of router.specialists) {
  const shadowConfig = resolveShadowConfig(role, shadowEnabledRoles)
  if (shadowConfig === null) continue
  shadowSpecialistPromises.set(
    role,
    runShadowSpecialist({
      role,
      shadowConfig,
      apiKey: env.OLLAMA_API_KEY,
      systemPrompt: SPECIALIST_PROMPTS[role],
      userMessage: appendRoleRule(baseInitialMessage, role, sigilixConfig),
      chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
      signal: orchCtrl.signal,
      perfCtx,
    }),
  )
}
```

AFTER the existing `Promise.allSettled(...)` resolves and `specialistVerdicts` is collected (around line 1138), but BEFORE the synth setup, add the comparison emit for each shadow specialist:
```typescript
for (const [role, shadowPromise] of shadowSpecialistPromises) {
  // Don't await with a wall — the orch signal already abort-caps.
  // But we MUST settle this before we exit the handler so the
  // comparison emits. Use Promise.allSettled-style: wait, log, move on.
  // eslint-disable-next-line no-await-in-loop -- shadow comparison is per-role
  const shadow = await shadowPromise
  const prodVerdict = specialistVerdicts.find((v) => v.role === role)
  const prodFindings: FindingForOverlap[] = prodVerdict?.verdict?.findings.map((f) => ({
    path: f.path, line: f.line, category: f.category, score: f.score,
  })) ?? []
  const overlap = computeFindingsOverlap(prodFindings, shadow.findings)
  emitShadowVerdictComparison(perfCtx, {
    role,
    prodModel: prodVerdict?.modelUsed ?? SPECIALIST_CONFIGS[role].primary,
    shadowModel: shadow.modelUsed,
    prodVerdictOk: (prodVerdict?.verdict ?? null) !== null,
    shadowVerdictOk: shadow.verdictOk,
    prodElapsedMs: prodVerdict?.elapsedMs ?? 0,
    shadowElapsedMs: shadow.elapsedMs,
    prodAttemptsUsed: prodVerdict?.attemptsUsed ?? 0,
    shadowAttemptsUsed: shadow.attemptsUsed,
    prodFindingsCount: prodFindings.length,
    shadowFindingsCount: shadow.findings.length,
    overlapCount: overlap.overlapCount,
    prodOnlyCount: overlap.prodOnlyCount,
    shadowOnlyCount: overlap.shadowOnlyCount,
    prodScoreHistogram: overlap.prodScoreHistogram,
    shadowScoreHistogram: overlap.shadowScoreHistogram,
    shadowFailureReason: shadow.verdictOk ? null : (shadow.failureReason ?? "unknown"),
  })
}
```

- [ ] **Step 5: Wire shadow synth**

Find the synth section starting around line 1348 in `handlePrReviewEnsemble`. Just before the synth call begins, kick off the shadow synth (it gets the same user message — the synth prompt build is identical):

```typescript
const shadowSynthConfig = resolveShadowConfig("synth", shadowEnabledRoles)
const shadowSynthPromise = shadowSynthConfig
  ? runShadowSynth({
      shadowConfig: shadowSynthConfig,
      apiKey: env.OLLAMA_API_KEY ?? "",
      systemPrompt: SYNTHESIZER_PROMPT,
      userMessage: synthMessageWithMemory,
      chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
      signal: orchCtrl.signal,
      perfCtx,
    })
  : null
```

After the prod synth resolves (around line 1424 — wherever `attempt1`/`attempt2` settle and the prod synth verdict is finalized), but before the function exits, await + emit:

```typescript
if (shadowSynthPromise) {
  const shadow = await shadowSynthPromise
  const prodFindings: FindingForOverlap[] = synthOutcome?.verdict?.findings.map((f) => ({
    path: f.path, line: f.line, category: f.category, score: f.score,
  })) ?? []
  const overlap = computeFindingsOverlap(prodFindings, shadow.findings)
  emitShadowVerdictComparison(perfCtx, {
    role: "synth",
    prodModel: synthOutcome?.modelUsed ?? SYNTHESIZER_CONFIG.primary,
    shadowModel: shadow.modelUsed,
    prodVerdictOk: (synthOutcome?.verdict ?? null) !== null,
    shadowVerdictOk: shadow.verdictOk,
    prodElapsedMs: synthOutcome?.elapsedMs ?? 0,
    shadowElapsedMs: shadow.elapsedMs,
    prodAttemptsUsed: synthOutcome?.attemptsUsed ?? 0,
    shadowAttemptsUsed: shadow.attemptsUsed,
    prodFindingsCount: prodFindings.length,
    shadowFindingsCount: shadow.findings.length,
    overlapCount: overlap.overlapCount,
    prodOnlyCount: overlap.prodOnlyCount,
    shadowOnlyCount: overlap.shadowOnlyCount,
    prodScoreHistogram: overlap.prodScoreHistogram,
    shadowScoreHistogram: overlap.shadowScoreHistogram,
    shadowFailureReason: shadow.verdictOk ? null : (shadow.failureReason ?? "unknown"),
  })
}
```

(The exact variable name for prod synth's settled outcome — `synthOutcome` vs whatever it is in current code — must be confirmed by reading line 1379-1424 before applying. Adjust to the real name.)

Place the shadow-synth emit on EVERY return path that posts a review OR a skip-notice — i.e. it must fire even when prod synth bailed to skip-notice. The cleanest pattern is a single `finally`-style block at the very end of the handler:

```typescript
// At the end of handlePrReviewEnsemble's try block (or in finally — see existing
// telemetry-write pattern around line 545 for the equivalent on EnsembleTelemetry):
try {
  if (shadowSynthPromise) {
    // ... await + emit as above ...
  }
} catch (err) {
  // Defensive: a shadow telemetry crash must NOT take down the prod return.
  console.warn(JSON.stringify({
    event: "shadow-synth-emit-error",
    owner, repo, prNumber,
    err: err instanceof Error ? err.message : String(err),
  }))
}
```

The same defensive try/catch applies to the specialist comparison loop in Step 4.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: PASS — 2203 prior + new tests, no regressions.

- [ ] **Step 7: tsc + eslint clean**

Run: `npx tsc --noEmit && npx eslint --quiet src/ tests/`
Expected: clean.

- [ ] **Step 8: Confirm shadow events appear in `npm run build` output**

Run: `npm run build`
Expected: build succeeds with no new warnings.

- [ ] **Step 9: Commit**

```bash
git add src/lib/triage-pr-review-ensemble.ts tests/shadow-bakeoff-orchestrator-wire.test.ts worker-configuration.d.ts wrangler.toml
git commit -m "feat(arc-283): wire shadow specialists + synth into orchestrator with comparison telemetry"
```

---

## Task 6: Ops doc

**Files:**
- Create: `docs/ops/shadow-bakeoff.md`

- [ ] **Step 1: Write the doc**

```markdown
# Shadow-Mode Model Bake-Off (ARC-283 Phase B1b)

Operator reference for the shadow harness that lets us evaluate
candidate model lineups (per ARC-292) on real PR traffic without
exposing customers to the candidate.

## What it does

For each role in `SHADOW_BAKEOFF_ROLES` (CSV of `logic`/`security`/
`performance`/`tests`/`synth`), the orchestrator fires a parallel
`runWithRetryAndFallback` call against the CANDIDATE lineup defined
in `src/lib/shadow-bakeoff-config.ts:SHADOW_BAKEOFF_LINEUP`. The
shadow verdict is logged, never posted. Production behavior is
unaffected.

## Enabling shadow

Set the env var in `wrangler.toml` (or via `wrangler secret`):
```toml
SHADOW_BAKEOFF_ROLES = "synth"
```
Empty string / unset = shadow off everywhere (default).

Recommended rollout order (per Codex ARC-292):
1. `synth`            — highest customer impact (PR #97 demo).
2. `security,tests`   — coder-model candidates; high false-positive risk.
3. `performance`      — fallback swap only; primary already defended by ARC-167.
4. `logic`            — fallback swap only.

## Events emitted

### `shadow-model-attempt-completed`
One per LLM attempt in the shadow runner. Same shape as
`model-attempt-completed` (prod) so log analyzers can join on
`(role, attemptKind, attemptIndex)`.

Fields: `role`, `attemptKind` (primary/retry/fallback),
`attemptIndex`, `model`, `timeoutMs`, `startedAtMs`, `endedAtMs`,
`elapsedMs`, `outcome` (ok/failed/aborted/timeout), `failureReason`
(when outcome ≠ ok).

### `shadow-verdict-comparison`
One per role with shadow enabled, emitted after BOTH prod + shadow
settle. Carries the post-hoc diff.

Fields: `role`, `prodModel`, `shadowModel`, `prodVerdictOk`,
`shadowVerdictOk`, `prodElapsedMs`, `shadowElapsedMs`,
`prodAttemptsUsed`, `shadowAttemptsUsed`, `prodFindingsCount`,
`shadowFindingsCount`, `overlapCount`, `prodOnlyCount`,
`shadowOnlyCount`, `prodScoreHistogram`, `shadowScoreHistogram`,
`shadowFailureReason`.

Findings overlap matches on `(path, line, category)` tuple — same
line different category is NOT a match.

## Decision criteria

Codex's acceptance bar (per ARC-292):

| Metric                          | Bar                              |
|---------------------------------|----------------------------------|
| shadow valid-verdict rate       | ≥ prod baseline                  |
| shadow p95 elapsed              | ≤ 60s per-attempt cap            |
| shadow timeout / 503 / 429 rate | ≤ prod                           |
| findings overlap with prod      | ≥ 50% on score-4+ findings       |
| net unique useful findings      | ≥ 0 (founder-eyeballed sample)   |

If all five hold over ≥ 100 PR reviews, escalate to canary (Sigilix
internal repos + one low-risk customer). If shadow synth fails the
JSON/provenance bar OR shows timeout-rate regression, revert
`SHADOW_BAKEOFF_ROLES`.

## What shadow does NOT do

- Does NOT post verdicts. Ever.
- Does NOT mutate KV / Queue / DO state.
- Does NOT replace the prod model on its own — that's a separate PR
  after shadow data signs off.
- Does NOT fine-tune. ARC-292 explicitly defers fine-tuning until
  20-50 customers or 1000 labeled outcomes.

## Safety net

Shadow code paths are wrapped in defensive try/catch so a shadow
crash CANNOT take down the prod return. If you see
`shadow-synth-emit-error` events, file the failure but assume prod
is fine — the customer review still posted.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ops/shadow-bakeoff.md
git commit -m "docs(arc-283): operator guide for shadow-mode bake-off harness"
```

---

## Task 7: Final integration verification

- [ ] **Step 1: Full test suite green**

Run: `npx vitest run`
Expected: all tests pass (2203 + new), zero failures.

- [ ] **Step 2: Build clean**

Run: `npm run build`
Expected: tsc clean, vitest clean, wrangler dry-deploy clean (if part of build script).

- [ ] **Step 3: Verify NO production behavior change with `SHADOW_BAKEOFF_ROLES=""`**

Add (or confirm existing) end-to-end test in the orchestrator test file:
```typescript
it("ARC-283 B1b: with shadow off, behavior is byte-identical to pre-PR", async () => {
  // Snapshot the event log + return value against a baseline fixture.
  // The shadow code paths must add ZERO events when env is empty.
})
```

- [ ] **Step 4: Dispatch code-reviewer agent on the diff**

Spawn the `code-reviewer` agent with the full diff. Address findings before opening the PR.

- [ ] **Step 5: Dispatch Codex sign-off (per CLAUDE.md backend dual-signoff rule)**

Write a Codex handoff at `.claude/handoff/arc-283-b1b-codex-signoff.md` containing the scope summary + commit list. Invoke Codex non-interactively. Address blocking concerns.

- [ ] **Step 6: CodeRabbit phase-end review**

Run: `coderabbit review --plain --base $(git merge-base origin/main HEAD) HEAD`
Address actionable findings; reply-explain skips.

- [ ] **Step 7: Open PR**

```bash
gh pr create --title "feat(arc-283): shadow-mode model bake-off harness (Phase B1b)" --body "$(cat <<'EOF'
## Summary
- Adds zero-prod-impact shadow runner for the per-role candidate lineup from ARC-292.
- Wires `model-attempt-completed` for the prod path (scaffolded in B0, never connected).
- Emits `shadow-model-attempt-completed` + `shadow-verdict-comparison` events when `SHADOW_BAKEOFF_ROLES` is set; otherwise byte-identical to pre-PR behavior.
- Operator doc at `docs/ops/shadow-bakeoff.md`.

## Test plan
- [ ] vitest green on touched files + full suite
- [ ] manual: deploy to staging with `SHADOW_BAKEOFF_ROLES=synth`, run on one test PR, grep `shadow-verdict-comparison` in CF Logs
- [ ] verify prod review still posts when shadow synth fails (rig with bad model name)

Closes ARC-283 B1b.
EOF
)"
```

---

## Self-Review (post-write)

**Spec coverage:**
- Per-role candidate lineup: ✓ Task 1 (`SHADOW_BAKEOFF_LINEUP`)
- Env-gated enablement: ✓ Task 1 + Task 5
- Shadow runs use same retry/fallback policy: ✓ Task 3 (delegates to `runWithRetryAndFallback`)
- Cross-provider invariant enforced at module load: ✓ Task 1 test
- Per-attempt telemetry: ✓ Task 4 (`onAttempt`) + Task 2 (`emitShadowAttempt`)
- Per-run comparison telemetry: ✓ Task 2 + Task 5
- Findings overlap on (path, line, category): ✓ Task 2 (`computeFindingsOverlap`)
- Score histograms: ✓ Task 2
- Defensive: shadow crash cannot affect prod: ✓ Task 5 (try/catch wrappers)
- Operator doc: ✓ Task 6
- Wires the long-scaffolded `model-attempt-completed` prod event: ✓ Task 4 Step 6

**Placeholder scan:**
- All code blocks contain real code. The "fill in from existing fixture" pointers in Task 5 Step 1 are unavoidable — orchestrator integration tests in this repo all reuse a shared `Env` builder; the test file MUST pick that up rather than re-inventing 80 lines of fixture.
- Variable names like `synthOutcome` in Task 5 Step 5 are gated behind "confirmed by reading line 1379-1424" — that's a real read-before-write instruction, not a TODO.

**Type consistency:**
- `ModelConfig` is imported from `triage-pr-review-ensemble.ts` consistently in shadow-bakeoff-config.ts, shadow-bakeoff-runner.ts.
- `EnsembleRunCtx` from `ensemble-perf-telemetry.ts` is the correlation type in all new telemetry.
- `FindingForOverlap` is defined once in `shadow-bakeoff-telemetry.ts` and re-exported wherever needed.
- `AttemptCallbackInfo` is the single shape the `onAttempt` callback receives. Same fields in Task 4 (definition), Task 3 (runner consumes), Task 4 Step 6 (prod consumes).
- `ShadowAttemptKind` and `ModelAttemptKind` are deliberately separate types (different events) but use identical string unions — that's a copy with intent.

**Risk register:**
- The `ModelConfig` export from `triage-pr-review-ensemble.ts` is currently a non-exported interface (line 380). Task 1 / Task 3 / Task 4 ALL require it to be `export interface ModelConfig { ... }`. Add `export` as part of Task 1's edit (small enough to fold in).
- `parseSynthAnswer` and `parsePrReviewResponse` must also be exported from `triage-pr-review-ensemble.ts` for the shadow runner to use them. Verify in Task 3 Step 3 and export if not already.
- The `chat` import path used in `vi.mock` is critical — Task 3 Step 3 includes a `grep` to confirm. If `chat` is co-located in `triage-pr-review-ensemble.ts` rather than its own module, the mock target changes accordingly.
