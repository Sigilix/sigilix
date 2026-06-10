// SIG-344 tests-overfire corpus.
//
// Measurement-only baseline for the tests specialist. Raw scoring is a
// human-labeled oracle over model output and deliberately does NOT call the
// production tests validator. The optional post-gate view below reports the
// current customer-visible surface after `evaluateTestFinding`, but it is not
// the truth source.

import { evaluateTestFinding } from "@/src/lib/validate-test-finding"
import type { TestingEvidencePack } from "@/src/lib/testing-evidence-pack"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

export type TestsOverfireClass =
  | "docs-only"
  | "config-only"
  | "covered-style-refactor"
  | "security-vulnerability-duplicate"
  | "performance-vulnerability-duplicate"
  | "vague-needs-more-tests"
  | "missing-branch-assertion"
  | "deleted-regression-coverage"
  | "parser-coercion-untested"
  | "untested-error-path"
  | "authz-test-gap"

export interface TestsOverfireCase {
  id: string
  label: "vuln" | "safe"
  bugClass: TestsOverfireClass
  path: string
  targetLine: number
  note: string
  diff: string
  testingEvidenceBlock: string
  testingEvidence: TestingEvidencePack
  inspectedTestContentByPath?: Readonly<Record<string, string>>
  targetTokens: readonly string[]
  coverageGaps?: ReadonlySet<string>
  /** Safe cases default to target-path scoring; set true for docs/config. */
  anyTestingBlockerIsFp?: boolean
}

export interface TestsScoredFinding {
  path: string
  line: number
  score: number
  category?: string
  headline?: string
  body?: string
  testGap?: string
  inspectedTestFiles?: string[]
  evidenceRefs?: string[]
  failureExample?: string
}

export interface TestsCaseResult {
  id: string
  label: "vuln" | "safe"
  bugClass: TestsOverfireClass
  caught: boolean
  falsePositive: boolean
  nearestLine: number | null
}

const WINDOW = 5
const BLOCKER_SCORE = 4

const EMPTY_TESTING_EVIDENCE: TestingEvidencePack = {
  sourceFilesChanged: [],
  testFilesChanged: [],
  testFilesInPromptDiff: [],
  testFilesNotInPromptDiff: [],
  siblingMappings: [],
  inspectedTestFiles: [],
  helperCoverageBySource: {},
}

const slugTestContent = `import { describe, expect, it } from "vitest"
import { slugify } from "../src/lib/slug"

describe("slugify", () => {
  it("normalizes labels", () => {
    expect(slugify("Hello, World!")).toBe("hello-world")
  })
})`

const retryTestContent = `import { describe, expect, it } from "vitest"
import { retryWithBackoff } from "../src/lib/retry"

describe("retryWithBackoff", () => {
  it("returns successful attempt", async () => {
    await expect(retryWithBackoff(async () => "ok")).resolves.toBe("ok")
  })
})`

function pack(overrides: Partial<TestingEvidencePack>): TestingEvidencePack {
  return {
    sourceFilesChanged: [],
    testFilesChanged: [],
    testFilesInPromptDiff: [],
    testFilesNotInPromptDiff: [],
    siblingMappings: [],
    inspectedTestFiles: [],
    helperCoverageBySource: {},
    ...overrides,
  }
}

function samePath(found: string, expected: string): boolean {
  const norm = (p: string): string => p.replace(/^[ab]\//, "")
  const f = norm(found)
  const e = norm(expected)
  return f === e || f.endsWith("/" + e) || e.endsWith("/" + f)
}

function isTestsBlocker(f: TestsScoredFinding): boolean {
  return f.score >= BLOCKER_SCORE && (f.category === undefined || f.category === "testing")
}

function textOf(f: TestsScoredFinding): string {
  return [
    f.headline,
    f.body,
    f.testGap,
    f.failureExample,
    ...(f.evidenceRefs ?? []),
    ...(f.inspectedTestFiles ?? []),
  ].filter((v): v is string => typeof v === "string").join("\n").toLowerCase()
}

function onTarget(c: TestsOverfireCase, f: TestsScoredFinding): boolean {
  return samePath(f.path, c.path) && Math.abs(f.line - c.targetLine) <= WINDOW
}

function matchesTargetTokens(c: TestsOverfireCase, f: TestsScoredFinding): boolean {
  if (c.targetTokens.length === 0) return true
  const text = textOf(f)
  return c.targetTokens.some((token) => text.includes(token.toLowerCase()))
}

function toPrReviewFinding(f: TestsScoredFinding): PrReviewFinding {
  return {
    path: f.path,
    line: f.line,
    score: f.score,
    category: f.category ?? "testing",
    headline: f.headline ?? "",
    body: f.body ?? "",
    ...(f.testGap !== undefined ? { testGap: f.testGap } : {}),
    ...(f.inspectedTestFiles !== undefined ? { inspectedTestFiles: f.inspectedTestFiles } : {}),
    ...(f.evidenceRefs !== undefined ? { evidenceRefs: f.evidenceRefs } : {}),
    ...(f.failureExample !== undefined ? { failureExample: f.failureExample } : {}),
  } as PrReviewFinding
}

export function stablePromptHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

export function applyCurrentTestGate(
  c: TestsOverfireCase,
  findings: readonly TestsScoredFinding[],
): TestsScoredFinding[] {
  return findings
    .filter((f) => evaluateTestFinding(toPrReviewFinding(f), c.testingEvidence, c.coverageGaps).keep)
    .map((f) => ({ ...f }))
}

export function scoreCase(
  c: TestsOverfireCase,
  findings: readonly TestsScoredFinding[],
): TestsCaseResult {
  const blockers = findings.filter(isTestsBlocker)
  if (c.label === "safe") {
    const fps = c.anyTestingBlockerIsFp
      ? blockers
      : blockers.filter((f) => onTarget(c, f) && matchesTargetTokens(c, f))
    return {
      id: c.id,
      label: c.label,
      bugClass: c.bugClass,
      caught: false,
      falsePositive: fps.length > 0,
      nearestLine: fps[0]?.line ?? null,
    }
  }

  const onPath = blockers.filter((f) => onTarget(c, f) && matchesTargetTokens(c, f))
  let nearestLine: number | null = null
  for (const f of onPath) {
    const dist = Math.abs(f.line - c.targetLine)
    if (nearestLine === null || dist < Math.abs(nearestLine - c.targetLine)) nearestLine = f.line
  }
  return {
    id: c.id,
    label: c.label,
    bugClass: c.bugClass,
    caught: onPath.length > 0,
    falsePositive: false,
    nearestLine,
  }
}

const coveredSlugEvidence = `[TESTING EVIDENCE — authoritative; computed from the full diff before specialist dispatch]

Source files changed in this PR (1):
- \`src/lib/slug.ts\`  ← covered by test in this PR: \`tests/slug.test.ts\`

Test files changed in this PR (1):
- \`tests/slug.test.ts\` — in [DIFF] block; content included below

Citation requirements (the orchestrator's \`evaluateTestingFindingCitation\` gate drops findings that don't cite):
- When firing a \`category: "testing"\` finding claiming a source file lacks test coverage, anchor the finding to that source file (its \`path\`) and set \`evidenceRefs\` to the EXACT mapping string for THAT source from "Source→test mapping refs" below. The cited mapping's source must equal the finding's \`path\` — citing a mapping for a different file is rejected.
- When the finding instead claims the existing tests are insufficient (vs. absent), set \`inspectedTestFiles\` to one or more of the EXACT test-file paths listed under "Inspected test files" below — files whose full content is embedded in this block. A path not in that list is rejected.
- When the finding claims the PR REMOVED or RENAMED test coverage (a deleted test file), set \`evidenceRefs: ["testFileChanged:<path>"]\` naming a path from "Test files changed in this PR" above. Use this form when the test was deleted (so its content can't be embedded).
- Findings without a citation that resolves against this block are dropped silently and never reach the customer review.

Source→test mapping refs (copy verbatim into \`evidenceRefs\`):
- \`siblingMapping:src/lib/slug.ts->tests/slug.test.ts\`

Inspected test files (copy verbatim into \`inspectedTestFiles\`):
- \`tests/slug.test.ts\`

[TEST FILE CONTENT — \`tests/slug.test.ts\`]
\`\`\`ts
import { describe, expect, it } from "vitest"
import { slugify } from "../src/lib/slug"

describe("slugify", () => {
  it("normalizes labels", () => {
    expect(slugify("Hello, World!")).toBe("hello-world")
  })
})
\`\`\``

const retryEvidence = `[TESTING EVIDENCE — authoritative; computed from the full diff before specialist dispatch]

Source files changed in this PR (1):
- \`src/lib/retry.ts\`  ← covered by test in this PR: \`tests/retry.test.ts\`

Test files changed in this PR (1):
- \`tests/retry.test.ts\` — in [DIFF] block; content included below

Citation requirements (the orchestrator's \`evaluateTestingFindingCitation\` gate drops findings that don't cite):
- When firing a \`category: "testing"\` finding claiming a source file lacks test coverage, anchor the finding to that source file (its \`path\`) and set \`evidenceRefs\` to the EXACT mapping string for THAT source from "Source→test mapping refs" below. The cited mapping's source must equal the finding's \`path\` — citing a mapping for a different file is rejected.
- When the finding instead claims the existing tests are insufficient (vs. absent), set \`inspectedTestFiles\` to one or more of the EXACT test-file paths listed under "Inspected test files" below — files whose full content is embedded in this block. A path not in that list is rejected.
- When the finding claims the PR REMOVED or RENAMED test coverage (a deleted test file), set \`evidenceRefs: ["testFileChanged:<path>"]\` naming a path from "Test files changed in this PR" above. Use this form when the test was deleted (so its content can't be embedded).
- Findings without a citation that resolves against this block are dropped silently and never reach the customer review.

Source→test mapping refs (copy verbatim into \`evidenceRefs\`):
- \`siblingMapping:src/lib/retry.ts->tests/retry.test.ts\`

Inspected test files (copy verbatim into \`inspectedTestFiles\`):
- \`tests/retry.test.ts\`

[TEST FILE CONTENT — \`tests/retry.test.ts\`]
\`\`\`ts
import { describe, expect, it } from "vitest"
import { retryWithBackoff } from "../src/lib/retry"

describe("retryWithBackoff", () => {
  it("returns successful attempt", async () => {
    await expect(retryWithBackoff(async () => "ok")).resolves.toBe("ok")
  })
})
\`\`\``

const parseEvidence = `[TESTING EVIDENCE — authoritative; computed from the full diff before specialist dispatch]

Source files changed in this PR (1):
- \`src/lib/parse-kind.ts\`  ← no sibling test file in this PR

Citation requirements (the orchestrator's \`evaluateTestingFindingCitation\` gate drops findings that don't cite):
- When firing a \`category: "testing"\` finding claiming a source file lacks test coverage, anchor the finding to that source file (its \`path\`) and set \`evidenceRefs\` to the EXACT mapping string for THAT source from "Source→test mapping refs" below. The cited mapping's source must equal the finding's \`path\` — citing a mapping for a different file is rejected.
- When the finding instead claims the existing tests are insufficient (vs. absent), set \`inspectedTestFiles\` to one or more of the EXACT test-file paths listed under "Inspected test files" below — files whose full content is embedded in this block. A path not in that list is rejected.
- When the finding claims the PR REMOVED or RENAMED test coverage (a deleted test file), set \`evidenceRefs: ["testFileChanged:<path>"]\` naming a path from "Test files changed in this PR" above. Use this form when the test was deleted (so its content can't be embedded).
- Findings without a citation that resolves against this block are dropped silently and never reach the customer review.

Source→test mapping refs (copy verbatim into \`evidenceRefs\`):
- \`siblingMapping:src/lib/parse-kind.ts->NONE\``

const authEvidence = `[TESTING EVIDENCE — authoritative; computed from the full diff before specialist dispatch]

Source files changed in this PR (1):
- \`src/routes/admin.ts\`  ← no sibling test file in this PR

Citation requirements (the orchestrator's \`evaluateTestingFindingCitation\` gate drops findings that don't cite):
- When firing a \`category: "testing"\` finding claiming a source file lacks test coverage, anchor the finding to that source file (its \`path\`) and set \`evidenceRefs\` to the EXACT mapping string for THAT source from "Source→test mapping refs" below. The cited mapping's source must equal the finding's \`path\` — citing a mapping for a different file is rejected.
- When the finding instead claims the existing tests are insufficient (vs. absent), set \`inspectedTestFiles\` to one or more of the EXACT test-file paths listed under "Inspected test files" below — files whose full content is embedded in this block. A path not in that list is rejected.
- When the finding claims the PR REMOVED or RENAMED test coverage (a deleted test file), set \`evidenceRefs: ["testFileChanged:<path>"]\` naming a path from "Test files changed in this PR" above. Use this form when the test was deleted (so its content can't be embedded).
- Findings without a citation that resolves against this block are dropped silently and never reach the customer review.

Source→test mapping refs (copy verbatim into \`evidenceRefs\`):
- \`siblingMapping:src/routes/admin.ts->NONE\``

const refundDeletionEvidence = `[TESTING EVIDENCE — authoritative; computed from the full diff before specialist dispatch]

Test files changed in this PR (1):
- \`tests/refunds.test.ts\` — in [DIFF] block; content NOT available (omitted to fit the evidence-block size budget)

Citation requirements (the orchestrator's \`evaluateTestingFindingCitation\` gate drops findings that don't cite):
- When firing a \`category: "testing"\` finding claiming a source file lacks test coverage, anchor the finding to that source file (its \`path\`) and set \`evidenceRefs\` to the EXACT mapping string for THAT source from "Source→test mapping refs" below. The cited mapping's source must equal the finding's \`path\` — citing a mapping for a different file is rejected.
- When the finding instead claims the existing tests are insufficient (vs. absent), set \`inspectedTestFiles\` to one or more of the EXACT test-file paths listed under "Inspected test files" below — files whose full content is embedded in this block. A path not in that list is rejected.
- When the finding claims the PR REMOVED or RENAMED test coverage (a deleted test file), set \`evidenceRefs: ["testFileChanged:<path>"]\` naming a path from "Test files changed in this PR" above. Use this form when the test was deleted (so its content can't be embedded).
- Findings without a citation that resolves against this block are dropped silently and never reach the customer review.`

export const TESTS_OVERFIRE_CASES: TestsOverfireCase[] = [
  {
    id: "safe-docs-only-release-note",
    label: "safe",
    bugClass: "docs-only",
    path: "docs/release.md",
    targetLine: 4,
    note: "docs-only release prose should not produce a missing-tests finding",
    testingEvidenceBlock: "",
    testingEvidence: EMPTY_TESTING_EVIDENCE,
    targetTokens: [],
    anyTestingBlockerIsFp: true,
    diff: `diff --git a/docs/release.md b/docs/release.md
--- a/docs/release.md
+++ b/docs/release.md
@@ -1,3 +1,6 @@
 # Release notes
+
+The review badge now links to the latest run summary.
+No runtime code changed in this release-note update.
`,
  },
  {
    id: "safe-config-only-script",
    label: "safe",
    bugClass: "config-only",
    path: "package.json",
    targetLine: 5,
    note: "config/script-only change has no testing evidence block and should stay clean",
    testingEvidenceBlock: "",
    testingEvidence: EMPTY_TESTING_EVIDENCE,
    targetTokens: [],
    anyTestingBlockerIsFp: true,
    diff: `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -2,6 +2,7 @@
   "scripts": {
+    "check:docs": "markdownlint docs/**/*.md",
     "test": "vitest run"
   }
 }
`,
  },
  {
    id: "safe-covered-style-refactor",
    label: "safe",
    bugClass: "covered-style-refactor",
    path: "src/lib/slug.ts",
    targetLine: 3,
    note: "covered normalization refactor has a sibling test in the PR",
    testingEvidenceBlock: coveredSlugEvidence,
    testingEvidence: pack({
      sourceFilesChanged: ["src/lib/slug.ts"],
      testFilesChanged: ["tests/slug.test.ts"],
      testFilesInPromptDiff: ["tests/slug.test.ts"],
      siblingMappings: [{ source: "src/lib/slug.ts", test: "tests/slug.test.ts" }],
      inspectedTestFiles: ["tests/slug.test.ts"],
    }),
    inspectedTestContentByPath: { "tests/slug.test.ts": slugTestContent },
    targetTokens: ["slugify", "slug", "test"],
    diff: `diff --git a/src/lib/slug.ts b/src/lib/slug.ts
--- a/src/lib/slug.ts
+++ b/src/lib/slug.ts
@@ -1,3 +1,4 @@
 export function slugify(input: string): string {
+  const normalized = input.trim().toLowerCase()
   return normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
 }
diff --git a/tests/slug.test.ts b/tests/slug.test.ts
--- a/tests/slug.test.ts
+++ b/tests/slug.test.ts
@@ -3,4 +3,7 @@ describe("slugify", () => {
+  it("normalizes labels", () => {
+    expect(slugify("Hello, World!")).toBe("hello-world")
+  })
 })
`,
  },
  {
    id: "safe-security-vulnerability-not-tests",
    label: "safe",
    bugClass: "security-vulnerability-duplicate",
    path: "src/ui/render.tsx",
    targetLine: 4,
    note: "a raw XSS sink is security's finding, not a duplicate tests-specialist P1",
    testingEvidenceBlock: "",
    testingEvidence: EMPTY_TESTING_EVIDENCE,
    targetTokens: ["dangerouslysetinnerhtml", "xss", "test", "coverage"],
    diff: `diff --git a/src/ui/render.tsx b/src/ui/render.tsx
--- a/src/ui/render.tsx
+++ b/src/ui/render.tsx
@@ -1,3 +1,6 @@
 export function Preview({ html }: { html: string }) {
+  return <div dangerouslySetInnerHTML={{ __html: html }} />
 }
`,
  },
  {
    id: "safe-performance-vulnerability-not-tests",
    label: "safe",
    bugClass: "performance-vulnerability-duplicate",
    path: "src/routes/users.ts",
    targetLine: 5,
    note: "N+1 request-path bug should be performance, not a testing duplicate",
    testingEvidenceBlock: "",
    testingEvidence: EMPTY_TESTING_EVIDENCE,
    targetTokens: ["test", "coverage", "users", "n+1", "n + 1"],
    diff: `diff --git a/src/routes/users.ts b/src/routes/users.ts
--- a/src/routes/users.ts
+++ b/src/routes/users.ts
@@ -1,3 +1,8 @@
 export async function GET(req: Request): Promise<Response> {
+  const ids = new URL(req.url).searchParams.getAll("id")
+  const users = []
+  for (const id of ids) {
+    users.push(await db.users.findUnique({ where: { id } }))
+  }
+  return Response.json(users)
 }
`,
  },
  {
    id: "safe-vague-needs-more-tests",
    label: "safe",
    bugClass: "vague-needs-more-tests",
    path: "src/lib/retry.ts",
    targetLine: 3,
    note: "existing test content is present; vague 'needs more tests' should not be a P1",
    testingEvidenceBlock: retryEvidence,
    testingEvidence: pack({
      sourceFilesChanged: ["src/lib/retry.ts"],
      testFilesChanged: ["tests/retry.test.ts"],
      testFilesInPromptDiff: ["tests/retry.test.ts"],
      siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
      inspectedTestFiles: ["tests/retry.test.ts"],
    }),
    inspectedTestContentByPath: { "tests/retry.test.ts": retryTestContent },
    targetTokens: ["needs more tests", "coverage", "retry"],
    diff: `diff --git a/src/lib/retry.ts b/src/lib/retry.ts
--- a/src/lib/retry.ts
+++ b/src/lib/retry.ts
@@ -1,4 +1,5 @@
 export async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
+  const delayMs = 10
   return fn()
 }
diff --git a/tests/retry.test.ts b/tests/retry.test.ts
--- a/tests/retry.test.ts
+++ b/tests/retry.test.ts
@@ -1,4 +1,7 @@
+it("returns successful attempt", async () => {
+  await expect(retryWithBackoff(async () => "ok")).resolves.toBe("ok")
+})
`,
  },
  {
    id: "real-missing-branch-assertion",
    label: "vuln",
    bugClass: "missing-branch-assertion",
    path: "src/lib/retry.ts",
    targetLine: 4,
    note: "new timeout branch is reachable but sibling test only covers success",
    testingEvidenceBlock: retryEvidence,
    testingEvidence: pack({
      sourceFilesChanged: ["src/lib/retry.ts"],
      testFilesChanged: ["tests/retry.test.ts"],
      testFilesInPromptDiff: ["tests/retry.test.ts"],
      siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
      inspectedTestFiles: ["tests/retry.test.ts"],
    }),
    inspectedTestContentByPath: { "tests/retry.test.ts": retryTestContent },
    targetTokens: ["timeout", "branch", "retrywithbackoff", "inspectedtestfile:tests/retry.test.ts"],
    diff: `diff --git a/src/lib/retry.ts b/src/lib/retry.ts
--- a/src/lib/retry.ts
+++ b/src/lib/retry.ts
@@ -1,5 +1,9 @@
 export async function retryWithBackoff<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
+  if (signal?.aborted) {
+    throw new Error("timeout")
+  }
   return fn()
 }
diff --git a/tests/retry.test.ts b/tests/retry.test.ts
--- a/tests/retry.test.ts
+++ b/tests/retry.test.ts
@@ -1,4 +1,7 @@
+it("returns successful attempt", async () => {
+  await expect(retryWithBackoff(async () => "ok")).resolves.toBe("ok")
+})
`,
  },
  {
    id: "real-deleted-regression-coverage",
    label: "vuln",
    bugClass: "deleted-regression-coverage",
    path: "tests/refunds.test.ts",
    targetLine: 5,
    note: "PR deletes the only negative-refund regression test",
    testingEvidenceBlock: refundDeletionEvidence,
    testingEvidence: pack({
      testFilesChanged: ["tests/refunds.test.ts"],
      testFilesInPromptDiff: ["tests/refunds.test.ts"],
    }),
    targetTokens: ["deleted", "removes", "refund", "testfilechanged:tests/refunds.test.ts"],
    diff: `diff --git a/tests/refunds.test.ts b/tests/refunds.test.ts
--- a/tests/refunds.test.ts
+++ /dev/null
@@ -1,7 +0,0 @@
-import { describe, expect, it } from "vitest"
-import { refund } from "../src/lib/refunds"
-
-it("rejects negative refund amounts", () => {
-  expect(() => refund({ amount: -1 })).toThrow("amount")
-})
`,
  },
  {
    id: "real-parser-coercion-untested",
    label: "vuln",
    bugClass: "parser-coercion-untested",
    path: "src/lib/parse-kind.ts",
    targetLine: 3,
    note: "new coercion behavior has no sibling test in the PR",
    testingEvidenceBlock: parseEvidence,
    testingEvidence: pack({
      sourceFilesChanged: ["src/lib/parse-kind.ts"],
      siblingMappings: [{ source: "src/lib/parse-kind.ts", test: null }],
    }),
    targetTokens: ["kind", "coerc", "siblingmapping:src/lib/parse-kind.ts->none"],
    diff: `diff --git a/src/lib/parse-kind.ts b/src/lib/parse-kind.ts
--- a/src/lib/parse-kind.ts
+++ b/src/lib/parse-kind.ts
@@ -1,4 +1,8 @@
 export function parseKind(raw: unknown): "bug" | "task" {
+  const kind = String(raw ?? "task").toLowerCase()
+  if (kind === "bug" || kind === "task") return kind
+  return "task"
 }
`,
  },
  {
    id: "real-untested-error-path",
    label: "vuln",
    bugClass: "untested-error-path",
    path: "src/lib/retry.ts",
    targetLine: 4,
    note: "new rejection/error path is not asserted by the sibling test",
    testingEvidenceBlock: retryEvidence,
    testingEvidence: pack({
      sourceFilesChanged: ["src/lib/retry.ts"],
      testFilesChanged: ["tests/retry.test.ts"],
      testFilesInPromptDiff: ["tests/retry.test.ts"],
      siblingMappings: [{ source: "src/lib/retry.ts", test: "tests/retry.test.ts" }],
      inspectedTestFiles: ["tests/retry.test.ts"],
    }),
    inspectedTestContentByPath: { "tests/retry.test.ts": retryTestContent },
    targetTokens: ["error path", "reject", "throw", "retrywithbackoff", "tests/retry.test.ts"],
    diff: `diff --git a/src/lib/retry.ts b/src/lib/retry.ts
--- a/src/lib/retry.ts
+++ b/src/lib/retry.ts
@@ -1,5 +1,9 @@
 export async function retryWithBackoff<T>(fn: () => Promise<T>): Promise<T> {
+  try {
+    return await fn()
+  } catch (err) {
+    throw new Error(\`retry failed: \${String(err)}\`)
+  }
-  return fn()
 }
diff --git a/tests/retry.test.ts b/tests/retry.test.ts
--- a/tests/retry.test.ts
+++ b/tests/retry.test.ts
@@ -1,4 +1,7 @@
+it("returns successful attempt", async () => {
+  await expect(retryWithBackoff(async () => "ok")).resolves.toBe("ok")
+})
`,
  },
  {
    id: "real-authz-test-gap",
    label: "vuln",
    bugClass: "authz-test-gap",
    path: "src/routes/admin.ts",
    targetLine: 4,
    note: "correct privileged route still needs an unauthenticated/unauthorized test",
    testingEvidenceBlock: authEvidence,
    testingEvidence: pack({
      sourceFilesChanged: ["src/routes/admin.ts"],
      siblingMappings: [{ source: "src/routes/admin.ts", test: null }],
    }),
    targetTokens: ["admin", "unauth", "forbid", "403", "siblingmapping:src/routes/admin.ts->none"],
    diff: `diff --git a/src/routes/admin.ts b/src/routes/admin.ts
--- a/src/routes/admin.ts
+++ b/src/routes/admin.ts
@@ -1,4 +1,8 @@
 export async function adminRoute(req: Request): Promise<Response> {
+  const session = await getSession(req)
+  if (!session?.isAdmin) {
+    return new Response("forbidden", { status: 403 })
+  }
   return Response.json(await loadAdminDashboard())
 }
`,
  },
]
