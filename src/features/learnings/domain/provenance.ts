// PR-review memory provenance — "show your work" (v1).
//
// Apply-everywhere memory silently shapes a PR review with repo ∪ org learnings.
// This module makes that VISIBLE: it turns the set of learnings ACTUALLY injected
// into the review prompt into a compact, display-only provenance note rendered in
// the review overview.
//
// RECALL-SAFETY (paramount): this is DISPLAY-ONLY. It never gates, suppresses,
// reorders, or downgrades a finding — the review's verdict is computed exactly as
// before. A `suppress`-polarity learning is COUNTED in the aggregate but its rule
// text is NEVER surfaced (surfacing it would reveal a silenced finding), so only
// `context` / `require` entries appear in the visible list.
//
// Pure module: no IO, no async, no env reads except the flag resolver (which reads
// the Env TYPE only, type-only import). Gated behind SIGILIX_MEMORY_PROVENANCE
// (default off, OPENCLAW_ fallback auto-covered by normalizeEnv): off →
// `resolveAppliedMemoryProvenance` returns undefined → nothing threads to the
// renderer → byte-identical review output (ships dark).

import type { Env } from "@/src/shared/types/env"
import { resolveMemoryProvenanceMode } from "./mode"
import type { LearningEntry, LearningScope } from "./types"

/** Cap a single rule's rendered length so a verbose learning stays scannable. */
const MAX_LABEL_CHARS = 100

/** One applied learning, reduced to the display-safe fields (no suppress text). */
export interface MemoryProvenanceItem {
  id: string
  /**
   * A short human label derived from the rule text (truncated). RAW (unescaped) —
   * escape at the render boundary (see `renderMemoryProvenance`) before embedding
   * it in markdown/HTML.
   */
  label: string
  scope: LearningScope
  /** The path glob the learning is scoped to, if any. RAW — escape at render. */
  pathGlob?: string
}

/**
 * The compact provenance summary for one review: the visible (non-suppress) applied
 * learnings plus aggregate counts. `total` counts the FULL applied set; `orgCount` /
 * `repoCount` count only the VISIBLE (non-suppress) entries so the summary
 * parenthetical matches the shown list, and `suppressCount` carries the rest — so
 * `total === orgCount + repoCount + suppressCount` for the repo∪org scopes this
 * PR-review path can apply. `suppressCount` lets the note say HOW MANY
 * noise-reduction rules applied without ever exposing their text.
 */
export interface MemoryProvenance {
  items: MemoryProvenanceItem[]
  total: number
  orgCount: number
  repoCount: number
  suppressCount: number
}

/**
 * Reduce the applied learnings into a display-safe provenance summary. Returns null
 * for an empty set (→ no note). Suppress-polarity entries are counted but their rule
 * text is excluded from `items` — recall-safety.
 */
export function buildMemoryProvenance(entries: ReadonlyArray<LearningEntry>): MemoryProvenance | null {
  if (entries.length === 0) return null
  let orgCount = 0
  let repoCount = 0
  let suppressCount = 0
  const items: MemoryProvenanceItem[] = []
  for (const entry of entries) {
    // NEVER surface a suppress rule's text — it could reveal a silenced finding.
    // Count it in the aggregate ONLY, and keep it out of the visible list AND the
    // per-scope counts (so the summary never claims a guardrail it doesn't show).
    if (entry.polarity === "suppress") {
      suppressCount++
      continue
    }
    if (entry.scope === "org") orgCount++
    else if (entry.scope === "repo") repoCount++
    const glob = entry.pathGlob?.trim()
    items.push({
      id: entry.id,
      label: truncateLabel(entry.rule),
      scope: entry.scope,
      ...(glob ? { pathGlob: glob } : {}),
    })
  }
  return { items, total: entries.length, orgCount, repoCount, suppressCount }
}

/**
 * Flag-gated capture used at the prompt-injection point. Returns the provenance for
 * the injected set ONLY when SIGILIX_MEMORY_PROVENANCE is "on"; otherwise undefined,
 * so nothing threads downstream and the review output stays byte-identical.
 */
export function resolveAppliedMemoryProvenance(
  env: Pick<Env, "OPENCLAW_MEMORY_PROVENANCE">,
  entries: ReadonlyArray<LearningEntry>,
): MemoryProvenance | undefined {
  if (resolveMemoryProvenanceMode(env) !== "on") return undefined
  return buildMemoryProvenance(entries) ?? undefined
}

/**
 * Render the provenance as a compact, collapsible overview footer — mirroring the
 * `renderOverviewFooter` "Memory · …" vocabulary. The summary line is always visible;
 * the applied rules sit inside a `<details>` so the note stays tight. Returns null
 * when nothing applied (→ the caller renders no section). Pure.
 */
export function renderMemoryProvenance(prov: MemoryProvenance): string | null {
  if (prov.total === 0) return null
  const summary = `Grounded on ${prov.total} ${plural(prov.total, "memory", "memories")} (${prov.orgCount} org ${plural(
    prov.orgCount,
    "guardrail",
  )}, ${prov.repoCount} repo ${plural(prov.repoCount, "fact")})`
  const lines = [`<sub>·</sub> <details><summary><b>Memory</b> · ${summary}</summary>`, ""]
  for (const item of prov.items) {
    const glob = item.pathGlob ? ` \`${escapeInline(item.pathGlob)}\`` : ""
    lines.push(`- [${item.scope}]${glob} ${escapeInline(item.label)}`)
  }
  if (prov.suppressCount > 0) {
    lines.push(
      `- <sub>${prov.suppressCount} noise-reduction ${plural(prov.suppressCount, "rule")} applied as context (text not shown).</sub>`,
    )
  }
  lines.push("</details>")
  return lines.join("\n")
}

function truncateLabel(rule: string): string {
  const oneLine = rule.replace(/\s+/g, " ").trim()
  if (oneLine.length <= MAX_LABEL_CHARS) return oneLine
  return `${oneLine.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`
}

/**
 * Escape a persisted, user/LLM-derived string before embedding it in the markdown
 * container so a crafted rule can't break out or inject HTML (matches the escaping
 * `render.ts` applies to the same learning text).
 */
function escapeInline(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}
