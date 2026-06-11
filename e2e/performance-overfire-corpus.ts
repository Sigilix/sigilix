// SIG-341 performance-overfire corpus.
//
// Measures the performance specialist's ability to separate real load-bearing
// regressions from common overfire shapes. The live harness replays these diffs
// through the real performance specialist and reports raw vs post-gate metrics.

import { buildAddedLineTextByLine } from "@/src/features/ast-rules/domain/diff-filter"
import {
  clampIntentionalLiveEvalSerialLoopSeverity,
  clampTrivialSyncIoSeverity,
  evaluatePerfFinding,
  type PerfEvidence,
} from "@/src/lib/ensemble/domain/gates/validate-perf-finding"
import { buildChangedLineTextByPath } from "@/src/lib/ensemble/domain/gates/validate-logic-finding"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

export type PerformanceOverfireClass =
  | "serial-eval-loop"
  | "tiny-fixed-loop"
  | "cold-setup"
  | "budget-without-measurement"
  | "n-plus-one"
  | "sync-io-hot-path"
  | "quadratic-input"
  | "unbounded-retry"

export interface PerformanceOverfireCase {
  id: string
  label: "vuln" | "safe"
  bugClass: PerformanceOverfireClass
  path: string
  targetLine: number
  note: string
  diff: string
  /** Optional role-scoped block to mimic production perf inputs. */
  perfFactsBlock?: string
}

export interface PerformanceScoredFinding {
  path: string
  line: number
  score: number
  category?: string
  headline?: string
  body?: string
  complexityEstimate?: string
  hotPathIdentifier?: string
  independentAssessment?: string
}

export interface PerformanceCaseResult {
  id: string
  label: "vuln" | "safe"
  bugClass: PerformanceOverfireClass
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
  const fParts = f.split("/")
  const eParts = e.split("/")
  if (fParts.length < 2 || eParts.length < 2) return false
  return (
    fParts[fParts.length - 1] === eParts[eParts.length - 1] && fParts[fParts.length - 2] === eParts[eParts.length - 2]
  )
}

function isPerformanceBlocker(f: PerformanceScoredFinding): boolean {
  return f.score >= BLOCKER_SCORE
}

function toPrReviewFinding(f: PerformanceScoredFinding): PrReviewFinding {
  return {
    path: f.path,
    line: f.line,
    score: f.score,
    category: "performance",
    headline: f.headline ?? "",
    body: f.body ?? "",
    ...(f.complexityEstimate !== undefined ? { complexityEstimate: f.complexityEstimate } : {}),
    ...(f.hotPathIdentifier !== undefined ? { hotPathIdentifier: f.hotPathIdentifier } : {}),
    ...(f.independentAssessment !== undefined ? { independentAssessment: f.independentAssessment } : {}),
  } as PrReviewFinding
}

function onTarget(c: PerformanceOverfireCase, f: PerformanceScoredFinding): boolean {
  return samePath(f.path, c.path) && Math.abs(f.line - c.targetLine) <= WINDOW
}

export function applyPerfEvidenceGate(
  c: PerformanceOverfireCase,
  findings: readonly PerformanceScoredFinding[],
): PerformanceScoredFinding[] {
  const evidence: PerfEvidence = {
    changedLineTextByPath: buildChangedLineTextByPath(c.diff),
    astPerfFindings: [],
  }
  const kept = findings.filter((f) => evaluatePerfFinding(toPrReviewFinding(f), evidence).keep).map((f) => ({ ...f }))
  const addedLineTextByLine = buildAddedLineTextByLine(c.diff)
  // The clamps gate on `category === "performance"` and mutate `score` in
  // place. A scored performance finding's category is always "performance"
  // (mirrors `toPrReviewFinding`); supply it explicitly so the clamp input
  // carries the required `category: string` field without changing behavior.
  const clampable = kept.map((f) => ({ ...f, category: f.category ?? "performance" }))
  clampTrivialSyncIoSeverity(clampable, addedLineTextByLine)
  clampIntentionalLiveEvalSerialLoopSeverity(clampable, addedLineTextByLine)
  // Propagate the clamped scores back onto the kept findings (same order).
  return kept.map((f, i) => ({ ...f, score: clampable[i]!.score }))
}

export function scoreCase(
  c: PerformanceOverfireCase,
  findings: readonly PerformanceScoredFinding[],
): PerformanceCaseResult {
  const onPath = findings.filter((f) => isPerformanceBlocker(f) && onTarget(c, f))
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
  const caught = onPath.length > 0
  for (const f of onPath) {
    const dist = Math.abs(f.line - c.targetLine)
    if (nearestLine === null || dist < Math.abs(nearestLine - c.targetLine)) nearestLine = f.line
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

export const PERFORMANCE_OVERFIRE_CASES: PerformanceOverfireCase[] = [
  {
    id: "safe-serial-live-eval-loop",
    label: "safe",
    bugClass: "serial-eval-loop",
    path: "tests/model-recall-eval.live.test.ts",
    targetLine: 13,
    note: "live model eval loops intentionally run serially for stable K-repeat metrics and provider politeness",
    diff: `diff --git a/tests/model-recall-eval.live.test.ts b/tests/model-recall-eval.live.test.ts
--- a/tests/model-recall-eval.live.test.ts
+++ b/tests/model-recall-eval.live.test.ts
@@ -8,6 +8,13 @@ describe.skipIf(!API_KEY)("model recall baseline", () => {
   it("measures recall", async () => {
+    const perCase = new Map<string, Result>()
+    for (let k = 0; k < repeats; k++) {
+      for (const c of cases) {
+        // Sequential by design: keep benchmark order stable and avoid provider bursts.
+        const result = await runCase(c, apiKey)
+        perCase.set(c.id, result)
+      }
+    }
   })
 })
`,
  },
  {
    id: "safe-tiny-fixed-loop",
    label: "safe",
    bugClass: "tiny-fixed-loop",
    path: "src/lib/hash-prefix.ts",
    targetLine: 3,
    note: "a loop bounded to four iterations is not an input-growth performance regression",
    diff: `diff --git a/src/lib/hash-prefix.ts b/src/lib/hash-prefix.ts
--- a/src/lib/hash-prefix.ts
+++ b/src/lib/hash-prefix.ts
@@ -1,3 +1,8 @@
 export function prefix(bytes: Uint8Array): string {
+  const parts: string[] = []
+  for (let i = 0; i < 4; i++) {
+    parts.push(bytes[i]?.toString(16).padStart(2, "0") ?? "00")
+  }
+  return parts.join("")
 }
`,
  },
  {
    id: "safe-cold-setup-map",
    label: "safe",
    bugClass: "cold-setup",
    path: "src/config/routes.ts",
    targetLine: 3,
    note: "small setup-time allocation is not load-bearing hot-path work",
    diff: `diff --git a/src/config/routes.ts b/src/config/routes.ts
--- a/src/config/routes.ts
+++ b/src/config/routes.ts
@@ -1,3 +1,5 @@
 const ROUTES = ["health", "metrics", "ready"] as const
+export const ROUTE_TABLE = ROUTES.map((name) => ({ name, path: \`/\${name}\` }))
+
 export const DEFAULT_ROUTE = "/health"
`,
  },
  {
    id: "safe-budget-target-only",
    label: "safe",
    bugClass: "budget-without-measurement",
    path: "src/api/orders.ts",
    targetLine: 4,
    note: "a declared perf budget is a policy target, not proof the PR exceeded latency",
    perfFactsBlock: [
      "[PERF BUDGETS - pre-LLM, structured]",
      "- touched hot path: src/api/orders.ts",
      "- p95LatencyBudgetMs: 200",
      "- no runtime measurements are included in this review input",
    ].join("\n"),
    diff: `diff --git a/src/api/orders.ts b/src/api/orders.ts
--- a/src/api/orders.ts
+++ b/src/api/orders.ts
@@ -1,4 +1,6 @@
export async function listOrders(req: Request): Promise<Response> {
+  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 25), 100)
+  const orders = await db.orders.list({ limit })
   return Response.json(orders)
 }
`,
  },
  {
    id: "real-n-plus-one-request",
    label: "vuln",
    bugClass: "n-plus-one",
    path: "src/api/orders.ts",
    targetLine: 5,
    note: "request path awaits one user lookup per id instead of batching",
    diff: `diff --git a/src/api/orders.ts b/src/api/orders.ts
--- a/src/api/orders.ts
+++ b/src/api/orders.ts
@@ -1,4 +1,9 @@
 export async function GET(req: Request): Promise<Response> {
+  const ids = new URL(req.url).searchParams.getAll("user")
+  const users = []
+  for (const id of ids) {
+    users.push(await db.users.findUnique({ where: { id } }))
+  }
+  return Response.json(users)
 }
`,
  },
  {
    id: "real-sync-io-request",
    label: "vuln",
    bugClass: "sync-io-hot-path",
    path: "src/worker.ts",
    targetLine: 5,
    note: "request handler performs synchronous file I/O on every request",
    diff: `diff --git a/src/worker.ts b/src/worker.ts
--- a/src/worker.ts
+++ b/src/worker.ts
@@ -1,4 +1,7 @@
+import { readFileSync } from "node:fs"
+
 export async function handleRequest(req: Request): Promise<Response> {
+  const template = readFileSync("./templates/order.html", "utf8")
+  return new Response(template.replace("{{id}}", new URL(req.url).searchParams.get("id") ?? ""))
 }
`,
  },
  {
    id: "real-quadratic-user-input",
    label: "vuln",
    bugClass: "quadratic-input",
    path: "src/lib/reconcile.ts",
    targetLine: 3,
    note: "nested membership scan over two request-sized arrays is O(n*m)",
    diff: `diff --git a/src/lib/reconcile.ts b/src/lib/reconcile.ts
--- a/src/lib/reconcile.ts
+++ b/src/lib/reconcile.ts
@@ -1,3 +1,5 @@
 export function matchingItems(items: Item[], others: Item[]): Item[] {
+  return items.filter((item) => others.some((other) => other.id === item.id))
 }
`,
  },
  {
    id: "real-unbounded-retry",
    label: "vuln",
    bugClass: "unbounded-retry",
    path: "src/lib/upstream.ts",
    targetLine: 4,
    note: "retry loop has no attempt cap or backoff under persistent upstream failure",
    diff: `diff --git a/src/lib/upstream.ts b/src/lib/upstream.ts
--- a/src/lib/upstream.ts
+++ b/src/lib/upstream.ts
@@ -1,3 +1,9 @@
 export async function callWithRetry(call: () => Promise<Response>): Promise<Response> {
+  while (true) {
+    try {
+      return await call()
+    } catch {
+      continue
+    }
+  }
 }
`,
  },
]
