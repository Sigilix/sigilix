# Benchmark ground truth — sigilix-e2e-fullstack — "payments & refunds" (RECONCILED)

Branch `pr/11-payments-refunds`, commit 2a3bc30. Head-to-head: Sigilix vs CodeRabbit vs
Greptile, blind, same diff/moment. Ground truth hand-verified by an independent blind
bug-hunt (code-reviewer) + adversarial label audit (DeepSeek-v4-pro). Code is UNCHANGED;
only the labels were corrected (T5→real; +5 genuine unplanned bugs added) so every real
issue scores as a true positive and only the 4 genuine traps measure precision.

Difficulty: EASY (AST/deterministic) → MEDIUM (logic) → UNGODLY (intent-level subtle).

## Real bugs — 18 rows (group a tool's finding to a row when the same fix addresses it)

| id | file | tier | cat | sev | the bug |
|----|------|------|-----|-----|---------|
| b1 | payments.ts webhook | EASY | security | P0 | SQL injection — `event.invoiceId` string-interpolated into the UPDATE |
| b2 | payments.ts charge | EASY-MED | logic | P1 | charge accounting broken: INSERT not awaited (fire-and-forget) AND `paidCents` re-adds `amountCents` on top of a SUM that may already include it (double-count). one fix region |
| b3 | payments.ts list | EASY | perf | P3 | `await` inside `for...of` enriching each payment with refunds (N+1) |
| b4 | payments.ts charge | EASY | logic | P2 | invoice-not-found returns default 200 (missing `.status(404)`) |
| b5 | payments.ts (all) | EASY-MED | logic | P2 | no try/catch + no error middleware → DB error = unhandled rejection / hang / crash |
| b6 | refunds.ts | MEDIUM | logic | P1 | refund `amount` treated as dollars `*100` (float, no round) — 100× over-refund + fractional cents into an int column; contradicts the cents-on-the-wire contract |
| b7 | payments.ts list | MEDIUM | logic | P1 | pagination `OFFSET page*limit` — page 1 skips the first page (should be `(page-1)*limit`) |
| b8 | payments.ts list | MEDIUM | logic | P1 | raw snake_case rows `as unknown as Payment[]` — wire contract is camelCase; client reads undefined |
| b9 | payments.ts charge | UNGODLY | security | P1 | IDOR — charge looks up invoice by `:id` only, never scopes to `req.auth.customerId` |
| b10 | refunds.ts | UNGODLY | logic | P1 | over-refund — `alreadyRefunded` read but never used to cap; can refund more than paid |
| b11 | payments.ts webhook | UNGODLY | logic | P1 | idempotency violation — `event.id` never read/stored/checked despite the comment; retry double-applies |
| b12 | refunds.ts | UNGODLY | logic | P1 | read-modify-write race — SELECT SUM then INSERT, no txn/lock; concurrent refunds over-refund |
| b13 | payments.ts charge | UNGODLY-MED | logic | P1 | wrong predicate — flips invoice to `paid` when `paidCents>0` (should be `>= amount_cents`); partial payment marked paid; status hardcoded `"paid"` in the response |
| b14 | payments.ts webhook | MEDIUM | security | P0 | hardcoded fallback secret `whsec_test_placeholder` does NOT fail closed → forgeable signature (was labeled a trap; it is a real vuln) |
| b15 | payments.ts refund | UNGODLY | security | P1 | IDOR — refund endpoint never scopes invoice/payment to `req.auth.customerId`; can refund anyone's payment, and `paymentId` not checked against `:id` |
| b16 | payments.ts list | MEDIUM | security | P1 | IDOR — `/api/payments` lists ALL customers' payments; `?ids=` fetches arbitrary payments — no customer scoping |
| b17 | payments.ts charge | MEDIUM | logic | P2 | `amountCents` from body unvalidated — NaN/negative/float writes (contrast: limit/page ARE guarded) |
| b18 | refunds.ts / refund route | LOW | logic | P3 | refund response `{refundId, refundedCents}` matches no declared wire type (`Refund` is `{id,paymentId,amountCents}`) |
| b19 | payments.ts webhook | UNGODLY | logic | P1 | webhook ignores `event.type` — always `UPDATE … status='paid'`; a `refund.succeeded` event wrongly marks the invoice paid (and records no refund) |

Tiers: EASY={b1,b2,b3,b4,b5} · MEDIUM={b6,b7,b8,b14,b16,b17} · UNGODLY={b9,b10,b11,b12,b13,b15,b19} · LOW={b18}
P0/P1 (high-sev, the trust-critical subset)={b1,b2,b6,b7,b8,b9,b10,b11,b12,b13,b14,b15,b16,b19} (14 rows)
Total real-bug rows = 19. UNGODLY subset = {b9,b10,b11,b12,b13,b15,b19} (7).

## Traps (genuinely safe) — 4

| id | file | looks like | why safe |
|----|------|-----------|----------|
| t1 | payments.ts list | SQL injection (string-built `IN (...)`) | placeholders are `$1,$2,...` from array index; ids bound as params — fully parameterized |
| t2 | payments.ts balance | IDOR (over-eager) | query IS scoped `WHERE id=$1 AND customer_id=$2` with `req.auth.customerId`; 404 if not owned — correct authz |
| t3 | payments.ts balance | float money bug | outstanding kept in integer cents (`amount - paid + refunded`); no float (a pedantic `::int` overflow note is defensible at absurd magnitudes, not counted) |
| t4 | payments.ts list | unsafe `Number()` coercion | `Number.isInteger && 1<=n<=100` guard → 400 otherwise; validated |

Also genuinely-safe (don't count a flag as a real catch): `timingSafeEqual` length pre-guard (correct idiom), `req.auth!` assertion (middleware guarantees it).

## Scoring
- Recall(tool) = real-bug rows caught ÷ 18; also report the P0/P1 subset (÷13) and the UNGODLY subset (÷6).
- Precision(tool) = real catches ÷ (real catches + trap-flagged-as-bug + hallucinated findings).
- Trust metric = count of high-sev (P0/P1) FALSE alarms (trap or hallucination). Zero is the believability bar.
- Equivalence: one row per root issue / shared fix; group a tool's wording variants to the same row.
