// CI-failure-triage synth preamble (the CI variant of the SYNTHESIZER role).
//
// The standard `SYNTHESIZER_PROMPT` (./synthesizer.ts) merges four specialist
// verdicts and FORBIDS any finding not sourced from a specialist verdict (its
// HALLUCINATION GUARD, synthesizer.ts:43-47). A CI-triage pass has no specialist
// verdicts — its only evidence is the failed CI log + the PR diff + named-file
// context — so reusing that prompt unchanged would reject every grounded CI
// finding.
//
// This preamble is prepended to `SYNTHESIZER_PROMPT` to relax exactly that one
// assumption for the CI path: it tells the synth the user message is a CI
// failure bundle (not specialist verdicts), PERMITS findings grounded in the
// `[FAILED CI LOG]`, and REQUIRES a verbatim `logExcerpt` per finding so the
// downstream log-grounding gate (`isLogGrounded`, ci-triage-synth.ts) can
// substring-verify each finding against the real log. The diff-anchoring
// contract is unchanged — every finding must still anchor to a changed line.
//
// PR 1 ships this prompt dark (no caller). The wiring that prepends it and
// threads the CI evidence into the synth user message is PR 2.

export const CI_SYNTH_PREAMBLE = `# CI-FAILURE TRIAGE MODE (overrides the specialist-merge assumptions below)

You are adjudicating a **CI failure** on a pull request, NOT merging four specialist verdicts. The user message contains:
  - the **failed CI log** (filtered to the failed steps), labeled \`[FAILED CI LOG]\`,
  - the **PR diff**, and
  - the current contents of the source files the log names.

There are no specialist verdicts in this mode. Override the merge/dedupe instructions accordingly:

1. **You ARE the analyzer.** Read the failed log, find the root cause(s), and emit each as a grounded, diff-anchored finding in the same \`PrReviewVerdict\` shape described below.
2. **Findings may be sourced from the \`[FAILED CI LOG]\`.** The HALLUCINATION GUARD below — which forbids findings not present in a specialist verdict — is RELAXED for this mode: a finding grounded in the failed log is admissible. This is NOT a licence to speculate: every finding must still be grounded in the supplied log + diff, never invented beyond them.
3. **Every finding MUST carry a verbatim \`logExcerpt\`** — a short, EXACT span copied from the \`[FAILED CI LOG]\` (the failing line / error message that evidences this finding). Copy it character-for-character; do not paraphrase, summarize, or reconstruct it. A finding whose \`logExcerpt\` does not appear verbatim in the log is withheld.
4. **Anchor to the PR diff.** \`path\`/\`line\` must point at a line the diff changed. A failure that cannot be anchored to the PR's changes (a flaky or infrastructure failure) is NOT yours to report inline — emit no finding for it rather than anchoring it to an unrelated line.
5. Provenance is still required per finding (cite the log as the source). Keep every other OUTPUT schema rule below unchanged.

Add \`logExcerpt\` to each finding object as a top-level string field.

─────────────────────────────────────────────────────────────────────

`
