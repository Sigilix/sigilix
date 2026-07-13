import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LEGACY_TENANT_INSTALLATION_ID, type ResolvedApiKey } from "@/src/lib/api-key-resolver"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  canonicalTenantId,
  personalMemoryUserId,
  resolveApiPersonalMemoryUserId,
  resolveApiStableUserId,
  scopeMemoryUserId,
} from "./agent-memory-personal-subject"

const IDENTITY_MIGRATION = readFileSync(
  new URL("../../../migrations/0006_create_user_identity.sql", import.meta.url),
  "utf8",
)

const caller = (overrides: Partial<ResolvedApiKey> = {}): ResolvedApiKey => ({
  installationId: 42,
  createdBy: "111",
  ...overrides,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("personal memory subjects", () => {
  it("canonicalizes identity segments and nests them under the installation", () => {
    expect(canonicalTenantId(" User-ABC ")).toBe("user-abc")
    expect(scopeMemoryUserId("user:user-abc", 42)).toBe("inst:42:user:user-abc")
    expect(personalMemoryUserId(42, " User-ABC ")).toBe("inst:42:user:user-abc")
  })

  it("preserves the legacy generic-scope contract without weakening personal subjects", () => {
    expect(scopeMemoryUserId("legacy-user", LEGACY_TENANT_INSTALLATION_ID)).toBe("legacy-user")
    expect(personalMemoryUserId(LEGACY_TENANT_INSTALLATION_ID, "internal-user")).toBe("inst:-1:user:internal-user")
  })

  it("rejects the legacy global key and unprovable key creators", async () => {
    expect(
      await resolveApiPersonalMemoryUserId(
        {},
        caller({ installationId: LEGACY_TENANT_INSTALLATION_ID, createdBy: null }),
      ),
    ).toBeNull()
    expect(await resolveApiPersonalMemoryUserId({}, caller({ createdBy: "" }))).toBeNull()
    expect(await resolveApiPersonalMemoryUserId({}, caller())).toBeNull()
  })

  it("resolves the API-key creator through user_identity", async () => {
    const db = makeD1()
    await db.exec(IDENTITY_MIGRATION)
    await db
      .prepare(
        `INSERT INTO user_identity
         (user_id, github_user_id, providers, created_at, last_login_at)
         VALUES (?, ?, '["github"]', ?, ?)`,
      )
      .bind("internal-user", "111", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run()

    await expect(resolveApiPersonalMemoryUserId({ SIGILIX_PLATFORM_DB: db }, caller())).resolves.toBe(
      "inst:42:user:internal-user",
    )
    await expect(resolveApiStableUserId({ SIGILIX_PLATFORM_DB: db }, caller())).resolves.toEqual({
      status: "ok",
      userId: "internal-user",
    })
  })

  it("fails closed when the creator has no identity row", async () => {
    const db = makeD1()
    await db.exec(IDENTITY_MIGRATION)

    await expect(resolveApiPersonalMemoryUserId({ SIGILIX_PLATFORM_DB: db }, caller())).resolves.toBeNull()
    await expect(resolveApiStableUserId({ SIGILIX_PLATFORM_DB: db }, caller())).resolves.toEqual({
      status: "ok",
      userId: null,
    })
  })

  it("fails closed and emits telemetry when the identity lookup throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const db = {
      prepare: () => {
        throw new Error("D1 unavailable")
      },
    } as unknown as D1Database

    await expect(resolveApiPersonalMemoryUserId({ SIGILIX_PLATFORM_DB: db }, caller())).resolves.toBeNull()
    await expect(resolveApiStableUserId({ SIGILIX_PLATFORM_DB: db }, caller())).resolves.toEqual({
      status: "unavailable",
    })
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("personal-subject-resolve-failed"))).toBe(true)
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("D1 unavailable"))).toBe(false)
  })
})
