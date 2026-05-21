# SIG-128 Helper-Covered Glue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the tests specialist from firing sev≥4 "needs integration tests" on orchestrator glue whose new logic delegates to same-PR unit-tested helpers, without suppressing genuinely-untested code.

**Architecture:** A new pure module `helper-coverage.ts` computes a per-source tri-state status (`all`/`partial`/`none`): a `->NONE` source is `all` when EVERY substantive added line delegates to a same-PR tested helper (and that helper's sibling test references the delegated symbol). The status is merged into the testing-evidence pack, rendered as informational evidence (all/partial), and gates a new shadow-first validator reject path that drops only the `all`-status missing-coverage finding.

**Tech Stack:** TypeScript, Cloudflare Workers, acorn (via `ast-rules/parser`), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-21-sig-128-helper-covered-glue-design.md`

**Verified facts (do not re-derive):**
- `classifyDiffFiles(paths)` → `ClassifiedDiffFile[]`; the testing pack's `siblingMappings` is `{ source, test: string|null }[]`. A non-null `test` means the source has a sibling unit test in this PR (`diff-file-classify.ts`).
- `parseSource(code, ext): { ok:true, ast } | { ok:false, reason }` and `walkAst(ast, visitors)` (visitor keyed by node `type`) are exported from `src/lib/ast-rules/parser.ts` / `walker.ts`. `SourceExt` ∈ `.ts .tsx .mts .cts .js .jsx .mjs .cjs` (confirm in parser.ts).
- `buildAddedLineTextByLine(diff): Map<path, Map<lineNo, text>>` (`ast-rules/diff-filter.ts`) — the text has the leading `+` STRIPPED, indentation preserved.
- Orchestrator (`triage-pr-review-ensemble.ts`): `fullDiff` (complete diff, `:1111`) is the reliable basis; `diff` (`:1147`) is first-batch + char-truncated — DO NOT use `diff` for coverage. `astFilesByPath` (changed JS/TS head content) exists. Testing-evidence wired at `:1844-1886`; `testingEvidenceFetchResult.contentByPath` = inspected test content keyed by test path. Validator `validateForSubmission` calls `evaluateTestFinding(f, testingEvidence, coverageGaps)` at `:5646`.
- Tests live in `tests/`, Vitest. Single file: `npx vitest run tests/helper-coverage.test.ts`. Full gate: `npm run build` (tsc + eslint + vitest). The repo uses `noUncheckedIndexedAccess` — guard indexed access or use `!` with a justified invariant.

---

## File Structure

- **Create** `src/lib/helper-coverage.ts` — resolver, import-binding extraction, substantive-line classification, `detectHelperCoverage`. Pure, never throws.
- **Create** `tests/helper-coverage.test.ts` — unit tests.
- **Modify** `src/lib/testing-evidence-pack.ts` — add `helperCoverageBySource` to the pack, `mergeHelperCoverage`, and render annotation.
- **Modify** `tests/testing-evidence-pack.test.ts` — render-annotation tests.
- **Modify** `src/lib/validate-test-finding.ts` — `glue-covered-by-helper` reject reason + gate.
- **Modify** `tests/validate-test-finding.test.ts` — validator tests.
- **Modify** `src/lib/triage-pr-review-ensemble.ts` — wire detection between `:1879` and `:1883`.

---

## Task 1: Types + import resolver

**Files:** Create `src/lib/helper-coverage.ts`; Create `tests/helper-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest"
import { resolveImportToRepoPath } from "../src/lib/helper-coverage"

describe("resolveImportToRepoPath", () => {
  const tested = new Set(["src/lib/branch-retrieval.ts", "src/lib/foo.ts", "src/lib/widget/index.ts"])
  it("resolves a relative extensionless specifier to a tested source", () => {
    expect(resolveImportToRepoPath("src/lib/triage-pr-review-ensemble.ts", "./branch-retrieval", tested))
      .toBe("src/lib/branch-retrieval.ts")
  })
  it("resolves a .js specifier to the .ts source (TS ESM convention)", () => {
    expect(resolveImportToRepoPath("src/lib/x.ts", "./foo.js", tested)).toBe("src/lib/foo.ts")
  })
  it("resolves a directory import to index.ts", () => {
    expect(resolveImportToRepoPath("src/lib/x.ts", "./widget", tested)).toBe("src/lib/widget/index.ts")
  })
  it("returns null for a bare package specifier", () => {
    expect(resolveImportToRepoPath("src/lib/x.ts", "acorn", tested)).toBeNull()
  })
  it("returns null when the resolved path is not a tested source", () => {
    expect(resolveImportToRepoPath("src/lib/x.ts", "./untested", tested)).toBeNull()
  })
  it("resolves a parent-relative specifier", () => {
    expect(resolveImportToRepoPath("src/lib/sub/x.ts", "../foo", tested)).toBe("src/lib/foo.ts")
  })
})
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/helper-coverage.test.ts`).

- [ ] **Step 3: Implement** — create `src/lib/helper-coverage.ts`:

```typescript
// SIG-128: credit orchestrator glue whose new logic delegates to same-PR
// unit-tested helpers, so the tests specialist stops over-firing "needs
// integration tests" on wiring already covered by extracted helper tests.
//
// Pure module, never throws: any failure for a source yields status "none"
// (fail closed — never suppresses a finding). See the design doc for the
// tri-state contract (all = every substantive added line delegates).

import { parseSource, type SourceExt } from "./ast-rules/parser"
import { walkAst, type AstNode } from "./ast-rules/walker"
import type { TestingSiblingMapping } from "./testing-evidence-pack"

const CODE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const

export interface HelperCoverage {
  status: "all" | "partial" | "none"
  /** Distinct same-PR tested-helper source paths that contributed delegating lines. */
  helpers: string[]
}

function stripCodeExt(p: string): string {
  for (const e of CODE_EXTS) {
    if (p.endsWith(e)) return p.slice(0, -e.length)
  }
  return p
}

/** Normalize a path by resolving `.`/`..` segments. No leading slash. */
function normalizePath(p: string): string {
  const out: string[] = []
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") { out.pop(); continue }
    out.push(seg)
  }
  return out.join("/")
}

/**
 * Resolve a RELATIVE import specifier (from `importerPath`) to a member of
 * `candidateSources`, or null. Handles extensionless, `.js`→`.ts`, the
 * `.tsx/.mts/.cts` family, and directory `index.*` imports. Bare/package
 * specifiers return null. Ambiguity (≠1 match) → null (fail closed).
 */
export function resolveImportToRepoPath(
  importerPath: string,
  specifier: string,
  candidateSources: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith(".")) return null
  const dir = importerPath.includes("/") ? importerPath.slice(0, importerPath.lastIndexOf("/")) : ""
  const joined = normalizePath(`${dir}/${specifier}`)
  const target = stripCodeExt(joined) // extensionless target stem
  const matches = new Set<string>()
  for (const c of candidateSources) {
    const cStem = stripCodeExt(c)
    if (cStem === target) matches.add(c)          // ./foo[.ts] → foo.ts
    else if (cStem === `${target}/index`) matches.add(c) // ./widget → widget/index.ts
  }
  return matches.size === 1 ? [...matches][0]! : null
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/lib/helper-coverage.ts tests/helper-coverage.test.ts
git commit -m "feat(sig-128): import resolver for helper-coverage detection"
```

---

## Task 2: Import-binding extraction (acorn)

**Files:** Modify `src/lib/helper-coverage.ts`; `tests/helper-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { extractTestedHelperBindings, type HelperBinding } from "../src/lib/helper-coverage"

describe("extractTestedHelperBindings", () => {
  const tested = new Map<string, string>([["src/lib/branch-retrieval.ts", "tests/branch-retrieval.test.ts"]])
  it("returns local+imported names bound from a tested helper, skipping type-only", () => {
    const src = [
      `import { mergeBranchAware, retrieveBranchChunks as rbc } from "./branch-retrieval"`,
      `import type { BranchVector } from "./branch-retrieval"`,
      `import { foo } from "./untested"`,
      `const x = mergeBranchAware([], [], new Set())`,
    ].join("\n")
    const out = extractTestedHelperBindings("src/lib/ensemble.ts", src, ".ts", tested)
    const byLocal = Object.fromEntries(out.map((b) => [b.local, b]))
    expect(byLocal["mergeBranchAware"]).toMatchObject({ imported: "mergeBranchAware", helperSource: "src/lib/branch-retrieval.ts" })
    expect(byLocal["rbc"]).toMatchObject({ imported: "retrieveBranchChunks", helperSource: "src/lib/branch-retrieval.ts" })
    expect(byLocal["BranchVector"]).toBeUndefined() // type-only skipped
    expect(byLocal["foo"]).toBeUndefined()          // untested module skipped
  })
  it("returns [] when the file does not parse", () => {
    expect(extractTestedHelperBindings("src/lib/x.ts", "const = = =", ".ts", tested)).toEqual([])
  })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add to `src/lib/helper-coverage.ts`:

```typescript
export interface HelperBinding {
  /** Local name as used in the importing file. */
  local: string
  /** Original exported name in the helper module (== local unless aliased). */
  imported: string
  /** Resolved helper source path (a tested same-PR module). */
  helperSource: string
  /** The helper's sibling test path (for the symbol cross-check). */
  helperTest: string
}

/**
 * Parse `code` and return the bindings imported from same-PR TESTED helper
 * modules (skipping type-only imports). `testedHelpers` maps a tested
 * source path → its sibling test path. Never throws — parse failure → [].
 */
export function extractTestedHelperBindings(
  importerPath: string,
  code: string,
  ext: SourceExt,
  testedHelpers: ReadonlyMap<string, string>,
): HelperBinding[] {
  const parsed = parseSource(code, ext)
  if (!parsed.ok) return []
  const candidateSources = new Set(testedHelpers.keys())
  const out: HelperBinding[] = []
  walkAst(parsed.ast as AstNode, {
    ImportDeclaration: (n) => {
      // Whole `import type { … }` decl — skip.
      if (n?.importKind === "type") return
      const spec = typeof n?.source?.value === "string" ? n.source.value : ""
      const helperSource = resolveImportToRepoPath(importerPath, spec, candidateSources)
      if (helperSource === null) return
      const helperTest = testedHelpers.get(helperSource)
      if (!helperTest) return
      for (const s of n?.specifiers ?? []) {
        // Per-specifier type-only (`import { type X }`) — skip.
        if (s?.importKind === "type") continue
        const local = s?.local?.name
        if (typeof local !== "string" || local.length === 0) continue
        // Default / namespace specifiers have no `imported`; use local.
        const imported = typeof s?.imported?.name === "string" ? s.imported.name : local
        out.push({ local, imported, helperSource, helperTest })
      }
    },
  })
  return out
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/lib/helper-coverage.ts tests/helper-coverage.test.ts
git commit -m "feat(sig-128): extract tested-helper import bindings via acorn"
```

---

## Task 3: Substantive-line classification

**Files:** Modify `src/lib/helper-coverage.ts`; `tests/helper-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { isSubstantiveAddedLine } from "../src/lib/helper-coverage"

describe("isSubstantiveAddedLine", () => {
  it("treats executable lines as substantive", () => {
    expect(isSubstantiveAddedLine("  const x = mergeBranchAware(a, b)")).toBe(true)
    expect(isSubstantiveAddedLine("  return foo()")).toBe(true)
    expect(isSubstantiveAddedLine("export const TOP_K = 6")).toBe(true)
  })
  it("treats imports/types/comments/blank/punctuation as NOT substantive", () => {
    expect(isSubstantiveAddedLine(`import { x } from "./y"`)).toBe(false)
    expect(isSubstantiveAddedLine("export type Foo = string")).toBe(false)
    expect(isSubstantiveAddedLine("export interface Foo {")).toBe(false)
    expect(isSubstantiveAddedLine("  type Local = number")).toBe(false)
    expect(isSubstantiveAddedLine("  // a comment")).toBe(false)
    expect(isSubstantiveAddedLine("   * jsdoc")).toBe(false)
    expect(isSubstantiveAddedLine("")).toBe(false)
    expect(isSubstantiveAddedLine("   }")).toBe(false)
    expect(isSubstantiveAddedLine("  })")).toBe(false)
    expect(isSubstantiveAddedLine(`export { foo } from "./y"`)).toBe(false)
  })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add to `src/lib/helper-coverage.ts`:

```typescript
/**
 * A line carries executable logic worth test-accounting. Excludes imports,
 * type-only declarations, re-exports, comments, blank lines, and pure
 * structural punctuation. Conservative: when unsure, treat as substantive
 * (so genuine logic is never silently excluded from the `all` denominator).
 * Input is the `+`-stripped added-line text (indentation preserved).
 */
export function isSubstantiveAddedLine(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  // Comments (line, block open/continuation/close).
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false
  // Pure structural punctuation: `}`, `)`, `};`, `},`, `});`, etc.
  if (/^[)}\]( ;,]*$/.test(t)) return false
  // Imports and re-exports / type-only declarations carry no testable logic.
  if (/^import\b/.test(t)) return false
  if (/^export\s+(type|interface)\b/.test(t)) return false
  if (/^(type|interface)\s/.test(t)) return false
  if (/^export\s*\{/.test(t)) return false // `export { … } from "…"` re-export
  return true
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/lib/helper-coverage.ts tests/helper-coverage.test.ts
git commit -m "feat(sig-128): substantive-added-line classifier"
```

---

## Task 4: `detectHelperCoverage` (tie it together)

**Files:** Modify `src/lib/helper-coverage.ts`; `tests/helper-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { detectHelperCoverage } from "../src/lib/helper-coverage"
import type { TestingSiblingMapping } from "../src/lib/testing-evidence-pack"

const ORCH = "src/lib/ensemble.ts"
const mappings: TestingSiblingMapping[] = [
  { source: ORCH, test: null }, // the ->NONE orchestrator
  { source: "src/lib/branch-retrieval.ts", test: "tests/branch-retrieval.test.ts" },
]
const testContent = { "tests/branch-retrieval.test.ts": `it("mergeBranchAware", () => { mergeBranchAware([],[],new Set()) })` }

function lineMap(lines: Record<number, string>): Map<string, Map<number, string>> {
  const inner = new Map<number, string>()
  for (const [k, v] of Object.entries(lines)) inner.set(Number(k), v)
  return new Map([[ORCH, inner]])
}

describe("detectHelperCoverage", () => {
  it("status=all when every substantive added line delegates to a tested helper exercised by its test", () => {
    const code = [
      `import { mergeBranchAware } from "./branch-retrieval"`, // line 1
      `const merged = mergeBranchAware(a, b, paths)`,           // line 2 (substantive, delegates)
      `}`,                                                       // line 3 (punctuation, ignored)
    ].join("\n")
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: lineMap({ 1: `import { mergeBranchAware } from "./branch-retrieval"`, 2: `const merged = mergeBranchAware(a, b, paths)`, 3: `}` }),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource[ORCH]).toEqual({ status: "all", helpers: ["src/lib/branch-retrieval.ts"] })
  })

  it("status=partial when only some substantive lines delegate", () => {
    const code = `import { mergeBranchAware } from "./branch-retrieval"\nconst merged = mergeBranchAware(a, b, p)\nif (x > threshold) doInlineThing(x)`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: lineMap({ 1: `import { mergeBranchAware } from "./branch-retrieval"`, 2: `const merged = mergeBranchAware(a, b, p)`, 3: `if (x > threshold) doInlineThing(x)` }),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource[ORCH]?.status).toBe("partial")
  })

  it("status=none when no substantive line delegates (true positive preserved)", () => {
    const code = `const y = computeInline(x)\nreturn y * 2`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: lineMap({ 1: `const y = computeInline(x)`, 2: `return y * 2` }),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource[ORCH]?.status).toBe("none")
  })

  it("status=none (fail closed) when the helper test does NOT reference the delegated symbol", () => {
    const code = `import { mergeBranchAware } from "./branch-retrieval"\nconst m = mergeBranchAware(a, b, p)`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: lineMap({ 1: `import { mergeBranchAware } from "./branch-retrieval"`, 2: `const m = mergeBranchAware(a, b, p)` }),
      siblingMappings: mappings,
      testContentByPath: { "tests/branch-retrieval.test.ts": `it("something else", () => {})` },
    })
    expect(out.coverageBySource[ORCH]?.status).toBe("none")
  })

  it("status=none (fail closed) when the source has no added-line text available", () => {
    const code = `import { mergeBranchAware } from "./branch-retrieval"\nconst m = mergeBranchAware(a, b, p)`
    const out = detectHelperCoverage({
      filesByPath: new Map([[ORCH, code]]),
      addedLineTextByPath: new Map(), // no added lines captured for ORCH
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource[ORCH]?.status).toBe("none")
  })

  it("only considers ->NONE sources (covered sources are skipped)", () => {
    const out = detectHelperCoverage({
      filesByPath: new Map([["src/lib/branch-retrieval.ts", "export const x = 1"]]),
      addedLineTextByPath: lineMap({}),
      siblingMappings: mappings,
      testContentByPath: testContent,
    })
    expect(out.coverageBySource["src/lib/branch-retrieval.ts"]).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add to `src/lib/helper-coverage.ts`:

```typescript
const KNOWN_EXTS: ReadonlySet<string> = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])

function extOf(path: string): SourceExt | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const e = path.slice(dot).toLowerCase()
  return KNOWN_EXTS.has(e) ? (e as SourceExt) : null
}

/** Whole-token presence of `name` in `text`. */
function referencesSymbol(text: string, name: string): boolean {
  // Escape is unnecessary: JS identifiers are [A-Za-z0-9_$] only.
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${name}(?:[^A-Za-z0-9_$]|$)`).test(text)
}

export interface DetectHelperCoverageArgs {
  filesByPath: ReadonlyMap<string, string>
  addedLineTextByPath: ReadonlyMap<string, ReadonlyMap<number, string>>
  siblingMappings: readonly TestingSiblingMapping[]
  testContentByPath: Readonly<Record<string, string>>
}

/**
 * Tri-state helper-coverage per `->NONE` source. `all` ⇒ every substantive
 * added line delegates to a same-PR tested helper whose sibling test
 * references the delegated symbol. Fail closed (→ `none`) on any missing
 * input. Never throws.
 */
export function detectHelperCoverage(
  args: DetectHelperCoverageArgs,
): { coverageBySource: Record<string, HelperCoverage> } {
  // Tested-helper source → its sibling test path.
  const testedHelpers = new Map<string, string>()
  for (const m of args.siblingMappings) {
    if (m.test !== null && m.test.length > 0) testedHelpers.set(m.source, m.test)
  }
  const noneSources = args.siblingMappings.filter((m) => m.test === null).map((m) => m.source)

  const coverageBySource: Record<string, HelperCoverage> = {}
  for (const source of noneSources) {
    coverageBySource[source] = computeOne(source, testedHelpers, args)
  }
  return { coverageBySource }
}

function computeOne(
  source: string,
  testedHelpers: ReadonlyMap<string, string>,
  args: DetectHelperCoverageArgs,
): HelperCoverage {
  const NONE: HelperCoverage = { status: "none", helpers: [] }
  const content = args.filesByPath.get(source)
  const ext = extOf(source)
  const added = args.addedLineTextByPath.get(source)
  if (typeof content !== "string" || ext === null || !added || added.size === 0) return NONE

  const bindings = extractTestedHelperBindings(source, content, ext, testedHelpers)
  if (bindings.length === 0) return NONE

  let substantive = 0
  let delegating = 0
  const helpers = new Set<string>()
  for (const [, text] of added) {
    if (!isSubstantiveAddedLine(text)) continue
    substantive += 1
    let lineDelegates = false
    for (const b of bindings) {
      if (!referencesSymbol(text, b.local)) continue
      const testBody = args.testContentByPath[b.helperTest]
      // Cross-check: the helper's sibling test must reference the imported
      // symbol — "imports a tested helper" alone isn't enough (Codex HIGH).
      if (typeof testBody === "string" && referencesSymbol(testBody, b.imported)) {
        lineDelegates = true
        helpers.add(b.helperSource)
      }
    }
    if (lineDelegates) delegating += 1
  }

  if (substantive === 0) return NONE
  if (delegating === substantive) return { status: "all", helpers: [...helpers].sort() }
  if (delegating > 0) return { status: "partial", helpers: [...helpers].sort() }
  return NONE
}
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**

```bash
git add src/lib/helper-coverage.ts tests/helper-coverage.test.ts
git commit -m "feat(sig-128): detectHelperCoverage tri-state status (all/partial/none)"
```

---

## Task 5: Pack extension + render annotation

**Files:** Modify `src/lib/testing-evidence-pack.ts`; `tests/testing-evidence-pack.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/testing-evidence-pack.test.ts`:

```typescript
import { mergeHelperCoverage, renderTestingEvidenceBlock, buildTestingEvidencePack } from "../src/lib/testing-evidence-pack"

describe("SIG-128 helper-coverage annotation", () => {
  const emptyFetch = { contentByPath: {}, failedPaths: [], truncatedPaths: [], totalChars: 0 }
  function packWith(coverage: Record<string, { status: "all" | "partial" | "none"; helpers: string[] }>) {
    const base = buildTestingEvidencePack({
      splitFilePaths: ["src/lib/ensemble.ts", "src/lib/branch-retrieval.ts", "tests/branch-retrieval.test.ts"],
      reviewedFilePaths: ["src/lib/ensemble.ts", "src/lib/branch-retrieval.ts", "tests/branch-retrieval.test.ts"],
    })
    return mergeHelperCoverage(base, coverage)
  }
  it("renders an 'all delegates' note for an all-status ->NONE source", () => {
    const pack = packWith({ "src/lib/ensemble.ts": { status: "all", helpers: ["src/lib/branch-retrieval.ts"] } })
    const block = renderTestingEvidenceBlock(pack, emptyFetch)
    expect(block).toContain("ALL changed logic here delegates to helpers unit-tested in this PR")
    expect(block).toContain("src/lib/branch-retrieval.ts")
  })
  it("renders a 'partial' note without suppressing", () => {
    const pack = packWith({ "src/lib/ensemble.ts": { status: "partial", helpers: ["src/lib/branch-retrieval.ts"] } })
    expect(renderTestingEvidenceBlock(pack, emptyFetch)).toContain("SOME changed lines call tested helpers")
  })
  it("leaves a none-status ->NONE source with the original wording", () => {
    const pack = packWith({ "src/lib/ensemble.ts": { status: "none", helpers: [] } })
    expect(renderTestingEvidenceBlock(pack, emptyFetch)).toContain("no sibling test file in this PR")
  })
  it("mergeHelperCoverage is immutable and defaults to {}", () => {
    const base = buildTestingEvidencePack({ splitFilePaths: ["src/lib/ensemble.ts"], reviewedFilePaths: ["src/lib/ensemble.ts"] })
    expect(base.helperCoverageBySource).toEqual({})
    const merged = mergeHelperCoverage(base, { "src/lib/ensemble.ts": { status: "all", helpers: [] } })
    expect(base.helperCoverageBySource).toEqual({}) // unchanged
    expect(merged.helperCoverageBySource["src/lib/ensemble.ts"]?.status).toBe("all")
  })
})
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/testing-evidence-pack.test.ts`).

- [ ] **Step 3: Implement** in `src/lib/testing-evidence-pack.ts`:

3a. Reuse the single `HelperCoverage` type from Task 1 (do NOT define a second type). At the top of `testing-evidence-pack.ts`, add a type-only import (safe — type-only imports don't create a runtime cycle even though `helper-coverage.ts` imports `TestingSiblingMapping` back from this file):
```typescript
import type { HelperCoverage } from "./helper-coverage"
```
In `TestingEvidencePack`, add the field (and document it):
```typescript
  /** SIG-128: per-source helper-coverage status, keyed by source path.
   *  Only `->NONE` sources are present. Default {} (populated by
   *  `mergeHelperCoverage` at orchestrator level). */
  helperCoverageBySource: Record<string, HelperCoverage>
```

3b. In `buildTestingEvidencePack`'s returned object, add `helperCoverageBySource: {},` alongside `inspectedTestFiles: []`.

3c. Add the merge fn (near `mergeInspectedTestFileContents`):
```typescript
/**
 * SIG-128: merge detected helper-coverage into the pack. Returns a new
 * pack (immutable). Populated at orchestrator level because detection
 * needs file content + diff the pure builder doesn't receive.
 */
export function mergeHelperCoverage(
  pack: TestingEvidencePack,
  coverageBySource: Record<string, HelperCoverage>,
): TestingEvidencePack {
  return { ...pack, helperCoverageBySource: { ...coverageBySource } }
}
```

3d. In `renderTestingEvidenceBlock`, replace the `siblingHint` computation in the source-files loop:
```typescript
      const m = pack.siblingMappings.find((s) => s.source === p)
      const siblingHint = m && m.test !== null
        ? `  ← covered by test in this PR: \`${m.test}\``
        : `  ← no sibling test file in this PR`
```
with:
```typescript
      const m = pack.siblingMappings.find((s) => s.source === p)
      const cov = pack.helperCoverageBySource[p]
      let siblingHint: string
      if (m && m.test !== null) {
        siblingHint = `  ← covered by test in this PR: \`${m.test}\``
      } else if (cov?.status === "all") {
        const list = cov.helpers.map((h) => `\`${h}\``).join(", ")
        siblingHint = `  ← no sibling test file in this PR, but ALL changed logic here delegates to helpers unit-tested in this PR: ${list}`
      } else if (cov?.status === "partial") {
        const list = cov.helpers.map((h) => `\`${h}\``).join(", ")
        siblingHint = `  ← no sibling test file in this PR; SOME changed lines call tested helpers (${list}), others add inline logic — judge accordingly`
      } else {
        siblingHint = `  ← no sibling test file in this PR`
      }
```

- [ ] **Step 4: Run → PASS** (`npx vitest run tests/testing-evidence-pack.test.ts`). Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/testing-evidence-pack.ts tests/testing-evidence-pack.test.ts
git commit -m "feat(sig-128): helperCoverageBySource pack field + informational render"
```

---

## Task 6: Validator reject path

**Files:** Modify `src/lib/validate-test-finding.ts`; `tests/validate-test-finding.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/validate-test-finding.test.ts` (match the file's existing finding/pack fixture style; the snippet below shows the assertions — adapt the fixture builders to the existing helpers in that file):

```typescript
import { evaluateTestFinding } from "../src/lib/validate-test-finding"
import type { TestingEvidencePack } from "../src/lib/testing-evidence-pack"

function glueFinding() {
  return {
    // sev>=4 missing-coverage finding citing the orchestrator's real ->NONE
    id: "t1", category: "testing", score: 4,
    path: "src/lib/ensemble.ts",
    headline: "Wiring lacks integration tests",
    body: "The branch-aware wiring in `src/lib/ensemble.ts` has no integration test.",
    evidenceRefs: ["siblingMapping:src/lib/ensemble.ts->NONE"],
  } as any
}
function packWith(status: "all" | "partial" | "none"): TestingEvidencePack {
  return {
    sourceFilesChanged: ["src/lib/ensemble.ts"], testFilesChanged: ["tests/branch-retrieval.test.ts"],
    testFilesInPromptDiff: [], testFilesNotInPromptDiff: [],
    siblingMappings: [{ source: "src/lib/ensemble.ts", test: null }, { source: "src/lib/branch-retrieval.ts", test: "tests/branch-retrieval.test.ts" }],
    inspectedTestFiles: [], helperCoverageBySource: { "src/lib/ensemble.ts": { status, helpers: ["src/lib/branch-retrieval.ts"] } },
  }
}

describe("SIG-128 glue-covered-by-helper", () => {
  it("rejects an all-status ->NONE missing-coverage finding", () => {
    expect(evaluateTestFinding(glueFinding(), packWith("all"))).toEqual({ keep: false, reason: "glue-covered-by-helper" })
  })
  it("keeps the same finding when status is partial", () => {
    expect(evaluateTestFinding(glueFinding(), packWith("partial"))).toEqual({ keep: true })
  })
  it("keeps the same finding when status is none (true positive preserved)", () => {
    expect(evaluateTestFinding(glueFinding(), packWith("none"))).toEqual({ keep: true })
  })
})
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/validate-test-finding.test.ts`).

- [ ] **Step 3: Implement** in `src/lib/validate-test-finding.ts`:

3a. Extend `TestDropReason`:
```typescript
export type TestDropReason =
  | "missing-path"
  | "uncited-missing-coverage"
  | "vague-insufficient-test"
  | "glue-covered-by-helper" // SIG-128: ->NONE finding on a file whose changed logic fully delegates to same-PR tested helpers
```

3b. In `evaluateTestFinding`, inside the `if (missingClass) {` branch, BEFORE the `citesRealMissingCoverage` return, add the helper-coverage gate:
```typescript
  if (missingClass) {
    // SIG-128: a ->NONE missing-coverage finding on a source whose changed
    // logic FULLY delegates to same-PR tested helpers (status "all") is the
    // orchestrator-glue false positive. Reject it. `partial`/`none` are not
    // suppressed (FP-safe — a genuinely-untested orchestrator still fires).
    if (pack.helperCoverageBySource?.[finding.path.trim()]?.status === "all") {
      return { keep: false, reason: "glue-covered-by-helper" }
    }
    return citesRealMissingCoverage(finding, pack)
      ? { keep: true }
      : { keep: false, reason: "uncited-missing-coverage" }
  }
```
(`finding.path` is already confirmed non-empty above the class machinery; `pack` is non-null here. Use optional chaining on `helperCoverageBySource` for back-compat with packs built before this field — though `buildTestingEvidencePack` now always sets `{}`.)

- [ ] **Step 4: Run → PASS** (`npx vitest run tests/validate-test-finding.test.ts`). Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validate-test-finding.ts tests/validate-test-finding.test.ts
git commit -m "feat(sig-128): validator drops all-status glue-covered missing-coverage findings"
```

---

## Task 7: Orchestrator wiring

**Files:** Modify `src/lib/triage-pr-review-ensemble.ts`

> Read `:1100-1160` (diff/batch vars) and `:1844-1890` (testing-evidence build) first to re-anchor line numbers.

- [ ] **Step 1: Add imports** — in the `./testing-evidence-pack` import group (`:82-86`), add `mergeHelperCoverage`. Add a new import:
```typescript
import { detectHelperCoverage } from "./helper-coverage"
import { buildAddedLineTextByLine } from "./ast-rules/diff-filter"
```
(If `buildAddedLineTextByLine` is already imported from `./ast-rules/diff-filter`, add it to the existing import instead of duplicating.)

- [ ] **Step 2: Wire detection** — between the `mergeInspectedTestFileContents` call (`:1879-1882`) and `renderTestingEvidenceBlock` (`:1883`), insert:
```typescript
    // SIG-128: credit orchestrator glue whose changed logic delegates to
    // same-PR tested helpers. Uses `fullDiff` (the COMPLETE per-file patch)
    // for added-line text — NOT the truncated/first-batch `diff` — and the
    // already-fetched changed JS/TS head content (`astFilesByPath`). A source
    // missing from either input fails closed to "none" (never suppresses).
    const helperCoverage = detectHelperCoverage({
      filesByPath: astFilesByPath,
      addedLineTextByPath: buildAddedLineTextByLine(fullDiff),
      siblingMappings: testingEvidencePackInitial.siblingMappings,
      testContentByPath: testingEvidenceFetchResult.contentByPath,
    })
    const testingEvidencePackWithCoverage = mergeHelperCoverage(
      testingEvidencePack,
      helperCoverage.coverageBySource,
    )
```
Then change the `renderTestingEvidenceBlock` call and EVERY downstream use of `testingEvidencePack` (notably `validateForSubmission({ … testingEvidence: testingEvidencePack … })` at `:2541`) to use `testingEvidencePackWithCoverage`. Grep to confirm all references:
```
grep -n "testingEvidencePack\b" src/lib/triage-pr-review-ensemble.ts
```
Update each post-`:1883` reference to `testingEvidencePackWithCoverage`. (Do NOT rename `testingEvidencePackInitial`.)

- [ ] **Step 3: Type-check + full gate**

Run: `npx tsc --noEmit` → clean. (`astFilesByPath` is a `Map<string,string>`; `detectHelperCoverage` accepts `ReadonlyMap`. If `astFilesByPath` is declared `const` and populated conditionally, it's still in scope here — confirm it's not inside a narrower block.)

Run: `npm run build` → PASS (tsc + eslint + full vitest).

- [ ] **Step 4: Commit**

```bash
git add src/lib/triage-pr-review-ensemble.ts
git commit -m "feat(sig-128): wire helper-coverage detection into the testing-evidence pack"
```

---

## Post-implementation (not part of the TDD loop)

- **Verify acceptance against the recurrence cases:** add a focused test (or extend Task 4) reproducing the SIG-129 ensemble shape (changed lines call `mergeBranchAware`/`shouldRunBranchAwareRetrieval` from `branch-retrieval.ts` with `branch-retrieval.test.ts` present) → `all`; and a genuinely-untested orchestrator change → `none`. Both are already covered by Task 4's fixtures; confirm they map to the real shapes.
- **Code review:** `code-reviewer` + `typescript-pro`; the detection logic (line accounting, resolver) → `verify-algo`; Codex second pass (this was Codex-designed — have it confirm the implementation matches the hardened design).
- **CodeRabbit** at phase end before the PR (`coderabbit review --plain --base $(git merge-base origin/main HEAD) HEAD`).
- **Rollout:** the drop rides the existing `OPENCLAW_TESTS_VALIDATOR_MODE` (shadow default). No enforce flip until shadow telemetry confirms the recurrence FP is suppressed AND no genuine-untested finding is dropped. The render annotation ships live (informational, FP-safe).
- **PR:** branch `sig-128`; `Closes SIG-128`; move ticket In Progress at start, In Review on PR open.
