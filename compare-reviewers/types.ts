// SIG-70 — Sigilix vs CodeRabbit head-to-head measurement framework.
//
// Shared shapes + the controlled vocabularies the reviewer labels into.
// Everything here is pure data; no IO. The CLI (`cli.ts`) and the gh
// fetch layer (`github.ts`) are the only modules that touch the network
// or the filesystem — the labeling logic, worksheet parsing, and the
// summary tally are all pure functions over these types, unit-tested in
// `tests/compare-reviewers.test.ts`.

/** The two bots we compare. `coderabbit` ⇒ the `coderabbitai[bot]` login. */
export const BOTS = ["sigilix", "coderabbit"] as const
export type Bot = (typeof BOTS)[number]

/**
 * The six mutually-exclusive labels the reviewer assigns to each real-world
 * issue. The `{bot}_only_*` labels mean exactly one bot flagged the issue;
 * `both_*` means the issue appears in both bots' findings (the reviewer pairs
 * them in the worksheet). `*_real_bug` ⇒ a genuine issue worth a comment;
 * `*_noise` ⇒ a false positive / not worth flagging.
 */
export const LABELS = [
  "sigilix_only_real_bug",
  "sigilix_only_noise",
  "cr_only_real_bug",
  "cr_only_noise",
  "both_real",
  "both_noise",
] as const
export type Label = (typeof LABELS)[number]

/** Topic each labeled issue is tagged with (independent of the six labels). */
export const CATEGORIES = ["security", "perf", "logic", "tests", "style"] as const
export type Category = (typeof CATEGORIES)[number]

/** Labels that imply Sigilix flagged the issue. */
export const SIGILIX_LABELS: readonly Label[] = [
  "sigilix_only_real_bug",
  "sigilix_only_noise",
  "both_real",
  "both_noise",
]
/** Labels that imply CodeRabbit flagged the issue. */
export const CR_LABELS: readonly Label[] = [
  "cr_only_real_bug",
  "cr_only_noise",
  "both_real",
  "both_noise",
]
/** Labels that mean the flagged issue is a genuine bug. */
export const REAL_LABELS: readonly Label[] = [
  "sigilix_only_real_bug",
  "cr_only_real_bug",
  "both_real",
]

export function isLabel(s: string): s is Label {
  return (LABELS as readonly string[]).includes(s)
}
export function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s)
}

/**
 * One bot finding, normalized from a GitHub review comment. `ref` is the
 * short handle the reviewer uses in the worksheet (`s1`, `s2`, … for Sigilix;
 * `c1`, `c2`, … for CodeRabbit). Findings are sorted by `commentId` before
 * refs are assigned, so the same PR collected twice yields the same refs.
 */
export interface NormalizedFinding {
  ref: string
  bot: Bot
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
  /** Sigilix's self-reported category when parseable; CodeRabbit has none. */
  botCategory?: string
}

/** One labeled real-world issue — the reviewer's verdict, parsed from the worksheet. */
export interface LabeledItem {
  /** 1-based row number from the worksheet (display only). */
  id: number
  /** The finding refs this issue groups (e.g. `["s1","c3"]`). */
  findings: string[]
  label: Label
  category: Category
  note: string
}

/** The persisted per-PR comparison record (`data/{owner}-{repo}-{pr}.json`). */
export interface ComparisonFile {
  schemaVersion: 1
  owner: string
  repo: string
  pr: number
  prUrl: string
  /** ISO timestamp of the collect run that last refreshed `findings`. */
  collectedAt: string
  findings: {
    sigilix: NormalizedFinding[]
    coderabbit: NormalizedFinding[]
  }
  /** Reviewer labels; empty until `label` parses a filled worksheet. */
  items: LabeledItem[]
}
