// SIG-393 — region re-sweep: pure decision + prompt-shaping logic.
//
// The dense-PR saturation failure (a specialist finds the loudest bug per
// region and stops) is recovered by a SCOPED second pass over regions that
// already produced findings. Validated on the frozen dense fixture before
// this engine code existed: +2.75 rows/run mean at K=8, b12 (the refund
// TOCTOU race, 0/8 baseline) flipping to stable — see
// docs/superpowers/specs/2026-06-11-sig-393-region-resweep-spec.md.
//
// File-level regions, decided by measurement: window granularity gave equal
// lift at double the calls. The model work lives in `app/resweep.ts`; this
// module is pure (gate decision, region selection, guidance builder) so the
// policy is unit-testable without a model.

export type ResweepMode = "off" | "shadow" | "on"

/** Normalize `OPENCLAW_RESWEEP_MODE` (default "off"). */
export function parseResweepMode(raw: string | undefined): ResweepMode {
  const v = (raw ?? "").trim().toLowerCase()
  return v === "shadow" || v === "on" ? v : "off"
}

/** The finding slice the gate/regions need — projected from specialist verdicts. */
export interface ResweepFindingRef {
  path: string
  line: number
  category: string
  score: number
}

/**
 * The epic's high-risk surfaces (SIG-369 lane triggers): paths whose
 * changes concentrate recall-critical bug classes. Substring match on the
 * changed path, lowercase.
 */
const HIGH_RISK_PATH_HINTS = [
  "auth",
  "payment",
  "billing",
  "refund",
  "webhook",
  "charge",
  "wallet",
  "invoice",
  "migration",
  "permission",
  "queue",
  "token",
  "secret",
  "session",
] as const

export function isHighRiskPath(path: string): boolean {
  const p = path.toLowerCase()
  return HIGH_RISK_PATH_HINTS.some((hint) => p.includes(hint))
}

export interface ResweepGateInput {
  mode: ResweepMode
  findings: readonly ResweepFindingRef[]
  /** Added-line count per changed path (from the packed diff blocks). */
  addedLinesByPath: ReadonlyMap<string, number>
}

export interface ResweepGateDecision {
  fire: boolean
  reasons: string[]
  /** Paths with ≥1 finding, ordered by finding count DESC (the region candidates). */
  flaggedPaths: string[]
}

/**
 * The effort gate — the lane allocator's first concrete trigger (SIG-369).
 * Deterministic-only v1: the overview's model-scored `reviewEffort` is not
 * available inside the review pipeline, so the gate fires on the signals
 * the epic lists as its co-triggers:
 *
 *   clustered findings (≥1 region with ≥2 findings)
 *     AND breadth-or-size (≥2 flagged regions OR ≥150 added lines total)
 *     AND risk-or-size (≥1 high-risk flagged path OR ≥150 added lines total)
 *
 * Small PRs never pay: one file with one finding fails the first clause.
 */
export function decideResweepGate(input: ResweepGateInput): ResweepGateDecision {
  const byPath = new Map<string, number>()
  for (const f of input.findings) byPath.set(f.path, (byPath.get(f.path) ?? 0) + 1)
  const flaggedPaths = [...byPath.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)

  if (input.mode === "off") return { fire: false, reasons: ["mode-off"], flaggedPaths }

  const totalAdded = [...input.addedLinesByPath.values()].reduce((a, b) => a + b, 0)
  const clusteredRegions = [...byPath.values()].filter((n) => n >= 2).length
  const highRiskFlagged = flaggedPaths.some(isHighRiskPath)

  const reasons: string[] = []
  if (clusteredRegions >= 1) reasons.push(`clustered-regions:${clusteredRegions}`)
  if (flaggedPaths.length >= 2) reasons.push(`flagged-regions:${flaggedPaths.length}`)
  if (totalAdded >= 150) reasons.push(`added-lines:${totalAdded}`)
  if (highRiskFlagged) reasons.push("high-risk-surface")

  const fire =
    clusteredRegions >= 1 && (flaggedPaths.length >= 2 || totalAdded >= 150) && (highRiskFlagged || totalAdded >= 150)
  if (!fire && reasons.length === 0) reasons.push("no-trigger")
  return { fire, reasons, flaggedPaths }
}

export interface ResweepRegion {
  path: string
  /** The region's diff slice (one file's block from the packed diff). */
  diffSlice: string
  /** Pass-1 findings in this region — categories + line anchors only. */
  priorFindings: ResweepFindingRef[]
}

/**
 * Select the regions to re-sweep: flagged paths that exist in the diff,
 * ordered by finding count DESC (the gate's `flaggedPaths` order), capped
 * at `maxRegions` so a pathological PR can't fan out unboundedly. Dropped
 * regions are returned for telemetry — silent truncation reads as "covered
 * everything" when it didn't.
 */
export function selectResweepRegions(args: {
  flaggedPaths: readonly string[]
  diffBlocks: ReadonlyMap<string, string>
  findings: readonly ResweepFindingRef[]
  maxRegions: number
}): { regions: ResweepRegion[]; droppedPaths: string[] } {
  const inDiff = args.flaggedPaths.filter((p) => args.diffBlocks.has(p))
  const kept = inDiff.slice(0, Math.max(0, args.maxRegions))
  const regions = kept.map((path) => ({
    path,
    diffSlice: args.diffBlocks.get(path)!,
    priorFindings: args.findings.filter((f) => f.path === path),
  }))
  return { regions, droppedPaths: inDiff.slice(kept.length) }
}

/**
 * The re-sweep guidance block. DELIBERATELY passes categories + line
 * anchors, NOT the pass-1 headlines: the prototype's verbatim-headline
 * guidance measurably primes the model's wording (and would echo findings
 * back) — the measurement-validity caveat in the spec. The instruction
 * carries the lever's core move: assume more issues exist than were found.
 */
export function buildResweepGuidance(region: ResweepRegion): string {
  const anchors = region.priorFindings
    .slice()
    .sort((a, b) => a.line - b.line)
    .map((f) => `- a ${f.category} issue near line ${f.line}`)
  return [
    `FOCUSED RE-REVIEW — a prior review pass already examined \`${region.path}\` and flagged:`,
    ...anchors,
    "",
    "Those findings are already recorded — do NOT re-report them.",
    "Your job in THIS pass: enumerate every OTHER genuine issue in this file's diff.",
    "Dense changes hide secondary bugs behind the loudest one — assume more issues exist,",
    "including ones adjacent to the lines listed above. Report only genuine defects",
    "(correctness, security, data integrity, contract violations) you can ground in the",
    "visible code. Do not pad with stylistic nits.",
  ].join("\n")
}
