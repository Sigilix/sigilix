// SIG-318 (PR 12c) — the SYNTH-input + synth-outcome PURE helpers of the
// PR-review orchestrator (domain layer). Relocated verbatim from the
// `triage-pr-review-ensemble` god-file so the carved specialists+synth app
// phase (ensemble/app/specialists.ts) can call them without importing the
// orchestrator. The bodies are byte-identical; only `classifySynthOutcome`'s
// param type is widened to a STRUCTURAL shape (it referenced the adapter's
// `runSynthesizer` return type via `Awaited<ReturnType<...>>`, which would pull
// an adapter dependency into the pure domain — the body reads only the three
// fields named in `SynthOutcomeInput`, so the adapter output + the existing
// test object literals both satisfy the widened supertype).
//
// Dependency rule: this module imports only domain/shared leaves (no env reads,
// no network, no IO). The god-file re-exports every symbol below so existing
// importers (tests + siblings) are unaffected.
//
// SIG-375 (SIG-318 env→Config): the synth-bypass gate no longer reads `env` —
// `parseSynthBypassEnabled` takes the RAW flag string and `isSynthBypassEligible`
// takes the parsed boolean (the domain-purity fix). The edge (`../config.ts`)
// reads `env.OPENCLAW_SYNTH_BYPASS_ENABLED` once into `EnsembleConfig.flags`; the
// env-taking `isSynthBypassEnabled` / `isSynthBypassEligible` wrappers the shim
// re-exports (for the existing unit tests) live there too.

import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { PrReviewVerdict, PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { SynthesizerProvenance } from "./validation"
import type { PrReviewVerdictWithIds } from "./findings"
import { filterWithdrawnFindings, type WithdrawalRecord } from "@/src/lib/review-withdrawal-store"
import type { ApprovalReadinessSourceFinding } from "@/src/lib/approval-readiness"

// SIG-318: the per-specialist verdict token cap, relocated with the synth-input
// builder it bounds.
export const SPECIALIST_VERDICT_TOKEN_CAP = 8_000

// SIG-484: the RAISED per-verdict cap (gated by `synthSourceFloorLow`). The default
// 8k cap drops lowest-score-first, starving score 2-3 findings before synth sees them
// on dense PRs — which also starves the SIG-484 source floor. A BOUNDED raise (per the
// DeepSeek-v4-pro sign-off: NOT full removal, to avoid blowing the synth context budget
// + diluting dedup attention) gives the densest PRs headroom while staying capped.
export const SPECIALIST_VERDICT_TOKEN_CAP_HIGH = 16_000

/** SIG-484: the per-verdict synth-input cap to use. Multi-batch uncaps (Infinity); the
 *  source-floor-low flag raises to the bounded HIGH cap so score 2-3 findings reach synth
 *  (+ the floor) ONLY when it is `on` — `floorLowOn` must be `flags.synthSourceFloorLow ===
 *  "on"`, NOT `!== "off"`, because raising the cap changes the synth INPUT (a behavior
 *  change that must NOT happen in `shadow`). Otherwise `undefined` keeps the default 8k. */
export function synthInputCapFor(multiBatch: boolean, floorLowOn: boolean): number | undefined {
  if (multiBatch) return Number.POSITIVE_INFINITY
  if (floorLowOn) return SPECIALIST_VERDICT_TOKEN_CAP_HIGH
  return undefined
}

export interface ApprovalReadinessSourceVerdict {
  role: SpecialistRole
  verdict: (PrReviewVerdict & { findings: Array<PrReviewFinding & { id: string }> }) | null
}

/**
 * SIG-392: lever-recovered finding ids → origin, for the render-time
 * synth-input `origin` marker (see `renderSpecialistVerdictsForSynth`).
 * Pure; shadow mode passes empty id lists → empty map → byte-identical
 * synth input.
 */
export function buildLeverOrigins(
  resweepFindingIds: readonly string[],
  lensFindingIds: readonly string[],
): ReadonlyMap<string, "resweep" | "lens"> {
  const out = new Map<string, "resweep" | "lens">()
  for (const id of resweepFindingIds) out.set(id, "resweep")
  for (const id of lensFindingIds) out.set(id, "lens")
  return out
}

export function buildSynthInputVerdicts<T extends ApprovalReadinessSourceVerdict>(
  sourceVerdicts: ReadonlyArray<T>,
  maxTokens: number = SPECIALIST_VERDICT_TOKEN_CAP,
): Array<T & { verdict: PrReviewVerdictWithIds }> {
  const out: Array<T & { verdict: PrReviewVerdictWithIds }> = []
  for (const source of sourceVerdicts) {
    if (!source.verdict) continue
    out.push({
      ...source,
      verdict: truncateVerdictToTokens(source.verdict, maxTokens),
    } as T & { verdict: PrReviewVerdictWithIds })
  }
  return out
}

// SIG-318 (PR 12d): the source-finding flattener relocated verbatim from the
// god-file with the render-prep phase that calls it. Pure — flattens the synth-
// input specialist verdicts to their (withdrawal-filtered) findings tagged with
// role + verdict confidence, for approval-readiness assessment.
export function collectApprovalReadinessSourceFindings(
  sourceVerdicts: ReadonlyArray<ApprovalReadinessSourceVerdict>,
  withdrawals: ReadonlyArray<WithdrawalRecord>,
): ApprovalReadinessSourceFinding[] {
  return sourceVerdicts.flatMap((v) => {
    const verdict = v.verdict
    if (!verdict) return []
    const { kept } = filterWithdrawnFindings(verdict.findings, withdrawals)
    return kept.map((finding) => ({
      role: v.role,
      id: finding.id,
      finding,
      verdictConfidence: verdict.confidence,
    }))
  })
}

/**
 * ARC-278: classified outcome of one synth attempt. `ok` means we
 * have a usable verdict + provenance; the three failure shapes line
 * up with the three skip gates the pre-ARC-278 code bailed on
 * (timeout / parse / invalid-provenance).
 */
export type SynthAttemptOutcome = "ok" | "timeout" | "parse" | "provenance"

/**
 * SIG-318 (PR 12c): the structural subset of `runSynthesizer`'s output that
 * `classifySynthOutcome` reads. Kept structural so the pure domain doesn't
 * import the model-provider adapter; the adapter's `SynthesizerRunOutput` and
 * the synth-path locals satisfy it by subtyping.
 */
export type SynthOutcomeInput = {
  verdict: PrReviewVerdict | null
  provenance: SynthesizerProvenance | null
  failureReason?: string
}

/**
 * ARC-278: pure helper. Classify the result of one
 * `runSynthesizer(...)` call (or the `null` we substitute for
 * synth-local timeout) into one of four outcomes. Encapsulates the
 * subtle Phase 4a.2 abort-rather-than-throw shape — without this,
 * three call sites duplicated the `/abort|timeout/i.test(failureReason)`
 * regex match.
 */
export function classifySynthOutcome(
  output: SynthOutcomeInput | null | undefined,
  localTimeout: boolean,
): SynthAttemptOutcome {
  if (localTimeout) return "timeout"
  if (!output) return "timeout" // defensive — caller's null/undefined → treat as timeout
  const reason = output.failureReason ?? ""
  if (/abort/i.test(reason) || /timeout/i.test(reason)) return "timeout"
  if (output.verdict && output.provenance) return "ok"
  return output.failureReason === "synth_invalid_provenance" ? "provenance" : "parse"
}

/**
 * ARC-278: prepend a per-outcome retry hint to the original synth
 * user message. Pure — exposed for unit tests that pin the prompt
 * text (which feeds the model's recovery behavior on retry).
 *
 * For `timeout`: a terse "be prompter and more concise" hint, since
 * the model already had the full schema + verdict block on attempt
 * 1 and timeout suggests either it stalled mid-generation OR the
 * retry-side environment was overloaded. Hint is short to avoid
 * burning tokens on retry overhead.
 *
 * For `parse` / `provenance`: a constraint reminder pointed at the
 * specific failure mode. The retry runs at the smaller
 * SYNTHESIZER_RETRY_TIMEOUT_MS budget, so the model only has time
 * for one tight re-emission — we tell it exactly what to fix.
 */
export function buildSynthRetryMessage(originalMessage: string, outcome: SynthAttemptOutcome): string {
  if (outcome === "ok") return originalMessage
  const hint =
    outcome === "parse"
      ? "RETRY: Your previous response could not be parsed as JSON. Re-emit ONLY a single JSON object matching the schema. No prose. No markdown fence. No leading or trailing text."
      : outcome === "provenance"
        ? "RETRY: Your previous response's `provenance` field was malformed. Re-emit with a valid `provenance` object: `{ findings: [...], dropped: [...], softened?: [...] }`. Each `provenance.findings[i].sourceFindingIds[]` and each `provenance.softened[i].sourceFindingId` must reference real source specialist finding IDs from the [SPECIALIST VERDICTS] block."
        : "RETRY: Your previous response did not arrive within the time budget. Re-emit promptly and concisely; the schema and inputs above are unchanged."
  return `${originalMessage}\n\n${hint}`
}

/**
 * Truncate a verdict's JSON-stringified form to fit the token cap.
 * Drops lowest-score findings first to preserve severity. Approximate
 * — uses 4 chars/token estimate.
 */
export function truncateVerdictToTokens(verdict: PrReviewVerdictWithIds, maxTokens: number): PrReviewVerdictWithIds {
  const charBudget = maxTokens * 4
  const working = { ...verdict, findings: [...verdict.findings] }
  // Sort findings by score DESC so we drop the lowest first.
  working.findings.sort((a, b) => b.score - a.score)
  while (JSON.stringify(working).length > charBudget && working.findings.length > 0) {
    working.findings.pop()
  }
  return working
}

/**
 * SIG-228 Phase 3c: returns true when the raw `OPENCLAW_SYNTH_BYPASS_ENABLED`
 * value is `"on"`. Default-off keeps the always-synth legacy behavior in
 * dev/test and in any production environment where the flag was never flipped.
 * Production wrangler.toml ships this `"on"` so the bypass fires for
 * single-specialist no-major reviews (the dispatcher's hot path).
 */
export function parseSynthBypassEnabled(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "on"
}

/**
 * SIG-228 Phase 3c: pure eligibility predicate, extracted so unit tests
 * can pin the gate without spinning up the full ensemble. Returns true
 * iff ALL of:
 *
 *   1. The synth-bypass flag is on (`enabled` — SIG-375: the parsed
 *      `OPENCLAW_SYNTH_BYPASS_ENABLED === "on"`, threaded in via Config).
 *   2. The DISPATCHER decided to fan out to exactly 1 specialist
 *      (`dispatchedCount === 1`). The hot path is "router narrowed
 *      to 1 on purpose" — NOT "router fanned out to N, only 1 came
 *      back." The latter is a degraded-coverage run and MUST run
 *      synth so it can render the `[DEGRADED COVERAGE]` block.
 *   3. Exactly 1 candidate verdict came back non-null (sanity-check;
 *      the only way this differs from #2 is if the single dispatched
 *      specialist itself failed, which makes the bypass impossible).
 *   4. None of that candidate's findings have `score >= 4`.
 *
 * Here `score >= 4` is the major/critical SEVERITY threshold (P0/P1) — this is
 * a synth-skip optimization, NOT the posted verdict. The verdict rule
 * (`chooseReviewEventForRenderedFindings` / `isTrivialFinding`) now blocks on
 * ANY substantive finding regardless of severity; the bypass only avoids the
 * synthesizer when a lone specialist has no P0/P1, which never changes the
 * posted event. The orchestrator's inline bypass branch reads the predicate
 * verbatim — keep these in sync.
 */
export function isSynthBypassEligible(
  enabled: boolean,
  dispatchedCount: number,
  candidates: ReadonlyArray<{ verdict: { findings: ReadonlyArray<{ score: number }> } | null }>,
): boolean {
  if (!enabled) return false
  if (dispatchedCount !== 1) return false
  if (candidates.length !== 1) return false
  const sole = candidates[0]
  if (!sole || !sole.verdict) return false
  return sole.verdict.findings.every((f) => f.score < 4)
}

/**
 * Build the `[AST RULE FINDINGS]` synth-prompt block (pure, exported for test).
 * ARC-181 + SIG-245: the SUPERSEDE-and-drop instruction (drop a specialist
 * finding that matches an AST entry on (path,line,role_hint)) is only safe when the
 * AST version will actually be POSTED — i.e. when `astRules.autoInline` is ON.
 * With autoInline OFF (the DEFAULT) the AST findings are never posted anywhere,
 * so telling the synth to drop the matching specialist finding silently loses a
 * real issue that BOTH engines caught. Verified in prod telemetry (e2e-backend
 * PR#1): the security specialist EMITTED shell-injection + disabled-TLS findings
 * on src/services/exec.ts, the synth dropped them as `superseded_by_ast/*`, and
 * the AST version was never re-injected — 2 real P0/P1 bugs vanished. So when
 * autoInline is OFF, the synth must KEEP its matching findings and use the AST
 * entries only for confidence + Fix-Plan ordering. Genuine cross-specialist
 * duplicates are still merged via the synth's separate `duplicate` drop reason.
 */
export function buildAstFindingsSynthBlock(astFindingsJson: string, autoInline: boolean): string {
  if (astFindingsJson.length === 0) return ""
  // SIG-309 PR2 note: the emit rule's "already covered" test uses (path, line)
  // — deliberately BROADER than the confirmation rule's (path, line, role_hint).
  // A same-line specialist finding of ANY role almost certainly concerns the
  // same security sink, so the broader key biases toward "already covered" →
  // suppress the synth emit. That's the FP-safe direction (fewer emits, never
  // a double-post), at a marginal recall cost on the rare cross-role same-line case.
  const instruction = autoInline
    ? `Match these against specialist findings on \`(path, line, role_hint)\` triple. When a specialist finding shares ALL THREE with an AST entry, drop it from your output and include \`{ specialist, sourceFindingId, headline, reason: "superseded_by_ast/<id>" }\` in \`provenance.dropped[]\`. Cross-role matches (e.g. AST=security vs specialist=performance) do NOT supersede.`
    : `These are deterministic confirmations. When a specialist finding matches an AST entry on \`(path, line, role_hint)\`, KEEP the specialist finding (the AST version is NOT posted separately) and treat the match as raised confidence. Do NOT drop AST-matched findings as superseded. Use the AST entries to order the Fix Plan — deterministically-confirmed issues outrank speculative ones. (Genuine cross-specialist duplicate findings are still merged via the \`duplicate\` drop reason.)\n\nSIG-309/310: an AST entry with \`"deterministic_emit": true\` is a high-confidence finding the scanner PROVED is present — a security sink (command/shell injection, disabled TLS) or a contract-drift type smell. EMIT a finding for it yourself in the entry's \`role_hint\` category, using the entry's \`message\` and a concrete fix — UNLESS a specialist finding already covers it: for a \`role_hint:"security"\` entry, "covers it" = any finding at the same \`(path, line)\`; for any OTHER role (e.g. \`logic\`), "covers it" = a finding at the same \`(path, line, role_hint)\` (a different-role finding on the same line must NOT suppress it). Do NOT omit an uncovered entry just because no specialist raised it; that is exactly the case this flag exists for. SEVERITY by the entry's \`severity\` field: an \`error\` entry is a PROVEN-dangerous sink — score it on its merits (typically P0/P1 for security). A \`warning\` entry is an ADVISORY the scanner surfaced but can't fully prove (a dynamic HTML sink whose value might be a trusted constant; a \`role_hint:"logic"\` type-design smell) — emit it at score 2-3 (P2/P3), anchored at the entry's path+line, NEVER as a P0/P1 blocker, whatever its \`role_hint\`. (If your own specialist independently judges a \`warning\` security advisory to be a real P0/P1, that specialist finding 'covers' the entry per the rule above and stands on its merits — the P2 ceiling applies only to the deterministic advisory.) (Entries WITHOUT \`deterministic_emit\` stay confirmation/ordering only, per above. A \`deterministic_emit\` entry that a specialist DID match is still just a confirmation — keep the specialist finding, don't double-post.)`
  return `\n\n[AST RULE FINDINGS — pre-LLM, structured]\n\n${instruction}\n\n\`\`\`json\n${astFindingsJson}\n\`\`\``
}
