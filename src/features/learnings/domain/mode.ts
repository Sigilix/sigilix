import type { Env } from "@/src/shared/types/env"
import type { LearningsMode } from "./types"

export function resolveLearningsMode(raw: string | undefined): LearningsMode {
  switch (raw) {
    case "shadow":
      return "shadow"
    case "on":
      return "on"
    default:
      return "off"
  }
}

/**
 * The Memory Gardener's activity-aware decay rollout mode (Phase-1).
 *
 * Three-state, off-by-default (mirrors `resolveQuotaMode`'s off/shadow/enforce
 * shape but with `"off"` as the fallthrough — matching `resolveLearningsMode`):
 *   - `"off"`     — (default / unset / anything else) the decay pass is fully
 *                   inert: no KV read, no GitHub call, no telemetry.
 *   - `"shadow"`  — the pass scans + resolves PR closure + logs each would-reap
 *                   memory, but archives NOTHING (bake the eligibility signal).
 *   - `"enforce"` — the pass ALSO tombstones each eligible ephemeral memory
 *                   (archive-then-remove; never a hard delete).
 *
 * Pure: the only import is the `Env` TYPE (type-only, zero runtime cost).
 */
export type MemoryDecayMode = "off" | "shadow" | "enforce"

export function resolveMemoryDecayMode(env: Pick<Env, "OPENCLAW_MEMORY_DECAY_MODE">): MemoryDecayMode {
  const v = env.OPENCLAW_MEMORY_DECAY_MODE?.trim().toLowerCase()
  if (v === "enforce") return "enforce"
  if (v === "shadow") return "shadow"
  return "off"
}

/**
 * Seat∪Org memory layering — Phase 1 (write side only) rollout gate.
 *
 * Two-state, off-by-default (mirrors resolveMemoryDecayMode's
 * trim+lowercase parsing, but there is no "shadow" state here — the org
 * mirror write is itself already the shadow-safe step, since nothing reads
 * `learnings:org:*` yet):
 *   - `"off"` — (default / unset / anything else) the org-scope mirror write
 *               never runs: no installation-id resolution, no KV write.
 *   - `"on"`  — every repo-scope learning capture is ALSO mirrored into
 *               `learnings:org:<installationId>`.
 *
 * Pure: the only import is the `Env` TYPE (type-only, zero runtime cost).
 */
export type OrgMemoryCaptureMode = "off" | "on"

export function resolveOrgMemoryCaptureMode(env: Pick<Env, "OPENCLAW_ORG_MEMORY_CAPTURE">): OrgMemoryCaptureMode {
  const v = env.OPENCLAW_ORG_MEMORY_CAPTURE?.trim().toLowerCase()
  return v === "on" ? "on" : "off"
}
