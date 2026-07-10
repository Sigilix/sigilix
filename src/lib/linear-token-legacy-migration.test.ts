import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetBrokerClientCacheForTests,
  getValidAgentTokenViaBroker,
  type LinearTokenBrokerEnv,
} from "@/src/lib/linear-token-broker-client"
import type { LinearAgentTokenRecord } from "@/src/lib/linear-agent-oauth"

describe("Linear dogfood singleton migration", () => {
  beforeEach(() => __resetBrokerClientCacheForTests())

  it("copies the legacy record only into the explicitly allowed org+installation shard", async () => {
    const legacy: LinearAgentTokenRecord = {
      accessToken: "legacy-token",
      refreshToken: "legacy-refresh",
      installedAt: 1,
    }
    const records = new Map<string, LinearAgentTokenRecord>()
    const exportLegacyRecordForMigration = vi.fn(async () => legacy)
    const namespace = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => {
        if (id.name === "linear-agent") return { exportLegacyRecordForMigration }
        return {
          getValidTenantToken: async () => {
            const record = records.get(id.name)
            return record
              ? { ok: true as const, accessToken: record.accessToken }
              : { ok: false as const, reason: "not-installed" as const }
          },
          installTenant: async (record: LinearAgentTokenRecord) => {
            records.set(id.name, record)
            return { ok: true as const }
          },
        }
      },
    }
    const env = {
      LINEAR_TOKEN_BROKER: namespace,
      OPENCLAW_LINEAR_ALLOWED_ORG_ID: "org-dogfood",
      OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID: "42",
    } as unknown as LinearTokenBrokerEnv

    await expect(
      getValidAgentTokenViaBroker(env, { organizationId: "org-dogfood", installationId: 42 }, { readOnly: false }),
    ).resolves.toBe("legacy-token")
    expect(records.get("linear-org:v1:org-dogfood")).toMatchObject({
      accessToken: "legacy-token",
      organizationId: "org-dogfood",
      installationId: 42,
      actorType: "app",
    })

    await expect(
      getValidAgentTokenViaBroker(env, { organizationId: "other-org", installationId: 99 }, { readOnly: false }),
    ).resolves.toBeNull()
    expect(exportLegacyRecordForMigration).toHaveBeenCalledTimes(1)
    expect(records.has("linear-org:v1:other-org")).toBe(false)
  })

  it("fails closed when the tenant shard rejects the migrated record", async () => {
    const legacy: LinearAgentTokenRecord = { accessToken: "legacy-token", installedAt: 1 }
    const getValidTenantToken = vi.fn(async () => ({ ok: false as const, reason: "not-installed" as const }))
    const namespace = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) =>
        id.name === "linear-agent"
          ? { exportLegacyRecordForMigration: async () => legacy }
          : {
              getValidTenantToken,
              installTenant: async () => ({ ok: false as const, reason: "tenant-conflict" as const }),
            },
    }
    const env = {
      LINEAR_TOKEN_BROKER: namespace,
      OPENCLAW_LINEAR_ALLOWED_ORG_ID: "org-dogfood",
      OPENCLAW_LINEAR_LEGACY_INSTALLATION_ID: "42",
    } as unknown as LinearTokenBrokerEnv

    await expect(
      getValidAgentTokenViaBroker(env, { organizationId: "org-dogfood", installationId: 42 }, { readOnly: false }),
    ).resolves.toBeNull()
    expect(getValidTenantToken).toHaveBeenCalledOnce()
  })
})
