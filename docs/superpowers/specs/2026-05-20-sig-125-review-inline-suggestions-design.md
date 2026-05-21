# SIG-125 — Actionable code suggestions in proactive review

**Status:** Design approved (founder delegated final design decisions 2026-05-20).
**Ticket:** [SIG-125](https://linear.app/sigilix/issue/SIG-125)
**Spun off from:** SIG-110 PR B (#118).

## Problem

~60% of Sigilix's proactive-review inline findings carry a useful prose
description but **no concrete code change** — the reviewer learns what's
wrong but gets no patch. The one-click `` ```suggestion `` machinery
already exists, but only in `/sigilix improve` (`triage-pr-improve.ts` +
`filterAnchorableSuggestions`). The proactive review path renders prose
through `formatFindingComment` (`triage-pr-review.ts:1216`):
`PR_REVIEW_SCHEMA` has no replacement field, and the specialist prompt
asks for the fix in prose ("End with the minimal fix"). A review finding
therefore *structurally cannot* contain a code change today.

## Goal

Mirror CodeRabbit: a review finding should show the actual proposed code
change inline, and offer one-click commit when it is safe to do so.

## Two-tier behavior (founder ruling)

1. **Always — when a localized fix exists:** render the proposed
   replacement as a **non-committable** fenced `` ```<lang> `` block in
   the inline comment (`<lang>` inferred from the file extension). This is
   the "actual code change" that is missing today; it is always shown
   when the model produced one.
2. **High-confidence only:** when the per-finding `confidence >= 4` AND
   the replacement anchors cleanly (a contiguous RIGHT-side range on the
   PR's changed lines), upgrade the snippet to a **committable**
   `` ```suggestion `` block — the one-click "Commit suggestion" button.
3. **No localizable fix** (testing, architecture, multi-hunk): prose only,
   exactly as today.

Rationale: a *wrong* one-click suggestion is worse than prose (a reviewer
clicks "Commit suggestion" and breaks their code), so the committable
tier is gated on high confidence + clean anchoring. The non-committable
snippet is informational, so it has no confidence gate.

## Approach (decided)

Generate the replacement **inline in the existing specialists/synth** —
**no extra model call.** The review orchestrator already runs at ~885s of
its 895s wall-clock budget; a post-synthesis enrichment call (the
`/improve` model) was rejected on that constraint.

Add an **optional structured field** `suggestedReplacement?: string` to
the finding shape — the exact replacement lines for the finding's already
anchored range `[startLine ?? line, line]`. Sigilix renders and validates
it; we do NOT accept a model-authored `` ```suggestion `` fence (keeps
rendering consistent and the prose body separate from the patch).

## Components

### 1. Schema + types
- `PrReviewFinding` (`triage-pr-review.ts`): add `suggestedReplacement?: string`.
- `PR_REVIEW_SCHEMA` (`schemas.ts`): add `suggestedReplacement: { type: "string" }`
  to the findings item properties so schema-constrained decode can emit it.
- Parser (`parsePrReviewResponse` / the finding finalizer ~`triage-pr-review.ts:461`):
  read it as a trimmed scalar string; drop empty.

### 2. Generation (prompt)
- Specialist prompt (`pr-review-specialists.ts`, `SHARED_OUTPUT_INSTRUCTIONS`
  + per-role guidance): instruct emitting `suggestedReplacement` ONLY when
  the fix is a **contiguous edit** to the finding's anchored line range,
  containing the EXACT new code for that range (no diff markers, no fence —
  raw replacement lines). Omit it for testing/architecture/multi-hunk fixes.
- Synthesizer prompt (`SYNTHESIZER_PROMPT`): **preserve `suggestedReplacement`
  verbatim** from the kept source finding (same pattern just established for
  `complexityEstimate` / `hotPathIdentifier`). Synth may rewrite the prose
  body but must not alter the replacement.

### 3. Rendering — `formatFindingComment`
Given a finding with a non-empty `suggestedReplacement`:
- **Committable tier:** if `confidence >= 4` AND the finding's range is a
  contiguous RIGHT-side range on changed lines (`isContiguousRightRange`,
  reused from `triage-pr-improve.ts`), append a `` ```suggestion `` block
  whose content is `suggestedReplacement`.
- **Snippet tier (otherwise):** append a non-committable fenced
  `` ```<lang> `` block (lang from file extension via a small
  `extensionToFenceLang` helper) under a short "Proposed change" label.
- **No field:** prose only (unchanged path).

The anchoring check needs the diff's reviewable-position map (the same
`ReviewableMap` the comment-building code in `triage-pr-review.ts` already
has in scope). `formatFindingComment` gains an optional anchoring argument;
callers that don't have it (if any) fall back to the snippet tier.

### 4. Safety / validation
- Reuse `isContiguousRightRange` (and `hasSuggestionBlock` where useful)
  from `triage-pr-improve.ts` — extract to a shared module if importing
  across files is awkward.
- **422 fallback:** GitHub rejects the *entire* review if one committable
  suggestion is not applicable. Keep the existing review-submit fallback:
  on a 422, re-render the offending finding's committable block as the
  non-committable snippet and retry / fall back to a top-level comment
  (mirror `/improve`'s 422 path). A bad suggestion must never fail the
  review.

### 5. Versioning + tests
- Bump `PROMPT_VERSION` (output shape changed; reviews go stale on deploy —
  use `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE` during rollout).
- Unit tests:
  - two-tier selection matrix: {has replacement, no replacement} ×
    {confidence ≥4, <4} × {anchorable, not} → committable / snippet / prose.
  - schema + parser round-trip (trim, drop-empty).
  - synth preservation of `suggestedReplacement`.
  - `extensionToFenceLang` mapping.

## Data flow

```text
specialist verdict (suggestedReplacement?)  ── parsed/finalized ──▶
  synth verdict (suggestedReplacement preserved) ── finalized ──▶
    formatFindingComment(finding, confidence, anchoring?)
        confidence>=4 && contiguous-RIGHT-range  ─▶  ```suggestion (committable)
        else (replacement present)                ─▶  ```<lang>     (snippet)
        else                                       ─▶  prose only
    └─ submitReview ── 422? ─▶ downgrade committable→snippet, retry/fallback
```

## Out of scope (YAGNI)

- Single-hunk committable only (GitHub's `` ```suggestion `` constraint).
- No multi-file or multi-hunk suggestions.
- No extra model call; no separate enrichment pass.
- No change to `/sigilix improve`.

## Risks

- **Synth-preservation burden:** another field synth must carry verbatim.
  Mitigated by the existing pattern + a preservation unit test.
- **Confidently-wrong committable suggestion:** mitigated by the
  `confidence >= 4` gate + clean-anchoring requirement + the 422 fallback.
  The snippet tier is informational, so a wrong snippet is no worse than a
  wrong prose suggestion.
- **Prompt bloat:** one more output field + instruction on the already
  large review prompt; kept to a few lines.
