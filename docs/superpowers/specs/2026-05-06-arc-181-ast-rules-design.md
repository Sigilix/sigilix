# ARC-181 — AST rule-pack scanner before LLM (JS/TS) — design spec

**Status:** v2 — fully dual-signed-off (Codex APPROVE-WITH-CHANGES + Kimi APPROVE-WITH-CHANGES; all BLOCKING + MAJOR + MINOR addressed; one disagreement resolved in favor of Codex's cautious-rollout posture)
**Linear:** [ARC-181](https://linear.app/arc-and-anchor/issue/ARC-181/ast-rule-pack-scanner-before-llm-jsts)
**Branch:** `arc-181-ast-rules`
**Sibling pre-LLM scanners (already shipped):**
- ARC-187 secret scan (regex-based)
- ARC-193 deterministic regex checks (per-repo regex via `sigilix.json`)
- ARC-186 dep-vuln scan (manifest + advisory DB lookup)

---

## 1. Problem

Sigilix's existing pre-LLM scanners (regex secret-scan, regex deterministic-checks, dep-vuln lookup) all operate on **flat patterns**. They miss syntax-aware anti-patterns where the bug lives in the *shape* of the code, not its bytes:

- `eval(userInput)` is dangerous; `eval` inside a comment or string literal is not.
- `child_process.exec(cmd, { shell: true })` is risky; `exec(cmd)` with the default shape is fine.
- An `async` handler with no `try/catch` whose body throws is an unhandled-rejection bomb.

A regex matching `eval(` produces false positives on every test fixture and JSDoc reference. ARC-181 closes the gap with a **lightweight AST scanner** that runs before the LLM specialist fanout, mirroring the ARC-187/193/186 pre-LLM facts pattern.

## 2. Acceptance criteria (refined for v1)

- [ ] AST scan runs **before** the LLM specialist fanout on JS/TS changed files.
- [ ] **10 curated rules** ship in v1 (5 security + 5 correctness) per Linear AC.
- [ ] Findings flow as structured evidence to the security/perf/logic specialist prompts: `{ ruleId, severity, path, line, column, message, evidence, roleHint }`.
- [ ] **Auto-inline posting is opt-IN via `astRules.autoInline: true`** (default `false` for v1 cautious rollout; Codex BLOCKING #1). When opted in, `error`-severity findings post inline review comments without LLM intermediation; positions come from the existing `parseDiffToReviewablePositions` infrastructure (Codex BLOCKING #2). When opt-out, the prompt-injection path still runs and the LLM remains the sole comment author. Default flips to `true` after 2 weeks of telemetry shows aggregate FP rate < 5% (Kimi §10.5).
- [ ] Synthesizer dedupes AST findings vs LLM findings at the same `(path, line, ruleId-topic)` so reviewers don't see two voices saying the same thing.
- [ ] Per-rule disable via `sigilix.json`:
  ```json
  { "astRules": {
      "enabled": false,                                // hard kill-switch (default: true)
      "severityThreshold": "info",                     // info | warning | error (default: "info" reserved for future use, treated as no-op below "warning")
      "disabledRules": ["no-await-in-loop"],           // string[] of ruleId
      "autoInline": true                               // opt-IN to deterministic inline posting (default: false; flips after FP-telemetry review)
  } }
  ```
- [ ] **3+ positive + 3+ negative test fixtures per rule** (the AC says "3+ positive + 3+ negative test fixtures" — interpreted as 3+ positives + 3+ negatives **across the rule pack**, but v1 ships per-rule for confidence; sign-off may relax).

## 3. Scope decisions (lock before plan)

### 3.1 Parser choice — **acorn + acorn-walk + acorn-typescript**

| Option | Bundle (gzipped) | TS support | Risk |
|---|---|---|---|
| **acorn + acorn-walk + acorn-typescript** | ~50 KB | Yes (acorn-typescript plugin parses TS syntax without type-checking) | Low — acorn is the most-audited JS parser in the ecosystem |
| `@babel/parser` | ~250 KB | Full | Heavy bundle |
| `@typescript-eslint/parser` | 600 KB+ | Full | Pulls TS compiler — too heavy for Workers |
| `meriyah` | ~30 KB | TS-aware (limited) | Less battle-tested than acorn |

v1 lock: **acorn + acorn-walk + acorn-typescript**, all exact-pinned per the ARC-186 dependency policy. Roughly 50 KB gzipped delta to the Worker bundle.

**Workers compatibility:** all three packages are pure-JS ESM with no Node-only APIs. Verified.

### 3.2 Rule definition format — **TypeScript modules**, not JSON/YAML

The Linear AC says rules live at `rules/ast/js-ts/*.json|yaml`. v1 deviates from this:

- Each rule is a TypeScript file under `src/lib/ast-rules/rules/<rule-id>.ts` exporting an `AstRule` object (see §5.2).
- Rationale: declarative AST query DSLs (Semgrep, ast-grep) are external dependencies we'd have to bundle separately, OR we hand-roll a DSL interpreter (yak-shave). Code-based rules give us full TypeScript types, compile-time validation, and trivial extensibility.
- Trade-off: third-party rule contributions need a code change vs editing a JSON file. Acceptable for v1; we own the rule pack.
- Documented as **explicit AC deviation** for sign-off review. If the signers reject, we fall back to a JSON DSL with a hand-rolled matcher (substantially more work).

### 3.3 Files scanned (v1)

- Extensions: `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`.
- Source: PR diff (added/modified lines only), then **fetch full file** at PR head for the AST parse.
  - Rationale: parsing diff hunks alone is brittle — a function body can span a hunk boundary. Fetching full file is more accurate at the cost of one extra GitHub Contents API call per changed file.
  - Cap: skip files > 500 KB to avoid pathological parses (matches the existing `pathFilters` exclusion pattern).
- Files dropped by `pathFilters` (ARC-176) are also dropped here — single source of truth.
- **Diff-line filter**: AST visitor traverses the full file, but emits a finding ONLY when the matched node's line is in the PR's added/modified set (computed from the unified diff). This avoids re-flagging pre-existing code.

### 3.4 Confidence + severity bands

| Severity | Action when not silenced | Examples |
|---|---|---|
| `error` | Posts inline comment; specialist prompt block; counts toward Fix Plan | `no-eval-call`, `no-new-function-constructor`, `no-disabled-tls-reject-unauthorized` |
| `warning` | Specialist prompt block only (no auto-inline post; LLM may surface it) | `no-async-without-await`, `no-throw-literal` |
| `info` | Specialist prompt block only; lowest priority | future expansion |

`severityThreshold` filter applies BEFORE specialist prompt injection — sub-threshold findings never reach the prompt.

## 4. Rule pack v1 (the 10 curated rules)

### 4.1 Security rules (severity = `error`)

| Rule ID | What it catches | Confidence | Specialist hint |
|---|---|---|---|
| `no-eval-call` | `eval(<arg>)` direct call | High — extremely rare false positive | `security` |
| `no-new-function-constructor` | `new Function(<arg>)` | High | `security` |
| `spawn-shell-true` | `spawn(...)`, `spawnSync(...)`, `execFile(...)`, `execFileSync(...)` with `{ shell: true }` literal in the options object — Codex MINOR #7: `exec` already runs through a shell so `{shell:true}` is redundant there; the dangerous case is when callers explicitly opt the *non-shell* APIs into shell mode | High — literal-`true` AST match only | `security` |
| `no-disabled-tls-reject-unauthorized` | `{ rejectUnauthorized: false }` literal in any object expression | High — literal-`false` AST match only. Codex MINOR #8: legitimate test/local-agent uses are suppressed via the existing `pathFilters` (ARC-176) and `disabledRules` mechanisms; emitter does NOT special-case test paths to keep the rule simple. | `security` |
| `no-document-write-call` | `document.write(...)` or `document.writeln(...)` | High | `security` |

### 4.2 Correctness rules (severity = `warning`)

| Rule ID | What it catches | Confidence | Specialist hint |
|---|---|---|---|
| `no-async-without-await` | `async` function declaration / arrow with no `await` in body | Medium — sometimes intentional | `logic` |
| `no-throw-literal` | `throw "string"` or `throw 42` (non-Error throws) | High | `logic` |
| `no-await-in-loop` | `await` inside any `for`/`for-of`/`for-in`/`while`/`do-while` body — pure syntactic perf hint. **Renamed from `no-await-in-loop-iter-independent`** (Codex MAJOR #5 + Kimi MAJOR #3): "iteration-independent" requires dataflow analysis acorn can't provide. v1 emits the simpler perf hint and lets the LLM judge applicability. | Medium — known sequential-by-design false positives | `performance` |
| `no-floating-promise-call-known-async` | `someAsync()` as expression statement where `someAsync` is a same-file `async function` declaration. **Narrowed from "any call returning Promise"** (Codex MAJOR #4): without type info the original framing was high-FP. v1 only flags calls whose target is a syntactic-async function declared in the same file; cross-file / type-inferred Promise returns deferred to v2. | High (within the narrow scope) | `logic` |
| `no-process-env-mutation` | `process.env.X = "..."` assignment | High — almost always a test-leak bug | `logic` |

### 4.3 v2+ candidates (NOT in v1)

`no-misused-await-in-condition`, `no-uncaught-async-in-handler`, `no-bare-fetch-without-error-handling`, `unsafe-html-template`, `no-jwt-secret-hardcoded`. Defer until v1 ships and we've collected real-PR signal on false-positive rates.

## 5. Architecture

### 5.1 Module layout

```
src/lib/ast-rules/
├── parser.ts             — acorn + acorn-typescript dispatch
├── walker.ts             — acorn-walk wrapper with diff-line filter
├── runner.ts             — runAstRules(diff, filesByPath) → AstFinding[]
├── render.ts             — renderAstFindingsForPrompt(findings) → string
├── inline-poster.ts      — error-severity findings → inline review comments
├── rule-registry.ts      — exports the 10 rules + dynamic disable filter
└── rules/
    ├── no-eval-call.ts
    ├── no-new-function-constructor.ts
    ├── child-process-shell-true.ts
    ├── no-disabled-tls-reject-unauthorized.ts
    ├── no-document-write-call.ts
    ├── no-async-without-await.ts
    ├── no-throw-literal.ts
    ├── no-await-in-loop-iter-independent.ts
    ├── no-floating-promise-statement.ts
    └── no-process-env-mutation.ts
```

### 5.2 Rule contract

```ts
export interface AstRule {
  id: string                                    // kebab-case, stable
  severity: "error" | "warning" | "info"
  roleHint: "security" | "logic" | "performance" | "tests"
  shortDescription: string                      // 1-line headline
  language: "js" | "ts" | "both"
  /**
   * Visitor function — given an AST node + walker context, return a
   * finding or null. Caller filters by diff-line; the rule itself
   * doesn't need to know about diffs.
   */
  visit(node: AstNode, ctx: RuleContext): AstRuleHit | null
}

export interface AstRuleHit {
  message: string                               // user-visible
  evidence: string                              // raw source slice (≤200 chars, redacted of literal strings >40 chars)
  line: number
  column: number
}

export interface AstFinding extends AstRuleHit {
  ruleId: string
  severity: AstRule["severity"]
  roleHint: AstRule["roleHint"]
  path: string
}
```

### 5.3 Pipeline integration (where it slots in)

In `triage-pr-review-ensemble.ts`, after secret-scan + deterministic-checks but before specialist fanout (mirrors the ARC-186 dep-vuln slot):

```
secret-scan       (ARC-187)
deterministic-regex (ARC-193)
dep-vuln-scan     (ARC-186)
ast-rule-pack     (ARC-181)  ← NEW
   │
   ▼
combinedFactsBlock = [secretScan, depVulnBlock, deterministicBlock, astRuleBlock]
   │
   ▼
specialist fanout
```

For `error`-severity AST findings, the runner ALSO returns an `inlineComments` array that the ensemble posts via `submitReview` after the synth completes — bypassing the LLM. The synth receives the same findings as facts so it can dedupe.

### 5.4 Diff-line filtering + reviewable-position resolution

**Two filters, in order:**

1. **Changed-line intersection** (Kimi BLOCKING #2): from the unified diff, build a `changedLines: Map<path, Set<number>>` containing every `+` line (i.e. **net-new AND replaced** lines on the new-file side; the same set GitHub considers a `synchronize` event "changed"). When a rule emits a hit at AST node spanning lines `[startLine, endLine]`, the runner keeps the finding iff `[startLine, endLine] ∩ changedLines[path]` is non-empty. This catches multi-line bugs where the offending line is later in the node body. Pre-existing `eval(...)` calls in untouched code are not re-flagged.

2. **Reviewable-position resolution** (Codex BLOCKING #2): for findings that may post inline (i.e. `error`-severity AND `astRules.autoInline === true`), the runner cross-references the existing `parseDiffToReviewablePositions(diff): Map<path, ReviewablePosition[]>` infrastructure to resolve each finding's `(path, line)` to a `{ line, side: "RIGHT" }` review position. If no matching review position exists (rare but possible — e.g. file-deletion edge cases), the finding stays in the prompt block but does NOT auto-post. Telemetry: `ast-rules-finding-no-review-position`.

**Skip large files:** files with `(headFile.length > 500_000)` chars short-circuit before the parse with `ast-rules-scan-skipped-large-file` telemetry (NIT #10 — Codex). The 500 KB cap matches `pathFilters` exclusion semantics and prevents pathological acorn parses from eating the queue budget.

### 5.5 Synthesizer dedup — structured supersession

**Replaces v1's keyword-overlap heuristic** (Codex MAJOR #3 + Kimi BLOCKING #1).

Each AST finding carries a stable `astFindingId = "ast/${ruleId}/${pathHash7}/${line}"`. The runner injects findings into the synth prompt as a machine-readable JSON block:

```jsonc
{
  "ast_findings": [
    {
      "id": "ast/no-eval-call/abc1234/42",
      "rule_id": "no-eval-call",
      "path": "src/auth/login.ts",
      "line": 42,
      "severity": "error",
      "role_hint": "security",
      "message": "Direct eval() call",
      "evidence": "eval(userInput)"
    }
  ]
}
```

The synth prompt instructs the model to:

1. Match each specialist finding against `ast_findings` on `(path, line, role_hint)` triple. A specialist finding superseded by an AST finding shares the SAME `path`, the SAME `line` (±0 — line numbers are deterministic, no fuzzing), AND a `role_hint`-compatible category. (`security` AST finding may supersede `security`-categorized specialist findings; cross-role does not supersede.)
2. When matched, the synth output's `provenance.dropped[]` array carries `{ specialist, sourceFindingId, headline, reason: "superseded_by_ast/<astFindingId>" }`. This gives downstream review of dedup decisions and surfaces the AST finding as canonical in the comment body.
3. Specialist findings with NO matching AST entry pass through untouched.

**No keyword overlap, no role-hint guessing.** Deterministic structured-ID matching only.

If the synth output drops a specialist finding via this path, the rendered review body cites the AST finding directly (with the deterministic `ast/...` ID in a hidden HTML comment marker for audit).

## 6. Configuration

`sigilix.json` schema gain:

```ts
interface SigilixConfig {
  // ...existing fields...
  astRules?: {
    enabled?: boolean                  // default true; literal `false` disables
    severityThreshold?: "info" | "warning" | "error"  // default "warning"
    disabledRules?: string[]           // ruleId list; unknown IDs ignored
  }
}
```

Strict-bool parsing on `enabled` (mirror of `describe.enabled` / `depVulnScan.enabled` from ARC-191/ARC-186). Unknown `severityThreshold` values fall back to default.

## 7. Telemetry

| Event | When | Fields |
|---|---|---|
| `ast-rules-scan-skipped` | Disabled in config OR no JS/TS files in diff | `{ owner, repo, prNumber, reason }` |
| `ast-rules-scan-ran` | Scan completed | `{ owner, repo, prNumber, filesScanned, findingsCount, durationMs }` |
| `ast-rules-finding` | Per emitted finding (post-threshold, post-disable) | `{ owner, repo, prNumber, ruleId, severity, roleHint, path, line }` (Kimi MINOR #6: include `roleHint` for FP-rate segmentation) |
| `ast-rules-scan-skipped-large-file` | File > 500 KB short-circuited before parse (Codex NIT #10) | `{ owner, repo, prNumber, path, sizeBytes }` |
| `ast-rules-finding-no-review-position` | Finding had no matching review position (file deletion edge cases) | `{ owner, repo, prNumber, ruleId, path, line }` |
| `ast-rules-parse-failed` | acorn threw on a file | `{ owner, repo, prNumber, path, errMessage }` — non-blocking, file is skipped |
| `ast-rules-inline-posted` | Error-severity finding became an inline comment | `{ owner, repo, prNumber, ruleId, path, line }` |

Like ARC-186, raw evidence is redacted (literal strings > 40 chars truncated) before reaching telemetry.

## 8. Testing strategy

Per AC, **3+ positive + 3+ negative test fixtures**. v1 interpretation:

- **Per-rule tests**: 3 positive (must flag) + 3 negative (must NOT flag) = **60 micro-tests** for the 10 rules.
- **Pipeline integration test**: a synthetic diff with one of each severity tier; verify (a) error findings post inline ONLY when `autoInline: true`, (b) warning findings reach the specialist prompt, (c) below-threshold findings drop, (d) `disabledRules` filters work, (e) `pathFilters` short-circuit, (f) `astRules.enabled: false` short-circuits the whole scan.
- **Diff-line filter** (multi-line): a fixture where a rule matches at lines `[L1..L3]`, only `L2` is in `changedLines` → finding kept (intersection non-empty). Another where `[L1..L3]` are all OUTSIDE `changedLines` → finding suppressed.
- **Reviewable-position resolution**: a finding at `(path, line)` with no matching entry in `parseDiffToReviewablePositions` output → `ast-rules-finding-no-review-position` telemetry, finding stays in prompt block but does NOT auto-post.
- **Synth dedup structured matching**: synthetic synth output with specialist finding at `(path, line, role_hint)` matching an AST finding → `provenance.dropped[]` carries `superseded_by_ast/...` reason and the LLM finding is removed from the inline comments list. Cross-role does NOT supersede.
- **Parse-failure resilience**: a malformed JS file → `ast-rules-parse-failed` telemetry, scan continues with other files.
- **Large-file skip**: a 600 KB file → `ast-rules-scan-skipped-large-file` telemetry, no parse attempted.
- **TypeScript-syntax fixture coverage** (Codex MAJOR #6): explicit parse tests for the TS surface — TSX, decorators, import attributes (`with { type: "json" }`), `satisfies` operator, enums, namespaces, mixed JSX-in-TS, generic-arrow-with-comma-disambiguation. The `parser.ts` test suite asserts each parses without throwing AND that a smoke rule (e.g. `no-eval-call`) still fires on injected `eval()` calls inside each syntactic construct.

## 9. Constraints / non-goals (v1)

- No type-checking. acorn-typescript parses TS *syntax* but not types. Type-aware rules (e.g., "this method returns Promise but is in a sync context") are deferred to v2.
- No type-aware "uses-X-from-import-Y" rules in v1. Rules are AST-shape only.
- No transitive analysis or cross-file rules.
- No incremental cache. Scan re-runs full on every PR push.
- Rule pack is hard-coded; no custom user-defined rules in v1.

## 10. Decisions on prior open questions (resolved during sign-off)

1. **Rule definition format → TypeScript modules** (both signers approved). The Linear AC will be updated to record the deviation explicitly: "first-party TS rule modules; no user-defined rule files in v1; revisit declarative DSL in v2 if external contributions become a goal" (Codex MINOR #9 + Kimi MAJOR #4).
2. **Diff-line filter scope → added + modified lines** (Kimi §10.2): the `changedLines` set is every `+` line in the unified diff (added AND replacement-target lines), not just net-new. Multi-line node spans intersect with this set (§5.4).
3. **Synth dedup → structured supersession, no keywords** (Codex MAJOR #3 + Kimi BLOCKING #1 + Kimi §10.3): `(path, line, role_hint)` triple-match with deterministic `astFindingId` carry-through (§5.5). Discarded the v1 keyword-overlap heuristic.
4. **Auto-inline default → `false` for v1** (Codex BLOCKING #1 wins the disagreement with Kimi §10.4): the blast-radius of deterministic comments without LLM intermediation is a UX risk, not a parser-correctness issue. Ship the `astRules.autoInline` toggle with default `false`. Default flips to `true` after 2 weeks of real-PR FP-rate telemetry < 5% (Kimi §10.5 — fast-follow). Kimi's "consistency with ARC-187" reasoning was incorrect: ARC-187 secret-scan does NOT auto-post; it injects facts to the security-specialist prompt and the LLM authors the comment. ARC-181 follows the same posture by default.
5. **Rule cap → exactly 10 in v1; fast-follow after 2 weeks** (Kimi §10.5): if telemetry shows pack-aggregate FP < 5%, add 2-3 syntax-only rules in a minor bump. Reserve v2 for type-aware or cross-file analysis.

## 11. Sign-off summary

### Codex (v1 → v2)

| Codex finding | v2 change |
|---|---|
| **[BLOCKING]** Auto-inline should not default solely from `severity=error` | §2 + §3.4 + §6 — `astRules.autoInline` config, default `false`. |
| **[BLOCKING]** Diff-line filter must use reviewable diff positions | §5.4 — two-stage filter: `changedLines` intersection THEN `parseDiffToReviewablePositions` lookup. |
| **[MAJOR]** Synth dedup keyword overlap too fragile | §5.5 — structured `(path, line, role_hint)` matching with `astFindingId` carry-through. |
| **[MAJOR]** `no-floating-promise-statement` high-FP without type info | §4.2 — narrowed to `no-floating-promise-call-known-async` (same-file `async function` declaration target only). |
| **[MAJOR]** `no-await-in-loop-iter-independent` over-ambitious | §4.2 — renamed to `no-await-in-loop`, pure syntactic perf hint. |
| **[MAJOR]** Parser compatibility needs real fixture coverage | §8 — explicit parse-test surface for TSX, decorators, import attributes, `satisfies`, enums, namespaces, mixed JSX-in-TS. |
| **[MINOR]** `child-process-shell-true` semantics | §4.1 — renamed `spawn-shell-true`, scoped to `spawn`/`spawnSync`/`execFile`/`execFileSync` (the dangerous case). |
| **[MINOR]** TLS rejectUnauthorized test FP risk | §4.1 — note added: legitimate test/local uses suppressed via existing `pathFilters` + `disabledRules` mechanisms. |
| **[MINOR]** Update AC for rule format deviation | §10.1 — Linear AC update logged. |
| **[NIT]** Add `skippedLargeFile` skip reason | §5.4 + §7 — `ast-rules-scan-skipped-large-file` telemetry event. |

### Kimi (v1 → v2)

| Kimi finding | v2 change |
|---|---|
| **[BLOCKING]** Synth dedup keyword overlap too brittle | Already addressed via Codex MAJOR #3 reconciliation (§5.5). |
| **[BLOCKING]** Diff-line filter geometry needs `changedLines` + span intersection | §5.4 — explicit multi-line span intersection over the full `+` line set. |
| **[MAJOR]** `no-await-in-loop-iter-independent` rename | Already addressed via Codex MAJOR #5. |
| **[MAJOR]** Update Linear AC for TS module format deviation | Already addressed via Codex MINOR #9. |
| **[MINOR]** `astRules.autoInline` global toggle | §3.4 + §6 — toggle added; default `false` (sided with Codex BLOCKING #1). |
| **[MINOR]** Telemetry `ast-rules-finding` missing `roleHint` | §7 — `roleHint` field added to event shape. |
| **[NIT]** `severityThreshold` default `"warning"` silently drops `info` tier | §2 — default changed to `"info"`; `info` tier reserved for future expansion and is currently a no-op below `"warning"`. |

## 11. Bundle-size budget

- acorn ~22 KB gzipped
- acorn-walk ~8 KB
- acorn-typescript ~12 KB
- Rule pack + runner ~10 KB
- **Total: ~52 KB gzipped delta to the Worker bundle**

Combined with ARC-186's bundle (semver + advisory DB), Sigilix is comfortably under the 25 MB Workers cap.
