// SIG-452: adversarial-framing hardening prompt blocks.
//
// These are the ENFORCE-GATED conditional blocks for the "removed guarding test"
// signal. They live HERE — NOT inlined into `specialists/logic.ts`,
// `specialists/synthesizer.ts`, or `logic-examples.json` — precisely so that
// `OPENCLAW_ADVERSARIAL_FRAMING_MODE` = off / shadow stay BYTE-IDENTICAL to
// today's output (Codex change #2). The caller injects the rendered block into
// the relevant role's USER message ONLY in `enforce` mode and ONLY when at least
// one symbol-grade signal exists; off/shadow never construct or inject it.
//
// Two loci, tested independently (Codex change #3):
//   - LOGIC locus: the logic specialist needs the signal so it EMITS a finding —
//     the synth's hallucination guard forbids it from inventing a finding no
//     specialist surfaced, so the keep-rule alone (synth) would have nothing to
//     keep on a clean specialist pass.
//   - SYNTH locus: the synth needs the keep-rule because the overview wave-through
//     ("intentional contract change with test coverage") is where A2/A4 die.
//
// `ADVERSARIAL_FRAMING_PROMPT_VERSION` versions the block text so a prompt change
// is auditable in telemetry (the wiring logs it alongside the signal counts).

import type { RemovedGuardingTest } from "@/src/lib/removed-guarding-tests"

/** Bump on any change to the block TEXT below, so a prompt edit is auditable. */
export const ADVERSARIAL_FRAMING_PROMPT_VERSION = "1"

/** Render the grounded, cited evidence lines shared by both loci: each removed
 *  guarding test as `testPath` (covered `symbol` in `source`) + the quoted
 *  removed assertion. Only symbol-grade signals are passed here by the caller. */
function renderSignalLines(signals: readonly RemovedGuardingTest[]): string[] {
  const lines: string[] = []
  for (const s of signals) {
    const symbol = s.coveredSymbol !== null ? `\`${s.coveredSymbol}\`` : "(symbol)"
    lines.push(
      `- \`${s.testPath}\` removed an assertion guarding ${symbol} in \`${s.coveredSource}\` (changed in this PR): "${s.removedAssertionHint}"`,
    )
  }
  return lines
}

/**
 * The LOGIC-specialist enforce block. Injected into the logic role's user
 * message. Carries the grounded signal + the inverted-inference RULE + a compact
 * SKIP/FLAG example pair (an A4-shaped flip with a removed test = FLAG; a legit
 * refactor whose covered behavior is unchanged = SKIP). The model must cite the
 * changed line AND the removed test (grounded), at score >= 4.
 */
export function renderAdversarialFramingLogicBlock(signals: readonly RemovedGuardingTest[]): string {
  if (signals.length === 0) return ""
  return [
    "[REMOVED GUARDING TESTS — authoritative; computed from this PR's diff + AST]",
    "This is an ADDITIONAL recall target — it does NOT replace or narrow your normal logic review. Keep finding every other correctness bug as usual; this block only adds suspicion to the specific pairings below.",
    "This PR changed the behavior of the symbol(s) below AND removed, in the SAME diff, a test that pinned the old behavior:",
    ...renderSignalLines(signals),
    "",
    "RULE (adversarial-framing): A behavioral/contract change on a CHANGED line whose guarding test was REMOVED or WEAKENED in THIS diff is NOT presumptively intentional. Removing the test that pinned a behavior is a textbook way to sneak a regression past review — treat the removed coverage as a RED FLAG, not as evidence the change was deliberate.",
    "For each pairing above, re-examine the changed symbol's NEW behavior against what the removed assertion pinned. If the new behavior is a plausible BUG (a dropped field, an inverted precedence/comparison, a changed return shape, a lost guard), EMIT a logic finding at score >= 4 phrased as a confirm-intentional question to the author: state the behavior that changed here, and that the test pinning it (`<testPath>`) was removed in this PR — ask the author to confirm the change is intentional. Anchor the finding to the changed line AND cite the removed test (grounded). Do NOT down-rank it merely because the test was removed.",
    "",
    "Calibration (do NOT copy verbatim):",
    "- FLAG: a fallback-timestamp precedence flips from `created_at ?? updated_at` to `updated_at ?? created_at` on a changed line, and the same PR deletes the test asserting the old precedence — EMIT (score 4): behavior changed + its guard removed; ask the author to confirm. This is exactly the A4-class bug adversarial framing hides.",
    "- FLAG: a dedupe tuple drops a field (`[id]` instead of `[id, attempt]`) on a changed line so distinct rows now collapse, and the PR removes the test pinning per-attempt dedupe — EMIT (score 4): a data-integrity contract change with its guard removed. This is the A2 class.",
    "- SKIP: a test was removed but the covered symbol's RUNTIME behavior is unchanged (pure rename of an internal variable, a comment, a reformat) — do NOT emit; the removed coverage tracks a no-op change, not a behavioral one.",
    "- SKIP: the removed test was MOVED/RENAMED (its assertions re-appear at a new path) — not a dropped guard; do NOT emit. (The signal above already excludes renames; if you see a re-added equivalent assertion, treat it as a move.)",
  ].join("\n")
}

/**
 * The SYNTHESIZER enforce block. Injected into the synth's user message. The
 * keep-rule: a source finding about a behavioral change whose guarding test was
 * removed in the SAME PR must NOT be dismissed/waved-through as an "intentional
 * contract change with test coverage." Removed coverage is a red flag, not intent.
 */
export function renderAdversarialFramingSynthBlock(signals: readonly RemovedGuardingTest[]): string {
  if (signals.length === 0) return ""
  return [
    "[REMOVED GUARDING TESTS — authoritative; computed from this PR's diff + AST]",
    "This PR changed the behavior of the symbol(s) below AND removed, in the SAME diff, a test that pinned the old behavior:",
    ...renderSignalLines(signals),
    "",
    "KEEP RULE (adversarial-framing): When a specialist surfaced a finding about a behavioral/contract change on one of the pairings above, you MUST NOT dismiss or wave it through as an 'intentional contract change' / 'has test coverage' / 'deliberate' just because the change looks plausible or the diff frames it as intended. A guarding test REMOVED in the same PR is a RED FLAG, not evidence of intent — the removed coverage is exactly how a regression is sneaked past review. KEEP such a finding, grounded, at the specialist's severity (it is NOT a DETECTED-IMPOSSIBLE drop). Do not let the removed test lower your confidence or move the finding to summary-only commentary.",
    "Do NOT, however, INVENT a finding for a pairing no specialist raised — the hallucination guard still applies. This rule only protects an EXISTING specialist finding from being waved through; it does not create new findings.",
  ].join("\n")
}
