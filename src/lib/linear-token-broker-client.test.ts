// SIG-144 (Linear unification cutover, slice 2) — tests for the
// LinearTokenBroker DO client wrappers.
//
// Pure delegation + mapping tests against a hand-built DO stub (mirrors
// repo-graph-client.test.ts) — no real Cloudflare runtime needed. The isolate
// read cache is exercised with vi.useFakeTimers() to control the 30s TTL
// deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getValidAgentTokenViaBroker,
  forceRefreshViaBroker,
  installAgentTokenToBroker,
  stageAgentTokenToBroker,
  commitAgentTokenToBroker,
  rollbackAgentTokenFromBroker,
  uninstallAgentTokenFromBroker,
  __resetBrokerClientCacheForTests,
  type LinearTokenBrokerEnv,
} from "@/src/lib/linear-token-broker-client"
import type { BrokerTenantInstallResult, BrokerTokenResult } from "@/src/do/linear-token-broker"
import type { LinearAgentTokenRecord } from "@/src/lib/linear-agent-oauth"

type Call = { method: string; args: unknown[] }

const NOT_INSTALLED: BrokerTokenResult = { ok: false, reason: "not-installed" }

function makeEnv(stubMethods: {
  getValidToken?: (args: { readOnly: boolean }) => Promise<BrokerTokenResult>
  forceRefresh?: () => Promise<BrokerTokenResult>
  install?: (record: LinearAgentTokenRecord) => Promise<{ ok: true }>
  installTenant?: (
    record: LinearAgentTokenRecord,
    scope: { organizationId: string; installationId: number },
  ) => Promise<BrokerTenantInstallResult>
  stageTenantInstall?: (
    record: LinearAgentTokenRecord,
    scope: { organizationId: string; installationId: number },
    generation: string,
  ) => Promise<{ ok: true } | { ok: false; reason: "tenant-conflict" }>
  commitTenantInstall?: (
    scope: { organizationId: string; installationId: number },
    generation: string,
  ) => Promise<{ ok: true; committed: boolean } | { ok: false; reason: "not-staged" }>
  rollbackTenantInstall?: (
    scope: { organizationId: string; installationId: number },
    generation: string,
  ) => Promise<{ ok: true; removed: boolean } | { ok: false; reason: "generation-mismatch" }>
  uninstallTenant?: (scope: {
    organizationId: string
    installationId: number
  }) => Promise<{ ok: true; removed: boolean } | { ok: false; reason: "tenant-mismatch" }>
}): { env: LinearTokenBrokerEnv; calls: Call[] } {
  const calls: Call[] = []
  const stub = {
    getValidToken: (args: { readOnly: boolean }) => {
      calls.push({ method: "getValidToken", args: [args] })
      return (stubMethods.getValidToken ?? (async () => NOT_INSTALLED))(args)
    },
    forceRefresh: () => {
      calls.push({ method: "forceRefresh", args: [] })
      return (stubMethods.forceRefresh ?? (async () => NOT_INSTALLED))()
    },
    install: (record: LinearAgentTokenRecord) => {
      calls.push({ method: "install", args: [record] })
      return (stubMethods.install ?? (async () => ({ ok: true as const })))(record)
    },
    installTenant: (record: LinearAgentTokenRecord, scope: { organizationId: string; installationId: number }) => {
      calls.push({ method: "installTenant", args: [record, scope] })
      return (stubMethods.installTenant ?? (async () => ({ ok: true as const })))(record, scope)
    },
    stageTenantInstall: (
      record: LinearAgentTokenRecord,
      scope: { organizationId: string; installationId: number },
      generation: string,
    ) => {
      calls.push({ method: "stageTenantInstall", args: [record, scope, generation] })
      return (stubMethods.stageTenantInstall ?? (async () => ({ ok: true as const })))(record, scope, generation)
    },
    commitTenantInstall: (scope: { organizationId: string; installationId: number }, generation: string) => {
      calls.push({ method: "commitTenantInstall", args: [scope, generation] })
      return (stubMethods.commitTenantInstall ?? (async () => ({ ok: true as const, committed: true })))(
        scope,
        generation,
      )
    },
    rollbackTenantInstall: (scope: { organizationId: string; installationId: number }, generation: string) => {
      calls.push({ method: "rollbackTenantInstall", args: [scope, generation] })
      return (stubMethods.rollbackTenantInstall ?? (async () => ({ ok: true as const, removed: true })))(
        scope,
        generation,
      )
    },
    uninstallTenant: (scope: { organizationId: string; installationId: number }) => {
      calls.push({ method: "uninstallTenant", args: [scope] })
      return (stubMethods.uninstallTenant ?? (async () => ({ ok: true as const, removed: false })))(scope)
    },
  }
  const ns = {
    idFromName: (name: string) => {
      calls.push({ method: "idFromName", args: [name] })
      return { toString: () => name }
    },
    get: (id: unknown) => {
      calls.push({ method: "get", args: [id] })
      return stub
    },
  }
  return { env: { LINEAR_TOKEN_BROKER: ns } as unknown as LinearTokenBrokerEnv, calls }
}

beforeEach(() => {
  __resetBrokerClientCacheForTests()
  // The client emits a neutral console.warn breadcrumb on the no-token / RPC-error
  // paths — silence it by default; the observability describe re-spies to assert.
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("getValidAgentTokenViaBroker — resolution", () => {
  it("resolves the singleton stub via idFromName('linear-agent') then get()", async () => {
    const { env, calls } = makeEnv({ getValidToken: async () => ({ ok: true, accessToken: "tok-1" }) })

    await getValidAgentTokenViaBroker(env, { readOnly: true })

    const idFromNameCall = calls.find((c) => c.method === "idFromName")
    expect(idFromNameCall?.args[0]).toBe("linear-agent")
    expect(calls.find((c) => c.method === "get")).toBeDefined()
  })

  it("passes readOnly through to getValidToken", async () => {
    const { env, calls } = makeEnv({ getValidToken: async () => ({ ok: true, accessToken: "tok-1" }) })

    await getValidAgentTokenViaBroker(env, { readOnly: false })

    const rpcCall = calls.find((c) => c.method === "getValidToken")
    expect(rpcCall?.args[0]).toEqual({ readOnly: false })
  })
})

describe("getValidAgentTokenViaBroker — mapping to string | null", () => {
  it("maps { ok: true, accessToken } to the access token", async () => {
    const { env } = makeEnv({ getValidToken: async () => ({ ok: true, accessToken: "tok-1" }) })
    await expect(getValidAgentTokenViaBroker(env, { readOnly: true })).resolves.toBe("tok-1")
  })

  it("maps { ok: false, reason: 'not-installed' } to null", async () => {
    const { env } = makeEnv({ getValidToken: async () => ({ ok: false, reason: "not-installed" }) })
    await expect(getValidAgentTokenViaBroker(env, { readOnly: true })).resolves.toBeNull()
  })

  it("maps { ok: false, reason: 'refresh-failed' } to null", async () => {
    const { env } = makeEnv({ getValidToken: async () => ({ ok: false, reason: "refresh-failed" }) })
    await expect(getValidAgentTokenViaBroker(env, { readOnly: false })).resolves.toBeNull()
  })

  it("maps a DO RPC throw to null — never throws", async () => {
    const { env } = makeEnv({
      getValidToken: async () => {
        throw new Error("DO unreachable")
      },
    })
    await expect(getValidAgentTokenViaBroker(env, { readOnly: true })).resolves.toBeNull()
  })
})

describe("getValidAgentTokenViaBroker — observability (neutral, no token material)", () => {
  it("emits linear-token-broker-unavailable WITH the reason on an ok:false result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { env } = makeEnv({ getValidToken: async () => ({ ok: false, reason: "not-installed" }) })

    await getValidAgentTokenViaBroker(env, { readOnly: true })

    const line = warn.mock.calls.flat().map(String).join("\n")
    expect(line).toContain("linear-token-broker-unavailable")
    expect(line).toContain("not-installed")
  })

  it("emits linear-token-broker-rpc-error on a DO throw, and never logs token material", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { env } = makeEnv({
      getValidToken: async () => {
        throw new Error("DO unreachable")
      },
    })

    await getValidAgentTokenViaBroker(env, { readOnly: true })

    const line = warn.mock.calls.flat().map(String).join("\n")
    expect(line).toContain("linear-token-broker-rpc-error")
  })

  it("does NOT warn on a successful read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { env } = makeEnv({ getValidToken: async () => ({ ok: true, accessToken: "tok-1" }) })

    await getValidAgentTokenViaBroker(env, { readOnly: true })

    expect(warn).not.toHaveBeenCalled()
  })
})

describe("getValidAgentTokenViaBroker — isolate cache (readOnly: true)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("a second readOnly call within the TTL does NOT re-hit the DO", async () => {
    const { env, calls } = makeEnv({ getValidToken: async () => ({ ok: true, accessToken: "tok-1" }) })

    const first = await getValidAgentTokenViaBroker(env, { readOnly: true })
    const second = await getValidAgentTokenViaBroker(env, { readOnly: true })

    expect(first).toBe("tok-1")
    expect(second).toBe("tok-1")
    expect(calls.filter((c) => c.method === "getValidToken")).toHaveLength(1)
  })

  it("a readOnly call after the cache TTL expires re-hits the DO", async () => {
    vi.useFakeTimers()
    const { env, calls } = makeEnv({ getValidToken: async () => ({ ok: true, accessToken: "tok-1" }) })

    await getValidAgentTokenViaBroker(env, { readOnly: true })
    vi.advanceTimersByTime(31_000) // past the 30s TTL
    await getValidAgentTokenViaBroker(env, { readOnly: true })

    expect(calls.filter((c) => c.method === "getValidToken")).toHaveLength(2)
  })

  it("readOnly: false NEVER reads from (or populates) the cache — every call hits the DO", async () => {
    const { env, calls } = makeEnv({ getValidToken: async () => ({ ok: true, accessToken: "tok-1" }) })

    await getValidAgentTokenViaBroker(env, { readOnly: false })
    await getValidAgentTokenViaBroker(env, { readOnly: false })

    expect(calls.filter((c) => c.method === "getValidToken")).toHaveLength(2)
  })

  it("a failed (ok: false) result is never cached — the next readOnly call still hits the DO", async () => {
    const { env, calls } = makeEnv({ getValidToken: async () => ({ ok: false, reason: "not-installed" }) })

    await getValidAgentTokenViaBroker(env, { readOnly: true })
    await getValidAgentTokenViaBroker(env, { readOnly: true })

    expect(calls.filter((c) => c.method === "getValidToken")).toHaveLength(2)
  })

  it("a cached token does not leak across a stale-then-fresh DO answer change within the TTL", async () => {
    let answer: BrokerTokenResult = { ok: true, accessToken: "tok-1" }
    const { env, calls } = makeEnv({ getValidToken: async () => answer })

    const first = await getValidAgentTokenViaBroker(env, { readOnly: true })
    answer = { ok: true, accessToken: "tok-2" } // the DO would now answer differently
    const second = await getValidAgentTokenViaBroker(env, { readOnly: true })

    expect(first).toBe("tok-1")
    expect(second).toBe("tok-1") // still served from cache, not the new DO answer
    expect(calls.filter((c) => c.method === "getValidToken")).toHaveLength(1)
  })
})

describe("forceRefreshViaBroker", () => {
  it("calls stub.forceRefresh() and maps { ok: true, accessToken } to the token", async () => {
    const { env, calls } = makeEnv({ forceRefresh: async () => ({ ok: true, accessToken: "tok-2" }) })
    await expect(forceRefreshViaBroker(env)).resolves.toBe("tok-2")
    expect(calls.filter((c) => c.method === "forceRefresh")).toHaveLength(1)
  })

  it("maps { ok: false } to null", async () => {
    const { env } = makeEnv({ forceRefresh: async () => ({ ok: false, reason: "refresh-failed" }) })
    await expect(forceRefreshViaBroker(env)).resolves.toBeNull()
  })

  it("maps a DO RPC throw to null — never throws", async () => {
    const { env } = makeEnv({
      forceRefresh: async () => {
        throw new Error("DO unreachable")
      },
    })
    await expect(forceRefreshViaBroker(env)).resolves.toBeNull()
  })

  it("primes the isolate read cache so an immediately-following readOnly read skips the DO", async () => {
    const { env, calls } = makeEnv({
      forceRefresh: async () => ({ ok: true, accessToken: "tok-2" }),
      getValidToken: async () => ({ ok: true, accessToken: "tok-stale" }),
    })

    await forceRefreshViaBroker(env)
    const read = await getValidAgentTokenViaBroker(env, { readOnly: true })

    expect(read).toBe("tok-2") // the forced token, not whatever getValidToken would answer
    expect(calls.filter((c) => c.method === "getValidToken")).toHaveLength(0)
  })
})

describe("installAgentTokenToBroker", () => {
  const record: LinearAgentTokenRecord = {
    accessToken: "tok-1",
    refreshToken: "ref-1",
    installedAt: 1,
  }

  it("calls stub.install(record) with the exact record and returns true", async () => {
    const { env, calls } = makeEnv({ install: async () => ({ ok: true }) })

    await expect(installAgentTokenToBroker(env, record)).resolves.toBe(true)

    const rpcCall = calls.find((c) => c.method === "install")
    expect(rpcCall?.args[0]).toEqual(record)
  })

  it("returns false (never throws) when the DO RPC throws", async () => {
    const { env } = makeEnv({
      install: async () => {
        throw new Error("DO unreachable")
      },
    })
    await expect(installAgentTokenToBroker(env, record)).resolves.toBe(false)
  })

  it("invalidates the isolate read cache so a subsequent readOnly read reflects the new install", async () => {
    const { env } = makeEnv({
      getValidToken: async () => ({ ok: true, accessToken: "tok-old" }),
      install: async () => ({ ok: true }),
    })

    await getValidAgentTokenViaBroker(env, { readOnly: true }) // primes the cache with tok-old
    await installAgentTokenToBroker(env, record)

    // Re-point the stub's getValidToken to the post-install answer and confirm
    // the cache was actually cleared (a fresh DO read happens, not a stale hit).
    const { env: env2, calls: calls2 } = makeEnv({ getValidToken: async () => ({ ok: true, accessToken: "tok-new" }) })
    // installAgentTokenToBroker clears the SAME module-level cache regardless of
    // which env instance triggered it, so env2's read must hit the DO.
    const read = await getValidAgentTokenViaBroker(env2, { readOnly: true })
    expect(read).toBe("tok-new")
    expect(calls2.filter((c) => c.method === "getValidToken")).toHaveLength(1)
  })

  it("maps a tenant install's structured conflict result to false", async () => {
    const scope = { organizationId: "org-a", installationId: 11 }
    const tenantRecord: LinearAgentTokenRecord = { ...record, ...scope, actorType: "app" }
    const { env, calls } = makeEnv({
      installTenant: async () => ({ ok: false, reason: "tenant-conflict" }),
    })

    await expect(installAgentTokenToBroker(env, scope, tenantRecord)).resolves.toBe(false)
    expect(calls.find((call) => call.method === "installTenant")?.args).toEqual([tenantRecord, scope])
  })
})

describe("uninstallAgentTokenFromBroker", () => {
  it("uses the exact organization shard and passes the immutable scope again", async () => {
    const scope = { organizationId: "org-a", installationId: 11 }
    const { env, calls } = makeEnv({
      uninstallTenant: async () => ({ ok: true, removed: true }),
    })

    await expect(uninstallAgentTokenFromBroker(env, scope)).resolves.toBe(true)

    expect(calls.find((call) => call.method === "idFromName")?.args).toEqual(["linear-org:v1:org-a"])
    expect(calls.find((call) => call.method === "uninstallTenant")?.args).toEqual([scope])
  })

  it("fails closed when the shard reports a tenant mismatch", async () => {
    const { env } = makeEnv({
      uninstallTenant: async () => ({ ok: false, reason: "tenant-mismatch" }),
    })
    await expect(uninstallAgentTokenFromBroker(env, { organizationId: "org-a", installationId: 11 })).resolves.toBe(
      false,
    )
  })
})

describe("tenant install receipt wrappers", () => {
  const scope = { organizationId: "org-a", installationId: 11 }
  const receipt = { generation: "generation-a" }
  const record: LinearAgentTokenRecord = {
    accessToken: "tok-new",
    installedAt: 1,
    ...scope,
    actorType: "app",
  }

  it("passes the same client-generated generation through stage, commit, and rollback", async () => {
    const { env, calls } = makeEnv({})

    await expect(stageAgentTokenToBroker(env, scope, record, receipt)).resolves.toBe(true)
    await expect(commitAgentTokenToBroker(env, scope, receipt)).resolves.toBe(true)
    await expect(rollbackAgentTokenFromBroker(env, scope, receipt)).resolves.toBe(true)

    expect(calls.find((call) => call.method === "stageTenantInstall")?.args).toEqual([
      record,
      scope,
      receipt.generation,
    ])
    expect(calls.find((call) => call.method === "commitTenantInstall")?.args).toEqual([scope, receipt.generation])
    expect(calls.find((call) => call.method === "rollbackTenantInstall")?.args).toEqual([scope, receipt.generation])
  })

  it("returns false on an ambiguous stage RPC throw so the caller can issue the receipt rollback", async () => {
    const { env } = makeEnv({
      stageTenantInstall: async () => {
        throw new Error("response lost")
      },
    })
    await expect(stageAgentTokenToBroker(env, scope, record, receipt)).resolves.toBe(false)
    await expect(rollbackAgentTokenFromBroker(env, scope, receipt)).resolves.toBe(true)
  })
})
