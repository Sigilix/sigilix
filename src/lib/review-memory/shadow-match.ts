// SIG-276 Phase 3 — shadow claim matcher (Site 2).
//
// PURE + SYNC. Matches an incoming finding's write-time claim TYPES
// against the per-claim-type `shadowClaims` aggregated onto active
// memories by `lookup.ts` (Site 1), and produces telemetry rows for the
// `review-memory-claim-shadow` corpus.
//
// OBSERVATION-ONLY: the returned rows are consumed by NOTHING in the
// posting path — Phase 3 never changes softening. The ensemble emits one
// aggregated `review-memory-claim-shadow` event per review and discards
// the rows. (Phase 4 calibrates on the corpus and decides activation.)
//
// Match key is `claim.type` (the stable 4-value enum), NOT `claim.id`:
// `computeClaimId` folds `extractorVersion` into the id, so id-matching
// would silently false-negative across an extractor bump. We carry the
// incoming version separately and flag `version_mismatch` so Phase 4 can
// measure the false-negative rate an id-match WOULD have incurred.

import type { ReviewMemoryCategory, ReviewMemoryClaimType, ReviewMemoryFinding } from "./types"

/** Default distinct-PR floor for the telemetry-only `wouldSoftenAtFloor`
 *  LABEL. Phase-4-tunable; it GATES NOTHING in Phase 3. */
export const SHADOW_DISTINCT_PR_FLOOR = 2

/**
 * SIG-280 Phase 4: the `OPENCLAW_REVIEW_MEMORY_CLAIM_SHADOW` flag is now an
 * enum. `on` keeps its Phase-3 meaning (shadow telemetry only). `render` and
 * `soften` are RESERVED Phase-4 modes — in PR A they behave identically to
 * `shadow` (the shadow pass runs; no render/soften behavior is wired yet).
 * Any value not in the set (incl. absent) is `off`.
 */
export type ClaimShadowMode = "off" | "shadow" | "render" | "soften"

export function resolveClaimShadowMode(raw: string | undefined): ClaimShadowMode {
  switch (raw) {
    case "on":
      return "shadow"
    case "render":
      return "render"
    case "soften":
      return "soften"
    default:
      return "off"
  }
}

/** Minimal incoming-claim view the matcher needs (from the id-less
 *  marker data on a to-be-emitted finding). */
export interface ShadowMatchIncomingClaim {
  type: ReviewMemoryClaimType
  extractorVersion: number
}

/** Severity tier of a finding (mirrors the ensemble's `severityTier`). */
export type ShadowSeverityTier = "P0" | "P1" | "P2" | "P3"

/** One incoming finding reduced to its match inputs. `category` is null
 *  when the finding has no resolvable specialist category (skip). */
export interface ShadowMatchFinding {
  category: ReviewMemoryCategory | null
  /** sha12 of the finding's path; null when unavailable. */
  pathSha12: string | null
  /**
   * SIG-280: sha16 finding fingerprint (same `computeFid` as the marker).
   * The OFFLINE join key — lets Phase-4 calibration match a claim-matched
   * finding here against a later `review-memory-outcome:dismissed` event by
   * the same fid. sha16, no PII.
   */
  fid: string
  /** SIG-280: live severity tier (from the current score) — telemetry only. */
  severityTier: ShadowSeverityTier
  claims: readonly ShadowMatchIncomingClaim[]
}

/** One telemetry row. Enum/number/boolean only — NO free-text (privacy §9). */
export interface ShadowMatchRow {
  /** SIG-280: the finding's sha16 fid — OFFLINE join key to the outcome event. */
  fid: string
  /** SIG-280: the finding's live severity tier — telemetry only. */
  severityTier: ShadowSeverityTier
  /** The matched claim enum, or null for the `category-no-claim-match` tier. */
  claimType: ReviewMemoryClaimType | null
  matchedTier: "path-category" | "category" | "category-no-claim-match"
  distinctPrCount: number
  signalCount: number
  lastSignalTs: string | null
  /** Whether today's category-only soften would ALSO fire for this finding. */
  categoryOnlyWouldAlsoFire: boolean
  /** `distinctPrCount >= floor` — a Phase-4 LABEL; GATES NOTHING. */
  wouldSoftenAtFloor: boolean
  /** Type matched but the incoming extractor version is not in the stored set. */
  version_mismatch: boolean
  /** Raw (uncalibrated) confidences — telemetry ONLY. */
  rawConfidences: number[]
}

/**
 * Match incoming findings' claim types against active memories'
 * `shadowClaims`. Returns one row per (finding, matched claim type) for
 * tier-1/2 matches, plus one `category-no-claim-match` row per finding
 * whose category memory is active but whose claims did not intersect (or
 * which carried no claims). Per finding, a claim type is deduped to its
 * most-specific tier (path-category over category).
 */
export function shadowMatchReviewMemoryClaims(args: {
  memories: readonly ReviewMemoryFinding[]
  findings: readonly ShadowMatchFinding[]
  floor?: number
}): ShadowMatchRow[] {
  const floor = args.floor ?? SHADOW_DISTINCT_PR_FLOOR
  const rows: ShadowMatchRow[] = []

  for (const f of args.findings) {
    if (f.category === null) continue

    const catMem = args.memories.find((m) => m.scope === "category" && m.category === f.category)
    const pathMems = args.memories.filter(
      (m) =>
        m.scope === "path-category" && m.category === f.category && f.pathSha12 !== null && m.pathSha12 === f.pathSha12,
    )
    const categoryOnlyWouldAlsoFire = catMem !== undefined

    let matchedThisFinding = false
    const seenTypes = new Set<ReviewMemoryClaimType>()

    for (const incoming of f.claims) {
      if (seenTypes.has(incoming.type)) continue
      seenTypes.add(incoming.type)

      // Tier 1: path-category match (most specific).
      let tier: ShadowMatchRow["matchedTier"] | null = null
      let sc: NonNullable<ReviewMemoryFinding["shadowClaims"]>[number] | undefined
      for (const pm of pathMems) {
        const hit = pm.shadowClaims?.find((c) => c.type === incoming.type)
        if (hit) {
          tier = "path-category"
          sc = hit
          break
        }
      }
      // Tier 2: category match.
      if (!sc && catMem) {
        const hit = catMem.shadowClaims?.find((c) => c.type === incoming.type)
        if (hit) {
          tier = "category"
          sc = hit
        }
      }
      if (sc && tier) {
        matchedThisFinding = true
        rows.push({
          fid: f.fid,
          severityTier: f.severityTier,
          claimType: incoming.type,
          matchedTier: tier,
          distinctPrCount: sc.distinctPrCount,
          signalCount: sc.signalCount,
          lastSignalTs: sc.lastSignalTs,
          categoryOnlyWouldAlsoFire,
          wouldSoftenAtFloor: sc.distinctPrCount >= floor,
          version_mismatch: !sc.extractorVersions.includes(incoming.extractorVersion),
          rawConfidences: sc.rawConfidences,
        })
      }
    }

    // Tier 3: category memory active but claims did not refine it (or the
    // finding carried no claims). The precision question Phase 4 needs.
    if (categoryOnlyWouldAlsoFire && !matchedThisFinding) {
      rows.push({
        fid: f.fid,
        severityTier: f.severityTier,
        claimType: null,
        matchedTier: "category-no-claim-match",
        distinctPrCount: 0,
        signalCount: 0,
        lastSignalTs: null,
        categoryOnlyWouldAlsoFire: true,
        wouldSoftenAtFloor: false,
        version_mismatch: false,
        rawConfidences: [],
      })
    }
  }

  return rows
}
