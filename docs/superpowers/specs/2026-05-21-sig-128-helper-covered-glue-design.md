# SIG-128 — Credit orchestrator glue covered by tested helpers

**Status:** Design approved (founder approved mechanism + detection precision 2026-05-21; revised per Codex architecture review same day, re-approved).
**Ticket:** [SIG-128](https://linear.app/sigilix/issue/SIG-128)
**Project:** Sigilix Engine. Lower priority than SIG-127 (noise, not blocking).
**Builds on:** SIG-113 (testing-evidence pack + citation gate), SIG-111 (tests specificity gate), SIG-121 (acorn AST infra: `parseSource`/`walkAst`/`buildChangedLines`).

## Problem

The tests specialist over-fires a sev≥4 **"needs integration tests"** finding on
orchestrator/glue files (e.g. `src/lib/triage-pr-review-ensemble.ts`) even when
the new wiring's decision logic is **extracted into pure helpers that have
sibling unit tests in the same PR**. Recurred on PR #119 (SIG-125), #120
(SIG-121), and #123 (SIG-129) — skipped-with-rationale each time, and it cost a
fix-up round on #123.

Why it survives both existing gates: the orchestrator has **no sibling test
file**, so the testing-evidence pack emits a *real*
`siblingMapping:<orchestrator>->NONE`. A finding citing that real `->NONE`:

- passes the **SIG-113 citation gate** (`evaluateTestingFindingCitation`) — the
  `->NONE` is real, and
- passes the **SIG-111 specificity gate** (`evaluateTestFinding`) — it's the
  missing-coverage class and `citesRealMissingCoverage()` is true (the `->NONE`
  resolves) → **KEEP**.

Neither gate can tell that the orchestrator's new logic is exercised through
extracted helpers that *do* have sibling tests in the same PR.

## Approach (decided + Codex-reviewed)

Deterministic **pack-credit + validator gate**, shadow-first — matching the
existing SIG-111/113 "pre-LLM evidence + post-LLM gate" architecture. A
no-sibling-test source file earns a **helper-coverage status** describing how
much of its substantive added code delegates to same-PR tested helpers. The
status is surfaced to the specialist as evidence and gates a new validator
reject path.

**Codex architecture review (2026-05-21) hardened the original boolean design.**
The key correction: file-level boolean suppression creates false negatives (one
delegating line would suppress a finding even when the PR also added genuinely
untested inline logic). The accepted shape:

> Per-source **tri-state status** (`all` / `partial` / `none`). **Suppress only
> `all`**; render `partial` as informational evidence that NEVER drops a
> finding.

### Definitions

- **Substantive added line** — an added (`+`) line in the file's diff, after
  excluding: import/export-only lines, type-only declarations, comment-only
  lines, blank lines, and lines that are pure punctuation (`}`, `)`, `};`,
  etc.). These are the lines that carry executable logic.
- **Tested helper (same-PR)** — a source module `Y` that appears in the pack's
  `siblingMappings` with a **non-null** sibling test (`Y -> tests/Y.test.ts`).
- **Delegating line** — a substantive added line that references a symbol
  imported into this file from a tested-helper module `Y`, **and** that symbol
  appears in `Y`'s sibling-test content (already fetched into the pack via
  `inspectedTestFileContents`). The test-content cross-check is what upgrades
  "imports a tested helper" into "the specific delegated symbol is exercised by
  a test" (Codex HIGH #2).
- **Status:**
  - `all` — there is ≥1 substantive added line AND **every** substantive added
    line is a delegating line.
  - `partial` — some but not all substantive added lines delegate.
  - `none` — zero delegating lines, no substantive added lines, or the data
    needed to decide is incomplete (**fail closed** — never `all`).

## Components

### 1. New pure module `src/lib/helper-coverage.ts`

```
detectHelperCoverage(args: {
  filesByPath: ReadonlyMap<string, string>   // changed JS/TS head content
  addedLineTextByPath: ReadonlyMap<string, ReadonlyMap<number, string>>  // per-file added-line TEXT from buildAddedLineTextByLine(fullDiff)
  siblingMappings: readonly TestingSiblingMapping[]
  testContentByPath: Record<string, string>   // inspected sibling-test content
}): { coverageBySource: Record<string, HelperCoverage> }

interface HelperCoverage { status: "all" | "partial" | "none"; helpers: string[] }
```

For each source with a `->NONE` mapping:
1. Parse it with acorn (`parseSource`); on parse failure → `none` (fail closed).
2. Extract import bindings: for each `ImportDeclaration`, resolve the specifier
   to a repo path and collect the local names it binds (default, named,
   namespace; **skip type-only imports**).
3. Keep only imports resolving to a **tested-helper** source (in
   `siblingMappings` with non-null test). Build a map `localName -> helperSource`.
4. Compute the file's substantive added lines (added-line set ∩ non-trivial
   lines). If the file's full added-line set isn't available → `none`.
5. A substantive line is **delegating** iff it references a `localName` from
   step 3 whose symbol also appears in the helper's sibling-test content
   (`testContentByPath[helper's test]`). Reference detection: identifier match
   on the line (token-boundary), not substring.
6. Status from the delegating-vs-substantive counts per the definitions above.
7. `helpers` = the distinct tested-helper sources that contributed delegating
   lines (for the prompt detail). Never throws — any internal failure for a
   file yields `none` for that file.

**Import resolution** (`resolveImportToRepoPath`, pure, exported for tests) must
handle: relative specifiers (`./x`, `../lib/x`), extensionless imports,
`.js`→`.ts`, `.tsx/.mts/.cts`, and `index.ts` directory imports. Resolve
relative to the importing file's directory, normalize, then match against the
tested-source set by comparing extension-stripped paths. **Ambiguity → no
match (fail closed).** Non-relative/bare specifiers (npm packages) never match.

### 2. Pack extension (`testing-evidence-pack.ts`)

Add `helperCoverageBySource: Record<string, HelperCoverage>` to
`TestingEvidencePack` (default `{}`). Populated at orchestrator level via a new
`mergeHelperCoverage(pack, coverage)` (mirrors `mergeInspectedTestFileContents`)
— detection needs file content + diff that the pure `buildTestingEvidencePack`
doesn't receive.

### 3. Orchestrator wiring (`triage-pr-review-ensemble.ts`)

- Ensure the changed JS/TS head content is available to detection. `astFilesByPath`
  is already gated by `(astRulesConfig.enabled || wantSymbolRetrieval ||
  wantBranchAware)`; helper-coverage detection runs whenever a testing-evidence
  pack is built with ≥1 `->NONE` source, so add its need to that fetch condition
  (or reuse `astFilesByPath` when already populated and skip otherwise →
  `none`, fail closed).
- **Diff-basis consistency (Codex MED):** the testing pack is built from the
  full post-filter inventory, so detection reads its per-file added-line TEXT
  map from `buildAddedLineTextByLine(fullDiff)` (the FULL diff, not the
  possibly-truncated first-batch `diff`). Detection must use a changed-line basis
  consistent with the file content it parses. If a `->NONE` source's complete
  added-line set isn't represented in the available diff (truncated / later
  batch), that file fails closed to `none`. (Implementation plan pins which
  diff variable is the reliable basis.)
- Call `detectHelperCoverage`, then `mergeHelperCoverage` into the pack before
  `renderTestingEvidenceBlock`.

### 4. Evidence-block render (`renderTestingEvidenceBlock`)

For a `->NONE` source, replace the bare "← no sibling test file in this PR":
- `all` → "← no sibling test file, but ALL changed logic here delegates to
  helpers unit-tested in this PR: `branch-retrieval.ts` (← `tests/branch-retrieval.test.ts`)".
- `partial` → "← no sibling test file; SOME changed lines call tested helpers
  (`…`), others add inline logic — judge accordingly."
- `none` → unchanged (current text).

**Informational only.** It does not instruct the model to suppress; the hard
drop lives solely in the shadow-gated validator. This keeps the live prompt
change FP-safe (a genuine untested-logic finding can still fire).

### 5. Validator reject path (`validate-test-finding.ts`)

In `evaluateTestFinding`, **inside the missing-coverage branch, before the
`citesRealMissingCoverage` keep** (and after the deletion/rename + real
`coverageGap` keeps, which stay earlier): if `pack.helperCoverageBySource[finding.path]?.status === "all"`,
return `{ keep: false, reason: "glue-covered-by-helper" }`. Add that to
`TestDropReason`.

Scope (FP-safety): only the **sev≥4 missing-coverage `->NONE` class** on an
`all`-status file is affected. Insufficient-test findings, coverage-gap-cited
findings, deletion/rename findings, `partial`/`none` files, and `<4` findings
are all untouched. Rides the existing `OPENCLAW_TESTS_VALIDATOR_MODE`
(shadow default → telemeter the would-drop; enforce → drop).

## Data flow

```
full diff inventory ─ buildTestingEvidencePack ─→ pack (siblingMappings, ->NONE sources)
astFilesByPath + buildAddedLineTextByLine(fullDiff) + inspected test content
        └─ detectHelperCoverage ─→ coverageBySource {source: all|partial|none}
                └─ mergeHelperCoverage(pack, …) ─→ pack.helperCoverageBySource
                        ├─ renderTestingEvidenceBlock  (all/partial annotation, informational)
                        └─ evaluateTestFinding         (drop ->NONE finding iff status==="all", shadow-gated)
```

## Error handling

- `detectHelperCoverage` never throws; any per-file failure (parse error, missing
  content, unresolved imports, incomplete changed-line basis) → that source is
  `none` (fail closed — never suppresses).
- Pack/validator changes are back-compatible: absent `helperCoverageBySource`
  (older callers) behaves as all-`none` → no new drops.
- The drop is shadow-gated; shadow telemetry records the would-drop with reason
  `glue-covered-by-helper` for the SIG-86 aggregator before any enforce flip.

## Testing

Pure-unit (no I/O; mocked content + mappings):

- **detection — `all`:** orchestrator whose every substantive added line calls a
  same-PR tested helper (the SIG-129 ensemble shape) → `all`.
- **detection — `partial`:** some lines delegate, others add inline branching →
  `partial`.
- **detection — `none` (true positive preserved):** added inline logic with no
  tested-helper delegation → `none`.
- **detection — fail-closed:** parse failure, missing content, or
  imports-tested-helper-but-test-content-doesn't-reference-the-symbol → not `all`.
- **resolver:** extensionless / `.js`→`.ts` / `index.ts` / type-only-skipped /
  bare-package-ignored / ambiguous→no-match.
- **render:** `all` and `partial` annotations; `none` unchanged.
- **validator:** `all`-status `->NONE` finding → drop (`glue-covered-by-helper`)
  in enforce, keep in shadow; `partial`/`none` → unchanged; insufficient-test and
  coverageGap findings → unchanged.

## Acceptance criteria (from ticket)

- [ ] Tests specialist no longer fires "needs integration tests" on orchestrator
  glue when the called helpers have sibling unit tests in the diff — covered by
  the `all`-status drop, verified against the #119/#120/#123 recurrence shapes.
- [ ] Testing-evidence pack credits "logic extracted into a tested pure helper"
  as coverage for the calling site — the `all`/`partial` annotation + the
  validator gate.
- [ ] Existing true-positive findings (genuinely untested logic) still caught —
  `none`/`partial` files are never suppressed; verified against a genuinely-
  untested fixture.

## Scope boundaries (v1)

- JS/TS files only (acorn). Non-JS/TS `->NONE` sources → `none`.
- Same-PR tested helpers only (a helper tested in a *prior* PR isn't credited —
  its sibling test isn't in this diff). Acceptable: the recurrence is always
  same-PR extraction.
- Shadow default; no enforce flip until the recurrence + genuinely-untested
  verification passes in shadow telemetry.
