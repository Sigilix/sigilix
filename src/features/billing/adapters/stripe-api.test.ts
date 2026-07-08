// sig-billing-dup-sub-guard: the Stripe list/cancel helpers. Focus on the pagination that
// guarantees the OLDEST active subscription is never missed behind a page of historical
// cancellations (keep-oldest correctness), plus the fail-soft error contract.

import { afterEach, describe, expect, it, vi } from "vitest"
import { listCustomerSubscriptions, cancelSubscription } from "@/src/features/billing/adapters/stripe-api"

const KEY = "sk_test"

afterEach(() => vi.unstubAllGlobals())

describe("listCustomerSubscriptions", () => {
  it("walks starting_after pages until has_more is false (oldest active never buried)", async () => {
    // Page 1: 100 historical canceled subs. Page 2: the single OLD active sub. A one-page
    // read would miss it; pagination must surface it.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `sub_dead_${i}`,
      status: "canceled",
      created: 1000 + i,
      items: { data: [{ price: { id: "price_pro" } }] },
    }))
    const page2 = [
      { id: "sub_old_active", status: "active", created: 5, items: { data: [{ price: { id: "price_max" } }] } },
    ]

    const seen: Array<string | null> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(typeof input === "string" ? input : input.toString())
      const after = u.searchParams.get("starting_after")
      seen.push(after)
      if (!after) {
        return new Response(JSON.stringify({ data: page1, has_more: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: page2, has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const res = await listCustomerSubscriptions(KEY, "cus_1")
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.subscriptions).toHaveLength(101)
    // The second request advanced past the last id of page 1.
    expect(seen).toEqual([null, "sub_dead_99"])
    // The oldest active sub is present for the selector to keep.
    expect(res.subscriptions.find((s) => s.id === "sub_old_active")?.status).toBe("active")
  })

  it("non-2xx → fail-soft error result (never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "no such customer", type: "invalid_request_error" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    const res = await listCustomerSubscriptions(KEY, "cus_missing")
    expect(res).toMatchObject({ ok: false, status: 404 })
  })

  it("empty data array → ok with no subscriptions (a customer with none)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ object: "list", data: [], has_more: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    const res = await listCustomerSubscriptions(KEY, "cus_empty")
    expect(res).toEqual({ ok: true, subscriptions: [] })
  })

  it("2xx with a malformed body (no data array) → FAILS CLOSED (never an empty-list conclusion)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ object: "list", has_more: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    const res = await listCustomerSubscriptions(KEY, "cus_bad")
    expect(res.ok).toBe(false)
  })
})

describe("cancelSubscription", () => {
  it("DELETEs the subscription and resolves ok on 2xx", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "sub_x", status: "canceled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    vi.stubGlobal("fetch", fetchMock)
    const res = await cancelSubscription(KEY, "sub_x")
    expect(res.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(new URL(typeof url === "string" ? url : url.toString()).pathname).toBe("/v1/subscriptions/sub_x")
    expect(init?.method).toBe("DELETE")
  })

  it("non-2xx → fail-soft error result (never throws)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "cannot cancel", type: "invalid_request_error" } }), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    const res = await cancelSubscription(KEY, "sub_x")
    expect(res).toMatchObject({ ok: false, status: 402 })
  })
})
