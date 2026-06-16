// SIG-104 PR-3: the deterministic suppress-polarity decision — the recall-safe
// core that decides whether a `polarity:"suppress"` learning may drop a noise
// finding at the POST-SYNTH soften gate (render-prep), co-located with the
// review-memory soften + the precision-profile suppression.
//
// RECALL-SAFETY IS THE WHOLE POINT (founder + spec §5/§12.4). A suppression bug
// that hides a real bug is the worst outcome an AI reviewer can have, so the
// HARD carve-outs below are non-negotiable and each is independently unit-tested:
//
//   1. NEVER suppress a P0/P1 — `score >= SUPPRESS_FLOOR_TIER` (the SAME floor
//      the precision profile reuses; imported, never hardcoded).
//   2. NEVER suppress a security/logic finding, keyed on PROVENANCE (the source
//      specialist that raised it AND the `<role>-<n>` source-id prefixes) NOT the
//      synth `category` — a real security/logic bug is routinely miscategorized as
//      tests/perf (spec §12.4 #139), and `sourceSpecialists` can itself be
//      malformed, so the source-id prefixes are the authoritative fallback.
//   3. NEVER suppress a finding carrying DETERMINISTIC evidence — an AST detector
//      slice, a CWE id, a scanner/AST `evidenceId` (`secret:`/`depvuln:`/`sarif:`/
//      `ast/`), or a deterministic `evidenceRef` (`coverageGap:`/`inspectedTestFile:`/
//      `siblingMapping:`/`testFileChanged:`) — it is grounded in a tool fact.
//   4. Suppress ONLY on a NARROW match: a suppress learning must cite a concrete
//      pathGlob and/or category basis that matches the finding. A blanket
//      learning (no path AND no category) is too broad to safely attribute at
//      the gate and is left as prompt-context only (it never silently drops).
//
// On top of those, the gate FAILS CLOSED: a finding with no/unknown provenance
// (empty `sourceSpecialists` AND empty `sourceFindingIds`) is never suppressed —
// we cannot prove it is not a security/logic finding (Codex sign-off, 2026-06-15).
//
// Pure + surface-agnostic (no GitHub/PR/env assumptions) so it is exhaustively
// testable and reusable across the CLI / portal / triage adapters.
//
// The deterministic-evidence-id prefixes are duplicated (not imported) from the
// ensemble's `DETERMINISTIC_EVIDENCE_ID_PREFIXES`: COMPLIANCE.md §1 forbids a
// `features/*` → `src/lib/*` edge, and a feature domain stays pure. The carve-out
// is recall-POSITIVE (a broader keep-list only protects more findings), so the
// small duplication is the safe trade vs. inverting the dependency rule.

import type { FindingCategory } from "@/src/shared/domain/finding-category"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import { SUPPRESS_FLOOR_TIER } from "@/src/features/precision-profile"
import { pathMatchesAny } from "@/src/shared/util/path-glob"
import type { LearningEntry } from "./types"

/**
 * The minimal finding shape the suppress gate reads. Provenance (`sourceSpecialists`)
 * and the deterministic-evidence fields are the carve-out keys — the synth
 * `category` is deliberately NOT trusted for the security/logic carve-out.
 */
export interface SuppressibleFinding {
  /** Severity 1–5. A P0/P1 (>= SUPPRESS_FLOOR_TIER) is never suppressed. */
  score: number
  /** Synth category — used ONLY for a positive narrow match, never for the carve-out. */
  category: FindingCategory
  /** The finding's path — matched against a suppress learning's pathGlob. */
  path: string
  /** PROVENANCE: the specialists that raised this finding. The security/logic carve-out keys here. */
  sourceSpecialists: ReadonlyArray<SpecialistRole>
  /**
   * PROVENANCE (authoritative fallback): the synth source-finding ids, formatted
   * `<role>-<n>` (e.g. `security-3`). `sourceSpecialists` is synth-reported and can
   * be malformed, so the carve-out ALSO derives security/logic from these prefixes
   * — mirroring `rolesFromValidatedSources` (validation-internals.ts). A finding
   * tagged `sourceSpecialists:["tests"]` but `sourceFindingIds:["security-0"]` is
   * still protected (Codex review, 2026-06-15).
   */
  sourceFindingIds?: ReadonlyArray<string> | undefined
  /** Deterministic AST detector slice (SIG-317) — presence ⇒ grounded ⇒ never suppress. */
  astEvidence?: string | undefined
  /** CWE id backing a security finding (SIG-108) — presence ⇒ grounded ⇒ never suppress. */
  cweId?: string | undefined
  /** Scanner/AST evidence id (SIG-108). A deterministic-prefixed, non-NONE id ⇒ grounded ⇒ never suppress. */
  evidenceId?: string | undefined
  /**
   * Evidence refs (SIG-113). A deterministic-fact ref (`coverageGap:`,
   * `inspectedTestFile:`, `siblingMapping:`, `testFileChanged:`) ⇒ grounded ⇒
   * never suppress — the same refs the validation path treats as deterministic.
   */
  evidenceRefs?: ReadonlyArray<string> | undefined
}

/** Why a suppress learning matched the finding (for the audit log + attribution). */
export type SuppressBasis = "path" | "category" | "path+category"

/** One suppress decision for a candidate finding index. */
export interface LearningSuppressDecision {
  /** Index into the input finding array. */
  index: number
  /** The matching learning's id (audit / `reason:"learning/<id>"`). */
  learningId: string
  /** The learning's normalized rule text (for the inline attribution pill). */
  ruleText: string
  /** The narrow basis the match cited. */
  basis: SuppressBasis
}

/** A finding a suppress learning matched but a HARD carve-out KEPT (drives the attribution pill). */
export interface LearningCarveOutKeep {
  index: number
  learningId: string
  ruleText: string
  basis: SuppressBasis
  /** Which carve-out spared it. */
  reason: "p0p1-floor" | "security-logic-provenance" | "deterministic-evidence"
}

export interface LearningSuppressResult {
  /** Findings that may be dropped (in `on` mode). Empty in any safe/over-cautious case. */
  suppressions: LearningSuppressDecision[]
  /** Findings a suppress learning matched but a carve-out protected — attribution-eligible. */
  carveOutKeeps: LearningCarveOutKeep[]
}

const SECURITY_LOGIC_ROLES: ReadonlySet<SpecialistRole> = new Set<SpecialistRole>(["security", "logic"])

/**
 * Deterministic `evidenceId` + `evidenceRef` prefixes. Kept in sync with the
 * ensemble's `DETERMINISTIC_EVIDENCE_ID_PREFIXES` / `DETERMINISTIC_EVIDENCE_REF_PREFIXES`
 * (validation-internals.ts) — duplicated, not imported, to respect the feature → lib
 * dependency boundary (see the module header). Id prefixes are lower-cased-compared.
 */
const DETERMINISTIC_EVIDENCE_ID_PREFIXES = ["secret:", "depvuln:", "sarif:", "ast/"] as const
const DETERMINISTIC_EVIDENCE_REF_PREFIXES = [
  "coverageGap:",
  "inspectedTestFile:",
  "siblingMapping:",
  "testFileChanged:",
] as const

/**
 * Decide which findings a `polarity:"suppress"` learning may drop, with the four
 * hard carve-outs applied. Pure — the caller (render-prep) enforces the mode:
 * `shadow` telemeters the result and drops nothing; `on` drops `suppressions`.
 * A finding matched by a suppress learning but spared by a carve-out is returned
 * in `carveOutKeeps` so the attribution pill can surface "a learned rule would
 * have downweighted this; kept because it's a blocker / security / logic."
 *
 * Each finding yields AT MOST ONE decision — the first suppress learning that
 * narrowly matches wins (decisions are stable in finding order, then learning
 * order). A carve-out keep is recorded only when NO suppression was possible for
 * that finding (a protected finding is never both suppressed and kept).
 */
export function decideLearningSuppressions(
  findings: ReadonlyArray<SuppressibleFinding>,
  learnings: ReadonlyArray<LearningEntry>,
): LearningSuppressResult {
  const suppressLearnings = learnings.filter((l) => l.polarity === "suppress")
  const suppressions: LearningSuppressDecision[] = []
  const carveOutKeeps: LearningCarveOutKeep[] = []
  if (suppressLearnings.length === 0) return { suppressions, carveOutKeeps }

  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]
    if (finding === undefined) continue
    const carveOut = protectingCarveOut(finding)

    for (const learning of suppressLearnings) {
      const basis = matchBasis(finding, learning)
      if (basis === null) continue
      // The first narrowly-matching suppress learning decides this finding. A
      // carve-out converts the match into an attribution keep instead of a drop.
      if (carveOut === null) {
        suppressions.push({ index, learningId: learning.id, ruleText: learning.rule, basis })
      } else {
        carveOutKeeps.push({ index, learningId: learning.id, ruleText: learning.rule, basis, reason: carveOut })
      }
      break
    }
  }

  return { suppressions, carveOutKeeps }
}

/**
 * The hard carve-out that protects a finding from suppression, or null when none
 * applies. Order is fixed (floor → provenance → evidence) so the recorded reason
 * is deterministic when several would apply. FAILS CLOSED: a finding with no
 * provenance (empty `sourceSpecialists`) is protected — we can't prove it isn't
 * security/logic, so we never suppress it.
 */
function protectingCarveOut(finding: SuppressibleFinding): LearningCarveOutKeep["reason"] | null {
  if (finding.score >= SUPPRESS_FLOOR_TIER) return "p0p1-floor"
  // Unknown provenance (no specialists AND no source ids) → fail closed: we can't
  // prove it isn't security/logic, so keep it.
  if (finding.sourceSpecialists.length === 0 && (finding.sourceFindingIds?.length ?? 0) === 0) {
    return "security-logic-provenance"
  }
  if (hasSecurityLogicProvenance(finding)) return "security-logic-provenance"
  if (hasDeterministicEvidence(finding)) return "deterministic-evidence"
  return null
}

/**
 * True when a finding is security/logic by PROVENANCE. Checks BOTH the synth-
 * reported `sourceSpecialists` AND the `<role>-<n>` source-id prefixes (the latter
 * is the authoritative fallback — `sourceSpecialists` can be malformed), mirroring
 * `rolesFromValidatedSources` (validation-internals.ts).
 */
function hasSecurityLogicProvenance(finding: SuppressibleFinding): boolean {
  if (finding.sourceSpecialists.some((role) => SECURITY_LOGIC_ROLES.has(role))) return true
  return (finding.sourceFindingIds ?? []).some((id) =>
    [...SECURITY_LOGIC_ROLES].some((role) => id.startsWith(`${role}-`)),
  )
}

/** True when a finding is grounded in a deterministic tool fact (AST / CWE / scanner id / fact ref). */
function hasDeterministicEvidence(finding: SuppressibleFinding): boolean {
  if (typeof finding.astEvidence === "string" && finding.astEvidence.trim().length > 0) return true
  if (typeof finding.cweId === "string" && finding.cweId.trim().length > 0) return true
  const evidenceId = finding.evidenceId?.trim()
  if (evidenceId !== undefined && evidenceId.length > 0 && evidenceId.toUpperCase() !== "NONE") {
    const lower = evidenceId.toLowerCase()
    if (DETERMINISTIC_EVIDENCE_ID_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  }
  return (finding.evidenceRefs ?? []).some((ref) =>
    DETERMINISTIC_EVIDENCE_REF_PREFIXES.some((prefix) => ref.trim().startsWith(prefix)),
  )
}

/**
 * The NARROW-match basis a suppress learning cites for a finding, or null when
 * the learning is too broad (no path AND no category) or simply doesn't match.
 * A blanket learning never matches here — it cannot cite a concrete basis, so it
 * stays prompt-context only and never drops a finding at the gate (spec §12.4).
 */
function matchBasis(finding: SuppressibleFinding, learning: LearningEntry): SuppressBasis | null {
  const glob = learning.pathGlob?.trim()
  const category = learning.category ?? null
  const hasPath = glob !== undefined && glob.length > 0
  const hasCategory = category !== null
  if (!hasPath && !hasCategory) return null // blanket → not gate-suppressible

  const pathMatches = hasPath ? pathMatchesAny(finding.path, [glob]) : false
  const categoryMatches = hasCategory ? finding.category === category : false

  // Every cited dimension must match (a path-AND-category learning is the
  // narrowest; a single-dimension learning matches on that one dimension).
  if (hasPath && !pathMatches) return null
  if (hasCategory && !categoryMatches) return null

  if (hasPath && hasCategory) return "path+category"
  return hasPath ? "path" : "category"
}
