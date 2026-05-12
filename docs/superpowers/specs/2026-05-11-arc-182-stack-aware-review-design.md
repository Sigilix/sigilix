# ARC-182 — Stack-aware review context (Graphite-style PR stacks)

**Date:** 2026-05-11
**Owner:** Daniel Martinez Julio (CTO)
**Status:** Draft — awaiting Codex sign-off
**Estimate:** 4 pts
**Branch:** `arc-182`

## Context

Graphite-style PR stacks: a PR's base branch is another open PR's head branch. Reviewing each PR in isolation surfaces false-positive findings ("this code assumes X") when X is established earlier in the stack. Goal: detect stacks, give the reviewer-model stack-awareness, and tag findings by stack origin so the same Sigilix review on a 3-PR stack reads coherently across all three reviews.

## Acceptance criteria (from Linear ARC-182)

1. PR whose base branch matches another open PR's head branch is detected as stacked
2. Review prompt includes stack metadata (position, parent PR, child PRs, stack root, file overlap) before diff
3. Findings can be tagged with `stackOrigin: "current-pr" | "downstack-context" | "upstack-followup"`
4. No-stack PRs produce unchanged reviews
5. Sticky summary includes a "Stack context" block listing position + linked PR numbers
6. Done when: a 2-PR stack fixture produces a review that names the parent PR and avoids reporting parent-owned issues as introduced by the child

## Design

### Module map (new files)

```
src/lib/pr-stack.ts                 — pure stack detection + file overlap helpers (~200 LOC)
src/prompts/pr-stack-prompt.ts      — stack-context prompt block + instruction text
tests/lib/pr-stack.test.ts          — unit tests for detectStack + file overlap (~250 LOC)
tests/lib/pr-stack-rendering.test.ts — integration tests for sticky-summary rendering
```

### Modified files

```
src/lib/github.ts                       — add listOpenPullRequests()
src/lib/triage-pr-review.ts             — fetch stack context, inject into prompt, render summary block
src/lib/triage-pr-review-ensemble.ts    — same, propagated through specialist messages + synthesizer
src/lib/schemas.ts                       — add optional stackOrigin to PR_REVIEW_SCHEMA finding shape
src/prompts/pr-review.ts                 — document stackOrigin field + bump PROMPT_VERSION → "3"
src/prompts/pr-review-specialists.ts     — specialist + synthesizer prompt updates
```

### 1. GitHub API extension

```typescript
// src/lib/github.ts
interface ListOpenPullsItem {
  number: number
  title: string
  state: "open"
  user: { login: string } | null
  head: { ref: string; sha: string }
  base: { ref: string; sha: string }
}

async listOpenPullRequests(
  owner: string,
  repo: string,
  opts?: { signal?: AbortSignal; perPage?: number }
): Promise<ListOpenPullsItem[]>
```

Uses `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100`. Paginates via `Link: rel="next"` header (Sigilix already does this in `listPullRequestFiles`).

Cap: 200 open PRs total (2 pages). Stack detection on repos with >200 open PRs is unlikely to be useful — the stack relationship search would have too much noise.

### 2. Pure stack detection — `src/lib/pr-stack.ts`

```typescript
export interface StackPr {
  number: number
  title: string
  headRef: string
  baseRef: string
  author: string | null
}

export interface StackContext {
  isStacked: boolean
  /** 1-indexed position in stack (1 = root, depth = top of stack). */
  position: number
  /** Total PRs in this stack, including this PR. */
  depth: number
  /** Immediate downstack parent (this PR's base == parent's head). */
  parent: StackPr | null
  /** Full downstack chain, root → ... → parent. */
  ancestors: StackPr[]
  /** Immediate upstack children (their base == this PR's head). */
  children: StackPr[]
  /** Bottom of the stack (the PR whose base is not another open PR). */
  root: StackPr | null
}

export function detectStack(args: {
  currentPr: { number: number; title: string; headRef: string; baseRef: string; author: string | null }
  openPrs: ReadonlyArray<{
    number: number
    title: string
    user: { login: string } | null
    head: { ref: string }
    base: { ref: string }
  }>
}): StackContext

export function computeFileOverlap(args: {
  currentFiles: ReadonlyArray<string>
  parentFiles: ReadonlyArray<string>
}): {
  sharedCount: number
  parentOnlyCount: number
  currentOnlyCount: number
  sharedFiles: ReadonlyArray<string>
}
```

**Cycle protection.** GitHub allows a PR to have its base set to its own head (e.g., user error during a force-push). The detector caps the ancestor walk at 16 hops and emits a `console.warn` telemetry event if the cap is hit. Same cap on the children walk.

**Same-author preference.** When two open PRs have the current PR's head as their base (a "fork" upstack), we report all of them in `children` but order by author match (current PR's author first), then PR number. Rationale: Graphite stacks are virtually always single-author chains; cross-author "stacks" are rarely actual stacks.

**Sibling forks at downstack.** If multiple open PRs share the current PR's base ref as their head (unusual but possible), pick the one with the most recent activity timestamp. Tests cover this edge case.

### 3. Prompt block — `src/prompts/pr-stack-prompt.ts`

```typescript
export function renderStackPromptBlock(ctx: StackContext, overlap?: ReturnType<typeof computeFileOverlap>): string

export const STACK_AWARENESS_INSTRUCTION: string
```

`renderStackPromptBlock` returns one of two things:
- `""` (empty string) when `!isStacked` — caller can concat freely
- A formatted block:

```
[STACK CONTEXT]
This PR is position 2 of 3 in a Graphite-style stack.
- Parent (downstack): #41 "Add user model" by @daniel
- Children (upstack): #43 "Add user routes"
- Stack root: #41
- File overlap with parent: 3 of 5 changed files are shared with #41

Stack-awareness instructions:
- Tag each finding with stackOrigin:
  - "current-pr" — issue is introduced or maintained in this PR's diff
  - "downstack-context" — issue is already present in #41 (parent or earlier); REPORT IT but DO NOT describe it as introduced by this PR
  - "upstack-followup" — fix belongs in an upstack PR (#43 or later); flag for awareness, don't block on it here
- Default to "current-pr" when uncertain
```

`STACK_AWARENESS_INSTRUCTION` is the schema-side documentation appended to the PR_REVIEW_PROMPT system prompt (and specialist prompts) once.

### 4. Schema + finding shape updates

```typescript
// src/lib/triage-pr-review.ts
export type StackOrigin = "current-pr" | "downstack-context" | "upstack-followup"

export interface PrReviewFinding {
  path: string
  line: number
  startLine?: number
  score: number
  category: FindingCategory
  headline: string
  body: string
  stackOrigin?: StackOrigin   // NEW — optional; absent on no-stack PRs
}
```

```typescript
// src/lib/schemas.ts — PR_REVIEW_SCHEMA finding additions
stackOrigin: {
  type: "string",
  enum: ["current-pr", "downstack-context", "upstack-followup"],
}
// stackOrigin not in `required` — optional field
```

**Parser update.** `parsePrReviewResponse()` reads `stackOrigin` if present, validates against the enum, defaults to `"current-pr"` on schema-bypass (matches the existing default-to-"logic" pattern for category).

### 5. Single-model orchestration — `handlePrReview()`

In `handlePrReview()`:

```typescript
const [meta, diff, openPrs] = await Promise.all([
  client.getPullRequest(owner, repo, prNumber),
  client.getPullRequestDiff(owner, repo, prNumber),
  client.listOpenPullRequests(owner, repo).catch((err) => {
    // Best-effort: if open-PRs fetch fails (rate limit, network), fall
    // back to no-stack review. Telemetry, no throw.
    console.warn("[pr-stack] listOpenPullRequests failed, falling back to no-stack review", { err: String(err) })
    return [] as ListOpenPullsItem[]
  }),
])
// ... existing stale-head guard ...

const stack = detectStack({
  currentPr: {
    number: prNumber,
    title: meta.title ?? "",
    headRef: meta.head?.ref ?? "",
    baseRef: meta.base?.ref ?? "",
    author: meta.user?.login ?? null,
  },
  openPrs,
})

// File overlap is only fetched when stacked + parent exists
let overlap: ReturnType<typeof computeFileOverlap> | undefined
if (stack.isStacked && stack.parent) {
  const [currentFiles, parentFiles] = await Promise.all([
    client.listPullRequestFiles(owner, repo, prNumber),
    client.listPullRequestFiles(owner, repo, stack.parent.number).catch(() => []),
  ])
  overlap = computeFileOverlap({
    currentFiles: currentFiles.map((f) => f.filename),
    parentFiles: parentFiles.map((f) => f.filename),
  })
}

const prompt = buildPrompt({
  prNumber,
  title: meta.title,
  body: meta.body ?? "",
  diff,
  stack,
  overlap,
})
```

`buildPrompt` becomes:

```typescript
function buildPrompt(ctx: PromptCtx): string {
  const stackBlock = renderStackPromptBlock(ctx.stack, ctx.overlap)
  const sections = [
    "[SYSTEM INSTRUCTIONS]",
    PR_REVIEW_PROMPT.trim(),
    "",
    stackBlock ? stackBlock : null,  // only injected when stacked
    stackBlock ? "" : null,
    "[PR SCOPE]",
    `Number: #${ctx.prNumber}`,
    // ... rest unchanged ...
  ].filter((x): x is string => x !== null)
  return sections.join("\n")
}
```

### 6. Sticky-summary update — `formatReviewBody()`

Add a `### Stack context` section between `### Sigilix Summary` and `### Fix Plan`. Emitted only when `stack.isStacked`:

```
### Stack context

This PR is **#2 of 3** in a stack.

- ⬇ Parent: #41 "Add user model"
- ⬆ Child:  #43 "Add user routes"
```

The block links to PRs by `#N` (GitHub auto-renders cross-PR links inside the same repo).

### 7. Ensemble path — `triage-pr-review-ensemble.ts`

Same shape:
- Fetch stack context + overlap in `handlePrReviewEnsemble()`
- Pass through `SpecialistInitialMessageCtx` and `SynthesizerInitialMessageCtx`
- `buildSpecialistInitialMessage` and `buildSynthesizerInitialMessage` inject `renderStackPromptBlock(...)` between the existing retrieval-snapshot section and the namespace section
- Specialist + synthesizer prompts updated to document `stackOrigin` and stack-aware reasoning rules

### 8. PROMPT_VERSION bump

`PROMPT_VERSION` bumps from `"2"` → `"3"`. This triggers the ARC-184 stale-review detection on any review whose manifest stored `"2"` — the next webhook would naturally re-review the PR with the new stack-aware prompt and stack-tagged findings. Existing review-memory entries keyed on category/severity stay valid (the new field is additive, not overlapping).

The `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE` env aid (per ARC-189 spec §4.8) is intended to be set during the rollout window so existing reviews don't all flip to stale at once.

**Rollout env requirements** (per Codex sign-off correction):

- `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE=on` — enables suppression.
- `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE_SET_AT=$(date +%s)` — UNIX seconds at the moment of the `wrangler deploy` command. **Required companion** — without `SET_AT`, the ARC-189 §4.8 fail-closed branch fires `review-stale-prompt-version-suppress-misconfig { reason: "set-at-missing" }` and stale-marking proceeds normally, defeating the spike-mitigation goal.
- Both must be set in the same `wrangler secret put` step (or as a coordinated double-secret update).
- **Suppression filters only the `prompt-version` stale reason.** Head/base/file-list drift still marks stale during the rollout window. That's the intended behavior — the rollout aid is about smoothing the prompt-version-bump spike, not about freezing all stale-marking.
- **Remove the suppression after ~24 hours**, and before the 72-hour fail-safe expires. The 72-hour fail-safe is a backstop; relying on it instead of removing the secret leaves the system in a fail-closed state where the next bump becomes ambiguous.

### 9. Telemetry

Add to the existing `since(label)` pr-review log lines:

```typescript
console.log(JSON.stringify({
  event: "pr-stack-context",
  owner, repo, prNumber,
  isStacked: stack.isStacked,
  position: stack.position,
  depth: stack.depth,
  parentPrNumber: stack.parent?.number ?? null,
  childCount: stack.children.length,
  overlapShared: overlap?.sharedCount ?? null,
  overlapTotal: overlap ? overlap.sharedCount + overlap.currentOnlyCount : null,
}))
```

So we can later measure: what % of reviews are on stacked PRs, distribution of stack depth, how often the model uses `stackOrigin` tags non-trivially.

### 10. Tests

```
tests/lib/pr-stack.test.ts
  - detectStack: no-stack PR (empty + non-empty openPrs without chain)
  - detectStack: 2-PR stack (current is top, parent is root)
  - detectStack: 3-PR stack (current is middle)
  - detectStack: current is root (parent = null, children present)
  - detectStack: cyclic stack (A.base = B.head, B.base = A.head) — caps + warn
  - detectStack: same-author preference for forked upstack
  - detectStack: sibling forks at downstack (multiple PRs sharing base ref as head)
  - computeFileOverlap: empty inputs, full overlap, no overlap, partial

tests/lib/pr-stack-rendering.test.ts
  - renderStackPromptBlock: empty when not stacked
  - renderStackPromptBlock: formatted block with parent + children + overlap
  - formatReviewBody: emits "### Stack context" section when stacked
  - formatReviewBody: omits section when not stacked
  - existing buildReviewSubmission tests still pass (no-stack default)

tests/integration/arc-182-stack-fixture.test.ts (NEW)
  - 2-PR stack fixture: parent PR introduces user.ts, child PR adds routes that consume user.ts
  - Mock GitHub: listOpenPullRequests returns both PRs
  - Run handlePrReview against child PR
  - Assert: prompt contains stack context block naming #parent
  - Assert: model finding output (mocked Ollama) preserves stackOrigin field
  - Assert: review body contains "### Stack context" section
```

Total test additions: ~12 cases, ~400 LOC.

## Risks + mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| `listOpenPullRequests` rate limits on busy repos | Medium | Best-effort with `.catch` fallback — no-stack review is the degraded mode. Telemetry log on fail. |
| Model invents wrong `stackOrigin` tag (e.g., tags real issues as "downstack-context") | Medium | Prompt explicitly says "default to current-pr when uncertain". Parser defaults to "current-pr" on enum-miss. |
| Stack ambiguity (forks, siblings, cycles) | Low | Deterministic disambiguation rules + tests. Worst case degrades to no-stack. |
| ARC-184 manifest invalidation flood at deploy | Low-Med | `OPENCLAW_SUPPRESS_PROMPT_VERSION_STALE` env aid for rollout. |
| Existing review-memory entries break | Low | New field is additive; existing entries keyed on `(owner/repo, category, tier)` are not affected. |

## Rollout

1. Land arc-182 on `main` with feature on by default
2. Watch `pr-stack-context` telemetry for 24-48h on Sigilix's own repo
3. If isStacked rate is meaningful (Sigilix dev work uses stacks routinely), measure model adoption of `stackOrigin` tags
4. If model adoption is weak (<30% tag usage on stacked PRs after 50 reviews), iterate on the prompt block wording in a follow-up PR

## Out of scope (NOT in this PR)

- Graphite metadata file parsing (`.graphite_*` files) — we infer stack from open-PR base/head only, which works for any branching tool, not just Graphite
- Cross-repo stack detection (a PR in repo A whose base is a head in repo B) — not a real thing in GitHub-PR semantics
- Stack VISUALIZATION inside the inline finding bodies — only the sticky summary block + the per-finding `stackOrigin` tag are in scope
- Stack-aware deduplication (e.g., "if parent already reported issue X, don't repeat") — that's ARC-156-adjacent and a separate PR

## Codex sign-off ask

Please review this design for: (a) correctness of the stack-detection logic, especially edge cases (cycles, forks, same-author preference, sibling base-ref); (b) integration correctness for both the single-model AND ensemble paths; (c) any architectural concern about adding a third async fetch (`listOpenPullRequests`) to the critical path of every PR review; (d) whether the PROMPT_VERSION bump cadence interacts poorly with ARC-184 manifest invalidation; (e) any opinion on whether file-overlap fetch should be conditional on stack-depth > 1 rather than just `isStacked`.

Approve, request changes, or push back with specific concerns.
