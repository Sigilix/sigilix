# SIG-392 — synth provenance reconstruction (gemma large-payload recovery)

## Problem (captured live)

On large synth payloads (61-finding resweep union) gemma4:31b emits a VALID
verdict (16 findings) but OMITS the `provenance` block entirely (`provType:
undefined`), ~17-50% of attempts. `parseSynthAnswer` hard-rejects (provenance
invalid → null), so the ladder falls back to deepseek-v4-flash. Net: the
better/cheaper synth's good verdict is discarded on exactly the dense PRs
re-sweep produces. Diagnosis ruled OUT the dangerous case (index
misalignment) — the verdict is intact; only the provenance metadata is gone.

## Change — reconstruct provenance from sources at the parse seam

`parseSynthAnswer(content, sources?)`: when the verdict parses but provenance
is absent/invalid AND `sources` is provided, RECONSTRUCT provenance instead of
returning null. `sources` = flat `{id, path, line, headline}[]` from the
synth-input specialist verdicts, threaded via `SynthesizerRunArgs`.

Reconstruction (pure, `domain/synth-provenance-reconstruct.ts`): for each
verdict finding, match source findings by `path` AND `|line - srcLine| <= 5`
(line proximity only — NOT headline). `sourceFindingIds` = co-located source
ids (ascending); `dropped: []`; `softened` omitted. A verdict finding matching
NO source gets `sourceFindingIds: []`.

**Matcher decision (revised from the original draft):** headline token-Jaccard
was REJECTED as a match gate — the synth rewrites wording, so a real rephrased
finding would score below any threshold and be wrongly dropped (a recall
regression). Co-location alone answers the guard's question. Trade-off
recorded below.

## Recall/precision safety (the trust-model argument)

- Reconstructed ids are REAL specialist ids (pulled from the source list), so
  the hallucination guard (`every sourceFindingId references a real source`)
  passes for matched findings — same as honest provenance.
- A verdict finding matching NO source → empty `sourceFindingIds` → the
  hallucination guard drops it. This is CORRECT: a synth finding with no
  traceable source IS a hallucination by the guard's own definition. So
  reconstruction CANNOT let an ungrounded finding through — it drops the
  unmatched ones exactly as the guard intends.
- Mis-attribution risk (assigning a wrong-but-real id): the guard only asks
  "does a real source exist"; a content-matched real id answers that
  correctly. Worst case is a slightly-off displayed source — not a
  correctness/security regression.
- Only fires when the verdict ALREADY parsed cleanly — garbage output still
  returns null → normal retry/fallback.

**Known precision hole (code review #501, rated LOW / acceptable):** when TWO
distinct bugs co-locate (same path, ±5 lines — e.g. the webhook
idempotency + event-type pair) and gemma both omits provenance AND emits both,
a verdict finding gets BOTH source ids; the downstream evidence backfill
(`buildFindingEvidenceRecord` / `backfillIndependentAssessmentFromSources`)
could then copy the wrong source's CWE/evidence/rationale onto a real finding.
This is a misattributed label on a GROUNDED finding, never a fabricated finding
(the guard contract — "a real source exists nearby" — still holds), and is
strictly tighter than the deepseek-fallback baseline it replaces. **Probe-gated
follow-up:** if the next dense probe shows reconstruction firing often on
multi-bug-per-line payloads, add headline-Jaccard as a TIEBREAKER (rank
co-located sources, prefer the semantic match; keep all only when none clearly
wins) — NOT as a gate. Deferred because a mistuned tiebreaker can wrongly drop
a real source (the correct source often scores ~0.2 on synth-reworded
headlines), which is worse than the bounded mislabel.

## Telemetry + gating

Telemetry `pr-review-synth-provenance-reconstructed` (verdictFindings,
matched, unmatchedDropped). Gating: OPEN QUESTION for sign-off — flag it
(off/on, prod on) or ship unflagged (it strictly improves on the current
deepseek fallback and is recall-safe). Recovery path only; rollback = revert.

## Tests

Unit: omitted-provenance + sources → reconstructed (matched finding gets its
real source id; unmatched finding gets []). Valid provenance → untouched
(passes through, no reconstruction). No sources → null (current behavior).
Garbage verdict → null. Live behavior measured by the next dense probe.
