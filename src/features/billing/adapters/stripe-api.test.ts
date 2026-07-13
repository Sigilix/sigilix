// sig-billing-dup-sub-guard: the Stripe list/cancel helpers. Focus on the pagination that
// guarantees the OLDEST active subscription is never missed behind a page of historical
// cancellations (keep-oldest correctness), plus the fail-soft error contract.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  listCustomerSubscriptions,
  listSubscriptionItems,
  cancelSubscription,
  updateSubscriptionItemQuantity,
} from "@/src/features/billing/adapters/stripe-api"

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

  it("fails closed when a subscription entry has no trustworthy creation order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          object: "list",
          has_more: false,
          data: [{ id: "sub_bad_created", status: "active", created: "not-a-timestamp", items: { data: [] } }],
        }),
      ),
    )

    const res = await listCustomerSubscriptions(KEY, "cus_bad_created")

    expect(res.ok).toBe(false)
  })
})

describe("listSubscriptionItems", () => {
  it("walks every page and strictly parses the complete subscription-item target shape", async () => {
    const seen: Array<{
      path: string
      method: string | undefined
      subscription: string | null
      limit: string | null
      after: string | null
    }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString())
      seen.push({
        path: url.pathname,
        method: init?.method,
        subscription: url.searchParams.get("subscription"),
        limit: url.searchParams.get("limit"),
        after: url.searchParams.get("starting_after"),
      })
      const after = url.searchParams.get("starting_after")
      const data = after
        ? [
            {
              id: "si_year",
              quantity: 12,
              price: {
                id: "price_max_annual",
                lookup_key: "sigilix_max_annual",
                nickname: "Max annual",
                recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
              },
            },
          ]
        : [
            {
              id: "si_month",
              quantity: 3,
              price: {
                id: "price_pro",
                lookup_key: null,
                nickname: null,
                recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
              },
            },
            {
              id: "si_addon",
              quantity: 2,
              price: {
                id: "price_addon",
                lookup_key: "sigilix_addon",
                nickname: "Add-on",
                recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
              },
            },
          ]
      return new Response(JSON.stringify({ data, has_more: !after }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const result = await listSubscriptionItems(KEY, "sub /annual")

    expect(result).toEqual({
      ok: true,
      items: [
        {
          id: "si_month",
          quantity: 3,
          price: {
            id: "price_pro",
            lookupKey: null,
            nickname: null,
            recurring: { interval: "month", intervalCount: 1, usageType: "licensed" },
          },
        },
        {
          id: "si_addon",
          quantity: 2,
          price: {
            id: "price_addon",
            lookupKey: "sigilix_addon",
            nickname: "Add-on",
            recurring: { interval: "month", intervalCount: 1, usageType: "licensed" },
          },
        },
        {
          id: "si_year",
          quantity: 12,
          price: {
            id: "price_max_annual",
            lookupKey: "sigilix_max_annual",
            nickname: "Max annual",
            recurring: { interval: "year", intervalCount: 1, usageType: "licensed" },
          },
        },
      ],
    })
    expect(seen).toEqual([
      {
        path: "/v1/subscription_items",
        method: "GET",
        subscription: "sub /annual",
        limit: "100",
        after: null,
      },
      {
        path: "/v1/subscription_items",
        method: "GET",
        subscription: "sub /annual",
        limit: "100",
        after: "si_addon",
      },
    ])
  })

  it("fails closed on malformed list envelopes and malformed item fields", async () => {
    const malformedBodies: unknown[] = [
      null,
      { has_more: false },
      { data: [], has_more: "false" },
      { data: [], has_more: true },
      { data: [{ id: "", quantity: 1, price: {} }], has_more: false },
      {
        data: [
          {
            id: "si_bad_quantity",
            quantity: -1,
            price: {
              id: "price_pro",
              lookup_key: null,
              nickname: null,
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
            },
          },
        ],
        has_more: false,
      },
      {
        data: [
          {
            id: "si_bad_recurring",
            quantity: 1,
            price: { id: "price_pro", lookup_key: null, nickname: null, recurring: null },
          },
        ],
        has_more: false,
      },
      {
        data: [
          {
            id: "si_bad_lookup",
            quantity: 1,
            price: {
              id: "price_pro",
              lookup_key: 7,
              nickname: null,
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
            },
          },
        ],
        has_more: false,
      },
    ]

    for (const body of malformedBodies) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ),
      )
      await expect(listSubscriptionItems(KEY, "sub_bad")).resolves.toMatchObject({ ok: false, status: 502 })
    }
  })

  it("fails closed rather than returning a truncated view after the page cap", async () => {
    let page = 0
    const fetchMock = vi.fn(async () => {
      page += 1
      return new Response(
        JSON.stringify({
          data: [
            {
              id: `si_${page}`,
              quantity: 1,
              price: {
                id: "price_pro",
                lookup_key: null,
                nickname: null,
                recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
              },
            },
          ],
          has_more: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(listSubscriptionItems(KEY, "sub_huge")).resolves.toEqual({
      ok: false,
      error: "subscription item list too large to page",
      status: 502,
    })
    expect(fetchMock).toHaveBeenCalledTimes(20)
  })

  it("propagates a non-2xx Stripe response without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "try later", type: "rate_limit_error" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
      ),
    )

    await expect(listSubscriptionItems(KEY, "sub_rate_limited")).resolves.toMatchObject({ ok: false, status: 429 })
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

describe("updateSubscriptionItemQuantity", () => {
  it("POSTs an absolute quantity with prorations, exact idempotency key, and AbortSignal", async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "si /primary", quantity: 7 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      updateSubscriptionItemQuantity(KEY, {
        subscriptionItemId: "si /primary",
        quantity: 7,
        idempotencyKey: "seat-capacity:operation:123",
        signal: controller.signal,
      }),
    ).resolves.toEqual({ ok: true, subscriptionItemId: "si /primary", quantity: 7 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0]!
    expect(typeof input === "string" ? input : input.toString()).toBe(
      "https://api.stripe.com/v1/subscription_items/si%20%2Fprimary",
    )
    expect(init?.method).toBe("POST")
    expect(init?.signal).toBe(controller.signal)
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(headers.get("idempotency-key")).toBe("seat-capacity:operation:123")
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    const body = new URLSearchParams(String(init?.body))
    expect([...body.entries()]).toEqual([
      ["quantity", "7"],
      ["proration_behavior", "create_prorations"],
    ])
  })

  it("rejects invalid item ids, quantities, and idempotency keys before calling Stripe", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const invalidInputs: unknown[] = [
      { subscriptionItemId: "", quantity: 2, idempotencyKey: "operation-1" },
      { subscriptionItemId: null, quantity: 2, idempotencyKey: "operation-1" },
      { subscriptionItemId: "si_primary", quantity: 0, idempotencyKey: "operation-1" },
      { subscriptionItemId: "si_primary", quantity: -1, idempotencyKey: "operation-1" },
      { subscriptionItemId: "si_primary", quantity: 1.5, idempotencyKey: "operation-1" },
      { subscriptionItemId: "si_primary", quantity: Number.MAX_SAFE_INTEGER + 1, idempotencyKey: "operation-1" },
      { subscriptionItemId: "si_primary", quantity: 2, idempotencyKey: "" },
      { subscriptionItemId: "si_primary", quantity: 2, idempotencyKey: "   " },
      { subscriptionItemId: "si_primary", quantity: 2, idempotencyKey: null },
    ]
    for (const input of invalidInputs) {
      await expect(
        updateSubscriptionItemQuantity(KEY, input as Parameters<typeof updateSubscriptionItemQuantity>[1]),
      ).resolves.toEqual({
        ok: false,
        error: "invalid subscription item quantity update",
        status: 400,
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed unless Stripe echoes the exact requested item id and quantity", async () => {
    const bodies = [
      { id: "si_other", quantity: 3 },
      { id: "si_primary", quantity: 2 },
      { id: "si_primary", quantity: "3" },
      { id: "si_primary" },
      null,
    ]

    for (const body of bodies) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      )
      await expect(
        updateSubscriptionItemQuantity(KEY, {
          subscriptionItemId: "si_primary",
          quantity: 3,
          idempotencyKey: "operation-2",
        }),
      ).resolves.toEqual({
        ok: false,
        error: "invalid stripe subscription item response",
        status: 502,
      })
    }
  })

  it("does not expose the Stripe secret when transport errors include it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error(`transport leaked ${KEY}`))),
    )

    const result = await updateSubscriptionItemQuantity(KEY, {
      subscriptionItemId: "si_primary",
      quantity: 3,
      idempotencyKey: "operation-3",
    })
    expect(result).toEqual({ ok: false, error: "stripe request failed", status: 502 })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})
