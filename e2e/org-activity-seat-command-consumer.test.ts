import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dispatchJob } from "@/src/index-dispatch"
import { enqueueDueSeatWork } from "@/src/features/billing"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

const INSTALLATION_ID = 42
const REPOSITORY_ID = 9_001
const TARGET_ID = "111"
const ACTOR_ID = "222"
const NOW_MS = 1_784_200_000_000
const PRICE_ID = "price_pro_monthly"

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
}

async function makeDb(options: { receivedAtMs?: number } = {}): Promise<D1Database> {
  const db = makeD1()
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0007_create_org_seat_assignment.sql",
    "0011_add_tenant_subscription_status.sql",
    "0012_add_tenant_billing_source.sql",
    "0020_create_stripe_seat_reconciliation.sql",
    "0022_create_org_workspace_access.sql",
    "0023_add_org_seat_billing_operation_context.sql",
    "0028_create_org_workspace_seat_assignment.sql",
    "0031_create_org_activity_seat_assignment.sql",
    "0032_extend_org_seat_billing_operation_activity_identity.sql",
    "0033_create_org_activity_seat_readiness.sql",
    "0034_create_org_activity_seat_command.sql",
    "0035_create_org_activity_seat_command_state.sql",
  ]) {
    await db.exec(migration(name))
  }
  await db
    .prepare(
      `INSERT INTO tenant
        (installation_id, tier, subscription_status, billing_source, created_at, updated_at)
       VALUES (?, 'pro', 'active', 'stripe', 't', 't')`,
    )
    .bind(INSTALLATION_ID)
    .run()
  await db
    .prepare(
      `INSERT INTO stripe_seat_subscription
        (installation_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         stripe_price_id, subscription_status, observed_quantity, derived_quantity, revision,
         snapshot_state, last_refreshed_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, 'cus_42', 'sub_42', 'si_42', ?, 'active', 1, 1, 1, 'ready', 900, 900, 900)`,
    )
    .bind(INSTALLATION_ID, PRICE_ID)
    .run()
  await db
    .prepare(
      `INSERT INTO org_seat_billing_lease
        (installation_id, lease_token, acquired_at_ms, expires_at_ms)
       VALUES (?, 'activation-lease', 500, 5_000)`,
    )
    .bind(INSTALLATION_ID)
    .run()
  await db
    .prepare(
      `INSERT INTO org_activity_seat_readiness
        (installation_id, activation_id, activation_source, schema_version,
         cutover_at_ms, cutover_at, activated_by_actor_github_user_id,
         stripe_snapshot_revision, billing_lease_acquired_at_ms)
       VALUES (?, 'ready-42', 'legacy_backfill_v1', 1, 1_000,
               '2026-07-16T00:00:01.000Z', '900', 1, 500)`,
    )
    .bind(INSTALLATION_ID)
    .run()
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, '500', 'member', 't', 't', NULL, 'actor', 'audit-500', 'member_added_or_regranted')`,
    )
    .bind(INSTALLATION_ID)
    .run()
  await db
    .prepare(
      `INSERT INTO org_workspace_seat_assignment
        (installation_id, github_user_id, assigned, last_known_login, created_at, updated_at, updated_by)
       VALUES (?, '500', 1, 'existing-member', 't', 't', 'actor')`,
    )
    .bind(INSTALLATION_ID)
    .run()
  await db.prepare("DELETE FROM org_seat_billing_lease WHERE installation_id = ?").bind(INSTALLATION_ID).run()
  await db
    .prepare(
      `INSERT INTO org_activity_seat_command
        (delivery_id, payload_sha256, installation_id, repository_id, pr_number,
         head_sha, action, target_github_user_id, target_login,
         actor_github_user_id, actor_login, author_association, received_at_ms)
       VALUES ('delivery-activity-1', ?, ?, ?, 7, ?, 'opened', ?, 'target-user', ?, 'activity-owner',
               'MEMBER', ?)`,
    )
    .bind(
      "a".repeat(64),
      INSTALLATION_ID,
      REPOSITORY_ID,
      "b".repeat(40),
      TARGET_ID,
      ACTOR_ID,
      options.receivedAtMs ?? 2_000,
    )
    .run()
  return db
}

function stripeItem(quantity: number): object {
  return {
    id: "si_42",
    quantity,
    price: {
      id: PRICE_ID,
      lookup_key: null,
      nickname: null,
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    },
  }
}

function makeEnv(
  db: D1Database,
  repositories: Array<{ id: number; full_name: string }> = [{ id: REPOSITORY_ID, full_name: "Sigilix/sigilix" }],
): { env: Env; sent: JobMessage[]; fetchMock: ReturnType<typeof vi.fn> } {
  const sent: JobMessage[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString())
    if (url.origin === "https://api.github.com" && url.pathname === "/installation/repositories") {
      expect(url.searchParams.get("page")).toBe("1")
      expect(new Headers(init?.headers).get("authorization")).toBe("token ghs_exact_42")
      return Response.json({
        total_count: repositories.length,
        repositories,
      })
    }
    if (url.toString() === "https://api.stripe.com/v1/subscription_items?subscription=sub_42&limit=100") {
      expect(init?.method).toBe("GET")
      return Response.json({ data: [stripeItem(1)], has_more: false })
    }
    if (url.toString() === "https://api.stripe.com/v1/subscription_items/si_42") {
      expect(init?.method).toBe("POST")
      expect(String(init?.body)).toContain("quantity=2")
      return Response.json({ id: "si_42", quantity: 2 })
    }
    throw new Error(`unexpected request: ${url.toString()}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return {
    env: {
      SIGILIX_PLATFORM_DB: db,
      SIGILIX_STRIPE_SECRET_KEY: "sk_test_secret",
      SIGILIX_STRIPE_PRICE_PRO: PRICE_ID,
      GITHUB_APP_ID: "123",
      GITHUB_PRIVATE_KEY: "cached-token-does-not-sign",
      OPENCLAW_STATE: {
        get: async (key: string) =>
          key === `gh-installation-token:${INSTALLATION_ID}`
            ? { token: "ghs_exact_42", expiresAt: NOW_MS + 3_600_000 }
            : null,
      } as unknown as KVNamespace,
      OPENCLAW_JOBS: {
        send: async (message: JobMessage) => {
          sent.push(message)
        },
      } as unknown as Queue<JobMessage>,
    } as Env,
    sent,
    fetchMock,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("immutable GitHub activity seat command through queue and Stripe recovery", () => {
  it("authorizes the exact repository, delegates once, and commits the immutable target identity", async () => {
    const db = await makeDb()
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
    const { env, sent, fetchMock } = makeEnv(db)

    await dispatchJob(
      { type: "org-activity-seat-command", deliveryId: "delivery-activity-1" } as unknown as JobMessage,
      env,
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: "org-seat-billing-reconcile",
      installationId: INSTALLATION_ID,
    })
    await expect(
      db
        .prepare(
          `SELECT state, resolution, operation_id, repository_authorized_at_ms
             FROM org_activity_seat_command_state WHERE delivery_id = 'delivery-activity-1'`,
        )
        .first(),
    ).resolves.toMatchObject({
      state: "delegated",
      resolution: null,
      operation_id: expect.any(String),
      repository_authorized_at_ms: NOW_MS,
    })

    await dispatchJob(sent[0]!, env)

    await expect(
      db
        .prepare(
          `SELECT installation_id, github_user_id, assigned, is_admin, last_known_login,
                  updated_by_actor_github_user_id, updated_by_actor_login
             FROM org_activity_seat_assignment WHERE installation_id = ? AND github_user_id = ?`,
        )
        .bind(INSTALLATION_ID, TARGET_ID)
        .first(),
    ).resolves.toEqual({
      installation_id: INSTALLATION_ID,
      github_user_id: TARGET_ID,
      assigned: 1,
      is_admin: 0,
      last_known_login: "target-user",
      updated_by_actor_github_user_id: ACTOR_ID,
      updated_by_actor_login: "activity-owner",
    })
    await expect(
      db
        .prepare(
          `SELECT state, target_identity_kind, target_github_user_id,
                  activity_actor_github_user_id, desired_quantity
             FROM org_seat_billing_operation`,
        )
        .first(),
    ).resolves.toEqual({
      state: "committed",
      target_identity_kind: "activity_github",
      target_github_user_id: TARGET_ID,
      activity_actor_github_user_id: ACTOR_ID,
      desired_quantity: 2,
    })
    expect(fetchMock.mock.calls.map(([input]) => new URL(input.toString()).origin)).toEqual([
      "https://api.github.com",
      "https://api.stripe.com",
      "https://api.stripe.com",
    ])
  })

  it("fails closed when the exact installation does not return the immutable repository id", async () => {
    const db = await makeDb()
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
    const { env, sent, fetchMock } = makeEnv(db, [{ id: 9_999, full_name: "Sigilix/sigilix" }])

    await dispatchJob({ type: "org-activity-seat-command", deliveryId: "delivery-activity-1" }, env)

    expect(sent).toHaveLength(0)
    await expect(
      db
        .prepare(
          `SELECT state, resolution, operation_id, repository_authorized_at_ms
             FROM org_activity_seat_command_state WHERE delivery_id = 'delivery-activity-1'`,
        )
        .first(),
    ).resolves.toEqual({
      state: "ignored",
      resolution: "repository_not_authorized",
      operation_id: null,
      repository_authorized_at_ms: null,
    })
    await expect(db.prepare("SELECT COUNT(*) AS count FROM org_seat_billing_operation").first()).resolves.toEqual({
      count: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("uses already-purchased capacity without creating a Stripe operation", async () => {
    const db = await makeDb()
    await db
      .prepare(
        `UPDATE stripe_seat_subscription SET observed_quantity = 2, derived_quantity = 2
          WHERE installation_id = ?`,
      )
      .bind(INSTALLATION_ID)
      .run()
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
    const { env, sent, fetchMock } = makeEnv(db)

    await dispatchJob({ type: "org-activity-seat-command", deliveryId: "delivery-activity-1" }, env)

    expect(sent).toHaveLength(0)
    await expect(
      db
        .prepare(
          `SELECT state, resolution, operation_id
             FROM org_activity_seat_command_state WHERE delivery_id = 'delivery-activity-1'`,
        )
        .first(),
    ).resolves.toEqual({ state: "applied", resolution: "assigned", operation_id: null })
    await expect(
      db
        .prepare(
          `SELECT github_user_id, assigned, updated_by_actor_github_user_id
             FROM org_activity_seat_assignment WHERE installation_id = ?`,
        )
        .bind(INSTALLATION_ID)
        .first(),
    ).resolves.toEqual({ github_user_id: TARGET_ID, assigned: 1, updated_by_actor_github_user_id: ACTOR_ID })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("honors an explicit immutable-user unassign tombstone", async () => {
    const db = await makeDb()
    await db
      .prepare(
        `INSERT INTO org_activity_seat_assignment
          (installation_id, github_user_id, assigned, is_admin, last_known_login,
           created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login)
         VALUES (?, ?, 0, 0, 'target-user', 't', 't', '900', 'admin')`,
      )
      .bind(INSTALLATION_ID, TARGET_ID)
      .run()
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
    const { env, sent } = makeEnv(db)

    await dispatchJob({ type: "org-activity-seat-command", deliveryId: "delivery-activity-1" }, env)

    expect(sent).toHaveLength(0)
    await expect(
      db
        .prepare(
          `SELECT state, resolution, operation_id
             FROM org_activity_seat_command_state WHERE delivery_id = 'delivery-activity-1'`,
        )
        .first(),
    ).resolves.toEqual({ state: "ignored", resolution: "manual_unassign", operation_id: null })
  })

  it("does not create another operation for an already-assigned immutable user", async () => {
    const db = await makeDb()
    await db
      .prepare(
        `INSERT INTO org_activity_seat_assignment
          (installation_id, github_user_id, assigned, is_admin, last_known_login,
           created_at, updated_at, updated_by_actor_github_user_id, updated_by_actor_login)
         VALUES (?, ?, 1, 0, 'target-user', 't', 't', '900', 'admin')`,
      )
      .bind(INSTALLATION_ID, TARGET_ID)
      .run()
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
    const { env, sent } = makeEnv(db)

    await dispatchJob({ type: "org-activity-seat-command", deliveryId: "delivery-activity-1" }, env)

    expect(sent).toHaveLength(0)
    await expect(
      db
        .prepare(
          `SELECT state, resolution, operation_id
             FROM org_activity_seat_command_state WHERE delivery_id = 'delivery-activity-1'`,
        )
        .first(),
    ).resolves.toEqual({ state: "applied", resolution: "already_assigned", operation_id: null })
    await expect(db.prepare("SELECT COUNT(*) AS count FROM org_seat_billing_operation").first()).resolves.toEqual({
      count: 0,
    })
  })

  it("terminates pre-cutover evidence without calling GitHub or Stripe", async () => {
    const db = await makeDb({ receivedAtMs: 1_000 })
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
    const { env, sent, fetchMock } = makeEnv(db)

    await dispatchJob({ type: "org-activity-seat-command", deliveryId: "delivery-activity-1" }, env)

    expect(sent).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(
      db
        .prepare(
          `SELECT state, resolution, repository_authorized_at_ms
             FROM org_activity_seat_command_state WHERE delivery_id = 'delivery-activity-1'`,
        )
        .first(),
    ).resolves.toEqual({ state: "ignored", resolution: "pre_cutover", repository_authorized_at_ms: null })
  })

  it("re-enqueues a persisted due command when its immediate queue send was lost", async () => {
    const db = await makeDb()
    const { env, sent, fetchMock } = makeEnv(db)

    vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
    await expect(enqueueDueSeatWork(env)).resolves.toBeUndefined()

    expect(sent).toEqual([{ type: "org-activity-seat-command", deliveryId: "delivery-activity-1" }])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
