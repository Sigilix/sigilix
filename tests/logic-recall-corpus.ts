// Subtle-logic recall corpus (Lane B #6 — the differentiator).
//
// WHY: the deterministic-floor approach is great for SECURITY (clean sink/taint
// signals) but structurally weak for LOGIC bugs, which are fuzzy and context-
// dependent (the money-float floor proved it — it over-fired on idiomatic billing
// code). The genuinely-differentiating "how did it catch THAT" subtle bugs need
// the MODEL's reasoning, not a rule. This corpus is the RULER for that: realistic
// subtle logic bugs the logic specialist SHOULD catch (vuln) + correct
// counterparts it must NOT flag (safe). The harness (tests/logic-recall-eval.live.test.ts)
// replays each diff through the real logic specialist and measures recall + FP.
//
// Each `diff` is a minimal unified diff (what the specialist actually sees).
// `buggyLine` is the new-file line of the defect; recall counts a hit when the
// specialist emits a finding on `path` within ±WINDOW of it. `safe` cases expect
// NO finding (the false-positive measure — does the specialist over-fire?).

export type BugClass =
  | "money-precision"
  | "toctou-race"
  | "off-by-one"
  | "async-await"
  | "idempotency"
  | "falsy-zero"
  | "wrong-operator"
  | "state-machine"

export interface LogicRecallCase {
  id: string
  label: "vuln" | "safe"
  bugClass: BugClass
  path: string
  buggyLine: number // new-file line of the defect (ignored for safe cases)
  note: string // what the bug is (for the report; NOT shown to the model)
  diff: string
}

export const LOGIC_RECALL_CASES: LogicRecallCase[] = [
  {
    id: "toctou-balance",
    label: "vuln",
    bugClass: "toctou-race",
    path: "src/wallet.ts",
    buggyLine: 13,
    note: "read-check-write on balance with no lock/transaction → concurrent withdrawals double-spend",
    diff: `diff --git a/src/wallet.ts b/src/wallet.ts
@@ -8,6 +8,12 @@ export class Wallet {
   constructor(private store: KV, private id: string) {}

+  async withdraw(amount: number): Promise<boolean> {
+    const balance = await this.store.get(this.id)
+    if (balance < amount) return false
+    await this.store.set(this.id, balance - amount)
+    return true
+  }
 }
`,
  },
  {
    id: "missing-await-auth",
    label: "vuln",
    bugClass: "async-await",
    path: "src/middleware/auth.ts",
    buggyLine: 8,
    note: "isAdmin() returns a Promise; without await the condition is always truthy → auth bypass",
    diff: `diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts
@@ -7,6 +7,11 @@ export function requireAdmin(svc: AuthService) {
   return async (req: Req, res: Res, next: Next) => {
+    if (!svc.isAdmin(req.user)) {
+      return res.status(403).end()
+    }
+    next()
   }
 }
`,
  },
  {
    id: "off-by-one-pagination",
    label: "vuln",
    bugClass: "off-by-one",
    path: "src/paginate.ts",
    buggyLine: 4,
    note: "slice(start, start + pageSize - 1) drops the last item of every page (fencepost)",
    diff: `diff --git a/src/paginate.ts b/src/paginate.ts
@@ -3,4 +3,5 @@ export function page<T>(items: T[], pageNum: number, pageSize: number): T[] {
   const start = pageNum * pageSize
-  return items.slice(start, start + pageSize)
+  return items.slice(start, start + pageSize - 1)
 }
`,
  },
  {
    id: "money-accumulate-float",
    label: "vuln",
    bugClass: "money-precision",
    path: "src/cart.ts",
    buggyLine: 9,
    note: "accumulates currency in a float then compares with === to an expected total → drift fails the equality",
    diff: `diff --git a/src/cart.ts b/src/cart.ts
@@ -4,7 +4,12 @@ export function settle(items: LineItem[], expectedTotal: number): boolean {
   let total = 0
+  for (const item of items) {
+    total += item.unitPrice * item.qty
+  }
+  // reconcile against the order total computed upstream
+  return total === expectedTotal
 }
`,
  },
  {
    id: "idempotency-charge",
    label: "vuln",
    bugClass: "idempotency",
    path: "src/payments/charge.ts",
    buggyLine: 7,
    note: "charge handler has no idempotency key and no guard; a retried webhook double-charges the customer",
    diff: `diff --git a/src/payments/charge.ts b/src/payments/charge.ts
@@ -6,3 +6,5 @@ export async function handleChargeWebhook(event: StripeEvent) {
   const order = await db.orders.find(event.orderId)
+  await stripe.charges.create({ amount: order.amountCents, customer: order.customerId })
+  return ack()
 }
`,
  },
  {
    id: "falsy-zero-config",
    label: "vuln",
    bugClass: "falsy-zero",
    path: "src/config.ts",
    buggyLine: 2,
    note: "`config.retries || 3` treats a valid 0 (no retries) as unset → silently forces 3 retries",
    diff: `diff --git a/src/config.ts b/src/config.ts
@@ -2,3 +2,4 @@ export function resolveRetries(config: Config): number {
-  return config.retries
+  return config.retries || 3
 }
`,
  },
  {
    id: "wrong-operator-range",
    label: "vuln",
    bugClass: "wrong-operator",
    path: "src/validate.ts",
    buggyLine: 2,
    note: "age range guard uses || instead of && → every value passes (always true)",
    diff: `diff --git a/src/validate.ts b/src/validate.ts
@@ -2,3 +2,4 @@ export function isAdult(age: number): boolean {
-  return age >= 18 && age <= 120
+  return age >= 18 || age <= 120
 }
`,
  },
  {
    id: "state-skip-validation",
    label: "vuln",
    bugClass: "state-machine",
    path: "src/order/transition.ts",
    buggyLine: 6,
    note: "allows any order → refunded but skips the required 'paid' check → refunds an unpaid order",
    diff: `diff --git a/src/order/transition.ts b/src/order/transition.ts
@@ -5,5 +5,8 @@ export function transition(order: Order, to: Status): Order {
   if (to === "refunded") {
+    order.status = "refunded"
+    order.refundedAt = Date.now()
+    return order
   }
   return order
 }
`,
  },
  {
    id: "off-by-one-loop-bound",
    label: "vuln",
    bugClass: "off-by-one",
    path: "src/sum.ts",
    buggyLine: 3,
    note: "i <= arr.length reads one past the end → arr[arr.length] is undefined, NaN propagates",
    diff: `diff --git a/src/sum.ts b/src/sum.ts
@@ -2,5 +2,6 @@ export function sumAll(arr: number[]): number {
   let s = 0
-  for (let i = 0; i < arr.length; i++) {
+  for (let i = 0; i <= arr.length; i++) {
     s += arr[i]
   }
 }
`,
  },
  {
    id: "async-unawaited-write",
    label: "vuln",
    bugClass: "async-await",
    path: "src/save.ts",
    buggyLine: 4,
    note: "the persist() promise isn't awaited before returning success → write may not complete / errors swallowed",
    diff: `diff --git a/src/save.ts b/src/save.ts
@@ -3,5 +3,7 @@ export async function saveProfile(p: Profile): Promise<Result> {
   validate(p)
+  db.persist(p)
+  return { ok: true }
 }
`,
  },

  // ─── SAFE counterparts (must NOT produce a logic finding) ───
  {
    id: "safe-toctou-atomic",
    label: "safe",
    bugClass: "toctou-race",
    path: "src/wallet.ts",
    buggyLine: 0,
    note: "atomic conditional decrement — no read-check-write race",
    diff: `diff --git a/src/wallet.ts b/src/wallet.ts
@@ -8,6 +8,11 @@ export class Wallet {
   constructor(private store: KV, private id: string) {}

+  async withdraw(amount: number): Promise<boolean> {
+    // atomic: the store rejects the decrement if it would go negative
+    const ok = await this.store.decrementIfAtLeast(this.id, amount)
+    return ok
+  }
 }
`,
  },
  {
    id: "safe-awaited-auth",
    label: "safe",
    bugClass: "async-await",
    path: "src/middleware/auth.ts",
    buggyLine: 0,
    note: "isAdmin is awaited correctly",
    diff: `diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts
@@ -7,6 +7,11 @@ export function requireAdmin(svc: AuthService) {
   return async (req: Req, res: Res, next: Next) => {
+    if (!(await svc.isAdmin(req.user))) {
+      return res.status(403).end()
+    }
+    next()
   }
 }
`,
  },
  {
    id: "safe-pagination",
    label: "safe",
    bugClass: "off-by-one",
    path: "src/paginate.ts",
    buggyLine: 0,
    note: "correct half-open slice",
    diff: `diff --git a/src/paginate.ts b/src/paginate.ts
@@ -3,4 +3,5 @@ export function page<T>(items: T[], pageNum: number, pageSize: number): T[] {
   const start = pageNum * pageSize
-  return items.slice(start, start + pageSize)
+  return items.slice(start, Math.min(start + pageSize, items.length))
 }
`,
  },
  {
    id: "safe-nullish-config",
    label: "safe",
    bugClass: "falsy-zero",
    path: "src/config.ts",
    buggyLine: 0,
    note: "uses ?? so a valid 0 is preserved",
    diff: `diff --git a/src/config.ts b/src/config.ts
@@ -2,3 +2,4 @@ export function resolveRetries(config: Config): number {
-  return config.retries
+  return config.retries ?? 3
 }
`,
  },
  {
    id: "safe-idempotent-charge",
    label: "safe",
    bugClass: "idempotency",
    path: "src/payments/charge.ts",
    buggyLine: 0,
    note: "passes an idempotency key derived from the event id",
    diff: `diff --git a/src/payments/charge.ts b/src/payments/charge.ts
@@ -6,6 +6,11 @@ export async function handleChargeWebhook(event: StripeEvent) {
   const order = await db.orders.find(event.orderId)
+  await stripe.charges.create(
+    { amount: order.amountCents, customer: order.customerId },
+    { idempotencyKey: event.id },
+  )
+  return ack()
 }
`,
  },
  {
    id: "safe-money-integer-cents",
    label: "safe",
    bugClass: "money-precision",
    path: "src/cart.ts",
    buggyLine: 0,
    note: "accumulates integer cents — exact",
    diff: `diff --git a/src/cart.ts b/src/cart.ts
@@ -4,7 +4,12 @@ export function settle(items: LineItem[], expectedCents: number): boolean {
   let totalCents = 0
+  for (const item of items) {
+    totalCents += item.unitPriceCents * item.qty
+  }
+  return totalCents === expectedCents
 }
`,
  },
]

// ─── scoring (pure — unit-tested without a model) ───

/** The projection of a specialist finding the scorer needs (= ShadowRunResult). */
export interface ScoredFinding {
  path: string
  line: number
  score: number
}

export interface CaseResult {
  id: string
  label: "vuln" | "safe"
  bugClass: BugClass
  /** vuln: did a finding land within `window` lines of the defect? */
  caught: boolean
  /** safe: did the specialist (wrongly) flag the correct code? */
  falsePositive: boolean
  nearestLine: number | null
}

const DEFAULT_WINDOW = 6
const MIN_SCORE = 3 // ignore score-1/2 nits — recall means a substantive flag

/** Tolerant path match — the live model may cite `a/src/x.ts`, `src/x.ts`, or
 *  `x.ts`. Strip a leading `a/`/`b/` and match on full path or basename so a
 *  prefix/format difference doesn't silently read as a miss. */
function samePath(found: string, expected: string): boolean {
  const norm = (p: string): string => p.replace(/^[ab]\//, "")
  const f = norm(found)
  const e = norm(expected)
  if (f === e || f.endsWith("/" + e) || e.endsWith("/" + f)) return true
  // Basename fallback (CodeRabbit #358): `src/a/wallet.ts` would match
  // `src/b/wallet.ts`. Safe HERE because each case targets ONE specific file, so
  // there's no same-basename ambiguity within a case's findings — but it would
  // mask a path error if a case ever spanned multiple files sharing a basename.
  const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1)
  return base(f) === base(e)
}

/** Score one case against a specialist's findings. Pure: no model, no I/O. A vuln
 *  is CAUGHT when some finding on the same path lands within `window` lines of the
 *  defect at score>=3; a safe case is a FALSE POSITIVE when any score>=3 finding
 *  lands on its path. */
export function scoreCase(
  c: LogicRecallCase,
  findings: readonly ScoredFinding[],
  window: number = DEFAULT_WINDOW,
): CaseResult {
  const onPath = findings.filter((f) => samePath(f.path, c.path) && f.score >= MIN_SCORE)
  if (c.label === "safe") {
    return { id: c.id, label: c.label, bugClass: c.bugClass, caught: false, falsePositive: onPath.length > 0, nearestLine: onPath[0]?.line ?? null }
  }
  let nearest: number | null = null
  let caught = false
  for (const f of onPath) {
    const dist = Math.abs(f.line - c.buggyLine)
    if (nearest === null || dist < Math.abs(nearest - c.buggyLine)) nearest = f.line
    if (dist <= window) caught = true
  }
  return { id: c.id, label: c.label, bugClass: c.bugClass, caught, falsePositive: false, nearestLine: nearest }
}

export interface RecallReport {
  vulnTotal: number
  caught: number
  recall: number
  safeTotal: number
  falsePositives: number
  fpRate: number
  byClass: Record<string, { total: number; caught: number }>
  results: CaseResult[]
}

/** Aggregate per-case results into the recall / FP-rate report. */
export function aggregate(results: CaseResult[]): RecallReport {
  const vuln = results.filter((r) => r.label === "vuln")
  const safe = results.filter((r) => r.label === "safe")
  const caught = vuln.filter((r) => r.caught).length
  const fps = safe.filter((r) => r.falsePositive).length
  const byClass: Record<string, { total: number; caught: number }> = {}
  for (const r of vuln) {
    const b = (byClass[r.bugClass] ??= { total: 0, caught: 0 })
    b.total++
    if (r.caught) b.caught++
  }
  return {
    vulnTotal: vuln.length,
    caught,
    recall: vuln.length ? caught / vuln.length : 0,
    safeTotal: safe.length,
    falsePositives: fps,
    fpRate: safe.length ? fps / safe.length : 0,
    byClass,
    results,
  }
}
