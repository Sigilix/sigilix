// SIG-476 PR1 — IN-WORKER deterministic confirmation (DARK: helper + tier only).
//
// The self-attested companion to verify-finding-receipt.ts's runner-receipt join.
// Where THAT confirms a finding against the customer's CI scan (an INDEPENDENT,
// forge-proof-signed third party → `runner-confirmed`/VERIFIED), this confirms a
// finding against OUR OWN in-worker deterministic AST engine: a non-AI rule
// independently flagged the SAME canonical vuln-class at the finding's line.
//
// WHAT IT MEANS (and DOESN'T): this is ANTI-HALLUCINATION, not bug-certainty. A
// `confirmed` verdict says "a deterministic detector that is NOT the model agrees
// the cited class is present here", which raises believability — it does NOT say
// the bug is exploitable (DeepSeek's soundness rule from the receipt-join applies
// verbatim). It is SELF-attested (our engine corroborates our review), so it can
// NEVER earn `runner-confirmed`: a CI receipt is a strictly stronger, independent
// witness and must always outrank a self-confirmation (see TIER_RANK).
//
// NON-CIRCULARITY (the load-bearing design, Codex sign-off): the model's finding
// already embeds an AST fact in its own `evidence`/`evidenceId`; if we derived the
// finding's class from THAT and then "corroborated" it with the SAME fact, the
// confirmation would be a tautology. So:
//   (1) the finding's class is derived from FINDING-OWN signals ONLY — a STRIPPED
//       `{evidenceId, cweId}` (NEVER the full finding, whose `evidence
//       .deterministicFactIds` `canonicalClassForFinding` would also read);
//   (2) the corroborating AST fact must be a co-located fact that is NOT the
//       finding's own evidence (the independence guard below).
// Both id shapes are normalized to a `ruleId/line/hash` identity before comparing
// (the finding's own evidence is `ast:<ruleId>:<astFindingId>` while a co-located
// fact is the bare `astFindingId` = `ast/<ruleId>/<hash>/<line>` — different
// wrappers for the SAME underlying fact).
//
// Pure + side-effect-free (like its siblings). PR1 ships the helper + the
// `deterministic-confirmed` tier ONLY — nothing assigns or renders it yet (PR2/3).

import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import { canonicalClassForFinding, coLocatedAstFactIds } from "./verify-finding-receipt"

/** The verdict this helper emits. The caller (PR2) maps `confirmed` →
 *  `deterministic-confirmed`; `inconclusive`/`no-check` change nothing. */
export type InWorkerConfirmDecision = "confirmed" | "inconclusive" | "no-check"

/**
 * SIG-476 PR2 — the self-confirmation gate mode (`OPENCLAW_SELFCONFIRM_MODE`).
 * `off` (default): the gate doesn't run. `shadow`: compute + telemeter the
 * confirmed/uplift fractions, NO behavior change (never mutates the tier — the
 * GO/NO-GO metric that decides whether `deterministic-confirmed` earns a distinct
 * pill or stays a GROUNDED sub-state). `on`: also annotate a `confirmed` finding
 * with the `deterministic-confirmed` signal. Three-state with `off` default,
 * mirroring `parseReceiptJoinMode` / `parseTrustLedgerMode`. */
export type SelfConfirmMode = "off" | "shadow" | "on"

export function parseSelfConfirmMode(raw: string | undefined): SelfConfirmMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "on") return "on"
  return "off"
}

/**
 * The underlying identity of an AST fact, normalized away from its wrapper. Both
 * the finding's own `ast:<ruleId>:ast/<ruleId>/<hash>/<line>` evidenceId and a
 * co-located `ast/<ruleId>/<hash>/<line>` fact id reduce to this triple, so two
 * references to the SAME fact compare equal regardless of wrapper.
 */
interface AstFactRef {
  ruleId: string
  hash: string
  line: string
}

/**
 * Parse a bare AST fact id (`ast/<ruleId>/<hash>/<line>`, the `astFindingId`
 * minted by features/ast-rules/domain/finding-id.ts and returned by
 * `coLocatedAstFactIds`) into its normalized identity. Returns null for any other
 * shape (a non-AST id can't be an AST fact).
 */
function parseAstFactId(id: string): AstFactRef | null {
  const t = id.trim()
  if (!t.startsWith("ast/")) return null
  const parts = t.split("/")
  // ["ast", ruleId, hash, line]
  if (parts.length < 4) return null
  const ruleId = (parts[1] ?? "").trim()
  const hash = (parts[2] ?? "").trim()
  const line = (parts[3] ?? "").trim()
  if (ruleId.length === 0 || hash.length === 0 || line.length === 0) return null
  return { ruleId, hash, line }
}

/**
 * Extract the finding's OWN AST fact identity from its `evidenceId`. The security
 * manifest mints `ast:<ruleId>:<astFindingId>` where `astFindingId` is itself the
 * bare `ast/<ruleId>/<hash>/<line>` (security-evidence-manifest.ts:185 +
 * features/ast-rules/domain/finding-id.ts). So the underlying fact is the embedded
 * `astFindingId` after the `ast:<ruleId>:` prefix. Returns null when the
 * evidenceId isn't an `ast:` id carrying a parseable bare fact (e.g. a
 * secret:/sarif: id, the `NONE` sentinel, or a worker-token-grounded finding) —
 * in which case the finding has no own AST fact to exclude.
 */
export function ownAstFactRef(evidenceId: string | undefined): AstFactRef | null {
  const eid = typeof evidenceId === "string" ? evidenceId.trim() : ""
  if (!eid.startsWith("ast:")) return null
  // ast:<ruleId>:<astFindingId> — the astFindingId is everything after the 2nd ":"
  // (it contains "/" not ":", so a simple slice past the second ":" is exact).
  const firstColon = eid.indexOf(":")
  const secondColon = eid.indexOf(":", firstColon + 1)
  if (secondColon < 0) return null
  const embedded = eid.slice(secondColon + 1)
  return parseAstFactId(embedded)
}

/**
 * Does a co-located fact id refer to the SAME underlying AST fact as the finding's
 * own evidence? Compares on the normalized `ruleId/hash/line` identity, not the
 * raw string (different wrappers, same fact). A co-located id that doesn't parse,
 * or refers to a DIFFERENT fact, is NOT the same → it's an independent witness.
 */
export function sameAstFact(coLocatedId: string, ownRef: AstFactRef): boolean {
  const co = parseAstFactId(coLocatedId)
  if (co === null) return false
  return co.ruleId === ownRef.ruleId && co.hash === ownRef.hash && co.line === ownRef.line
}

/**
 * In-worker deterministic confirmation for ONE finding. Pure, never throws, no IO.
 *
 *   - no-check     — not a sev>=4 security finding (out of population).
 *   - confirmed    — the finding's class (derived from FINDING-OWN signals only)
 *                    is INDEPENDENTLY corroborated by ≥1 co-located AST fact of the
 *                    SAME class that is NOT the finding's own evidence.
 *   - inconclusive — everything else (no derivable class, no independent co-located
 *                    class match, or a fail-closed null/conflict). Fail-open: an
 *                    inconclusive NEVER lowers a finding.
 *
 * @param finding the submitted finding (its class is read from a STRIPPED subset).
 * @param astSecurityFindings OUR in-worker AST detector's security-roled hits
 *   (caller pre-filters to the security role — same input `coLocatedAstFactIds`
 *   takes in the receipt-join path).
 */
export function confirmFindingAgainstInWorkerAst(
  finding: Pick<PrReviewFinding, "path" | "line" | "score" | "category" | "evidenceId" | "cweId">,
  astSecurityFindings: ReadonlyArray<{ path: string; line: number; astFindingId: string }>,
): InWorkerConfirmDecision {
  // (1) Population gate — only sev>=4 security findings, matching the receipt-join.
  if (typeof finding.score !== "number" || finding.score < 4) return "no-check"
  if (finding.category !== "security") return "no-check"

  // (2) Derive the finding's class from FINDING-OWN signals ONLY. CRITICAL: pass a
  // STRIPPED `{evidenceId, cweId}`, NOT the full finding — `canonicalClassForFinding`
  // would otherwise also read `finding.evidence?.deterministicFactIds` and could
  // re-introduce the very co-located AST fact we're about to corroborate WITH,
  // making the confirmation circular. We establish the model's class claim
  // INDEPENDENTLY of the deterministic facts here, then corroborate it below.
  // (Omit undefined keys to satisfy exactOptionalPropertyTypes — same as never
  // touching `evidence`, so `deterministicFactIds` can't sneak back in.)
  const strippedClassInput: Pick<PrReviewFinding, "evidenceId" | "cweId"> = {
    ...(finding.evidenceId !== undefined ? { evidenceId: finding.evidenceId } : {}),
    ...(finding.cweId !== undefined ? { cweId: finding.cweId } : {}),
  }
  const findingClass = canonicalClassForFinding(strippedClassInput, [])
  // Can't establish the model's class claim independently → fail-open inconclusive
  // (also covers the fail-closed null/conflict from canonicalClassForFinding).
  if (findingClass === null) return "inconclusive"

  // (3) Independent co-located deterministic corroboration. `coLocatedAstFactIds`
  // matches on path + line window ONLY (it does NOT class-filter), so we class-
  // filter each returned fact id by classifying it IN ISOLATION, and drop any fact
  // that IS the finding's own evidence (the independence guard).
  const ownRef = ownAstFactRef(finding.evidenceId)
  const coLocated = coLocatedAstFactIds(finding, astSecurityFindings)
  for (const factId of coLocated) {
    // Independence guard: skip the finding's OWN AST fact — corroborating a class
    // with the same fact the model already cited would be a tautology (→ GROUNDED,
    // not CONFIRMED).
    if (ownRef !== null && sameAstFact(factId, ownRef)) continue
    // Class-filter: classify this fact in ISOLATION (only the fact id, no finding
    // signals) and keep it only if it independently yields the finding's class.
    if (canonicalClassForFinding({}, [factId]) !== findingClass) continue
    // ≥1 class-matched, independent co-located AST fact → confirmed.
    return "confirmed"
  }

  // No independent, class-matched co-located fact. Fail-open → inconclusive.
  return "inconclusive"
}
