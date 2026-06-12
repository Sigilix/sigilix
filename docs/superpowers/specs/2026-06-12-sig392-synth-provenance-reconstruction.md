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
AND headline token-Jaccard >= 0.25 (reuse the near-dup-collapse tokenizer);
`sourceFindingIds` = matched source ids (ascending). `dropped: []`,
`softened: []`. A verdict finding matching NO source gets `sourceFindingIds:
[]`.

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
