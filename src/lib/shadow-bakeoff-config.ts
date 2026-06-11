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

const SHADOW_ROLES: ReadonlySet<ShadowRole> = new Set(["logic", "security", "performance", "tests", "synth"])

/**
 * Candidate per-role ModelConfig to bake off vs. production.
 *
 * Codex's bake-off priority order (drives which roles are enabled
 * first via `SHADOW_BAKEOFF_ROLES` env in prod):
 *   1. logic     — current wall-time floor; test the V4-Flash tradeoff.
 *   2. synth     — remove Moonshot from the customer-visible critical path.
 *   3. tests + security — coder/agent models with distinct primaries.
 *   4. performance fallback — ARC-167 already defends prod primary.
 */
export const SHADOW_BAKEOFF_LINEUP: Record<ShadowRole, ModelConfig> = {
  // Logic: move from DeepSeek V4-Pro → V4-Flash to attack the current
  // 100-270s bottleneck. This is an explicit speed/quality bake-off:
  // V4-Flash keeps the 1M context window and V4-series reasoning stack
  // while cutting active parameters sharply.
  logic: {
    primary: "deepseek-v4-flash:cloud",
    retries: 1,
    fallback: "mistral-large-3:675b-cloud",
  },
  // Security: vulnerability patterns are mostly syntax/dataflow
  // recognition. Qwen3-Coder-Next is tuned for agentic coding workflows,
  // and using it here keeps security distinct from tests and logic.
  security: {
    primary: "qwen3-coder-next:cloud",
    retries: 1,
    fallback: "deepseek-v3.1:671b-cloud",
  },
  // Performance: keep glm-5.1 primary (defended by ARC-167: 100%
  // success, +18% findings depth). The bake-off only changes fallback.
  performance: {
    primary: "glm-5.1:cloud",
    retries: 1,
    fallback: "kimi-k2.5:cloud",
  },
  // Tests: use a different agentic-code model from security so the
  // ensemble no longer has two roles anchored to the same model ID.
  // MiniMax M3 (upgraded from M2.5, 2026-06-05) is fast enough to stay off
  // the critical path and has strong coding-agent evidence.
  tests: {
    primary: "minimax-m3:cloud",
    retries: 1,
    fallback: "qwen3-coder:480b-cloud",
  },
  // Synth: replace Kimi K2.6 with gpt-oss 120B so the final merge step
  // is medium-usage, open-weight, and separate from every specialist.
  // This keeps the customer-visible role off Moonshot capacity.
  synth: {
    primary: "gpt-oss:120b-cloud",
    retries: 1,
    fallback: "glm-4.6:cloud",
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
export function resolveShadowConfig(role: ShadowRole, enabled: ReadonlySet<ShadowRole>): ModelConfig | null {
  if (!enabled.has(role)) return null
  return SHADOW_BAKEOFF_LINEUP[role]
}
