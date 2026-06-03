// SIG-317 Part 2 — enum/type-contract drift detector. The believability bar is
// ZERO P0/P1 false positives, so every test that proves a SKIP is a precision
// guard. The flag is a P2 advisory; the real FP risk lives in the union
// collection + the table→column→value correlation, which is what these pin down.
// The FP-vector regressions (comments, function-param unions, interpolation,
// SQL comments) come straight from the dual review (code-reviewer + DeepSeek).

import { describe, it, expect } from "vitest"
import {
  buildGlobalUnionMap,
  scanSqlEnumDrift,
} from "../src/lib/ast-rules/scan-enum-literal-drift"

// The REAL pr/10 shared/types.ts shape — note TWO distinct `status` unions
// (Invoice and Charge). A column-name-only match would be ambiguous and miss the
// bug; the table name (`UPDATE charges`) is what disambiguates to Charge.
const PR10_TYPES = `
export interface Invoice {
  id: string;
  status: "draft" | "open" | "paid";
}
export interface Charge {
  id: string;
  walletId: string;
  status: "pending" | "settled" | "failed";
}
`
const REFUND_DRIFT = `
export async function refundCharge(chargeId: string): Promise<void> {
  await pool.query("UPDATE charges SET status = 'refunded' WHERE id = $1", [chargeId]);
}
`

describe("buildGlobalUnionMap", () => {
  it("collects a union under its declaring type", () => {
    const m = buildGlobalUnionMap([PR10_TYPES])
    expect([...(m.get("charge")?.get("status") ?? [])].sort()).toEqual(["failed", "pending", "settled"])
    expect([...(m.get("invoice")?.get("status") ?? [])].sort()).toEqual(["draft", "open", "paid"])
  })

  it("does NOT collect a single-literal type (needs >=2 members)", () => {
    const m = buildGlobalUnionMap([`interface X { kind: "only" }`])
    expect(m.get("x")?.has("kind")).toBeFalsy()
  })

  it("normalizes snake_case ↔ camelCase to one key", () => {
    const m = buildGlobalUnionMap([`interface Wallet { owner_id: "u1" | "u2" }`])
    expect(m.get("wallet")?.has("ownerid")).toBe(true)
  })

  it("does NOT collect a union inside a // line comment (review H1)", () => {
    const m = buildGlobalUnionMap([`// status: "a" | "b" was the old shape`])
    expect(m.size).toBe(0)
  })

  it("does NOT collect a block-commented interface (review H1)", () => {
    const m = buildGlobalUnionMap([`/* interface Charge { status: "a" | "b" } */`])
    expect(m.size).toBe(0)
  })

  it("does NOT collect a union commented out INSIDE a real interface body (review H1)", () => {
    const m = buildGlobalUnionMap([`interface Charge {
      status: "pending" | "settled";
      // future: status: "pending" | "settled" | "refunded"
    }`])
    expect([...(m.get("charge")?.get("status") ?? [])].sort()).toEqual(["pending", "settled"])
  })

  it("blanks a commented-out interface inside an unterminated /* at EOF (no crash; real union kept)", () => {
    // Sigilix dogfood flagged a (non-existent) off-by-one here; CodeRabbit then
    // flagged the first version of this test as unobservable. This version is
    // observable: the would-be-parsed `interface Ghost` sits inside a NEVER-closed
    // `/*` — WITHOUT comment-blanking, TYPE_BLOCK_RE would collect `ghost`. So the
    // `ghost` assertion fails if EOF-blanking regresses.
    const m = buildGlobalUnionMap([
      `interface Charge { status: "pending" | "settled" }\n/* interface Ghost { status: "a" | "b" }`,
    ])
    expect(m.has("ghost")).toBe(false) // the commented interface must NOT be collected
    expect([...(m.get("charge")?.get("status") ?? [])].sort()).toEqual(["pending", "settled"])
  })

  it("does NOT collect a function-param / variable union (review H2 — not a schema contract)", () => {
    const m = buildGlobalUnionMap([
      `function setStatus(status: "active" | "inactive") {}`,
      `let mode: "read" | "write" = "read"`,
    ])
    expect(m.size).toBe(0)
  })
})

describe("scanSqlEnumDrift", () => {
  it("FLAGS the pr/10 D6 drift via the TABLE NAME (charges→Charge), despite a rival Invoice.status union", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES]) // type in one file
    const hits = scanSqlEnumDrift(REFUND_DRIFT, unions) // SQL in another
    expect(hits).toHaveLength(1)
    expect(hits[0]!.message).toContain("'refunded'")
    expect(hits[0]!.message).toContain("charges")
    expect(hits[0]!.line).toBe(3)
  })

  it("uses the TABLE's union, not a same-named rival: SET status='draft' on charges FLAGS ('draft' is Invoice's)", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift(`pool.query("UPDATE charges SET status = 'draft'")`, unions)).toHaveLength(1)
  })

  it("does NOT flag a value that IS a member of the table's union", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift(`pool.query("UPDATE charges SET status = 'settled'")`, unions)).toHaveLength(0)
    expect(scanSqlEnumDrift(`pool.query("UPDATE invoices SET status = 'paid'")`, unions)).toHaveLength(0)
  })

  it("does NOT flag when the table maps to no declaring type (no global fallback — review H2)", () => {
    const unions = buildGlobalUnionMap([`interface Job { phase: "queued" | "running" | "done" }`])
    // weird_legacy_tbl doesn't singularize to Job → no resolution → skip.
    expect(scanSqlEnumDrift(`pool.query("UPDATE weird_legacy_tbl SET phase = 'paused'")`, unions)).toHaveLength(0)
  })

  it("does NOT flag a column with no declared union on the mapped type", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift(`pool.query("UPDATE charges SET note = 'whatever'")`, unions)).toHaveLength(0)
  })

  it("does NOT flag a placeholder value ($1) — no string literal", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift(`pool.query("UPDATE charges SET status = $1", [s])`, unions)).toHaveLength(0)
  })

  it("does NOT flag an interpolated value '${x}' — dynamic, can't check (review M1)", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift("pool.query(`UPDATE charges SET status = '${s}' WHERE id=$1`)", unions)).toHaveLength(0)
  })

  it("does NOT flag a SQL write hidden in a -- comment inside the query string (DeepSeek)", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift(
      "pool.query(`SELECT 1 -- UPDATE charges SET status = 'refunded'\n`)", unions,
    )).toHaveLength(0)
  })

  it("does NOT flag an INSERT (no SET clause) with a valid status", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift(
      `pool.query("INSERT INTO charges (wallet_id, status) VALUES ($1, 'pending')")`, unions,
    )).toHaveLength(0)
  })

  it("matches a snake_case SQL column to a camelCase union property", () => {
    const unions = buildGlobalUnionMap([`interface Wallet { ownerId: "u1" | "u2" }`])
    expect(scanSqlEnumDrift(`pool.query("UPDATE wallets SET owner_id = 'u9' WHERE id = $1")`, unions)).toHaveLength(1)
  })

  it("flags only the drifting column when a SET has several assignments", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    const hits = scanSqlEnumDrift(
      `pool.query("UPDATE charges SET status = 'refunded', amount_cents = $1 WHERE id = $2")`, unions,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]!.message).toContain("'refunded'")
  })

  it("does NOT match a literal in the WHERE clause (only the SET clause is scanned)", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift(
      `pool.query("UPDATE charges SET amount_cents = $1 WHERE status = 'archived'")`, unions,
    )).toHaveLength(0)
  })

  it("attributes each statement's value to its OWN table in a multi-statement string (DeepSeek M2)", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    // first stmt targets invoices (status='settled' not in Invoice → flags),
    // second targets charges (status='refunded' not in Charge → flags). Each
    // value is checked against its own table's union, not the other's.
    const hits = scanSqlEnumDrift(
      `pool.query("UPDATE invoices SET status = 'settled'; UPDATE charges SET status = 'paid'")`, unions,
    )
    // 'settled' ∉ Invoice{draft,open,paid} → flag; 'paid' ∉ Charge{pending,settled,failed} → flag.
    expect(hits).toHaveLength(2)
  })

  it("compares unescaped values: SQL 'it''s' matches a union member \"it's\" (no false flag)", () => {
    const unions = buildGlobalUnionMap([`interface T { label: "it's" | "other" }`])
    expect(scanSqlEnumDrift(`pool.query("UPDATE ts SET label = 'it''s'")`, unions)).toHaveLength(0)
  })

  it("is a no-op when no unions were declared (empty map)", () => {
    expect(scanSqlEnumDrift(REFUND_DRIFT, buildGlobalUnionMap([]))).toHaveLength(0)
  })

  it("does NOT flag non-SQL code that happens to assign a union-named field", () => {
    const unions = buildGlobalUnionMap([PR10_TYPES])
    expect(scanSqlEnumDrift(`const status = 'refunded'; obj.status = 'refunded';`, unions)).toHaveLength(0)
  })
})
