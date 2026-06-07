// SIG-311 security-overfire corpus — measures whether the security specialist
// turns security-tooling/test/doc MENTIONS into P0/P1 findings, and whether the
// usage-vs-mention gate removes those from the inline surface without hurting
// real command/XSS recall.

import { buildAddedLineTextByLine } from "../src/lib/ast-rules/diff-filter"
import { evaluateSecurityUsage } from "../src/lib/validate-security-usage"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

export type SecurityOverfireClass =
  | "command-mention"
  | "xss-mention"
  | "doc-mention"
  | "command-injection"
  | "xss"

export interface SecurityOverfireCase {
  id: string
  label: "vuln" | "safe"
  bugClass: SecurityOverfireClass
  path: string
  targetLine: number
  note: string
  diff: string
  /** Optional role-scoped facts block to mimic production security inputs. */
  securityFactsBlock?: string
}

export interface SecurityScoredFinding {
  path: string
  line: number
  score: number
  category?: string
  headline?: string
  body?: string
  cweId?: string
  evidenceId?: string
  independentAssessment?: string
}

export interface SecurityCaseResult {
  id: string
  label: "vuln" | "safe"
  bugClass: SecurityOverfireClass
  caught: boolean
  falsePositive: boolean
  nearestLine: number | null
}

const WINDOW = 5
const BLOCKER_SCORE = 4

function samePath(found: string, expected: string): boolean {
  const norm = (p: string): string => p.replace(/^[ab]\//, "")
  const f = norm(found)
  const e = norm(expected)
  if (f === e || f.endsWith("/" + e) || e.endsWith("/" + f)) return true
  const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1)
  return base(f) === base(e)
}

function isSecurityBlocker(f: SecurityScoredFinding): boolean {
  return f.score >= BLOCKER_SCORE && (f.category === undefined || f.category === "security")
}

function toPrReviewFinding(f: SecurityScoredFinding): PrReviewFinding {
  return {
    path: f.path,
    line: f.line,
    score: f.score,
    category: "security",
    headline: f.headline ?? "",
    body: f.body ?? "",
    ...(f.cweId !== undefined ? { cweId: f.cweId } : {}),
    ...(f.evidenceId !== undefined ? { evidenceId: f.evidenceId } : {}),
    ...(f.independentAssessment !== undefined ? { independentAssessment: f.independentAssessment } : {}),
  } as PrReviewFinding
}

function onTarget(c: SecurityOverfireCase, f: SecurityScoredFinding): boolean {
  return samePath(f.path, c.path) && Math.abs(f.line - c.targetLine) <= WINDOW
}

export function applySecurityUsageGate(
  c: SecurityOverfireCase,
  findings: readonly SecurityScoredFinding[],
): SecurityScoredFinding[] {
  const addedLineTextByLine = buildAddedLineTextByLine(c.diff)
  return findings.filter((f) => evaluateSecurityUsage(toPrReviewFinding(f), { addedLineTextByLine }).keep)
}

export function scoreCase(
  c: SecurityOverfireCase,
  findings: readonly SecurityScoredFinding[],
): SecurityCaseResult {
  const onPath = findings.filter((f) => isSecurityBlocker(f) && onTarget(c, f))
  if (c.label === "safe") {
    return {
      id: c.id,
      label: c.label,
      bugClass: c.bugClass,
      caught: false,
      falsePositive: onPath.length > 0,
      nearestLine: onPath[0]?.line ?? null,
    }
  }
  let nearestLine: number | null = null
  let caught = false
  for (const f of onPath) {
    const dist = Math.abs(f.line - c.targetLine)
    if (nearestLine === null || dist < Math.abs(nearestLine - c.targetLine)) nearestLine = f.line
    if (dist <= WINDOW) caught = true
  }
  return {
    id: c.id,
    label: c.label,
    bugClass: c.bugClass,
    caught,
    falsePositive: false,
    nearestLine,
  }
}

export interface SecurityAggregateReport {
  vulnTotal: number
  caught: number
  recall: number
  safeTotal: number
  falsePositives: number
  fpRate: number
  results: SecurityCaseResult[]
}

export function aggregate(results: readonly SecurityCaseResult[]): SecurityAggregateReport {
  const vuln = results.filter((r) => r.label === "vuln")
  const safe = results.filter((r) => r.label === "safe")
  const caught = vuln.filter((r) => r.caught).length
  const fps = safe.filter((r) => r.falsePositive).length
  return {
    vulnTotal: vuln.length,
    caught,
    recall: vuln.length ? caught / vuln.length : 0,
    safeTotal: safe.length,
    falsePositives: fps,
    fpRate: safe.length ? fps / safe.length : 0,
    results: [...results],
  }
}

const execFact = (path: string, line: number): string => [
  "[SECURITY EVIDENCE MANIFEST — scanner-proposed candidates; the CWE is a PROPOSED classification, not a verdict]",
  "Each id below is a deterministic scanner hit with a PROPOSED CWE. The classification is a hypothesis to verify against the code, not an established fact. When you CONFIRM a sev>=4 security finding, copy the matching id VERBATIM into the finding's `evidenceId` to corroborate it. Inventing an id is rejected by the validator. For an access-control / IDOR / authz bug that NO deterministic scanner can detect, set `evidenceId: \"NONE\"` and justify in the body why no deterministic check exists.",
  "",
  `- \`ast:no-exec-shell-interpolation:ast/no-exec-shell-interpolation/sig311/${line}\` — ${path}:${line} [proposed CWE-78]: child_process exec with a dynamic shell command`,
].join("\n")

const xssFact = (path: string, line: number): string => [
  "[SECURITY EVIDENCE MANIFEST — scanner-proposed candidates; the CWE is a PROPOSED classification, not a verdict]",
  "Each id below is a deterministic scanner hit with a PROPOSED CWE. The classification is a hypothesis to verify against the code, not an established fact. When you CONFIRM a sev>=4 security finding, copy the matching id VERBATIM into the finding's `evidenceId` to corroborate it. Inventing an id is rejected by the validator. For an access-control / IDOR / authz bug that NO deterministic scanner can detect, set `evidenceId: \"NONE\"` and justify in the body why no deterministic check exists.",
  "",
  `- \`ast:no-dangerous-html-dynamic:ast/no-dangerous-html-dynamic/sig311/${line}\` — ${path}:${line} [proposed CWE-79]: dynamic HTML write sink`,
].join("\n")

export const SECURITY_OVERFIRE_CASES: SecurityOverfireCase[] = [
  {
    id: "safe-regexp-exec-detector",
    label: "safe",
    bugClass: "command-mention",
    path: "src/lib/ast-rules/scan-dynamic-html-sink.ts",
    targetLine: 7,
    note: "`re.exec(line)` is RegExp.prototype.exec in a detector, not child_process.exec",
    diff: `diff --git a/src/lib/ast-rules/scan-dynamic-html-sink.ts b/src/lib/ast-rules/scan-dynamic-html-sink.ts
--- a/src/lib/ast-rules/scan-dynamic-html-sink.ts
+++ b/src/lib/ast-rules/scan-dynamic-html-sink.ts
@@ -5,3 +5,7 @@ export function scanDynamicHtmlSinks(line: string) {
   const hits = []
+  for (const re of HTML_WRITE_SINK_EXTRACTORS) {
+    const match = re.exec(line)
+    if (match) hits.push(match[0])
+  }
   return hits
 }
`,
  },
  {
    id: "safe-exec-rule-message",
    label: "safe",
    bugClass: "command-mention",
    path: "src/lib/ast-rules/rules/no-exec-shell-interpolation.ts",
    targetLine: 7,
    note: "rule message mentions exec/command injection but does not execute a shell",
    diff: `diff --git a/src/lib/ast-rules/rules/no-exec-shell-interpolation.ts b/src/lib/ast-rules/rules/no-exec-shell-interpolation.ts
--- a/src/lib/ast-rules/rules/no-exec-shell-interpolation.ts
+++ b/src/lib/ast-rules/rules/no-exec-shell-interpolation.ts
@@ -4,3 +4,7 @@ export const noExecShellInterpolation = {
   id: "no-exec-shell-interpolation",
+  message:
+    "\`exec()\` with a dynamic command is a command-injection sink; use \`execFile\` instead.",
+  docs: "Flags shell interpolation.",
 }
`,
  },
  {
    id: "safe-xss-test-name",
    label: "safe",
    bugClass: "xss-mention",
    path: "tests/dynamic-html-sink.test.ts",
    targetLine: 6,
    note: "test name mentions dangerouslySetInnerHTML as expected behavior",
    diff: `diff --git a/tests/dynamic-html-sink.test.ts b/tests/dynamic-html-sink.test.ts
--- a/tests/dynamic-html-sink.test.ts
+++ b/tests/dynamic-html-sink.test.ts
@@ -3,3 +3,6 @@ describe("dynamic html scanner", () => {
+  it("flags dangerouslySetInnerHTML when the value is attacker controlled", () => {
+    expect(rule.id).toBe("no-dangerous-html-dynamic")
+  })
 })
`,
  },
  {
    id: "safe-doc-command-example",
    label: "safe",
    bugClass: "doc-mention",
    path: "docs/security-rules.md",
    targetLine: 6,
    note: "markdown example mentions an unsafe exec pattern; docs are not executable code",
    diff: "diff --git a/docs/security-rules.md b/docs/security-rules.md\n--- a/docs/security-rules.md\n+++ b/docs/security-rules.md\n@@ -3,3 +3,7 @@ Security rules\n+Bad command-injection example:\n+\n+```ts\n+exec(`convert ${path}`)\n+```\n",
  },
  {
    id: "real-child-process-exec",
    label: "vuln",
    bugClass: "command-injection",
    path: "src/jobs/convert.ts",
    targetLine: 5,
    note: "child_process.exec receives a user-controlled path in a shell command",
    securityFactsBlock: execFact("src/jobs/convert.ts", 5),
    diff: `diff --git a/src/jobs/convert.ts b/src/jobs/convert.ts
--- a/src/jobs/convert.ts
+++ b/src/jobs/convert.ts
@@ -1,3 +1,6 @@
+import { exec } from "child_process"
+
 export async function convert(req: Req) {
+  exec(\`convert \${req.query.path} -resize 200x200 out.png\`)
 }
`,
  },
  {
    id: "real-exec-in-security-tooling",
    label: "vuln",
    bugClass: "command-injection",
    path: "src/lib/ast-rules/runner-fixture.ts",
    targetLine: 5,
    note: "security-tooling path still contains a real child_process exec sink",
    securityFactsBlock: execFact("src/lib/ast-rules/runner-fixture.ts", 5),
    diff: `diff --git a/src/lib/ast-rules/runner-fixture.ts b/src/lib/ast-rules/runner-fixture.ts
--- a/src/lib/ast-rules/runner-fixture.ts
+++ b/src/lib/ast-rules/runner-fixture.ts
@@ -1,3 +1,6 @@
+import { exec } from "node:child_process"
+
 export function runFixture(req: Req) {
+  exec(\`node \${req.query.script}\`)
 }
`,
  },
  {
    id: "real-dangerous-html",
    label: "vuln",
    bugClass: "xss",
    path: "src/render/Profile.tsx",
    targetLine: 3,
    note: "untrusted request HTML flows into dangerouslySetInnerHTML",
    securityFactsBlock: xssFact("src/render/Profile.tsx", 3),
    diff: `diff --git a/src/render/Profile.tsx b/src/render/Profile.tsx
--- a/src/render/Profile.tsx
+++ b/src/render/Profile.tsx
@@ -1,3 +1,4 @@
 export function Profile({ req }: { req: Req }) {
+  return <div dangerouslySetInnerHTML={{ __html: req.body.bioHtml }} />
 }
`,
  },
]
