// Memory Gardener consolidation prompt + parser (Gardener P2).
//
// Pure domain logic mirroring `./extractor.ts`: build the single-shot prompt the
// Gardener LLM answers to collapse a cleared cluster of near-duplicate rules into
// ONE canonical rule, and strictly parse its JSON back. NO env, NO IO, NO clock,
// NO network. The caller (adapter) owns the model call; this file owns the
// contract.

import { FINDING_CATEGORIES, type FindingCategory } from "@/src/shared/domain/finding-category"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import { normalizeRule } from "./store-ops"
import type { LearningPolarity } from "./types"

export interface ConsolidationInput {
  /** Content-addressed learning id — echoed to the model so `mergedIds` is meaningful. */
  id: string
  rule: string
  polarity: LearningPolarity
  category?: FindingCategory | null
  pathGlob?: string | null
  /** ISO-8601 create time — the prompt surfaces recency so the model can prefer it. */
  createdTs: string
  appliedCount: number
}

export interface ParsedConsolidation {
  canonicalRule: string
  polarity: LearningPolarity
  category: FindingCategory | null
  pathGlob: string | null
  /** Model self-rated 0..1 confidence that the canonical faithfully subsumes ALL inputs. */
  confidence: number
  /** The input ids the model believes it merged. ADVISORY — the enforce path
   *  archives the cluster it actually enqueued, never blindly trusting this. */
  mergedIds: string[]
}

/**
 * Build the Gardener consolidation prompt for one cleared cluster. `cluster` is
 * ordered most-preferred-first (see `resolveClusterConflict`), so the model reads
 * the most-recent + most-applied rule at the top. The polarity is guaranteed
 * conflict-free by the caller (no suppress+require mix reaches here).
 */
export function buildConsolidationPrompt(cluster: ReadonlyArray<ConsolidationInput>): { system: string; user: string } {
  const system = [
    "You are the Memory Gardener. You are given N near-duplicate repo-review rules that all belong to ONE repo or org.",
    "Write ONE canonical rule that SUBSUMES every input rule without losing any of their meaning.",
    "",
    "Hard requirements:",
    "- PRESERVE polarity: do NOT turn a require into a suppress or vice-versa. Use the polarity the inputs share.",
    "- PRESERVE category and pathGlob: keep the most specific value the inputs agree on; use null only when they genuinely have none.",
    "- On any conflict between inputs, PREFER the most-recent and most-applied rule (the inputs are listed most-preferred first).",
    "- The canonical rule is a single normalized imperative sentence — not a list, not the raw inputs concatenated.",
    "- Redact any secret or personal data.",
    "- If the inputs do NOT actually say the same thing, set a LOW confidence rather than forcing a merge.",
    "",
    'Output STRICT JSON only: {"canonicalRule":string,"polarity":("suppress"|"require"|"context"),"category":string|null,"pathGlob":string|null,"confidence":number,"mergedIds":string[]}.',
    "confidence is your 0..1 belief that the canonical faithfully captures ALL inputs. mergedIds echoes the input ids you merged.",
    `Allowed categories: ${[...FINDING_CATEGORIES].join(", ")}.`,
  ].join("\n")

  const user = ["Near-duplicate rules to consolidate (most-preferred first):", "", ...cluster.map(formatMember)].join(
    "\n",
  )

  return { system, user }
}

function formatMember(member: ConsolidationInput, index: number): string {
  const parts = [
    `${index + 1}. id=${member.id}`,
    `   rule: ${member.rule}`,
    `   polarity: ${member.polarity}`,
    `   category: ${member.category ?? "null"}`,
    `   pathGlob: ${member.pathGlob ?? "null"}`,
    `   createdTs: ${member.createdTs}`,
    `   appliedCount: ${member.appliedCount}`,
  ]
  return parts.join("\n")
}

/**
 * Strictly parse the Gardener's JSON. Returns null (caller keeps the originals)
 * on any shape violation: missing/blank canonical rule, an unknown polarity, a
 * non-number confidence, etc. Mirrors `parseExtraction`'s conservatism —
 * "prefer a miss over a bad merge".
 */
export function parseConsolidation(raw: string): ParsedConsolidation | null {
  const parsed = parseFirstJsonObject(raw)
  if (parsed === null) return null

  const rawRule = parsed.canonicalRule
  if (typeof rawRule !== "string") return null
  const canonicalRule = normalizeRule(rawRule)
  if (!canonicalRule) return null

  const polarity = parsePolarity(parsed.polarity)
  if (polarity === null) return null

  const category = parseCategory(parsed.category)
  if (category === undefined) return null

  const pathGlob = parseOptionalString(parsed.pathGlob)
  if (pathGlob === undefined) return null

  const confidence = parseConfidence(parsed.confidence)
  if (confidence === null) return null

  const mergedIds = parseIdList(parsed.mergedIds)

  return { canonicalRule, polarity, category, pathGlob, confidence, mergedIds }
}

function parsePolarity(value: unknown): LearningPolarity | null {
  return value === "suppress" || value === "require" || value === "context" ? value : null
}

function parseCategory(value: unknown): FindingCategory | null | undefined {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string") return undefined
  return (FINDING_CATEGORIES as ReadonlySet<string>).has(value) ? (value as FindingCategory) : undefined
}

function parseOptionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  // Clamp into [0,1] rather than reject an out-of-range self-rating.
  return Math.min(1, Math.max(0, value))
}

function parseIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string" && v.length > 0)
}
