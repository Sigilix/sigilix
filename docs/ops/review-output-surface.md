# Review output surface — Checks annotations vs PR comments (SIG-144)

Sigilix can deliver its findings on two GitHub surfaces:

1. **PR review comments** — the historical default. Rich markdown findings
   posted as inline review comments + a summary review (APPROVE /
   REQUEST_CHANGES). Lives in the PR **Conversation** tab.
2. **Checks annotations** — per-finding annotations (path/line/severity)
   that render inline in the **Files changed** tab and in the **Checks**
   UI, like CodeRabbit/Copilot. They survive force-pushes better and
   integrate with required-checks.

## Configuration

`OPENCLAW_REVIEW_OUTPUT_SURFACE` (secret/var on the Worker):

| Value           | PR review comments | Checks annotations |
|-----------------|--------------------|--------------------|
| unset / `comments` (default) | ✅ | ❌ |
| `both`          | ✅ | ✅ |
| `annotations`   | ❌ (verdict + summary only) | ✅ |

```sh
wrangler secret put OPENCLAW_REVIEW_OUTPUT_SURFACE   # then type: both
```

Parsing is case-insensitive + trimmed; anything unrecognized falls back to
`comments`, so a missing/typo'd flag is byte-for-byte the pre-SIG-144
behavior (annotations stay dark — the SIG-216 posture).

In `annotations` mode the formal review still submits so the verdict
(APPROVE / REQUEST_CHANGES) and any required-checks gating still work; the
review body just points the reader at the Files/Checks surface and the
per-finding **inline review comments are suppressed** (findings live in the
annotations).

## Implementation notes

- The two surfaces share the same finding-normalization layer
  (`buildBodyOnlyCheckAnnotations`) and diverge only at the output step
  (`completeCheckRun` posts annotations; the ensemble submits comments).
- **Plain text** (SIG-216 lesson): GitHub renders the annotation `message`
  field literally, so each annotation is sanitized
  (`toPlainTextAnnotation`) — markdown/HTML/badge `<img>` tags stripped —
  before posting. The rich markdown still lives in the PR review thread.
- **Batching**: GitHub caps `output.annotations[]` at 50 per request and
  *appends* across `PATCH /check-runs/{id}` calls, so findings are written
  in ≤50 batches.
- **Graceful degradation**: GitHub rejects the *entire* request if one
  annotation is invalid (stale line after a force-push, file no longer in
  the diff). On a batch rejection we re-post the survivors one at a time
  and drop only the offender — `pr-review-check-annotation-dropped` logs
  each drop. Annotations only post on a `success` conclusion; everything is
  best-effort and never disturbs the underlying review.

## Telemetry (Workers logs)

- `pr-review-check-annotations-posted` — `{ posted, requested }` per review.
- `pr-review-check-annotation-batch-failed` — a 50-batch PATCH was rejected
  (triggers the per-annotation retry).
- `pr-review-check-annotation-dropped` — a single annotation couldn't post
  (path/line included).
- `pr-review-check-annotation-prefilter-dropped` — count dropped before
  posting for missing path / bad line range.
- `pr-review-inline-comments-suppressed-for-annotations` — `annotations`
  mode suppressed N inline comments.

## Deploy-time verification (the non-dev gate)

These require a deployed Worker + a real PR (cannot be unit-tested):

1. Set `OPENCLAW_REVIEW_OUTPUT_SURFACE=both`, open a PR with ≥1 finding,
   confirm annotations appear inline in the **Files changed** tab AND in
   the **Checks** UI, alongside the usual review comments.
2. **Force-push scenario**: push a rewrite that shifts the line a finding
   anchored to, re-review, and confirm annotations re-post correctly /
   stale ones drop without failing the Check run
   (`pr-review-check-annotation-dropped` in logs, review still posts).
3. Try `annotations` mode and confirm inline comments are suppressed while
   the verdict + summary review still post.
