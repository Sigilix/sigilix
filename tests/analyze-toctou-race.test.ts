// SIG-317 4b-v2 — TOCTOU / check-then-act race injector. The output is a HINT
// injected into the logic specialist's prompt (a FACT, not a finding) so it can't
// be a posted false positive — but a wrong hint wastes the model's attention, so
// these pin the FIRE/SILENT boundary, especially the atomicity exclusions.

import { describe, it, expect } from "vitest"
import { analyzeToctouRace, renderToctouHints } from "../src/lib/ast-rules/analyze-toctou-race"

const m = (...fns: string[]) => new Map([["svc.ts", fns.join("\n\n")]])
const fired = (src: string) => analyzeToctouRace(m(src)).map((h) => h.fn)

// The canonical racy shape (the pr/11 addSeat bug, minimised).
const RESERVE_RACE = `
function reserveStock(id, n) {
  const { rows } = await pool.query("SELECT qty FROM inventory WHERE id = $1", [id]);
  if (rows.length === 0) return false;
  if (rows[0].qty < n) return false;
  await pool.query("UPDATE inventory SET qty = qty - $2 WHERE id = $1", [id, n]);
  return true;
}`

describe("analyzeToctouRace — FIRES on real check-then-act races", () => {
  it("fires on a SELECT-check-then-separate-relative-UPDATE (reserveStock)", () => {
    expect(fired(RESERVE_RACE)).toEqual(["reserveStock"])
  })

  it("fires on a counter cap (claimCoupon: used_count >= max_uses then +1)", () => {
    const src = `function claimCoupon(id) {
      const { rows } = await pool.query("SELECT used_count, max_uses FROM coupons WHERE id = $1", [id]);
      if (rows[0].used_count >= rows[0].max_uses) return false;
      await pool.query("UPDATE coupons SET used_count = used_count + 1 WHERE id = $1", [id]);
      return true;
    }`
    expect(fired(src)).toEqual(["claimCoupon"])
  })

  it("names the atomic sibling in the message when one exists in the same change", () => {
    const sibling = `function reserveStockAtomic(id, n) {
      await pool.query("UPDATE inventory SET qty = qty - $2 WHERE id = $1 AND qty >= $2", [id, n]);
    }`
    const hints = analyzeToctouRace(m(RESERVE_RACE, sibling))
    expect(hints.map((h) => h.fn)).toEqual(["reserveStock"])
    expect(hints[0]!.message).toContain("reserveStockAtomic")
    expect(hints[0]!.message).toContain("ATOMICALLY")
  })
})

describe("analyzeToctouRace — SILENT on every atomic / safe variant", () => {
  it("SILENT on an atomic test-and-set (guard inside the UPDATE WHERE)", () => {
    const src = `function reserveStockAtomic(id, n) {
      const res = await pool.query("UPDATE inventory SET qty = qty - $2 WHERE id = $1 AND qty >= $2", [id, n]);
      return (res.rowCount ?? 0) > 0;
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on SELECT ... FOR UPDATE (pessimistic row lock)", () => {
    const src = `function claimCouponLocked(id) {
      const { rows } = await pool.query("SELECT used_count, max_uses FROM coupons WHERE id = $1 FOR UPDATE", [id]);
      if (rows[0].used_count >= rows[0].max_uses) return false;
      await pool.query("UPDATE coupons SET used_count = used_count + 1 WHERE id = $1", [id]);
      return true;
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on INSERT ... ON CONFLICT (idempotent upsert — over-credit injector's domain)", () => {
    const src = `function grantInviteUpsert(userId) {
      const { rows } = await pool.query("SELECT invites_sent FROM users WHERE id = $1", [userId]);
      if (rows[0].invites_sent >= 5) return false;
      await pool.query("INSERT INTO invites (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
      return true;
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on an optimistic-version / CAS predicate in the UPDATE WHERE", () => {
    const src = `function bumpVersion(id, expected) {
      const { rows } = await pool.query("SELECT v FROM docs WHERE id = $1", [id]);
      if (rows[0].v < 1) return false;
      await pool.query("UPDATE docs SET v = v + 1 WHERE id = $1 AND version = $2", [id, expected]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on a SERIALIZABLE-isolation operation", () => {
    const src = `function reserveSerializable(id, n) {
      await pool.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      const { rows } = await pool.query("SELECT qty FROM inventory WHERE id = $1", [id]);
      if (rows[0].qty < n) return false;
      await pool.query("UPDATE inventory SET qty = qty - $2 WHERE id = $1", [id, n]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on an advisory-lock-wrapped check-then-act", () => {
    const src = `function reserveLocked(id, n) {
      await pool.query("SELECT pg_advisory_xact_lock($1)", [id]);
      const { rows } = await pool.query("SELECT qty FROM inventory WHERE id = $1", [id]);
      if (rows[0].qty < n) return false;
      await pool.query("UPDATE inventory SET qty = qty - $2 WHERE id = $1", [id, n]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on a NON-GATING compare (logs but does not short-circuit the write — touchSeen)", () => {
    const src = `function touchSeen(id) {
      const { rows } = await pool.query("SELECT hits FROM counters WHERE id = $1", [id]);
      if (rows[0].hits > 1000) logger.warn("hot key");
      await pool.query("UPDATE counters SET hits = hits + 1 WHERE id = $1", [id]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT when the guarded column differs from the written column (column-continuity)", () => {
    const src = `function checkAthenBumpB(id) {
      const { rows } = await pool.query("SELECT a FROM t WHERE id = $1", [id]);
      if (rows[0].a >= 10) return false;
      await pool.query("UPDATE t SET b = b + 1 WHERE id = $1", [id]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on a presence-only guard (rows.length === 0, not a value compare)", () => {
    const src = `function existsThenBump(id) {
      const { rows } = await pool.query("SELECT cnt FROM t WHERE id = $1", [id]);
      if (rows.length === 0) return false;
      await pool.query("UPDATE t SET cnt = cnt + 1 WHERE id = $1", [id]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on an unconditional relative write (no value-guard at all)", () => {
    const src = `function bumpAlways(id) {
      await pool.query("UPDATE t SET cnt = cnt + 1 WHERE id = $1", [id]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT when SELECT and UPDATE key DIFFERENT rows (different key column)", () => {
    const src = `function crossRow(aid, bid) {
      const { rows } = await pool.query("SELECT qty FROM inventory WHERE sku = $1", [aid]);
      if (rows[0].qty < 1) return false;
      await pool.query("UPDATE inventory SET qty = qty - 1 WHERE id = $2", [bid]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT on a nullish sanity-check (=== undefined, not a value-limit guard) [DeepSeek FP-1]", () => {
    // A `=== undefined` is an existence/sanity check on C, not a limit guard, so
    // it must not satisfy the range-operator value-guard — no race.
    const src = `function bumpIfPresent(id) {
      const { rows } = await pool.query("SELECT cnt FROM t WHERE id = $1", [id]);
      if (rows[0].cnt === undefined) return;
      await pool.query("UPDATE t SET cnt = cnt + 1 WHERE id = $1", [id]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT when an atomic guard FOLLOWS a string literal in the WHERE [DeepSeek bug-2]", () => {
    // The atomic `qty >= $2` sits after `status = 'active'`; the per-literal SQL
    // extraction must not truncate the WHERE at the embedded quote and miss it.
    const src = `function reserveActive(id, n) {
      const { rows } = await pool.query("SELECT qty FROM inventory WHERE id = $1", [id]);
      if (rows[0].qty < n) return false;
      await pool.query("UPDATE inventory SET qty = qty - $2 WHERE id = $1 AND status = 'active' AND qty >= $2", [id, n]);
    }`
    expect(fired(src)).toEqual([])
  })

  it("SILENT inside a DurableObject class (serialized by construction)", () => {
    const src = `class Counter extends DurableObject {
      async reserve(id, n) {
        const { rows } = await this.sql.query("SELECT qty FROM inventory WHERE id = $1", [id]);
        if (rows[0].qty < n) return false;
        await this.sql.query("UPDATE inventory SET qty = qty - $2 WHERE id = $1", [id, n]);
      }
    }`
    expect(fired(src)).toEqual([])
  })
})

describe("renderToctouHints", () => {
  it("renders a labelled block, empty string when no hints", () => {
    expect(renderToctouHints([])).toBe("")
    const block = renderToctouHints([{ message: "F races on T.c", fn: "F", table: "t", column: "c" }])
    expect(block).toContain("[CHECK-THEN-ACT / TOCTOU RACE")
    expect(block).toContain("F races on T.c")
  })
})
