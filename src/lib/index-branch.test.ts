import { describe, expect, it } from "vitest"

import {
  branchStateRepo,
  encodeBranchName,
  isBranchStateRepo,
  isValidEncodedBranch,
  parseBranchNamespace,
  isTrackedLongLivedBranch,
  parseTrackedBranches,
  resolveIndexTarget,
} from "@/src/lib/index-branch"

describe("index branch helpers", () => {
  it("encodes branch names into a bounded 17-char hash segment", async () => {
    // SIG-218: regardless of input length the encoded form is "h" + 16 hex.
    const short = await encodeBranchName("dev")
    const medium = await encodeBranchName("feature/SIG-35 branch aware")
    const long = await encodeBranchName("sig-216-followup-routing-and-badge-font")
    const adversarial = await encodeBranchName("x".repeat(500))
    expect(short).toMatch(/^h[0-9a-f]{16}$/)
    expect(medium).toMatch(/^h[0-9a-f]{16}$/)
    expect(long).toMatch(/^h[0-9a-f]{16}$/)
    expect(adversarial).toMatch(/^h[0-9a-f]{16}$/)
    expect(short.length).toBe(17)
    expect(medium.length).toBe(17)
    expect(long.length).toBe(17)
    expect(adversarial.length).toBe(17)
  })

  it("produces deterministic, collision-free encodings within a repo's branch space", async () => {
    const dev1 = await encodeBranchName("dev")
    const dev2 = await encodeBranchName("dev")
    const featureA = await encodeBranchName("feature/a")
    const featureB = await encodeBranchName("feature/b")
    const upperA = await encodeBranchName("Feature/A")
    expect(dev1).toBe(dev2)
    expect(dev1).not.toBe(featureA)
    expect(featureA).not.toBe(featureB)
    expect(featureA).not.toBe(upperA)
  })

  it("trims the branch name before hashing", async () => {
    expect(await encodeBranchName("  dev  ")).toBe(await encodeBranchName("dev"))
  })

  it("composes the branch state repo with the bounded hash segment", async () => {
    const encoded = await encodeBranchName("feature/SIG-35")
    expect(await branchStateRepo("sigilix", "feature/SIG-35")).toBe(`sigilix/__branch__/${encoded}`)
  })

  it("validates encoded-branch segments structurally", async () => {
    const encoded = await encodeBranchName("dev")
    expect(isValidEncodedBranch(encoded)).toBe(true)
    expect(isValidEncodedBranch("not-hex")).toBe(false)
    expect(isValidEncodedBranch("h12")).toBe(false)
    // SIG-218: the legacy utf8-as-hex encoding is no longer accepted; the
    // new form is fixed-length 17 chars.
    expect(isValidEncodedBranch("h646576")).toBe(false)
    expect(isValidEncodedBranch("h" + "0".repeat(15))).toBe(false)
    expect(isValidEncodedBranch("h" + "0".repeat(17))).toBe(false)
  })

  it("parses branch namespaces into encoded segments (branch name irrecoverable)", async () => {
    const encoded = await encodeBranchName("dev")
    expect(parseBranchNamespace(`sigilix/sigilix/__branch__/${encoded}`)).toEqual({
      owner: "sigilix",
      repo: "sigilix",
      encodedBranch: encoded,
      namespace: `sigilix/sigilix/__branch__/${encoded}`,
    })
    expect(parseBranchNamespace("sigilix/sigilix")).toBeNull()
    // Legacy variable-length encodings no longer parse.
    expect(parseBranchNamespace("sigilix/sigilix/__branch__/h646576")).toBeNull()
  })

  it("resolves default branches to the existing repo namespace", async () => {
    expect(
      await resolveIndexTarget({
        owner: "Sigilix",
        repo: "sigilix",
        defaultBranch: "main",
        branch: "main",
      }),
    ).toMatchObject({
      branch: "main",
      stateRepo: "sigilix",
      namespace: "sigilix/sigilix",
      isDefault: true,
    })
  })

  it("resolves non-default branches to isolated state and namespace", async () => {
    const encoded = await encodeBranchName("dev")
    expect(
      await resolveIndexTarget({
        owner: "Sigilix",
        repo: "sigilix",
        defaultBranch: "main",
        branch: "dev",
      }),
    ).toMatchObject({
      branch: "dev",
      stateRepo: `sigilix/__branch__/${encoded}`,
      namespace: `sigilix/sigilix/__branch__/${encoded}`,
      isDefault: false,
    })
    expect(isBranchStateRepo(`sigilix/__branch__/${encoded}`)).toBe(true)
    expect(isBranchStateRepo("sigilix")).toBe(false)
    expect(isBranchStateRepo("my__branch__repo")).toBe(false)
    expect(isBranchStateRepo("sigilix/nested/__branch__/dev")).toBe(false)
  })

  it("keeps the full Vectorize namespace under Cloudflare's 64-byte cap", async () => {
    // SIG-218 regression guard. Pre-fix: a 39-char branch under
    // sigilix/sigilix produced a 106-byte namespace and crashed Vectorize
    // with VECTOR_UPSERT_ERROR (40013).
    const target = await resolveIndexTarget({
      owner: "sigilix",
      repo: "sigilix",
      defaultBranch: "main",
      branch: "sig-216-followup-routing-and-badge-font",
    })
    expect(target.namespace.length).toBeLessThanOrEqual(64)
  })

  it("tracks common long-lived branches plus configured names", () => {
    expect(isTrackedLongLivedBranch("dev", undefined)).toBe(true)
    expect(isTrackedLongLivedBranch("release", undefined)).toBe(false)
    expect(isTrackedLongLivedBranch("release", "qa, release")).toBe(true)
    expect(Array.from(parseTrackedBranches(" qa ,, Next ")).sort()).toContain("next")
  })
})
