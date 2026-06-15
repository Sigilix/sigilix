// SIG-418 Phase 2 (Design B′) — pure finding-id namespacing tests.
//
// The load-bearing guarantee (mandatory correction #2): namespacing a finding id
// per batch as `${role}-b${n}-${idx}` must NOT break the EXISTING prefix-based
// role inference. So this suite asserts the namespaced ids against the REAL
// validation parsers (`firstSpecialistRoleFromSourceIds` / `sourceRolesInclude`),
// not a local re-implementation — if a future change moved the batch segment in
// front of the role, these would fail. Plus: ids are unique across batches, and
// the inverse parser round-trips.

import { describe, expect, it } from "vitest"
import { ALL_SPECIALISTS } from "@/src/shared/domain/specialist-role"
import { firstSpecialistRoleFromSourceIds, sourceRolesInclude } from "@/src/lib/ensemble/domain/validation-args"
import { namespaceFindingId, parseNamespacedFindingId } from "@/src/lib/ensemble/domain/multibatch-finding-id"

describe("namespaceFindingId", () => {
  it("is role-FIRST: `${role}-b${batchIdx}-${idx}`", () => {
    expect(namespaceFindingId("logic", 1, 0)).toBe("logic-b1-0")
    expect(namespaceFindingId("security", 0, 3)).toBe("security-b0-3")
    expect(namespaceFindingId("performance", 12, 7)).toBe("performance-b12-7")
    expect(namespaceFindingId("tests", 2, 11)).toBe("tests-b2-11")
  })

  it("ids are unique across batches for the same role + finding index", () => {
    const ids = new Set<string>()
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 5; i++) {
        for (const role of ALL_SPECIALISTS) ids.add(namespaceFindingId(role, batch, i))
      }
    }
    // 4 batches × 5 findings × 4 roles, all distinct (no collisions across batches).
    expect(ids.size).toBe(4 * 5 * ALL_SPECIALISTS.length)
    // The classic collision the namespace fixes: two batches' first logic finding.
    expect(namespaceFindingId("logic", 0, 0)).not.toBe(namespaceFindingId("logic", 1, 0))
  })

  it("the EXISTING role inference still resolves the role from a namespaced id", () => {
    // `firstSpecialistRoleFromSourceIds` and `sourceRolesInclude` infer role via
    // `id.startsWith(`${role}-`)` — role-first keeps that intact.
    for (const role of ALL_SPECIALISTS) {
      const id = namespaceFindingId(role, 3, 2)
      expect(firstSpecialistRoleFromSourceIds([id])).toBe(role)
      expect(sourceRolesInclude([id], role)).toBe(true)
      // And it does NOT read as some OTHER role.
      for (const other of ALL_SPECIALISTS) {
        if (other !== role) expect(sourceRolesInclude([id], other)).toBe(false)
      }
    }
  })

  it("role inference is unchanged whether the id is namespaced or the legacy `${role}-${i}` form", () => {
    // Legacy mint (assignStableFindingIds, untouched in PR 1) vs the namespaced
    // form must infer the SAME role — proves the namespace is back-compatible.
    expect(firstSpecialistRoleFromSourceIds(["security-0"])).toBe("security")
    expect(firstSpecialistRoleFromSourceIds([namespaceFindingId("security", 1, 0)])).toBe("security")
  })
})

describe("parseNamespacedFindingId", () => {
  it("round-trips a namespaced id back to its components", () => {
    for (const role of ALL_SPECIALISTS) {
      const parsed = parseNamespacedFindingId(namespaceFindingId(role, 5, 9))
      expect(parsed).toEqual({ role, batchIdx: 5, index: 9 })
    }
  })

  it("returns null for the legacy un-prefixed mint (`${role}-${i}`)", () => {
    // PR 1 does NOT change assignStableFindingIds, so this is the live shape — the
    // parser must not mis-read it as namespaced.
    expect(parseNamespacedFindingId("logic-0")).toBeNull()
    expect(parseNamespacedFindingId("security-12")).toBeNull()
  })

  it("returns null for deterministic-evidence ids and other non-matching shapes", () => {
    expect(parseNamespacedFindingId("ast/rule/hash/10")).toBeNull()
    expect(parseNamespacedFindingId("secret:aws-key")).toBeNull()
    expect(parseNamespacedFindingId("depvuln:lodash")).toBeNull()
    expect(parseNamespacedFindingId("sarif:0")).toBeNull()
    // A non-role prefix must not be accepted (role is matched from ALL_SPECIALISTS).
    expect(parseNamespacedFindingId("b1-logic-0")).toBeNull()
    expect(parseNamespacedFindingId("bogus-b1-0")).toBeNull()
    expect(parseNamespacedFindingId("logic-b1")).toBeNull()
    expect(parseNamespacedFindingId("logic-bx-0")).toBeNull()
  })
})
