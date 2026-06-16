import { FINDING_CATEGORIES, type FindingCategory } from "@/src/shared/domain/finding-category"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import { normalizeRule } from "./store-ops"
import type { LearningPolarity } from "./types"

export type ExtractionSurface = "inline-reply" | "top-level" | "qa"

export type ExtractedLearning = {
  rule: string
  polarity: LearningPolarity
  category?: FindingCategory | null
  pathGlob?: string | null
}

export function buildExtractionPrompt(args: {
  surface: ExtractionSurface
  replyText: string
  findingContext?: string
  changedPaths?: string[]
}): { system: string; user: string } {
  const system = [
    "Given this developer message, is there a DURABLE, GENERALIZABLE repo-review preference worth remembering for future reviews?",
    'Output STRICT JSON only: {"remember":boolean,"rule"?:string,"polarity"?:("suppress"|"require"|"context"),"category"?:string|null,"pathGlob"?:string|null}.',
    "",
    `Surface: ${args.surface}.`,
    surfacePolicy(args.surface),
    "",
    "Conservative anti-pollution rules:",
    "- Prefer a miss over a bad learning. Set remember=false for low confidence.",
    '- Reject pure acknowledgements such as "thanks", "fixed", "done", "looks good", or "lgtm".',
    '- Reject pure questions even if they contain "always" or "never".',
    "- Reject one-off explanations that do not generalize to future reviews.",
    "- Store a single normalized imperative rule, not the raw reply.",
    "- Redact secrets and personal data from the rule.",
    "- A repo-wide suppress rule needs explicit blanket language such as repo-wide, across the repository, or in every review.",
    "- Without explicit blanket suppress language, scope suppress rules to the relevant pathGlob or category.",
    `Allowed categories: ${[...FINDING_CATEGORIES].join(", ")}.`,
  ].join("\n")

  const user = [
    `Surface: ${args.surface}`,
    "",
    "Developer message:",
    args.replyText,
    "",
    args.findingContext ? `Finding context:\n${args.findingContext}` : "Finding context: none provided",
    "",
    formatChangedPaths(args.changedPaths),
  ].join("\n")

  return { system, user }
}

export function parseExtraction(raw: string): ExtractedLearning | null {
  const parsed = parseFirstJsonObject(raw)
  if (parsed === null) return null
  if (parsed.remember !== true) return null

  const rawRule = parsed.rule
  if (typeof rawRule !== "string") return null
  const rule = normalizeRule(rawRule)
  if (!rule) return null
  if (isAck(rule) || isPureQuestion(rule)) return null

  const polarity = parsePolarity(parsed.polarity, rule)
  if (polarity === null) return null

  const category = parseCategory(parsed.category)
  if (category === undefined) return null
  const pathGlob = parseOptionalString(parsed.pathGlob)
  if (pathGlob === undefined) return null

  if (polarity === "suppress" && category === null && pathGlob === null && !hasExplicitBlanketScope(rule)) {
    return null
  }

  return {
    rule,
    polarity,
    category,
    pathGlob,
  }
}

function surfacePolicy(surface: ExtractionSurface): string {
  switch (surface) {
    case "inline-reply":
      return "Policy: this is reacting to a specific Sigilix finding, so proactively extract a learning when the message teaches a durable preference."
    case "top-level":
      return "Policy: this references a Sigilix finding, so proactively extract a learning when the message teaches a durable preference."
    case "qa":
      return 'Policy: ONLY remember when the user explicitly signals learning intent with words like "remember", "always", "never", or "going forward".'
  }
}

function formatChangedPaths(changedPaths: string[] | undefined): string {
  if (!changedPaths || changedPaths.length === 0) return "Changed paths: none provided"
  return ["Changed paths:", ...changedPaths.map((path) => `- ${path}`)].join("\n")
}

function parsePolarity(value: unknown, rule: string): LearningPolarity | null {
  if (value === undefined || value === null || value === "") return inferPolarity(rule)
  if (value === "suppress" || value === "require" || value === "context") return value
  return null
}

function inferPolarity(rule: string): LearningPolarity {
  const lower = rule.toLowerCase()
  if (
    /\b(?:do not|don't|stop)\s+(?:flag|report|warn|comment)\b/.test(lower) ||
    /\b(?:suppress|ignore|false positive|noise finding|review noise)\b/.test(lower)
  ) {
    return "suppress"
  }
  if (
    /^(?:always|must|require|prefer|flag|enforce)\b/.test(lower) ||
    /\b(?:must|should always|always|never use|never allow)\b/.test(lower)
  ) {
    return "require"
  }
  return "context"
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

function isAck(rule: string): boolean {
  const compact = rule
    .toLowerCase()
    .replace(/[.!?,:;]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return ACK_PHRASES.has(compact)
}

function isPureQuestion(rule: string): boolean {
  const trimmed = rule.trim()
  if (trimmed.includes("?")) return true
  return /^(?:should|can|could|would|does|did|is|are|was|were|why|how|what|when|where|who)\b/i.test(trimmed)
}

function hasExplicitBlanketScope(rule: string): boolean {
  return /\b(?:repo[- ]wide|repository[- ]wide|across the repo|across the repository|across the codebase|entire repo|entire repository|entire codebase|for all files|for all paths|for all reviews|in every review|in this repo)\b/i.test(
    rule,
  )
}

const ACK_PHRASES: ReadonlySet<string> = new Set([
  "thanks",
  "thank you",
  "thanks fixed",
  "thank you fixed",
  "fixed",
  "done",
  "resolved",
  "addressed",
  "looks good",
  "sounds good",
  "lgtm",
  "ok",
  "okay",
  "got it",
  "makes sense",
])
