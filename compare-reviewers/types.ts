// SIG-70/SIG-326 — head-to-head reviewer measurement framework.
//
// Shared shapes + the controlled vocabularies the reviewer labels into.
// Everything here is pure data; no IO. The CLI (`cli.ts`) and the gh
// fetch layer (`github.ts`) are the only modules that touch the network
// or the filesystem — the labeling logic, worksheet parsing, and the
// summary tally are all pure functions over these types, unit-tested in
// `tests/compare-reviewers.test.ts`.

/** Tools we compare. GitHub login mapping lives in normalize.ts. */
export const TOOLS = ["sigilix", "coderabbit", "greptile"] as const
export type Tool = (typeof TOOLS)[number]

/**
 * A ground-truth outcome for one real-world issue. Tool participation is
 * inferred from the refs in `LabeledItem.findings`, which scales past two bots
 * without combinatorial labels.
 */
export const OUTCOMES = ["real_bug", "noise"] as const
export type Outcome = (typeof OUTCOMES)[number]

/** Topic each labeled issue is tagged with (independent of the six labels). */
export const CATEGORIES = ["security", "perf", "logic", "tests", "style"] as const
export type Category = (typeof CATEGORIES)[number]

export function isOutcome(s: string): s is Outcome {
  return (OUTCOMES as readonly string[]).includes(s)
}
export function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s)
}

export function toolDisplayName(tool: Tool): string {
  switch (tool) {
    case "sigilix": return "Sigilix"
    case "coderabbit": return "CodeRabbit"
    case "greptile": return "Greptile"
  }
}

/**
 * One bot finding, normalized from a GitHub review comment. `ref` is the
 * short handle the reviewer uses in the worksheet (`s1`, `s2`, … for Sigilix;
 * `c1`, `c2`, … for CodeRabbit). Findings are sorted by `commentId` before
 * refs are assigned, so the same PR collected twice yields the same refs.
 */
export interface NormalizedFinding {
  ref: string
  tool: Tool
  /** GitHub review-comment id — stable across re-collection. */
  commentId: number
  /** File path the comment is anchored to (null for file-level / PR-level). */
  path: string | null
  /** Line the comment is anchored to (null when GitHub reports none). */
  line: number | null
  /** First meaningful line of the comment body, markup-stripped + capped. */
  excerpt: string
  /** Permalink to the comment. */
  url: string
  /** Tool self-reported category when parseable; most tools have none. */
  botCategory?: string
}

/** One labeled real-world issue — the reviewer's verdict, parsed from the worksheet. */
export interface LabeledItem {
  /** 1-based row number from the worksheet (display only). */
  id: number
  /**
   * The finding refs this issue groups (e.g. `["s1","c3","g1"]`).
   * Empty means a labeled real bug no tool caught.
   */
  findings: string[]
  outcome: Outcome
  category: Category
  note: string
}

/** The persisted per-PR comparison record (`data/{owner}-{repo}-{pr}.json`). */
export interface ComparisonFile {
  schemaVersion: 2
  owner: string
  repo: string
  pr: number
  prUrl: string
  /** ISO timestamp of the collect run that last refreshed `findings`. */
  collectedAt: string
  findings: {
    sigilix: NormalizedFinding[]
    coderabbit: NormalizedFinding[]
    greptile: NormalizedFinding[]
  }
  /** Reviewer labels; empty until `label` parses a filled worksheet. */
  items: LabeledItem[]
}
