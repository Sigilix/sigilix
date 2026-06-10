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

// ─── initial user message builders ─────────────────────────────────────

export interface SpecialistInitialMessageCtx {
  prNumber: number
  title: string
  body: string
  diff: string
  retrievalSnapshot: string  // pre-formatted chunks (or empty when preflight failed)
  namespace: string  // for follow-up retrieve_codebase calls
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

export function buildSpecialistInitialMessage(
  ctx: SpecialistInitialMessageCtx,
): string {
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
    lines.push("[REVIEW PROFILE — chill] Surface only must-fix findings (correctness, security, real bugs). Skip nits, style preferences, and minor refactors.")
    lines.push("")
  } else if (ctx.profile === "assertive") {
    lines.push("[REVIEW PROFILE — assertive] Surface must-fix findings AND nits/style. Be thorough; the team has opted into more comments.")
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
    ctx.retrievalSnapshot.length > 0 ? ctx.retrievalSnapshot : "(no chunks; pre-flight retrieval did not return results)",
  )
  // SIG-138 Phase 2: graph-context neighbors of the changed code,
  // placed immediately after [RETRIEVAL SNAPSHOT] so both structural
  // and semantic context appear together. Additive: absent/empty →
  // no block emitted, output is bit-for-bit identical to pre-SIG-138.
  if (ctx.graphContext && ctx.graphContext.trim()) {
    lines.push("", "[GRAPH CONTEXT — dependency-graph neighbors of the changed code; additive, may be incomplete]", ctx.graphContext.trim())
  }
  if (ctx.dynamicEvidenceBlock && ctx.dynamicEvidenceBlock.trim()) {
    lines.push("", ctx.dynamicEvidenceBlock.trim())
  }
  lines.push(
    "",
    `[CODEBASE NAMESPACE FOR FOLLOW-UP retrieve_codebase CALLS]`,
    ctx.namespace,
  )
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

export function buildSynthesizerInitialMessage(
  ctx: SynthesizerInitialMessageCtx,
): string {
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
  lines.push(
    `[PR] #${ctx.prNumber}`,
    "",
    "[DIFF]",
    ctx.diff,
  )
  // SIG-138 Phase 2: graph-context neighbors, placed after [DIFF] and
  // before [SPECIALIST VERDICTS] so synth sees structural neighbors
  // alongside the diff when weighing specialist findings. Additive:
  // absent/empty → no block emitted, output is bit-for-bit identical
  // to pre-SIG-138.
  if (ctx.graphContext && ctx.graphContext.trim()) {
    lines.push("", "[GRAPH CONTEXT — dependency-graph neighbors of the changed code; additive, may be incomplete]", ctx.graphContext.trim())
  }
  if (ctx.dynamicEvidenceBlock && ctx.dynamicEvidenceBlock.trim()) {
    lines.push("", ctx.dynamicEvidenceBlock.trim())
  }
  lines.push(
    "",
    "[SPECIALIST VERDICTS]",
    ctx.specialistVerdictsBlock,
  )
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
): string {
  return verdicts
    .map(({ role, verdict }) => {
      const upper = role.toUpperCase()
      return `=== ${upper} ===\n${JSON.stringify(verdict, null, 2)}`
    })
    .join("\n\n")
}
