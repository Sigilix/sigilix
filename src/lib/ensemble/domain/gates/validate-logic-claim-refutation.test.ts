// SIG-328: the logic-claim refutation gate drops a high-sev logic finding ONLY
// when it can POSITIVELY prove the cited claim false against the AST — the two
// stable v4-pro priors (control-flow "double-response" + synchronous "race").
// It fails OPEN on every ambiguity, so it cannot suppress a real bug. These
// tests pin both the refutations AND the recall-safety counter-cases.

import { describe, expect, it } from "vitest"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import {
  evaluateLogicClaimRefutation,
  parseLogicClaimRefutationMode,
  LOGIC_CLAIM_REFUTATION_MIN_SEVERITY,
} from "@/src/lib/ensemble/domain/gates/validate-logic-claim-refutation"
import { createAstCache } from "@/src/features/ast-rules/domain/parse-cache"
import { LARGE_FILE_BYTES } from "@/src/features/ast-rules/domain/parser"
import {
  finding,
  ctx,
} from "@/src/lib/ensemble/domain/gates/validate-logic-claim-refutation.test-helpers"

describe("parseLogicClaimRefutationMode", () => {
  it("defaults to off; parses shadow/enforce case-insensitively", () => {
    expect(parseLogicClaimRefutationMode(undefined)).toBe("off")
    expect(parseLogicClaimRefutationMode("nonsense")).toBe("off")
    expect(parseLogicClaimRefutationMode("  SHADOW ")).toBe("shadow")
    expect(parseLogicClaimRefutationMode("enforce")).toBe("enforce")
  })
})

describe("control-flow refutation (REFUTE: the early-return guard makes the tail conditional)", () => {
  const AUTH = `export function requireAdmin(svc) {
  return async (req, res, next) => {
    if (!(await svc.isAdmin(req.user))) {
      return res.status(403).end()
    }
    next()
  }
}`
  it("refutes 'next() runs unconditionally after the 403 / double-response'", () => {
    const f = finding({
      path: "src/middleware/auth.ts",
      line: 6,
      headline: "`next()` runs unconditionally after the 403 response, causing a double-response",
      body: "When isAdmin returns false the middleware returns; next() is not inside an else block.",
    })
    const d = evaluateLogicClaimRefutation(f, ctx("src/middleware/auth.ts", AUTH))
    expect(d).toEqual({ keep: false, reason: "control-flow-claim-refuted-by-guard" })
  })

  it("refutes a generic 'runs unconditionally' when the immediate guard returns", () => {
    const SRC = `export function f(rateLimited) {
  if (rateLimited) return
  doWork()
}`
    const f = finding({ line: 3, headline: "doWork() runs unconditionally", body: "doWork always executes." })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(false)
  })

  it("refutes when the finding is anchored one line after the refuted tail statement", () => {
    const f = finding({
      path: "src/middleware/auth.ts",
      line: 7,
      headline: "`next()` runs unconditionally after the 403 response",
      body: "The next call is not inside an else branch.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/middleware/auth.ts", AUTH))).toEqual({
      keep: false,
      reason: "control-flow-claim-refuted-by-guard",
    })
  })

  it("refutes when the finding is anchored on the preceding guard's closing brace", () => {
    const f = finding({
      path: "src/middleware/auth.ts",
      line: 5,
      headline: "`next()` runs unconditionally after the 403 response",
      body: "The next call is not inside an else branch.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/middleware/auth.ts", AUTH))).toEqual({
      keep: false,
      reason: "control-flow-claim-refuted-by-guard",
    })
  })

  it("refutes the typed corpus auth shape when the live model anchors the closing brace", () => {
    const SRC = `export function requireAdmin(svc: AuthService) {
  return async (req: Req, res: Res, next: Next) => {
    if (!(await svc.isAdmin(req.user))) {
      return res.status(403).end()
    }
    next()
  }
}`
    const f = finding({
      path: "src/middleware/auth.ts",
      line: 7,
      headline: "`next()` runs after 403 response, causing a double-response error",
      body: "When `svc.isAdmin(req.user)` returns `false`, the middleware sends `res.status(403).end()` and returns. However, the `next()` call is not inside an `else` block.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/middleware/auth.ts", SRC))).toEqual({
      keep: false,
      reason: "control-flow-claim-refuted-by-guard",
    })
  })
})

describe("control-flow recall-safety (KEEP: a real bug whose claim is true/unprovable)", () => {
  it("KEEPS a real double-response (two sends, no separating return)", () => {
    const SRC = `export function handler(req, res) {
  res.status(200).json({ ok: true })
  res.status(200).json({ done: true })
}`
    const f = finding({
      line: 3,
      headline: "Second response sent — double-response",
      body: "res.json is called twice; the second send throws ERR_HTTP_HEADERS_SENT.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a real double-response where a send PRECEDES the guard (code-reviewer P1)", () => {
    const SRC = `export function h(res, x, a, b) {
  res.json(a)
  if (x) return
  res.json(b)
}`
    const f = finding({
      line: 4,
      headline: "Double-response: res.json is called twice",
      body: "On the !x path the second res.json send throws ERR_HTTP_HEADERS_SENT.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a real response-before-tail bug even when a later guard terminates", () => {
    const SRC = `export function h(res, x, next) {
  res.status(403).end()
  if (x) return
  next()
}`
    const f = finding({
      line: 4,
      headline: "`next()` runs after `res.status(403).end()`, causing a double response",
      body: "The response is sent before the guard, so the later `next()` still runs after it on the non-x path.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a missing-await auth guard — un-awaited call makes the guard dead → real bypass (SIG-328)", () => {
    // Identical to the refuted AUTH shape above, but the guard call is NOT
    // awaited: `!svc.isAdmin(req)` is `!Promise` === always false, so the 403
    // never fires and next() truly runs unconditionally. The guard is dead — the
    // missing await IS the bug — so the gate must NOT refute it (the prod eval
    // showed this case regressing 6/12 → 1/12 recall when SIG-328 was enforced).
    const SRC = `export function requireAdmin(svc: AuthService) {
  return async (req: Req, res: Res, next: Next) => {
    if (!svc.isAdmin(req.user)) {
      return res.status(403).end()
    }
    next()
  }
}`
    const f = finding({
      path: "src/middleware/auth.ts",
      line: 6,
      headline: "`next()` runs unconditionally — auth bypass from a missing await",
      body: "`svc.isAdmin(req.user)` returns a Promise; without `await`, `!Promise` is always false, so the 403 guard never triggers and next() always runs.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/middleware/auth.ts", SRC)).keep).toBe(true)
  })

  it("still REFUTES the same shape once the guard call is awaited (await → effective guard)", () => {
    const SRC = `export function requireAdmin(svc: AuthService) {
  return async (req: Req, res: Res, next: Next) => {
    if (!(await svc.isAdmin(req.user))) {
      return res.status(403).end()
    }
    next()
  }
}`
    const f = finding({
      path: "src/middleware/auth.ts",
      line: 6,
      headline: "`next()` runs unconditionally after the 403 response",
      body: "next() is not inside an else block.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/middleware/auth.ts", SRC)).keep).toBe(false)
  })

  it("KEEPS when the terminating guard repeats the same cited tail action", () => {
    const SRC = `export function h(res, x, a, b) {
  if (x) {
    res.json(a)
    return
  }
  res.json(b)
}`
    const f = finding({
      line: 6,
      headline: "Double-response: res.json is called twice",
      body: "The handler calls `res.json` in both the guard and the tail path.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a nested callback bug even when an outer guard terminates before the callback statement", () => {
    const SRC = `export function h(res, items, blocked) {
  if (blocked) return
  items.forEach((item) => {
    if (item.bad) res.json({ bad: true })
    res.json(item)
  })
}`
    const f = finding({
      line: 5,
      headline: "Double response: `res.json` is called twice inside the callback",
      body: "When `item.bad` is true, the callback sends one response and then sends another response.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS when the claim's subject is unbound (guard unrelated to the finding)", () => {
    const SRC = `export function f(rateLimited) {
  if (rateLimited) return
  next()
}`
    const f = finding({
      line: 3,
      headline: "Double-response: the handler emits two responses",
      body: "the second emit fires regardless",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })
})

describe("sync-race refutation (REFUTE: synchronous in-memory read-check-write)", () => {
  const WITHDRAW = `export function withdraw(account, amount) {
  assertPositive(amount)
  if (account.balance < amount) throw new Error("insufficient")
  account.balance -= amount
}`
  it("refutes 'read-check-write race on account.balance' in a synchronous fn", () => {
    const f = finding({
      path: "src/wallet/withdraw.ts",
      line: 4,
      score: 4,
      headline: "Read-check-write race on `account.balance`",
      body: "TOCTOU: concurrent withdrawals can overdraw the account.",
    })
    const d = evaluateLogicClaimRefutation(f, ctx("src/wallet/withdraw.ts", WITHDRAW))
    expect(d).toEqual({ keep: false, reason: "sync-race-claim-refuted-no-async-boundary" })
  })
})

describe("sync-race recall-safety (KEEP: any async / closure / IO / external boundary)", () => {
  it("KEEPS a genuine ASYNC race (await between check and write)", () => {
    const SRC = `export async function withdraw(account, amount) {
  if (account.balance < amount) throw new Error("x")
  await audit(account)
  account.balance -= amount
}`
    const f = finding({ line: 4, score: 4, headline: "Read-check-write race", body: "TOCTOU across the await." })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a synchronous FILESYSTEM TOCTOU (write is a call, not a member assignment)", () => {
    const SRC = `export function save(path, data) {
  if (existsSync(path)) return
  writeFileSync(path, data)
}`
    const f = finding({ line: 3, score: 4, headline: "TOCTOU race between existsSync and writeFileSync", body: "check-then-act on the filesystem." })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS when a nested closure could defer the write", () => {
    const SRC = `export function process(items, acc) {
  if (acc.total < 0) throw new Error("x")
  items.forEach((i) => { acc.total += i })
  acc.total -= 1
}`
    const f = finding({ line: 4, score: 4, headline: "Non-atomic read-check-write on acc.total", body: "race condition / lost update." })
    expect(evaluateLogicClaimRefutation(f, ctx("src/x.ts", SRC)).keep).toBe(true)
  })
})

describe("idempotency retry refutation", () => {
  const STABLE_KEY = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: event.id },
  )
  return ack()
}`

  it("refutes a retry/redelivery double-charge claim when a stable idempotency key is visible", () => {
    const f = finding({
      path: "src/payments/charge.ts",
      line: 5,
      headline: "Charge is created without checking whether the order was already paid",
      body: "If Stripe redelivers the webhook, this double-charges the order because there is no paid flag.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", STABLE_KEY))).toEqual({
      keep: false,
      reason: "idempotency-claim-refuted-by-visible-key",
    })
  })

  it("KEEPS the real bug when there is no idempotency key", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  await stripe.charges.create({ amount: order.amountCents, customer: order.customerId })
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 3,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook calls stripe.charges.create again with no idempotency key.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a generic double-charge claim without retry/redelivery wording", () => {
    const f = finding({
      path: "src/payments/charge.ts",
      line: 5,
      headline: "Charge can double-charge the order",
      body: "The handler does not check whether the order was already paid.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", STABLE_KEY)).keep).toBe(true)
  })

  it("KEEPS retry claims when the idempotency key is request.id", () => {
    const SRC = `export async function handleChargeWebhook(request, db, stripe) {
  const order = await db.orders.find(request.orderId)
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: request.id },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 5,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook can call stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS retry claims when the idempotency key is order.id", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: order.id },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 5,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook can call stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS when only an unrelated nested call has a stable idempotency key", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe, audit) {
  const order = await db.orders.find(event.orderId)
  function auditDelivery() {
    return audit.record({ idempotencyKey: event.id })
  }
  await stripe.charges.create({ amount: order.amountCents, customer: order.customerId })
  auditDelivery()
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 6,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook calls stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS when the idempotency key is computed through a helper expression", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: (() => event.id)() },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 5,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook calls stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS when multiple calls on the cited line make the target ambiguous", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe, audit) {
  const order = await db.orders.find(event.orderId)
  await stripe.charges.create({ amount: order.amountCents, customer: order.customerId }, { idempotencyKey: event.id }); audit.record("charged")
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 3,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook calls stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS when visible context says event.id is fresh per retry attempt", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  // Provider retries get a fresh event.id for the same order.
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: event.id },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 6,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook uses a fresh event id, so the idempotency key changes.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a generic retry claim when source context says different webhook events share an order", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  // Different webhook events can map to the same order, each with a unique ID.
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: event.id },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 6,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook can call stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS distinct-event duplicate claims even when a delivery key is present", () => {
    const f = finding({
      path: "src/payments/charge.ts",
      line: 5,
      headline: "A different event.id can charge the same order again",
      body: "The idempotency key is event.id, but a distinct event id for the same order bypasses it.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", STABLE_KEY)).keep).toBe(true)
  })

  it("KEEPS when the idempotency key is a hardcoded constant", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: "hardcoded-charge-key" },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 5,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook can call stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS when source context says event.id is not stable across retries", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  // event.id is not stable across retries; the id changes per attempt.
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: event.id },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 6,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook can call stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS when a long source comment eventually says event.id varies", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe) {
  const order = await db.orders.find(event.orderId)
  // event.id is assigned by the upstream delivery layer after routing, batching, fanout, provider normalization, and retry scheduling; it varies per delivery attempt.
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: event.id },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 6,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook can call stripe.charges.create again.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC)).keep).toBe(true)
  })

  it("still refutes when an unrelated timestamp log appears in the function", () => {
    const SRC = `export async function handleChargeWebhook(event, db, stripe, logger) {
  logger.info("processing at", Date.now())
  const order = await db.orders.find(event.orderId)
  await stripe.charges.create(
    { amount: order.amountCents, customer: order.customerId },
    { idempotencyKey: event.id },
  )
  return ack()
}`
    const f = finding({
      path: "src/payments/charge.ts",
      line: 6,
      headline: "Webhook retry can double-charge the order",
      body: "A redelivered webhook calls stripe.charges.create again despite no paid flag.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/payments/charge.ts", SRC))).toEqual({
      keep: false,
      reason: "idempotency-claim-refuted-by-visible-key",
    })
  })
})

describe("removed unsound return-value FP refutation", () => {
  const TRANSITION = `export function transition(order, to) {
  if (to === "refunded") {
    if (order.status !== "paid") throw new Error("only paid orders can be refunded")
    order.status = "refunded"
    order.refundedAt = Date.now()
    return order
  }
  return order
}`

  it("KEEPS an undefined-return claim even when the cited branch returns an identifier", () => {
    const f = finding({
      path: "src/order/transition.ts",
      line: 6,
      headline: "`transition` returns `undefined` for the 'refunded' case",
      body: "The return is inside the if block, so callers receive undefined.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/order/transition.ts", TRANSITION)).keep).toBe(true)
  })

  it("KEEPS an undefined-return claim when the line is broad and another branch can fall through", () => {
    const SRC = `export function maybe(x) {
  if (x) return 1
}`
    const f = finding({
      path: "src/maybe.ts",
      line: 1,
      headline: "`maybe` returns undefined",
      body: "The false branch falls through with no return value.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/maybe.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS an undefined-return claim anchored on an if statement with a valued return in only one branch", () => {
    const SRC = `export function maybe(x) {
  if (x) return 1
}`
    const f = finding({
      path: "src/maybe.ts",
      line: 2,
      headline: "`maybe` returns undefined",
      body: "The false branch falls through with no return value.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/maybe.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS an undefined-return claim when the cited return explicitly returns undefined", () => {
    const SRC = `export function maybe() {
  return undefined
}`
    const f = finding({
      path: "src/maybe.ts",
      line: 2,
      headline: "`maybe` returns `undefined`",
      body: "This return returns `undefined` explicitly.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/maybe.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS an undefined-return claim when the cited return uses void 0", () => {
    const SRC = `export function maybe() {
  return void 0
}`
    const f = finding({
      path: "src/maybe.ts",
      line: 2,
      headline: "`maybe` returns `undefined`",
      body: "The return statement returns void.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/maybe.ts", SRC)).keep).toBe(true)
  })
})

describe("removed unsound state-transition FP refutation", () => {
  it("KEEPS a double-refund claim even when a nearby guard appears to protect one assignment path", () => {
    const SRC = `export function transition(order, to) {
  if (to === "refunded") {
    if (order.status !== "paid") throw new Error("only paid orders can be refunded")
    order.status = "refunded"
    return order
  }
  if (to === "force-refunded") {
    order.status = "refunded"
    return order
  }
  return order
}`
    const f = finding({
      path: "src/order/transition.ts",
      line: 4,
      headline: "Refund transition allows double-refund, overwriting `refundedAt`",
      body: "Another path can still set the order to refunded without the paid-only guard.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/order/transition.ts", SRC)).keep).toBe(true)
  })
})

describe("scope + fail-open guards (KEEP)", () => {
  const AUTH = `export function requireAdmin(svc) {
  return async (req, res, next) => {
    if (!(await svc.isAdmin(req.user))) {
      return res.status(403).end()
    }
    next()
  }
}`
  const cfFinding = (o: Partial<PrReviewFinding> = {}) =>
    finding({ path: "src/middleware/auth.ts", line: 6, headline: "`next()` runs unconditionally after the 403", body: "double-response", ...o })

  it("KEEPS non-logic findings", () => {
    expect(evaluateLogicClaimRefutation(cfFinding({ category: "security" }), ctx("src/middleware/auth.ts", AUTH)).keep).toBe(true)
  })
  it(`KEEPS below the sev>=${LOGIC_CLAIM_REFUTATION_MIN_SEVERITY} floor`, () => {
    expect(evaluateLogicClaimRefutation(cfFinding({ score: 3 }), ctx("src/middleware/auth.ts", AUTH)).keep).toBe(true)
  })
  it("KEEPS a finding with no checkable claim shape", () => {
    const f = cfFinding({ headline: "off-by-one in the loop bound", body: "the slice drops the last element" })
    expect(evaluateLogicClaimRefutation(f, ctx("src/middleware/auth.ts", AUTH)).keep).toBe(true)
  })
  it("KEEPS when the cited source is unavailable (window-blind)", () => {
    expect(evaluateLogicClaimRefutation(cfFinding(), { fullFileByPath: new Map() }).keep).toBe(true)
  })
  it("KEEPS when the source fails to parse", () => {
    expect(evaluateLogicClaimRefutation(cfFinding(), ctx("src/middleware/auth.ts", "function ( { ][ )")).keep).toBe(true)
  })
  it("KEEPS for a non-source file extension", () => {
    expect(evaluateLogicClaimRefutation(cfFinding({ path: "docs/auth.md" }), ctx("docs/auth.md", AUTH)).keep).toBe(true)
  })
})

describe("unused-identifier refutation (REFUTE when the symbol is referenced)", () => {
  const SRC = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  return rows.filter((r) => r.name.includes(needle))
}`
  it("refutes 'Unused \`req\` parameter' when req IS referenced", () => {
    const f = finding({ path: "src/filter.ts", line: 2, headline: "Unused `req` parameter after refactor", body: "the req parameter is no longer used" })
    expect(evaluateLogicClaimRefutation(f, ctx("src/filter.ts", SRC))).toEqual({ keep: false, reason: "unused-claim-refuted-identifier-is-referenced" })
  })
  it("KEEPS 'unused `dead` variable' when dead really is unused (appears once)", () => {
    const S = `export function f(rows) {
  const dead = 1
  return rows.length
}`
    const g = finding({ path: "src/f.ts", line: 2, headline: "Unused variable `dead`", body: "the dead binding is never referenced" })
    expect(evaluateLogicClaimRefutation(g, ctx("src/f.ts", S)).keep).toBe(true)
  })
  it("KEEPS a genuinely-unused OUTER var that a NESTED scope reuses the name of (code-reviewer P1)", () => {
    const S = `export function outer(rows) {
  const dead = 1
  return rows.map((x) => {
    const dead = x * 2
    return dead
  })
}`
    const g = finding({ path: "src/f.ts", line: 2, headline: "Unused variable `dead`", body: "the outer dead binding is never used" })
    expect(evaluateLogicClaimRefutation(g, ctx("src/f.ts", S)).keep).toBe(true)
  })
})

describe("missing-return-type refutation (REFUTE when the annotation is present)", () => {
  it("refutes 'return type annotation is missing' when the function HAS one", () => {
    const S = `export function filterRows(rows: Row[], req: Req): Row[] {
  return rows.filter((r) => r.name.includes(String(req.query.q ?? "")))
}`
    const f = finding({ path: "src/filter.ts", line: 1, headline: "Function return type annotation is missing", body: "filterRows lacks an explicit return type annotation" })
    expect(evaluateLogicClaimRefutation(f, ctx("src/filter.ts", S))).toEqual({ keep: false, reason: "missing-return-type-claim-refuted-annotation-present" })
  })
  it("KEEPS 'return type is missing' when it genuinely is absent", () => {
    const S = `export function filterRows(rows: Row[], req: Req) {
  return rows.filter((r) => r.name.includes(String(req.query.q ?? "")))
}`
    const f = finding({ path: "src/filter.ts", line: 1, headline: "Function return type annotation is missing", body: "no explicit return type" })
    expect(evaluateLogicClaimRefutation(f, ctx("src/filter.ts", S)).keep).toBe(true)
  })
  it("KEEPS a real bug whose text merely contains 'return type' (the GUARD, not the annotation — code-reviewer P2)", () => {
    const S = `export async function load(id: string): Promise<Data> {
  return fetchData(id)
}`
    const f = finding({ path: "src/load.ts", line: 2, headline: "Missing the return-type guard before the await", body: "no narrowing before returning" })
    expect(evaluateLogicClaimRefutation(f, ctx("src/load.ts", S)).keep).toBe(true)
  })
})

describe("SIG-336: parse-once cache integration (behavior-invariant, parses each file once)", () => {
  const AUTH = `export function requireAdmin(svc) {
  return async (req, res, next) => {
    if (!(await svc.isAdmin(req.user))) {
      return res.status(403).end()
    }
    next()
  }
}`
  // A refuting control-flow finding (the canonical case from above).
  const refuting = finding({
    path: "src/middleware/auth.ts",
    line: 6,
    headline: "`next()` runs unconditionally after the 403 response, causing a double-response",
    body: "When isAdmin returns false the middleware returns; next() is not inside an else block.",
  })
  // A second finding citing the SAME file that does NOT refute (no claim shape).
  const nonRefuting = finding({
    path: "src/middleware/auth.ts",
    line: 6,
    headline: "consider renaming next for clarity",
    body: "stylistic only",
  })

  it("parses a file cited by N findings exactly ONCE (cache.size === 1)", () => {
    const cache = createAstCache()
    const fullFileByPath = new Map([["src/middleware/auth.ts", AUTH]])
    evaluateLogicClaimRefutation(refuting, { fullFileByPath, astCache: cache })
    evaluateLogicClaimRefutation(nonRefuting, { fullFileByPath, astCache: cache })
    evaluateLogicClaimRefutation(refuting, { fullFileByPath, astCache: cache })
    expect(cache.size).toBe(1) // one acorn parse for all three evaluations
  })

  it("yields the SAME decision with or without a cache (behavior-invariant)", () => {
    const fullFileByPath = new Map([["src/middleware/auth.ts", AUTH]])
    const cache = createAstCache()
    const withCache = evaluateLogicClaimRefutation(refuting, { fullFileByPath, astCache: cache })
    const withoutCache = evaluateLogicClaimRefutation(refuting, { fullFileByPath })
    expect(withCache).toEqual(withoutCache)
    expect(withCache).toEqual({ keep: false, reason: "control-flow-claim-refuted-by-guard" })
  })

  it("KEEPS (fails open) when the cited file exceeds the 500KB cache guard", () => {
    const cache = createAstCache()
    // Valid source padded past the byte ceiling — would refute if parsed, but the
    // cache skips it by size, so the gate fails open and keeps the finding.
    const huge = `${AUTH}\n// ${"x".repeat(LARGE_FILE_BYTES + 1)}\n`
    const fullFileByPath = new Map([["src/middleware/auth.ts", huge]])
    const d = evaluateLogicClaimRefutation(refuting, { fullFileByPath, astCache: cache })
    expect(d.keep).toBe(true)
  })
})
