// Phase 4 ensemble specialist prompts — locked v3.1.
//
// 4 specialists each get a SHARED [DIFF] + [PR META] + [RETRIEVAL SNAPSHOT]
// + [OUTPUT SCHEMA] block as their initial user message. Their roles
// are differentiated entirely by the SYSTEM prompt.
//
// Cross-lens caveat (Codex catch on Refinement 1):
//   Specialists may flag cross-lens issues when material — e.g., a perf
//   regression hiding in an auth file, a security concern surfaced by
//   a logic invariant. They should bias toward their assigned lens; if
//   another specialist's lens fits better, prefer letting them flag it.
//   Synthesizer dedupes overlaps.
//
// Output shape (JSON, matches PR_REVIEW_SCHEMA + 2 new fields):
//   - primaryLens: which lens THE specialist thinks this finding most
//     belongs in. Used by synthesizer for deduping + down-weighting
//     cross-domain noise.
//   - confidenceInLens: 1-5, specialist's confidence that the finding
//     genuinely sits in their lens (low if borderline, high if cleanly
//     in their domain).

import type { SpecialistRole } from "@/src/lib/ensemble-router"
import { LOGIC_PROMPT } from "./specialists/logic"
import { SECURITY_PROMPT } from "./specialists/security"
import { PERFORMANCE_PROMPT } from "./specialists/performance"
import { TESTS_PROMPT } from "./specialists/tests"
import { SYNTHESIZER_PROMPT } from "./specialists/synthesizer"

// SIG-388: the four specialist prompts + the synthesizer prompt now live
// in per-role files under ./specialists/ for clean prompt-tuning diffs.
// The composed strings are byte-for-byte identical to the previous inline
// definitions; the public export surface (SPECIALIST_PROMPTS,
// SYNTHESIZER_PROMPT, the message builders below) is unchanged.

export { SYNTHESIZER_PROMPT }

export const SPECIALIST_PROMPTS: Record<SpecialistRole, string> = {
  logic: LOGIC_PROMPT,
  security: SECURITY_PROMPT,
  performance: PERFORMANCE_PROMPT,
  tests: TESTS_PROMPT,
}

// SIG-392: recall-eliciting directive appended to the logic prompt when
// OPENCLAW_LOGIC_RECALL_MODE === "on". Measured (per-PR logic bake-off on the
// dense fixture, K=6, citation-judged): the default FP-disciplined prompt yields
// 6.0/20 logic recall; this suffix lifts v4-pro to ~16/20 and catches the
// frontier rows (b5/b10/b19/b20) it was "blind" to — at the same model, no
// migration. It deliberately trades specialist-stage precision for recall (the
// two are coupled at the prompt level); precision is the downstream gates' job
// (the engine's existing thesis). It flagged 0/4 fixture traps + 0 hallucinations
// in audit — its added "FP" is redundancy (same-class cross-handler findings),
// addressed by a class-collapse gate, NOT by softening this directive.
export const LOGIC_RECALL_SUFFIX = `
─────────────────────────────────────────────────────────────────────
RECALL DIRECTIVE:
Your objective is RECALL. Surface EVERY plausible logic/correctness defect,
INCLUDING subtle and lower-confidence ones (score them 2). A downstream layer
removes false positives, so do NOT self-censor or stop early — on a target-rich
diff, expect 10+ real defects, and conditional bugs (races, unhandled errors,
over-refund-on-retry, bypassable signature checks, wrong edge values) COUNT —
report them.
Do NOT trust comments, names, or claimed behavior ("idempotent", "validated",
"authorized") — verify from the actual code only.
TWO limits only (these do NOT reduce recall — apply them after you have found
everything):
  (a) report each distinct ROOT-CAUSE bug exactly ONCE — never the same defect
      under two findings;
  (b) do not emit a finding that is PURE style/naming/formatting with no wrong
      runtime behavior.
Systematically check the diff for each of these defect classes and report every
REAL, demonstrable instance:
- an awaited DB/IO call in an async handler with NO enclosing try/catch / error
  wrapper (a rejection becomes an unhandled rejection / hung request)
- a request field/param used without validation (negative, NaN, missing, wrong type)
- read-modify-write without a transaction/lock (SELECT-then-INSERT/UPDATE races)
- a query/mutation not scoped to the authenticated owner (IDOR / cross-tenant)
- a predicate compared against the wrong value ("> 0" vs "≥ total")
- off-by-one in pagination/offset/indexing
- a response shape that does not match its declared wire type
- a value read or computed but never USED to constrain the operation
- a handler that acts without checking an event/message "type" discriminator
- a signature/HMAC computed over RE-SERIALIZED data instead of the raw bytes
─────────────────────────────────────────────────────────────────────`

// SIG-392 (security lane): recall-eliciting directive appended to the SECURITY
// prompt when OPENCLAW_SECURITY_RECALL_MODE === "on". The base security prompt is
// heavily FP-disciplined (SIG-282/108/311/325/313 "verify before emit"), which —
// like the logic prompt — suppresses recall; the K=12 fixture map showed the
// security-owned frontier rows b16 (list-endpoint cross-tenant authz) and b20
// (HMAC over re-serialized body) at 0/12. This suffix pushes recall and names
// those classes explicitly, WITHOUT loosening the structured mechanism gates
// (those still apply to what it emits; precision stays the downstream gates' job).
export const SECURITY_RECALL_SUFFIX = `
─────────────────────────────────────────────────────────────────────
RECALL DIRECTIVE (security):
Your objective is RECALL. Surface EVERY plausible security weakness, INCLUDING
subtle and lower-confidence ones (score them 2). The structured gates above
(evidenceId citation, the SIG-325 source→sink→type mechanism, the SIG-313
four-part authorization tuple) STILL FULLY APPLY to everything you emit — keep
naming the mechanism and the missing check, and where ANY of the four authz
elements is UNKNOWN, still do NOT assert a flaw. ACTIVELY check each class below
and emit ONLY when the visible code satisfies the applicable SIG-325 / SIG-313
preconditions — the goal is to stop SKIPPING classes you can actually confirm,
not to lower the bar. Downstream may adjudicate and dedupe, but every finding you
emit must independently satisfy those evidence gates. On a target-rich diff
expect MULTIPLE real vulnerabilities; report every confirmable one.
Beyond single-object IDOR, systematically check the diff for these often-missed
classes and emit every instance whose mechanism you can confirm in the code:
- COLLECTION / LIST / batch endpoints that return rows ACROSS users or tenants
  with NO owner/tenant filter ("list all", a "?ids=" batch fetch, a search) —
  collection-scope IDOR / missing ROW-LEVEL tenant scoping. A missing
  \`WHERE owner_id = $principal\` on a list query is as exploitable as a missing
  \`:id\` ownership check — and the SIG-313 tuple holds (principal, the implicit
  "all rows" object key, the resource set, the absent scoping check).
- a signature / HMAC / digest verified over RE-SERIALIZED or RE-PARSED data
  (\`JSON.stringify(req.body)\`, a re-encoded payload) when the scheme is meant to
  sign the EXACT raw request bytes and no canonical-JSON contract is implemented —
  the recomputed bytes can differ from what was signed, desyncing or bypassing
  verification.
- a secret / signature check that FAILS OPEN — a hardcoded fallback secret, a
  missing-header path that proceeds, a comparison that yields true on error.
- an ownership/authz check that exists but guards the WRONG object, or runs
  AFTER the sensitive read/write.
- attacker-controlled input reaching an interpreted sink (SQL / command /
  template / header) without parameterization — even a single line.
Do NOT trust comments or names ("authenticated", "validated", "safe") — verify
from the actual code. Report each distinct ROOT-CAUSE vuln exactly ONCE; do not
emit pure hardening-with-no-exploit at score>=4.
─────────────────────────────────────────────────────────────────────`

/** Per-role recall directive, appended to the base prompt when that role's
 *  recall mode is on. Add a role here + flip its OPENCLAW_<ROLE>_RECALL_MODE to
 *  roll the SIG-392 recall lane out one specialist at a time. */
const RECALL_SUFFIX: Partial<Record<SpecialistRole, string>> = {
  logic: LOGIC_RECALL_SUFFIX,
  security: SECURITY_RECALL_SUFFIX,
}

/** Resolve a specialist's system prompt, appending the SIG-392 recall directive
 *  for any role in `recallRoles` (built from the per-role OPENCLAW_*_RECALL_MODE
 *  flags). Roles without a suffix, or not enabled, return the base prompt
 *  unchanged. Applied at the PROD specialist fanout only; the ARC-283 shadow path
 *  and the SIG-393 re-sweep phase intentionally stay on the base prompt (so the
 *  shadow bake-off stays a pure model diff and re-sweep is a separate rollout). */
export function specialistSystemPrompt(role: SpecialistRole, recallRoles: ReadonlySet<SpecialistRole>): string {
  const suffix = RECALL_SUFFIX[role]
  return suffix !== undefined && recallRoles.has(role)
    ? `${SPECIALIST_PROMPTS[role]}\n${suffix}`
    : SPECIALIST_PROMPTS[role]
}

// ─── initial user message builders ─────────────────────────────────────

export interface SpecialistInitialMessageCtx {
  prNumber: number
  title: string
  body: string
  diff: string
  retrievalSnapshot: string // pre-formatted chunks (or empty when preflight failed)
  namespace: string // for follow-up retrieve_codebase calls
  /**
   * ARC-174: per-repo guidance from `sigilix.json`. Prepended to the
   * message in a labeled block so the specialist treats it as
   * authoritative rules from the repo owner. Per-role rules are
   * appended downstream by the orchestrator (see `appendRoleRule`).
   */
  guidance?: string
  /**
   * Path-scoped guidance resolved by the orchestrator from
   * `sigilix.json.pathInstructions` and the PR's reviewable changed
   * files. Pre-rendered so role-specific rules can be scoped before
   * this prompt builder sees them.
   */
  pathInstructionsBlock?: string
  /**
   * ARC-193: pre-rendered deterministic-check hits block. Injected
   * BEFORE the diff so the specialist sees these as authoritative
   * facts about lines the regex layer already flagged. Empty/absent
   * = no deterministic findings to surface.
   */
  deterministicChecksBlock?: string
  /**
   * ARC-176: review-tone preset from sigilix.json `profile`. `chill`
   * (default; absent = chill) → flag must-fix only. `assertive` →
   * also surface nits and style. Rendered as a one-line directive
   * after guidance, before the diff.
   */
  profile?: "chill" | "assertive"
  /**
   * ARC-182: pre-rendered Graphite-style stack-context block. Injected
   * BEFORE the diff so the specialist tags findings with stackOrigin.
   * Empty/absent = no stack (or no stack context to surface) →
   * specialist omits the stackOrigin field on findings, matching the
   * "no-stack PRs produce unchanged reviews" acceptance criterion.
   *
   * Caller is `handlePrReviewEnsemble`, which builds this string via
   * `renderStackPromptBlock(stack, overlap)` from `pr-stack-prompt.ts`.
   */
  stackBlock?: string
  /**
   * SIG-91: pre-rendered diff file classification block (source/test
   * sibling mapping). Injected BEFORE the diff so the tests specialist
   * sees an authoritative `<source> ↔ <test>` mapping computed
   * deterministically from the diff file list — eliminating the false-
   * positive "module ships without tests" class on PRs that DO add
   * sibling test files. Logic/security/performance specialists also
   * see it (cheap context that primes test-relevance for them too).
   *
   * Empty/absent = the diff contains no source AND no test files
   * (e.g. docs-only PR); the classifier returns "" in that case so
   * the prompt stays lean.
   *
   * Caller is `handlePrReviewEnsemble`, which builds this string via
   * `renderDiffFileClassificationBlock` over the diff's file list.
   */
  diffFileClassificationBlock?: string
  /**
   * SIG-113: stronger evidence block specifically for the tests
   * specialist. When set, REPLACES `diffFileClassificationBlock` in
   * the rendered message — the testing-evidence block is a superset
   * (full diff inventory, in/out-of-prompt-diff annotations, full
   * test-file content, citation instructions).
   *
   * The orchestrator passes this only when building the tests
   * specialist's message. Other roles get `diffFileClassificationBlock`
   * unchanged.
   *
   * Caller builds via `renderTestingEvidenceBlock` from
   * `src/lib/testing-evidence-pack.ts`.
   */
  testingEvidenceBlock?: string
  /**
   * SIG-138 Phase 2: pre-rendered dependency-graph neighbors of the
   * changed code (K=2 BFS hops from `contextForVectorHits`). Injected
   * as a `[GRAPH CONTEXT]` labeled block adjacent to `[RETRIEVAL
   * SNAPSHOT]` so the specialist sees structural neighbors alongside
   * the semantic retrieval results.
   *
   * Empty/absent → block is not emitted; behavior is additive and
   * zero-change for PRs where graph context is unavailable.
   */
  graphContext?: string
  /**
   * Dynamic evidence cards around changed symbols/regions, including local
   * snippets, graph/retrieval relations, and test context. Injected adjacent
   * to graph context because both are precomputed grounding, not findings.
   *
   * Empty/absent → block is not emitted.
   */
  dynamicEvidenceBlock?: string
  /**
   * SIG-172: pre-rendered directory-scoped + glob-scoped rules block
   * discovered from SIGILIX.md / .sigilix/rules/*.md at index time
   * and matched against the PR's reviewable changed files at review
   * time. Distinct from `pathInstructionsBlock` (which renders
   * sigilix.json's `pathInstructions`): scoped rules live as repo
   * files alongside the code they govern; pathInstructions live as
   * one central sigilix.json entry.
   *
   * Rendered AFTER `[SHARED_NEGATIVE_CONSTRAINTS]` (system prompt) so
   * the constraints are positionally + lexically higher-priority. The
   * block's own header restates that the rules MUST defer to
   * constraints — positional + lexical defense per research §Q7.
   *
   * Empty/absent → block is not emitted.
   */
  scopedRulesBlock?: string
}

export function buildSpecialistInitialMessage(ctx: SpecialistInitialMessageCtx): string {
  const lines: string[] = []
  if (ctx.guidance && ctx.guidance.length > 0) {
    lines.push("[REPO GUIDANCE — applies to ALL specialists (from sigilix.json)]")
    lines.push(ctx.guidance)
    lines.push("")
  }
  if (ctx.pathInstructionsBlock && ctx.pathInstructionsBlock.length > 0) {
    lines.push(ctx.pathInstructionsBlock)
    lines.push("")
  }
  // SIG-172: scoped rules block. Sits between pathInstructions
  // (sigilix.json-driven) and profile/deterministic blocks so the
  // ordering mirrors mental model "specific-rule sources first, then
  // tone + automated facts." Header itself restates priority vs.
  // SHARED_NEGATIVE_CONSTRAINTS (system prompt) so the LLM doesn't
  // treat the two as peers (research §Q7).
  if (ctx.scopedRulesBlock && ctx.scopedRulesBlock.length > 0) {
    lines.push(ctx.scopedRulesBlock)
    lines.push("")
  }
  if (ctx.profile === "chill") {
    lines.push(
      "[REVIEW PROFILE — chill] Surface only must-fix findings (correctness, security, real bugs). Skip nits, style preferences, and minor refactors.",
    )
    lines.push("")
  } else if (ctx.profile === "assertive") {
    lines.push(
      "[REVIEW PROFILE — assertive] Surface must-fix findings AND nits/style. Be thorough; the team has opted into more comments.",
    )
    lines.push("")
  }
  if (ctx.deterministicChecksBlock && ctx.deterministicChecksBlock.length > 0) {
    lines.push(ctx.deterministicChecksBlock)
    lines.push("")
  }
  // ARC-182: stack context goes after guidance/profile/deterministic
  // blocks and BEFORE [PR] (and therefore before [DIFF]). Codex's
  // sign-off note flagged that the spec's "between retrieval and
  // namespace" placement would put it AFTER the diff in this builder,
  // violating the acceptance criterion that stack metadata appears
  // before the diff.
  if (ctx.stackBlock && ctx.stackBlock.length > 0) {
    lines.push(ctx.stackBlock)
    lines.push("")
  }
  // SIG-91: diff file classification (source ↔ test sibling map) goes
  // right before [PR] so the tests specialist sees the authoritative
  // pairing as the LAST thing before the diff. Empty string = no
  // source/test files in this diff; skip the block to keep the prompt
  // lean.
  //
  // SIG-113: the tests specialist gets a STRONGER block
  // (`testingEvidenceBlock`) instead — full diff inventory, full
  // test-file content, explicit citation instructions. When both are
  // supplied, testingEvidenceBlock wins. The orchestrator passes
  // testingEvidenceBlock ONLY for the tests-specialist message;
  // other specialists keep getting diffFileClassificationBlock as
  // ambient context (cheap signal that doesn't bloat the prompt).
  if (ctx.testingEvidenceBlock && ctx.testingEvidenceBlock.length > 0) {
    lines.push(ctx.testingEvidenceBlock)
    lines.push("")
  } else if (ctx.diffFileClassificationBlock && ctx.diffFileClassificationBlock.length > 0) {
    lines.push(ctx.diffFileClassificationBlock)
    lines.push("")
  }
  lines.push(
    `[PR] #${ctx.prNumber} — ${ctx.title}`,
    "",
    "[PR BODY]",
    ctx.body.length > 0 ? ctx.body : "(no description)",
    "",
    "[DIFF]",
    ctx.diff,
    "",
    "[RETRIEVAL SNAPSHOT]",
    ctx.retrievalSnapshot.length > 0
      ? ctx.retrievalSnapshot
      : "(no chunks; pre-flight retrieval did not return results)",
  )
  // SIG-138 Phase 2: graph-context neighbors of the changed code,
  // placed immediately after [RETRIEVAL SNAPSHOT] so both structural
  // and semantic context appear together. Additive: absent/empty →
  // no block emitted, output is bit-for-bit identical to pre-SIG-138.
  if (ctx.graphContext && ctx.graphContext.trim()) {
    lines.push(
      "",
      "[GRAPH CONTEXT — dependency-graph neighbors of the changed code; additive, may be incomplete]",
      ctx.graphContext.trim(),
    )
  }
  if (ctx.dynamicEvidenceBlock && ctx.dynamicEvidenceBlock.trim()) {
    lines.push("", ctx.dynamicEvidenceBlock.trim())
  }
  lines.push("", `[CODEBASE NAMESPACE FOR FOLLOW-UP retrieve_codebase CALLS]`, ctx.namespace)
  return lines.join("\n")
}

export interface SynthesizerInitialMessageCtx {
  prNumber: number
  diff: string
  /** Pre-rendered specialist verdict block: see renderSpecialistVerdictsForSynth(). */
  specialistVerdictsBlock: string
  /**
   * ARC-174: same per-repo guidance the specialists saw, prepended to
   * the synth message so it can apply repo-wide rules when merging
   * findings (e.g., guidance like "always promote security findings to
   * `score=5`" affects the synthesizer's deduping + rescoring).
   */
  guidance?: string
  /**
   * Same matched path-scoped guidance the specialists saw. Synth uses
   * it when merging/rescoring so path-local owner rules do not get
   * lost during fan-in.
   */
  pathInstructionsBlock?: string
  /**
   * ARC-182: same stack-context block the specialists saw. Synth uses
   * it to (a) preserve stackOrigin tags from specialists during
   * synthesis, and (b) adjudicate disagreement (e.g., two specialists
   * disagree on whether an issue is "current-pr" vs "downstack-context"
   * — synth defaults to "current-pr" when in doubt).
   */
  stackBlock?: string
  /**
   * ARC-277: when one or more specialists failed to return a verdict
   * (timeout / rate-limit / parse-fail), synth still runs but on
   * degraded input. The roles that DID return are in `rolesReturned`;
   * the roles that DIDN'T are in `rolesMissing`. Synth sees this
   * block in the prompt so it can:
   *   - skip findings that would have required a missing role
   *     (e.g. don't fabricate security findings if the security
   *      specialist didn't run)
   *   - acknowledge the gap in its `summary` field so the human
   *     reader sees "tests specialist didn't return; coverage was
   *     limited to logic + security + performance"
   *
   * Absent when all dispatched specialists returned (full coverage)
   * AND when zero specialists returned (the ensemble bails before
   * synth in the 0/N case in v1; that case will become a synth
   * stub-input in ARC-278).
   */
  degradedCoverage?: {
    rolesReturned: readonly SpecialistRole[]
    rolesMissing: readonly SpecialistRole[]
  }
  /**
   * SIG-138 Phase 2: same dependency-graph neighbors the specialists
   * saw. Synth sees this block so it can weigh findings on graph-
   * neighbor files with appropriate context (the callers passed the
   * same `graphContext` string to every specialist).
   *
   * Empty/absent → block is not emitted; additive, zero-change for
   * PRs where graph context is unavailable.
   */
  graphContext?: string
  /**
   * Same dynamic evidence cards the specialists saw. Synth uses them only to
   * adjudicate/merge specialist findings, not to invent findings by itself.
   *
   * Empty/absent → block is not emitted.
   */
  dynamicEvidenceBlock?: string
}

export function buildSynthesizerInitialMessage(ctx: SynthesizerInitialMessageCtx): string {
  const lines: string[] = []
  if (ctx.guidance && ctx.guidance.length > 0) {
    lines.push("[REPO GUIDANCE (from sigilix.json)]")
    lines.push(ctx.guidance)
    lines.push("")
  }
  if (ctx.pathInstructionsBlock && ctx.pathInstructionsBlock.length > 0) {
    lines.push(ctx.pathInstructionsBlock)
    lines.push("")
  }
  // ARC-182: stack context goes BEFORE [DIFF] (matching specialist
  // placement). Synth sees the same context the specialists saw, so
  // it can preserve / adjudicate stackOrigin tags consistently.
  if (ctx.stackBlock && ctx.stackBlock.length > 0) {
    lines.push(ctx.stackBlock)
    lines.push("")
  }
  // ARC-277: degraded-coverage block before [DIFF] so synth sees the
  // gap context up front and applies the constraints (no fabricating
  // findings in a missing role's domain, acknowledge the gap in
  // summary) to its full reasoning, not just at the tail end.
  if (ctx.degradedCoverage && ctx.degradedCoverage.rolesMissing.length > 0) {
    const returned = ctx.degradedCoverage.rolesReturned.join(", ")
    const missing = ctx.degradedCoverage.rolesMissing.join(", ")
    lines.push(
      "[DEGRADED COVERAGE]",
      `Specialists returned: ${returned}`,
      `Specialists MISSING (did not return — timeout / rate-limit / parse-fail): ${missing}`,
      "",
      "Constraints:",
      `- Do NOT fabricate findings that would have required a MISSING specialist's domain. If the \`security\` specialist is missing, do not surface security findings unless they appear in another specialist's output too.`,
      `- Add a one-sentence acknowledgement to your \`summary\` field that names the missing specialist roles, so the human reviewer knows coverage was reduced for this PR.`,
      `- Set \`confidence\` no higher than 3/5 when at least one role is missing — partial coverage means lower certainty.`,
      "",
    )
  }
  lines.push(`[PR] #${ctx.prNumber}`, "", "[DIFF]", ctx.diff)
  // SIG-138 Phase 2: graph-context neighbors, placed after [DIFF] and
  // before [SPECIALIST VERDICTS] so synth sees structural neighbors
  // alongside the diff when weighing specialist findings. Additive:
  // absent/empty → no block emitted, output is bit-for-bit identical
  // to pre-SIG-138.
  if (ctx.graphContext && ctx.graphContext.trim()) {
    lines.push(
      "",
      "[GRAPH CONTEXT — dependency-graph neighbors of the changed code; additive, may be incomplete]",
      ctx.graphContext.trim(),
    )
  }
  if (ctx.dynamicEvidenceBlock && ctx.dynamicEvidenceBlock.trim()) {
    lines.push("", ctx.dynamicEvidenceBlock.trim())
  }
  lines.push("", "[SPECIALIST VERDICTS]", ctx.specialistVerdictsBlock)
  return lines.join("\n")
}

/**
 * Render the 4 specialist verdicts (or however many succeeded) into
 * the canonical block the synthesizer sees. Each verdict gets a stable
 * finding ID assigned by the orchestrator (`logic-0`, `security-1`,
 * etc.) — this is the key the synthesizer references in
 * `provenance.findings[i].sourceFindingIds`.
 */
export function renderSpecialistVerdictsForSynth(
  verdicts: Array<{ role: SpecialistRole; verdict: unknown }>,
  leverOrigins?: ReadonlyMap<string, "resweep" | "lens">,
): string {
  return verdicts
    .map(({ role, verdict }) => {
      const upper = role.toUpperCase()
      return `=== ${upper} ===\n${JSON.stringify(annotateLeverOrigins(verdict, leverOrigins), null, 2)}`
    })
    .join("\n\n")
}

/**
 * SIG-392: stamp `origin: "resweep" | "lens"` onto lever-recovered findings in
 * the SYNTH-VISIBLE JSON only. The synth systematically merges-away
 * single-source lever candidates because nothing in its input distinguishes
 * them from pass-1 findings (both carry plain positional `role-i` ids after
 * the merge re-assignment); the marker gives the SYNTHESIZER_PROMPT's
 * lever-recovered protection rule something structural to key on. Annotation
 * happens at render time on copies, so `origin` exists nowhere outside the
 * rendered string — no domain type, telemetry, or posting path carries it.
 * Empty/absent map → the input object is returned untouched (byte-identical
 * render for shadow-mode and unlevered runs).
 */
function annotateLeverOrigins(verdict: unknown, leverOrigins?: ReadonlyMap<string, "resweep" | "lens">): unknown {
  if (!leverOrigins || leverOrigins.size === 0 || verdict === null || typeof verdict !== "object") return verdict
  const v = verdict as { findings?: unknown }
  if (!Array.isArray(v.findings)) return verdict
  let touched = false
  const findings = v.findings.map((f) => {
    if (f === null || typeof f !== "object") return f
    const id = (f as { id?: unknown }).id
    const origin = typeof id === "string" ? leverOrigins.get(id) : undefined
    if (!origin) return f
    touched = true
    return { ...(f as Record<string, unknown>), origin }
  })
  return touched ? { ...v, findings } : verdict
}
