// SIG-397 — frozen recall-regression fixture shapes.
//
// A fixture freezes one benchmark PR: its ground-truth bug rows + traps
// (each with an encoded equivalence rule) and per-tool snapshots of the
// actually-posted findings. The scorer (`scorer.ts`) is a pure function
// over these types; `cli.ts` owns all IO. Denominators (total rows, P0/P1
// subset, tier subsets) are ALWAYS derived from the loaded ground truth —
// never hardcoded — so the JSON is the single source of truth.

import type { Category, Tool } from "./types"

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const
export type Severity = (typeof SEVERITIES)[number]

export const TIERS = ["EASY", "MEDIUM", "UNGODLY", "LOW"] as const
export type Tier = (typeof TIERS)[number]

/**
 * One clause of an equivalence rule. A clause matches a finding when:
 *   - the finding's path is one of the row's `paths`, AND
 *   - every `allKeywords` entry hits the finding's match text
 *     (case-insensitive substring), AND
 *   - no `notKeywords` entry hits, AND
 *   - if `lineRanges` is present, the finding's line falls inside one of
 *     them (± `lineSlack`, default 5).
 *
 * `allKeywords` must be non-empty: line proximity alone is never enough —
 * the dense fixture stacks several bugs in the same handler, so every
 * clause needs a positive textual discriminator.
 */
export interface MatcherClause {
  allKeywords: string[]
  notKeywords?: string[]
  lineRanges?: Array<[number, number]>
  lineSlack?: number
  /**
   * When present, the finding's self-reported `botCategory` must be one of
   * these. Used by out-of-scope rules (e.g. Sigilix "testing" coverage
   * findings) where keywords alone are fragile — every Sigilix body contains
   * a "Why this wasn't caught" section that mentions tests.
   */
  botCategories?: string[]
  /**
   * What text the keywords run against. "excerpt" = the headline claim only;
   * "full" (default) = excerpt + body. Use "excerpt" for rows whose keywords
   * bleed into other findings' reasoning sections (bot bodies cross-reference
   * sibling bugs — e.g. the idempotency finding's body mentions the SQLi).
   */
  scope?: "excerpt" | "full"
}

/** A row matches when ANY clause matches. */
export interface EquivalenceRule {
  anyOf: MatcherClause[]
}

/** One ground-truth real bug ("group a finding here when the same fix addresses it"). */
export interface GroundTruthBug {
  id: string
  title: string
  paths: string[]
  tier: Tier
  category: Category
  severity: Severity
  match: EquivalenceRule
}

/** One trap: code that looks dangerous but is genuinely safe. */
export interface GroundTruthTrap {
  id: string
  title: string
  paths: string[]
  whySafe: string
  match: EquivalenceRule
}

/**
 * Findings that are TRUE observations but outside the bug table (e.g. the
 * dense fixture's "ships without tests" coverage findings, which the Jun-9
 * hand scoring neither credited as catches nor punished as noise). Matched
 * findings are excluded from both the precision numerator and denominator
 * and reported separately.
 */
export interface OutOfScopeRule {
  id: string
  title: string
  match: EquivalenceRule
}

export interface FixtureGroundTruth {
  schemaVersion: 1
  fixture: string
  owner: string
  repo: string
  pr: number
  headSha: string
  bugs: GroundTruthBug[]
  traps: GroundTruthTrap[]
  outOfScope: OutOfScopeRule[]
}

/**
 * A posted finding frozen into a fixture snapshot. Extends the worksheet's
 * `NormalizedFinding` with what matching needs: the full body text (the
 * 280-char excerpt is too short for keyword rules) and the parsed severity
 * (Sigilix's hidden `<!-- sigilix:severity:N -->` marker; null for tools
 * without a parseable severity).
 */
export interface FixtureFinding {
  ref: string
  tool: Tool
  commentId: number
  path: string | null
  line: number | null
  excerpt: string
  /** Full comment body with HTML comment markers stripped; keyword rules run against this. */
  bodyText: string
  severity: Severity | null
  url: string
  botCategory?: string
}

/** How one finding was classified by the scorer. */
export type FindingVerdict =
  | { kind: "bug"; id: string }
  | { kind: "trap"; id: string }
  | { kind: "out_of_scope"; id: string }
  | { kind: "unmatched" }

export interface ScoredFinding {
  ref: string
  path: string | null
  line: number | null
  excerpt: string
  severity: Severity | null
  verdict: FindingVerdict
}

/** Recall over a subset of bug rows: caught / total, with the row ids. */
export interface SubsetRecall {
  caught: number
  total: number
  /** caught / total, null when the subset is empty. */
  recall: number | null
  caughtIds: string[]
  missedIds: string[]
}

/** The scorer's full output for one tool against one fixture. */
export interface FixtureScore {
  fixture: string
  tool: Tool
  overall: SubsetRecall
  /** P0+P1 rows only — the trust-critical subset. */
  highSeverity: SubsetRecall
  byTier: Record<Tier, SubsetRecall>
  /**
   * real catches / (real catches + trap flags + unmatched). Out-of-scope
   * findings are excluded from both sides. Null when the denominator is 0.
   */
  precision: number | null
  precisionNumerator: number
  precisionDenominator: number
  /** Trap flags or unmatched findings asserted at P0/P1. The believability bar is 0. */
  highSevFalsePositives: ScoredFinding[]
  trapFlags: ScoredFinding[]
  unmatched: ScoredFinding[]
  outOfScope: ScoredFinding[]
  findings: ScoredFinding[]
}
