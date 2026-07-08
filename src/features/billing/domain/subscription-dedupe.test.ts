// sig-billing-dup-sub-guard: the PURE keep-oldest selection. Deterministic, IO-free.

import { describe, expect, it } from "vitest"
import { selectDuplicateSubscriptions, type SubscriptionSummary } from "./subscription-dedupe"

function sub(id: string, status: string, created: number): SubscriptionSummary {
  return { id, status, created, price: { id: `price_${id}`, lookup_key: null, nickname: null } }
}

describe("selectDuplicateSubscriptions", () => {
  it("no subscriptions → no survivor, no duplicates", () => {
    expect(selectDuplicateSubscriptions([])).toEqual({ survivor: null, duplicates: [] })
  })

  it("a single active subscription → it survives, nothing to cancel", () => {
    const only = sub("s1", "active", 100)
    expect(selectDuplicateSubscriptions([only])).toEqual({ survivor: only, duplicates: [] })
  })

  it("ignores non-active subscriptions entirely (no survivor, no re-cancel)", () => {
    const res = selectDuplicateSubscriptions([sub("s1", "canceled", 100), sub("s2", "past_due", 200)])
    expect(res).toEqual({ survivor: null, duplicates: [] })
  })

  it("two active subs → keeps the OLDEST, cancels the newer", () => {
    const older = sub("s_old", "active", 100)
    const newer = sub("s_new", "active", 200)
    // Order of the input array must not matter.
    const res = selectDuplicateSubscriptions([newer, older])
    expect(res.survivor).toEqual(older)
    expect(res.duplicates).toEqual([newer])
  })

  it("mixed statuses → oldest ACTIVE/TRIALING survives, other live ones are duplicates, dead ones ignored", () => {
    const trialing = sub("s_trial", "trialing", 50)
    const active = sub("s_active", "active", 150)
    const dead = sub("s_dead", "canceled", 10)
    const res = selectDuplicateSubscriptions([active, dead, trialing])
    expect(res.survivor).toEqual(trialing) // oldest of the two LIVE ones
    expect(res.duplicates).toEqual([active])
  })

  it("equal created timestamps → deterministic tiebreak by id (lexicographic)", () => {
    const a = sub("aaa", "active", 100)
    const b = sub("bbb", "active", 100)
    const res = selectDuplicateSubscriptions([b, a])
    expect(res.survivor).toEqual(a)
    expect(res.duplicates).toEqual([b])
  })

  it("three active subs → keeps oldest, cancels the two newer", () => {
    const s1 = sub("s1", "active", 100)
    const s2 = sub("s2", "active", 200)
    const s3 = sub("s3", "active", 300)
    const res = selectDuplicateSubscriptions([s3, s1, s2])
    expect(res.survivor).toEqual(s1)
    expect(res.duplicates).toEqual([s2, s3])
  })
})
