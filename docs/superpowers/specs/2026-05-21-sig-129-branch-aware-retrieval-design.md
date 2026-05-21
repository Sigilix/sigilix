# SIG-129 — Branch-aware retrieval

**Status:** Design approved (founder delegated approach + rollout decisions 2026-05-21; approved architecture + v1 scope boundaries same day).
**Ticket:** [SIG-129](https://linear.app/sigilix/issue/SIG-129)
**Cluster:** indexer/retrieval-parity, item A of A–E.
**Builds on:** SIG-121 (#120, symbol-based retrieval), SIG-132 (#122, `<owner>/<repo>` namespace), SIG-133 (#121, split-not-drop chunker).

## Problem

The codebase index only covers the **default branch**. When reviewing a
PR, retrieval cannot surface symbols/functions/types the PR newly adds —
they don't exist on `main` yet. This produces two failure classes:

1. **False negatives** — issues in branch-only code that retrieval can't
   reach.
2. **Hallucinated criticisms** — "symbol doesn't exist" when the PR just
   added it.

Worst on large/stacked PRs whose diff exceeds the model's window.

SIG-121 partly mitigates: it extracts changed *symbol names* from the
diff and embeds them as an augmenting query — but that query still hits
the **main-only** Vectorize index, so a brand-new symbol returns
main-index neighbors instead of its own (branch-only) definition.

Industry comparison (from the ticket): CodeRabbit + Greptile inject
changed files into retrieval context; Sourcegraph Cody operates on the
working branch; Copilot uses merge-base context. **None re-index the
whole repo per PR** into a throwaway namespace — that is cost-prohibitive.
They overlay PR-head (changed-file) content onto a persistent index.

## Key finding

The PR-review ensemble **already fetches the full head content of every
changed JS/TS file** — it lives in `astFilesByPath`
(`triage-pr-review-ensemble.ts:1360`), built for AST rules + SIG-121
symbol extraction via `client.getFileContent(owner, repo, path, headSha)`.
The head content of new/changed code is therefore *already in memory at
review time*. The gap is purely in **retrieval**, not in fetching.

## Core model

> **Branch state = main Vectorize index (unchanged files) ∪ changed-file
> head content (overrides).**

The only place the PR branch diverges from `main` is its changed files.
Unchanged files are byte-identical to `main`, so the existing main index
already covers them. We build an **ephemeral, in-memory retrievable set**
from the changed-file head content we already hold, and merge it into each
retrieval pass with **head content winning on path collision**.

No new GitHub fetches, no Vectorize writes, no per-PR namespace lifecycle.
This is exactly the CodeRabbit/Greptile "inject changed files into
retrieval context" pattern, and it satisfies the ticket's acceptance
criteria at near-zero marginal cost.

### Approaches considered

| Approach | Verdict |
|---|---|
| **Changed-file head content overlaid on main** (chosen) | Cheapest; industry-standard; reuses already-fetched content; complete (unchanged files == main). |
| Full PR-head re-index into ephemeral namespace | Rejected — expensive/slow on a freshly-enabled prod indexer; Vectorize write/delete lifecycle + cleanup risk; redundant since unchanged files match main. |
| Merge-base delta index into a namespace | Rejected — still adds per-PR Vectorize lifecycle for content we already hold in memory. |

## Components

### 1. New module `src/lib/branch-retrieval.ts`

Self-contained, mostly pure, mirroring `symbol-retrieval.ts`'s shape.

| Export | Responsibility | Depends on |
|---|---|---|
| `buildBranchChunks(filesByPath)` | Chunk head content via the indexer's `chunkFile` (same `CHUNKER_VERSION=2`, 30-line/10-overlap windows) so chunks are comparable to indexed ones. | `indexer.chunkFile` |
| `embedBranchChunks(ai, chunks)` | One batched `embedTexts` call (same `@cf/baai/bge-base-en-v1.5` model as the index → vectors comparable). Cap at `MAX_BRANCH_CHUNKS` to bound payload + cosine cost. | `embeddings.embedTexts` |
| `retrieveBranchChunks(queryVector, branchVectors, topK)` | In-memory cosine over cached branch vectors → top-K `RetrievedChunk[]`. | pure |
| `mergeBranchAware(mainChunks, branchChunks)` | Union; dedup by `path` with **branch (head) winning**; re-rank by score. | pure |
| `shouldRunBranchAwareRetrieval(flag, filesByPath)` | Gate: flag `=== "on"` and at least one changed JS/TS file present. | pure |

**Correctness checkpoint (impl plan must verify, not assume):** local
cosine scores must be on the *same metric* as Vectorize's returned scores
so `mergeBranchAware`'s re-rank is fair. Confirm the
`OPENCLAW_CODE_INDEX` Vectorize index's distance metric and normalize
identically before ranking. This is a `verify-math`/`verify-algo`
checkpoint. If the metrics cannot be made directly comparable, fall back
to a path-collision override only (branch always wins for changed paths,
branch chunks appended for new paths) rather than score-interleaving.

### 2. Ensemble wiring (`triage-pr-review-ensemble.ts`)

- New env flag **`OPENCLAW_BRANCH_AWARE_RETRIEVAL`** (default off), read
  off `env` and surfaced through the gate.
- Extend the `astFilesByPath` fetch condition (`:1361`) so head content
  is fetched when this flag is on too:
  `(astRulesConfig.enabled || wantSymbolRetrieval || wantBranchAware)`.
- Build + embed branch chunks **once per review**, right after
  `astFilesByPath` is populated; cache the resulting vectors and reuse
  across all retrieval passes.
- `mergeBranchAware` wraps the results of:
  - the **shared preflight snapshot** (all specialists),
  - the **perf** pass (SIG-110),
  - the **symbol** pass (SIG-121),
  before `formatChunksForPrompt`. Because the preflight snapshot is shared,
  **every specialist becomes branch-aware** — correct, since any of them
  can hallucinate "symbol doesn't exist."

### 3. Telemetry (shadow → SIG-86)

Emit a `pr-review-branch-retrieval` event per review, shaped like
SIG-121's `pr-review-symbol-retrieval` so the SIG-86 aggregator ingests it
the same way: `branch_chunk_count`, `embed_elapsed_ms`, and the per-pass
`head_override_preflight` / `head_override_perf` / `head_override_symbol`
counts (main chunks displaced by the changed-path tombstone in each pass).
These per-pass override counts are the chosen branch-vs-main signal for
this event; no `jaccard` field is emitted here.

Flag-off ⇒ no fetch, no embed, no emission ⇒ **bake-off and dogwatch are
undisturbed.**

## Data flow

```
PR review (ensemble)
  └─ astFilesByPath  (changed JS/TS head content — already fetched)
       └─ buildBranchChunks → embedBranchChunks (1 batched AI.run, cached)
            └─ for each retrieval pass (preflight | perf | symbol):
                 mainChunks      = retrieveChunks(query)        [Vectorize, main]
                 branchChunks    = retrieveBranchChunks(qVec)   [in-memory cosine]
                 merged          = mergeBranchAware(main, branch) [head wins on path]
                 snapshot        = formatChunksForPrompt(merged)
```

## Error handling

Entirely best-effort, matching SIG-121:

- Embed failure / timeout → empty branch set → silent fall back to today's
  main-only behavior. Never fatal.
- Composed timeout (`RETRIEVAL_PREFLIGHT_TIMEOUT_MS`); rethrow only on
  `orchCtrl` abort.
- The branch embed is **one `AI.run`, not a Vectorize query**, so it does
  **not** consume the per-PR `retrieve_codebase` call budget.
- `MAX_BRANCH_CHUNKS` cap bounds the embed payload and cosine cost on
  large/stacked PRs.

## Testing

Unit-only (pure functions + mocked `AI` binding):

- `buildBranchChunks` matches `chunkFile` windowing.
- chunk → embed → cosine ranking returns expected order (mocked vectors).
- `mergeBranchAware`: head-wins on path collision, dedup, re-rank, empty
  sides.
- `shouldRunBranchAwareRetrieval` gate (flag on/off, no JS/TS files).
- failure fallbacks (embed throws → empty set, main-only preserved).
- **Acceptance-criterion fixture:** a changed file adds
  `export function fooBar`; assert it is retrievable via the branch set
  and overrides any stale main copy of the same path.

## Scope boundaries (v1 — approved)

1. **JS/TS changed files only** — reuse the existing `astFilesByPath`
   (`jsTsPaths`); **zero** extra GitHub fetches. Broadening to other text
   files is a follow-up.
2. **Pre-computed ensemble snapshots only** — the live agent-loop
   `retrieve_codebase` tool stays main-only in v1 (mid-loop, harder to
   thread). Follow-up.
3. **Flag default off**, shadow telemetry only, until the SIG-86 bake-off
   shows the FN/hallucination reduction.

## Acceptance criteria (from ticket)

- [x design] A PR that adds a new exported symbol can retrieve and
  reference that symbol during review — covered by the branch set +
  acceptance fixture.
- [ ] Measurable reduction in false-negative / hallucination rates on a
  sample — via the shadow `pr-review-branch-retrieval` telemetry feeding
  the SIG-86 aggregator before the flag is flipped on.
