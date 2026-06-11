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
  | "swallowed-error"
  | "missing-bound"
  | "unbounded-input"
  | "sign-error"
  | "regex-dos"
  | "missing-transaction"

export interface LogicRecallCase {
  id: string
  label: "vuln" | "safe"
  bugClass: BugClass
  path: string
  buggyLine: number // new-file line of the defect (ignored for safe cases)
  note: string // what the bug is (for the report; NOT shown to the model)
  diff: string
}

/** Reconstruct the right-side source snippets in a corpus diff, preserving new-side line numbers. */
export function buildRightFileByPathFromDiff(diff: string): Map<string, string> {
  const files = new Map<string, string[]>()
  let currentPath: string | null = null
  let newLine: number | null = null

  const ensureFile = (path: string): string[] => {
    const existing = files.get(path)
    if (existing) return existing
    const lines: string[] = []
    files.set(path, lines)
    return lines
  }

  const writeLine = (text: string): void => {
    if (!currentPath || newLine == null) return
    const lines = ensureFile(currentPath)
    while (lines.length < newLine - 1) lines.push("")
    lines[newLine - 1] = text
    newLine++
  }

  for (const raw of diff.split(/\r?\n/)) {
    const fileMatch = raw.match(/^diff --git a\/.+ b\/(.+)$/)
    if (fileMatch) {
      currentPath = fileMatch[1] ?? null
      newLine = null
      continue
    }
    const newFileMatch = raw.match(/^\+\+\+ b\/(.+)$/)
    if (newFileMatch) {
      currentPath = newFileMatch[1] ?? currentPath
      continue
    }
    if (raw === "+++ /dev/null") {
      currentPath = null
      continue
    }
    const hunkMatch = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@\s?(.*)$/)
    if (hunkMatch) {
      newLine = Number(hunkMatch[1])
      const headerContext = hunkMatch[2]
      if (currentPath && headerContext && newLine > 1) {
        const lines = ensureFile(currentPath)
        while (lines.length < newLine - 2) lines.push("")
        if (lines[newLine - 2] == null || lines[newLine - 2] === "") lines[newLine - 2] = headerContext
      }
      continue
    }
    if (newLine == null) continue
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      writeLine(raw.slice(1))
    } else if (raw.startsWith(" ")) {
      writeLine(raw.slice(1))
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // Deleted line: advances old-side only.
      continue
    }
  }

  return new Map([...files.entries()].map(([path, lines]) => [path, lines.join("\n")]))
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
    id: "idempotency-unstable-event-id",
    label: "vuln",
    bugClass: "idempotency",
    path: "src/payments/charge.ts",
    buggyLine: 9,
    note: "idempotency key is derived from a delivery-attempt id that changes across retries, with no order-paid/domain guard",
    diff: `diff --git a/src/payments/charge.ts b/src/payments/charge.ts
@@ -6,3 +6,9 @@ export async function handleChargeWebhook(event: StripeEvent) {
   const order = await db.orders.find(event.orderId)
+  // Provider retries get a fresh event.id for the same order.
+  await stripe.charges.create(
+    { amount: order.amountCents, customer: order.customerId },
+    { idempotencyKey: event.id },
+  )
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
  {
    id: "swallowed-charge-error",
    label: "vuln",
    bugClass: "swallowed-error",
    path: "src/payments/process.ts",
    buggyLine: 7,
    note: "the charge failure is swallowed by an empty catch, then the order is marked paid anyway → unpaid orders ship",
    diff: `diff --git a/src/payments/process.ts b/src/payments/process.ts
@@ -4,4 +4,9 @@ export async function processOrder(order: Order): Promise<void> {
   markPending(order)
+  try {
+    await chargeCard(order.amountCents)
+  } catch (e) {}
+  markPaid(order)
 }
`,
  },
  {
    id: "missing-bound-index",
    label: "vuln",
    bugClass: "missing-bound",
    path: "src/api/items.ts",
    buggyLine: 3,
    note: "a request-controlled array index is used with no bounds check → out-of-range read / undefined.price crash",
    diff: `diff --git a/src/api/items.ts b/src/api/items.ts
@@ -2,4 +2,5 @@ export function itemPrice(items: Item[], req: Req): number {
   const idx = req.body.index
+  return items[idx].price
 }
`,
  },
  {
    id: "unbounded-limit",
    label: "vuln",
    bugClass: "unbounded-input",
    path: "src/api/list.ts",
    buggyLine: 3,
    note: "the page limit is taken straight from the request with no upper clamp → limit=10000000 exhausts memory/DB (DoS)",
    diff: `diff --git a/src/api/list.ts b/src/api/list.ts
@@ -2,3 +2,5 @@ export async function listRows(req: Req): Promise<Row[]> {
   const limit = Number(req.query.limit)
+  return db.fetch({ limit })
 }
`,
  },
  {
    id: "sign-error-withdraw",
    label: "vuln",
    bugClass: "sign-error",
    path: "src/wallet/withdraw.ts",
    buggyLine: 4,
    note: "withdraw ADDS the amount to the balance instead of subtracting → users gain money on every withdrawal (overdraft guard present, so the ONLY defect is the sign)",
    diff: `diff --git a/src/wallet/withdraw.ts b/src/wallet/withdraw.ts
@@ -2,3 +2,5 @@ export function withdraw(account: Account, amount: number): void {
   assertPositive(amount)
+  if (account.balance < amount) throw new Error("insufficient funds")
+  account.balance += amount
 }
`,
  },
  {
    id: "regex-dos-user-pattern",
    label: "vuln",
    bugClass: "regex-dos",
    path: "src/search/filter.ts",
    buggyLine: 3,
    note: "a request-controlled string is compiled into a RegExp → a catastrophic-backtracking pattern hangs the event loop (ReDoS)",
    diff: `diff --git a/src/search/filter.ts b/src/search/filter.ts
@@ -2,3 +2,5 @@ export function filterRows(rows: Row[], req: Req): Row[] {
   const re = new RegExp(req.query.pattern)
+  return rows.filter((r) => re.test(r.name))
 }
`,
  },
  {
    id: "missing-transfer-transaction",
    label: "vuln",
    bugClass: "missing-transaction",
    path: "src/payments/transfer.ts",
    buggyLine: 4,
    note: "debit and credit run as two separate awaits with no transaction → if credit fails after debit, money disappears",
    diff: `diff --git a/src/payments/transfer.ts b/src/payments/transfer.ts
@@ -3,4 +3,6 @@ export async function transfer(from: Id, to: Id, amount: number): Promise<void> {
   validate(amount)
+  await debit(from, amount)
+  await credit(to, amount)
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
@@ -8,6 +8,10 @@ export class Wallet {
   constructor(private store: KV, private id: string) {}

+  async withdraw(amount: number): Promise<boolean> {
+    return this.store.decrementIfAtLeast(this.id, amount)
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
  {
    id: "safe-charge-error-rethrown",
    label: "safe",
    bugClass: "swallowed-error",
    path: "src/payments/process.ts",
    buggyLine: 0,
    note: "the charge error is logged and rethrown — not swallowed; markPaid only runs on success",
    diff: `diff --git a/src/payments/process.ts b/src/payments/process.ts
@@ -4,4 +4,9 @@ export async function processOrder(order: Order): Promise<void> {
   markPending(order)
+  try {
+    await chargeCard(order.amountCents)
+    markPaid(order)
+  } catch (e) { logger.error(e); throw e }
 }
`,
  },
  {
    id: "safe-bounded-index",
    label: "safe",
    bugClass: "missing-bound",
    path: "src/api/items.ts",
    buggyLine: 0,
    note: "the request index is coerced and fully bounds-checked (integer, range) before use",
    diff: `diff --git a/src/api/items.ts b/src/api/items.ts
@@ -2,3 +2,6 @@ export function itemPrice(items: Item[], req: Req): number {
   const idx = Number(req.body.index)
+  if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) throw new RangeError("index out of range")
+  return items[idx].price
 }
`,
  },
  {
    id: "safe-clamped-limit",
    label: "safe",
    bugClass: "unbounded-input",
    path: "src/api/list.ts",
    buggyLine: 0,
    note: "the page limit is clamped to BOTH a safe minimum and maximum (negatives and NaN fall back to 100)",
    diff: `diff --git a/src/api/list.ts b/src/api/list.ts
@@ -2,3 +2,6 @@ export async function listRows(req: Req): Promise<Row[]> {
   const raw = Number(req.query.limit)
+  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 1000) : 100
+  return db.fetch({ limit })
 }
`,
  },
  {
    id: "safe-correct-withdraw",
    label: "safe",
    bugClass: "sign-error",
    path: "src/wallet/withdraw.ts",
    buggyLine: 0,
    note: "withdraw correctly subtracts, AND guards against overdraft — no flaggable gap (the operator is the only thing that differs from the vuln twin)",
    diff: `diff --git a/src/wallet/withdraw.ts b/src/wallet/withdraw.ts
@@ -2,3 +2,5 @@ export function withdraw(account: Account, amount: number): void {
   assertPositive(amount)
+  if (account.balance < amount) throw new Error("insufficient funds")
+  account.balance -= amount
 }
`,
  },
  {
    id: "safe-transactional-transfer",
    label: "safe",
    bugClass: "missing-transaction",
    path: "src/payments/transfer.ts",
    buggyLine: 0,
    note: "debit + credit run inside an atomic transaction",
    diff: `diff --git a/src/payments/transfer.ts b/src/payments/transfer.ts
@@ -3,3 +3,6 @@ export async function transfer(from: Id, to: Id, amount: number): Promise<void> {
   validate(amount)
+  await db.transaction(async (tx) => {
+    await debit(tx, from, amount)
+    await credit(tx, to, amount)
+  })
 }
`,
  },
  {
    id: "safe-literal-substring-filter",
    label: "safe",
    bugClass: "regex-dos",
    path: "src/search/filter.ts",
    buggyLine: 0,
    note: "filters by plain substring — the request value is never compiled into a RegExp, so there is no ReDoS surface",
    diff: `diff --git a/src/search/filter.ts b/src/search/filter.ts
@@ -2,3 +2,5 @@ export function filterRows(rows: Row[], req: Req): Row[] {
   const needle = String(req.query.q ?? "")
+  return rows.filter((r) => r.name.includes(needle))
 }
`,
  },
  {
    id: "safe-guarded-transition",
    label: "safe",
    bugClass: "state-machine",
    path: "src/order/transition.ts",
    buggyLine: 0,
    note: "the refund transition requires the order to be 'paid' first — the precondition is enforced",
    diff: `diff --git a/src/order/transition.ts b/src/order/transition.ts
@@ -5,5 +5,9 @@ export function transition(order: Order, to: Status): Order {
   if (to === "refunded") {
+    if (order.status !== "paid") throw new Error("only paid orders can be refunded")
+    order.status = "refunded"
+    order.refundedAt = Date.now()
+    return order
   }
   return order
 }
`,
  },
  {
    id: "safe-correct-range",
    label: "safe",
    bugClass: "wrong-operator",
    path: "src/validate.ts",
    buggyLine: 0,
    note: "a fresh month-range guard using && — both bounds are unambiguously required (months are 1–12), so there is no defensible 'contract change' angle; only the operator distinguishes it from a || always-true bug",
    diff: `diff --git a/src/validate.ts b/src/validate.ts
@@ -4,2 +4,5 @@ export function isAdult(age: number): boolean {
   return age >= 18
 }
+export function isValidMonth(month: number): boolean {
+  return month >= 1 && month <= 12
+}
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
    return {
      id: c.id,
      label: c.label,
      bugClass: c.bugClass,
      caught: false,
      falsePositive: onPath.length > 0,
      nearestLine: onPath[0]?.line ?? null,
    }
  }
  let nearest: number | null = null
  let caught = false
  for (const f of onPath) {
    const dist = Math.abs(f.line - c.buggyLine)
    if (nearest === null || dist < Math.abs(nearest - c.buggyLine)) nearest = f.line
    if (dist <= window) caught = true
  }
  return {
    id: c.id,
    label: c.label,
    bugClass: c.bugClass,
    caught,
    falsePositive: false,
    nearestLine: nearest,
  }
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
