# SIG-392 — inline-first: promote anchorable PR-scoped findings to inline

## Problem (runner#25)

The synth scoped a line-specific testing finding (untested error paths,
run_pylint.sh:60-67, a NEW file = fully anchorable) as `scope:"pr"`, so the
engine routed it to the review body. Investigation ruled out every gate
(security reclass = sev≥4 security; tests-coverage = score≥4; inline-grounding
= shadow in prod) and anchorability (new file, 25KB diff under the 80KB cap).
Root cause: model under-anchoring — `normalizeFindingScopeForAnchorability`
deliberately left `scope:"pr"` alone ("unanchorable by definition"), but the
synth demonstrably emits pr-scoped findings WITH concrete anchors.

## Change

`normalizeFindingScopeForAnchorability` (validation-internals.ts): `pr` joins
`file`/scope-omitted as a promotion candidate. Only `comment` (GitHub
bot-command behavior) and already-`line` short-circuit. A pr finding with a
concrete `line`/`startLine` range that resolves to a RIGHT-side reviewable
hunk flips to `scope:"line"` → renders inline. The existing
`pr-review-scope-normalized-to-line` telemetry now also fires with
`fromScope:"pr"`.

Founder directive: ANY anchorable finding goes inline. A genuine PR-level
finding (no line, or a line not in a RIGHT hunk) still falls through to the
body unchanged — promotion is anchorability-gated, not blanket.

## Safety

- Identical anchorability test + 422-safety as the file-scope path (SIG-216:
  any range line in a RIGHT hunk suffices; LEFT-only stays in body).
- Gates run on category/provenance/score, not scope — promoting scope changes
  only final rendering, no gate is skipped.
- The two old assertions ("leaves pr scope alone", "genuine pr-level when line
  not in hunk") are replaced/kept to pin both the promotion and the
  pass-through.

## Tests

validate-scope.test.ts: pr+anchorable → inline (flip telemetry fromScope:pr);
pr+line-not-in-hunk → stays body, no flip. Full build green (6952).
