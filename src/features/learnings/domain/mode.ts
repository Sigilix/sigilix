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
 * The Memory Gardener's memory-CONSOLIDATION rollout mode (Gardener P2).
 *
 * Three-state, off-by-default — the exact off/shadow/enforce shape of
 * `resolveMemoryDecayMode`:
 *   - `"off"`     — (default / unset / anything else) the consolidation pass is
 *                   fully inert: no KV scan, no embed, no LLM call, no telemetry.
 *   - `"shadow"`  — the pass scans + embeds + clusters each store and enqueues a
 *                   Gardener consolidation for every qualifying cluster; the
 *                   consumer RUNS the LLM + logs + writes the digest but writes
 *                   NO canonical rule and archives NOTHING (bake the signal).
 *   - `"enforce"` — the consumer ALSO appends the canonical rule and tombstones
 *                   its merged inputs (archive-then-remove; never a hard delete).
 *
 * Pure: the only import is the `Env` TYPE (type-only, zero runtime cost).
 */
export type MemoryConsolidateMode = "off" | "shadow" | "enforce"

export function resolveMemoryConsolidateMode(env: Pick<Env, "OPENCLAW_MEMORY_CONSOLIDATE">): MemoryConsolidateMode {
  const v = env.OPENCLAW_MEMORY_CONSOLIDATE?.trim().toLowerCase()
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

/**
 * Seat∪Org memory layering — Phase 2 (apply/read side) rollout gate.
 *
 * Three-state, off-by-default (mirrors resolveMemoryDecayMode's trim+lowercase
 * parsing, but with the `"on"` enforcement state named to match
 * `resolveLearningsMode`'s off/shadow/on shape — this is the READ side of the
 * same review pipeline the learnings mode gates, not the capture/write side
 * gated by resolveOrgMemoryCaptureMode):
 *   - `"off"`    — (default / unset / anything else) review reads repo-scope
 *                  learnings ONLY, byte-identical to pre-slice-2: no
 *                  installation-id resolution, no `learnings:org:*` KV read.
 *   - `"shadow"` — review ALSO loads the org-scope corpus + resolves the
 *                  installation and LOGS the delta (which org learnings WOULD
 *                  widen the applied set), but the applied set stays repo-only
 *                  (bake the signal, output byte-unchanged).
 *   - `"on"`     — the applied set is repo ∪ org (deduped by id; a repo copy
 *                  wins a collision), so an org-scope learning can shape the
 *                  review for any repo under the installation.
 *
 * Pure: the only import is the `Env` TYPE (type-only, zero runtime cost).
 */
export type OrgMemoryApplyMode = "off" | "shadow" | "on"

export function resolveOrgMemoryApplyMode(env: Pick<Env, "OPENCLAW_ORG_MEMORY_APPLY">): OrgMemoryApplyMode {
  const v = env.OPENCLAW_ORG_MEMORY_APPLY?.trim().toLowerCase()
  if (v === "on") return "on"
  if (v === "shadow") return "shadow"
  return "off"
}

/**
 * Seat∪Org memory layering — Phase 3 (CLI read side) rollout gate.
 *
 * Three-state, off-by-default (mirrors resolveOrgMemoryApplyMode's off/shadow/on
 * shape — this is the CLI's OWN read side, POST /v1/memory/query, a different
 * call site from the PR-review apply gate above, so it gets its own
 * independent flag):
 *   - `"off"`    — (default / unset / any other value) the CLI's memory-query
 *                  response is seat-memory ONLY, byte-identical to before this
 *                  slice: no installation check, no `learnings:org:*` KV read.
 *   - `"shadow"` — ALSO loads the caller-installation's org-scope corpus and
 *                  LOGS what it would add, but the returned results stay
 *                  seat-only (bake the signal, output byte-unchanged).
 *   - `"on"`     — the returned results are seat ∪ org, deduped by id (a seat
 *                  memory wins any id collision) — a developer's fresh CLI
 *                  session inherits everything the team's PR reviews taught
 *                  the org.
 *
 * Pure: the only import is the `Env` TYPE (type-only, zero runtime cost).
 */
export type CliOrgMemoryMode = "off" | "shadow" | "on"

export function resolveCliOrgMemoryMode(env: Pick<Env, "OPENCLAW_CLI_ORG_MEMORY">): CliOrgMemoryMode {
  const v = env.OPENCLAW_CLI_ORG_MEMORY?.trim().toLowerCase()
  if (v === "on") return "on"
  if (v === "shadow") return "shadow"
  return "off"
}

/**
 * Surface memory apply — Slack + Linear ANSWER read side rollout gate.
 *
 * Two-state, off-by-default (the two-state off/on shape of
 * `resolveOrgMemoryCaptureMode`, NOT the three-state apply gates — a surface
 * answer either injects the org∪repo learnings or it does not; there is no
 * shadow "bake the signal" state to log for a chat answer). A DIFFERENT call
 * site from the PR-review apply gate (`resolveOrgMemoryApplyMode`) and the CLI
 * read gate (`resolveCliOrgMemoryMode`), so it gets its own independent flag:
 *   - `"off"` — (default / unset / any other value) the Slack Q&A and Linear
 *               mention-reply answer prompts are byte-identical to before this
 *               slice: no `learnings:org:*` / `learnings:repo:*` read, no
 *               prompt injection.
 *   - `"on"`  — the answer prompt carries the repo ∪ org learnings (deduped by
 *               id, a repo copy winning a collision) with ORG guardrails labeled
 *               higher-precedence than repo facts. SEAT/personal memory is never
 *               applied here — shared channels read org + repo scope only.
 *
 * Pure: the only import is the `Env` TYPE (type-only, zero runtime cost).
 */
export type SurfaceMemoryApplyMode = "off" | "on"

export function resolveSurfaceMemoryApplyMode(env: Pick<Env, "OPENCLAW_SURFACE_MEMORY_APPLY">): SurfaceMemoryApplyMode {
  const v = env.OPENCLAW_SURFACE_MEMORY_APPLY?.trim().toLowerCase()
  return v === "on" ? "on" : "off"
}

/**
 * PR-review memory PROVENANCE ("show your work") — display-only overview note.
 *
 * Two-state, off-by-default (the two-state off/on shape of
 * `resolveSurfaceMemoryApplyMode` — a review either shows the provenance note or it
 * does not; there is no shadow "bake the signal" state for a purely display-only
 * note). Reads the SIGILIX_MEMORY_PROVENANCE var (SIGILIX_-first; the OPENCLAW_
 * fallback is auto-covered by `normalizeEnv`, so the reader reads the OPENCLAW_
 * sibling that the shim mirrors):
 *   - `"off"` — (default / unset / any other value) the review overview is
 *               byte-identical to before — no provenance note is rendered.
 *   - `"on"`  — the overview carries a compact, display-only note listing which
 *               repo/org learnings actually informed the review. NEVER gates,
 *               suppresses, reorders, or downgrades any finding; a suppress-polarity
 *               rule's text is never surfaced.
 *
 * Pure: the only import is the `Env` TYPE (type-only, zero runtime cost).
 */
export type MemoryProvenanceMode = "off" | "on"

export function resolveMemoryProvenanceMode(env: Pick<Env, "OPENCLAW_MEMORY_PROVENANCE">): MemoryProvenanceMode {
  const v = env.OPENCLAW_MEMORY_PROVENANCE?.trim().toLowerCase()
  return v === "on" ? "on" : "off"
}
