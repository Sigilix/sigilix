# Benchmark batch — answer key (ground truth)

Per-scenario planted items for labeling bot findings. Each item: the location, the
expected verdict (catch | silent), category, severity, and a one-line rationale.
This is the ground truth the `compare-reviewers` worksheets are scored against.

> Neutral PR framing is deliberate — titles/bodies carry no "benchmark"/SIG/AI hints
> so the bots aren't biased. Keep this file out of the e2e repos.

---

## B1 — backend — security — T1 (published / easy)

- **PR:** [sigilix-e2e-backend#26](https://github.com/Sigilix/sigilix-e2e-backend/pull/26) — "Add user search and CSV export endpoints"
- **Recall item (catch):** `src/routes/search.ts`, `GET /users/search` handler — the
  `q` query param is interpolated directly into the SQL string
  (`WHERE name ILIKE '%${q}%' OR email ILIKE '%${q}%'`). **Classic string-concat SQL
  injection.** Expected: **catch, P0/P1, category security.**
- **Precision traps (silent):**
  - `${sort}` interpolation is **safe** — `resolveSort` whitelists against `SORTABLE`.
    A finding calling the `ORDER BY ${sort}` an injection is a **false positive**.
  - `${limit}` interpolation is **safe** — `resolveLimit` clamps to an integer ≤ 100.
  - `GET /users/export.csv` uses a **parameterized** query (`$1`) — flagging it for
    injection is a **false positive**.
- **Notes:** the surrounding code shows the author *knew* about injection safety
  (whitelist + clamp + parameterized export) but missed the `q` value — a realistic
  "safe everywhere except one spot" shape. T1 floor: any competent reviewer catches it.

---

## B2 — backend — security — T2 (moderate)

- **PR:** [sigilix-e2e-backend#27](https://github.com/Sigilix/sigilix-e2e-backend/pull/27) — "Add saved payment methods endpoints"
- **Recall item (catch):** `src/routes/billing.ts`, `GET /users/:id/payment-methods`
  returns payment methods for **any** `:id` with **no check that `:id === req.subject`**
  — **IDOR / broken object-level authorization** (any authenticated user reads anyone's
  cards). Expected: **catch, P1, security.**
- **Precision trap (silent):** `GET /me/payment-methods` scopes to `subjectOf(req)`
  (the caller) — safe. Flagging it is a **false positive**.

## B3 — backend — logic — T3 (hard)

- **PR:** [sigilix-e2e-backend#28](https://github.com/Sigilix/sigilix-e2e-backend/pull/28) — "Add limited-stock coupon redemption endpoint"
- **Recall item (catch):** `src/routes/coupons.ts` redeem handler — `SELECT remaining`
  then a separate `UPDATE remaining - 1` is a **non-atomic check-then-act (TOCTOU)**:
  two concurrent redeems both pass the `remaining > 0` check and oversell (`remaining`
  goes negative). Fix = atomic `UPDATE … WHERE remaining > 0 RETURNING` or
  `SELECT … FOR UPDATE` in a transaction. Expected: **catch, P1, logic/concurrency.**
- No explicit trap.

## B4 — backend — performance — T2 (moderate)

- **PR:** [sigilix-e2e-backend#29](https://github.com/Sigilix/sigilix-e2e-backend/pull/29) — "Add team activity digest endpoint"
- **Recall item (catch):** `src/routes/digest.ts` `POST /digest` — `await` in a `for`
  loop runs **one query per user id, serially (N+1)**; ids are independent so it should
  batch (`WHERE user_id = ANY($1)` + GROUP BY) or parallelize. Expected: **catch, P2,
  performance.**
- **Precision trap (silent):** `applyOrderedSteps` also `await`s in a loop, but the
  steps are **ordered + dependent** (must be serial). Flagging it as N+1 is a **false
  positive**.

## B5 — backend — logic — **T4 (novel / "ungodly")**

- **PR:** [sigilix-e2e-backend#30](https://github.com/Sigilix/sigilix-e2e-backend/pull/30) — "Add per-subject token-bucket rate limiting"
- **Recall item (catch):** `src/rate-limit.ts` `TokenBucket.tryConsume` — on refill it
  sets `bucket.lastRefill = now`, **discarding the sub-interval remainder**
  (`elapsed % intervalMs`). Across repeated partial-interval calls the bucket loses that
  remainder every refill, so the **effective refill rate drifts below the configured
  rate** (systematic under-granting). Correct: `bucket.lastRefill += refills * intervalMs`.
  Expected: **catch, P1/P2, logic.** Ceiling case — likely missed by all three.
- Trap: the `Math.min(capacity, …)` cap is correct; flagging it is a FP.

---

## F1 — frontend — security — T1 (published / easy)

- **PR:** [sigilix-e2e-frontend#17](https://github.com/Sigilix/sigilix-e2e-frontend/pull/17) — "Add UserBio profile component"
- **Recall item (catch):** `src/components/UserBio.tsx` — `<div dangerouslySetInnerHTML={{ __html: bioHtml }} />`
  renders **user-authored** bio HTML unsanitized → **stored XSS.** Expected: **catch,
  P1, security.**
- **Precision trap (silent):** the sibling `dangerouslySetInnerHTML` renders
  `EDITOR_TIP_HTML`, a **hardcoded constant** — safe. Flagging it is a **false positive**.

## F2 — frontend — logic — T2 (moderate)

- **PR:** [sigilix-e2e-frontend#18](https://github.com/Sigilix/sigilix-e2e-frontend/pull/18) — "Add UserDetail panel"
- **Recall item (catch):** `src/components/UserDetail.tsx` — `useEffect(…, [])` omits
  `userId` from the dependency array; when the `userId` prop changes the panel **does
  not refetch** and shows the stale user. Fix: `[userId]`. Expected: **catch, P2, logic
  (exhaustive-deps).**
- No trap.

## F3 — frontend — performance — T3 (hard)

- **PR:** [sigilix-e2e-frontend#19](https://github.com/Sigilix/sigilix-e2e-frontend/pull/19) — "Add Dashboard with filtered member list"
- **Recall item (catch):** `src/components/Dashboard.tsx` — `fetchOptions` is a fresh
  object literal **every render**, used as a `useEffect(…, [fetchOptions])` dependency →
  the effect **refires on every render** (refetch loop / wasted work). Fix: hoist the
  constant or drop it from deps. Expected: **catch, P2/P3, performance.**
- **Precision trap (silent):** the `visible = useMemo(…)` is **correctly needed** (feeds
  a memoized row list); flagging it as an unnecessary/premature memo is a **false positive**.

## F4 — frontend — logic — **T4 (novel / "ungodly")**

- **PR:** [sigilix-e2e-frontend#20](https://github.com/Sigilix/sigilix-e2e-frontend/pull/20) — "Add membership cache for org permission checks"
- **Recall item (catch):** `src/api/membership-cache.ts` — `membershipKey(orgId, userId)`
  returns `orgId + userId` with **no delimiter**, so `("12","3")` and `("1","23")` both key
  to `"123"`. A membership/role lookup can therefore return a **different (org,user)
  pair's** cached entry — wrong-tenant role confusion (security-adjacent). Fix: a
  delimiter, e.g. `` `${orgId}:${userId}` ``. Expected: **catch, P1/P2, logic.** Ceiling —
  likely missed.
- No trap.

---

## FS1 — fullstack — security — T2 (moderate)

- **PR:** [sigilix-e2e-fullstack#21](https://github.com/Sigilix/sigilix-e2e-fullstack/pull/21) — "Add invoice delete endpoint"
- **Recall item (catch):** `server/api.ts` `POST /api/invoices/:id/delete` gates on
  `req.body.isAdmin === true` — a **client-supplied** flag. The server does no real
  authorization (no session/role check); any caller can send `{isAdmin:true}` and delete
  any invoice. **Broken access control / authorization trusting the client.** Expected:
  **catch, P1, security.**
- No trap (the `403` looks like a guard but *is* the bug).

## FS2 — fullstack — tests — T2 (**trap — probes SIG-347**)

- **PR:** [sigilix-e2e-fullstack#22](https://github.com/Sigilix/sigilix-e2e-fullstack/pull/22) — "Add invoice total footer + money helpers"
- **Precision trap (silent):** `web/InvoiceFooter.tsx` is pure presentation glue over
  `formatCents`/`sumCents`, which **are unit-tested in the same PR** (`shared/money.test.ts`).
  A tests-specialist firing "InvoiceFooter is untested / needs tests" is the **over-fire**
  the SIG-347 sibling-cross-check / glue suppression should suppress. Expected: **SILENT**
  on the footer (P3 max at most). This is the direct probe of the tests-specialist
  precision work.
- The money helpers themselves are tested — no missing-coverage finding is warranted.

## FS3 — fullstack — logic — T3 (hard)

- **PR:** [sigilix-e2e-fullstack#23](https://github.com/Sigilix/sigilix-e2e-fullstack/pull/23) — "Add prorated refund quote endpoint"
- **Recall item (catch):** `shared/refund.ts` `proratedRefundCents` converts integer cents
  to **float dollars** (`amountCents / 100`), multiplies by a float fraction, and rounds
  back. The codebase otherwise keeps money in **integer cents**; this float round-trip can
  drift a cent at certain ratios — the **float-money antipattern.** Correct:
  `Math.round(amountCents * (daysTotal - daysUsed) / daysTotal)`. Expected: **catch, P1/P2,
  logic.**
- No trap.

## FS4 — fullstack — control — clean (hallucination floor)

- **PR:** [sigilix-e2e-fullstack#24](https://github.com/Sigilix/sigilix-e2e-fullstack/pull/24) — "Extract invoice row mapping into a typed helper"
- **Expected: SILENT.** Behavior-preserving refactor (extract `toInvoice` + `InvoiceRow`
  type). No planted bug — any finding here counts toward the **hallucination/FP floor.**
- **Label note:** the `rows as InvoiceRow[]` cast is idiomatic for `pg` and behavior-
  equivalent to the prior untyped access; treat a finding on it as **noise**, not a TP.
