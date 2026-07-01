// SIG-494 — unit tests for the tenant-scope reconciliation gate
// (callerOwnsInstallation / callerOwnsRepo) added to close the cross-tenant
// grounding leak: a per-tenant key's resolved installationId was previously
// discarded, so any valid key could retrieve/review/query ANY indexed repo.

import { describe, it, expect } from "vitest"
import { LEGACY_TENANT_INSTALLATION_ID, callerOwnsInstallation, callerOwnsRepo } from "@/src/lib/api-key-resolver"
import type { InstallationLookup } from "@/src/shared/adapters/github/github-installation"

describe("callerOwnsInstallation", () => {
  it("a real per-tenant key OWNS a repo whose resolved installation matches its own", () => {
    const lookup: InstallationLookup = { ok: true, installationId: 42 }
    expect(callerOwnsInstallation(42, lookup)).toBe(true)
  })

  it("a real per-tenant key does NOT own a repo resolved to a DIFFERENT installation (the leak, closed)", () => {
    const lookup: InstallationLookup = { ok: true, installationId: 999 }
    expect(callerOwnsInstallation(42, lookup)).toBe(false)
  })

  it("fails CLOSED when the repo doesn't resolve to any installation at all", () => {
    const lookup: InstallationLookup = { ok: false, reason: "no_installation" }
    expect(callerOwnsInstallation(42, lookup)).toBe(false)
  })

  it("the LEGACY global key is exempt — always broad, regardless of the lookup", () => {
    expect(callerOwnsInstallation(LEGACY_TENANT_INSTALLATION_ID, { ok: true, installationId: 999 })).toBe(true)
    expect(callerOwnsInstallation(LEGACY_TENANT_INSTALLATION_ID, { ok: false, reason: "no_installation" })).toBe(true)
  })
})

describe("callerOwnsRepo", () => {
  const MAP = '{"o/r":"42","other/repo":"999"}'

  it("200-shape: a per-tenant key whose installation OWNS the requested repo", () => {
    expect(callerOwnsRepo(42, "o", "r", MAP)).toBe(true)
  })

  it("403-shape: a per-tenant key requesting a repo owned by a DIFFERENT installation", () => {
    expect(callerOwnsRepo(42, "other", "repo", MAP)).toBe(false)
  })

  it("403-shape: fails CLOSED when the repo isn't in the installation map at all", () => {
    expect(callerOwnsRepo(42, "unknown", "repo", MAP)).toBe(false)
  })

  it("403-shape: fails CLOSED when the installation map is undefined", () => {
    expect(callerOwnsRepo(42, "o", "r", undefined)).toBe(false)
  })

  it("200-shape: the LEGACY global key stays broad even for a repo owned by another installation", () => {
    expect(callerOwnsRepo(LEGACY_TENANT_INSTALLATION_ID, "other", "repo", MAP)).toBe(true)
  })

  it("200-shape: the LEGACY global key stays broad even with no installation map configured", () => {
    expect(callerOwnsRepo(LEGACY_TENANT_INSTALLATION_ID, "o", "r", undefined)).toBe(true)
  })
})
