# ARC-181 — AST rule-pack scanner before LLM (JS/TS) — design spec

**Status:** DRAFT v1 — pending dual sign-off (Kimi K2.6 + Codex)
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
- [ ] **High-confidence findings** (severity ≥ `error`, security category) post inline review comments without LLM intermediation — same surface as `submitReview` inline comments.
- [ ] Synthesizer dedupes AST findings vs LLM findings at the same `(path, line, ruleId-topic)` so reviewers don't see two voices saying the same thing.
- [ ] Per-rule disable via `sigilix.json`:
  ```json
  { "astRules": {
      "enabled": false,                                // hard kill-switch
      "severityThreshold": "warning",                  // info | warning | error
      "disabledRules": ["no-await-in-loop"]            // string[] of ruleId
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
| `child-process-shell-true` | `exec({...shell: true...})` or `execSync({...shell: true...})` | High — string literal `true` only | `security` |
| `no-disabled-tls-reject-unauthorized` | `{ rejectUnauthorized: false }` literal in any object expression | High — string literal `false` only | `security` |
| `no-document-write-call` | `document.write(...)` or `document.writeln(...)` | High | `security` |

### 4.2 Correctness rules (severity = `warning`)

| Rule ID | What it catches | Confidence | Specialist hint |
|---|---|---|---|
| `no-async-without-await` | `async` function declaration / arrow with no `await` in body | Medium — sometimes intentional | `logic` |
| `no-throw-literal` | `throw "string"` or `throw 42` (non-Error throws) | High | `logic` |
| `no-await-in-loop-iter-independent` | `for (const x of arr) { await f(x) }` where iterations are independent | Medium — perf hint | `performance` |
| `no-floating-promise-statement` | `someAsync()` as expression statement (not awaited, not assigned, not returned) | Medium — false positives on fire-and-forget by design | `logic` |
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

### 5.4 Diff-line filtering

The walker computes `(addedLines: Set<number>) per file` from the unified diff (existing `parseDiffToReviewablePositions` infrastructure). When a rule emits a hit at line `L`, the runner filters: `addedLines.has(L) ? keep : drop`. This is the single hot-spot for false positives in v1 — pre-existing `eval(...)` calls don't get re-flagged when an unrelated line in the same file changes.

### 5.5 Synthesizer dedup

Synth receives the AST findings block as authoritative facts. The synth prompt instructs:

> If a specialist verdict targets the same `(path, line)` as an entry in `[AST RULE FINDINGS — pre-LLM]` and overlaps in topic, drop the specialist finding (the AST one is canonical).

A heuristic check on overlap: if the specialist's finding shares ≥1 keyword from the AST rule's `id` (e.g., specialist mentions "eval" and AST finding is `no-eval-call`), treat as dup.

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
| `ast-rules-finding` | Per emitted finding (post-threshold, post-disable) | `{ owner, repo, prNumber, ruleId, severity, path, line }` |
| `ast-rules-parse-failed` | acorn threw on a file | `{ owner, repo, prNumber, path, errMessage }` — non-blocking, file is skipped |
| `ast-rules-inline-posted` | Error-severity finding became an inline comment | `{ owner, repo, prNumber, ruleId, path, line }` |

Like ARC-186, raw evidence is redacted (literal strings > 40 chars truncated) before reaching telemetry.

## 8. Testing strategy

Per AC, **3+ positive + 3+ negative test fixtures**. v1 interpretation:

- **Per-rule tests**: 3 positive (must flag) + 3 negative (must NOT flag) = **60 micro-tests** for the 10 rules.
- **Pipeline integration test**: a synthetic diff with one of each severity tier; verify (a) error findings post inline, (b) warning findings reach the specialist prompt, (c) below-threshold findings drop, (d) `disabledRules` filters work, (e) `pathFilters` short-circuit.
- **Diff-line filter**: a fixture where a rule matches at line `L` but `L` is NOT in the diff's added set → finding suppressed.
- **Parse-failure resilience**: a malformed JS file → `ast-rules-parse-failed` telemetry, scan continues with other files.

## 9. Constraints / non-goals (v1)

- No type-checking. acorn-typescript parses TS *syntax* but not types. Type-aware rules (e.g., "this method returns Promise but is in a sync context") are deferred to v2.
- No type-aware "uses-X-from-import-Y" rules in v1. Rules are AST-shape only.
- No transitive analysis or cross-file rules.
- No incremental cache. Scan re-runs full on every PR push.
- Rule pack is hard-coded; no custom user-defined rules in v1.

## 10. Open questions for sign-off

1. **Rule definition format.** §3.2 deviates from the AC's `*.json|yaml` rule files in favor of TypeScript modules. Sign off or push back to JSON DSL?
2. **Diff-line filter strictness.** §5.4 emits findings only on lines in the diff's added set. Should "modified" lines (changed but not net-added) also count? v1 leans **yes** — modified lines surface bugs the diff just introduced.
3. **Synth dedup heuristic.** §5.5 uses a keyword-overlap check between rule ID and specialist text. Is that reliable enough, or should we wire a structured "supersedes" reference from synth output?
4. **High-confidence inline posting.** §3.4 auto-posts `error`-severity findings without LLM. Acceptable for v1, or gate behind an explicit `astRules.autoInline: true` config field for opt-in?
5. **Rule cap of 10.** AC says 10. v1 ships exactly 10. After two weeks of real-PR signal, do we expand quickly or wait for v2 review? (Operational question, not blocking.)

## 11. Bundle-size budget

- acorn ~22 KB gzipped
- acorn-walk ~8 KB
- acorn-typescript ~12 KB
- Rule pack + runner ~10 KB
- **Total: ~52 KB gzipped delta to the Worker bundle**

Combined with ARC-186's bundle (semver + advisory DB), Sigilix is comfortably under the 25 MB Workers cap.
