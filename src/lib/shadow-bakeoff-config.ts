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
