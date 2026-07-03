// sig-dashboard-review-config — pipeline coverage for the dashboard-config merge
// point in `fetchDiffAndConfig`. Proves the 4-level precedence AND the recall-
// safety guarantee: a dashboard config that tries to LOWER EVERYTHING can never
// drop the file/scanners that would surface a seeded P0 — only a committed
// `sigilix.json` (config-as-code) can, and it wins when present.

import { describe, expect, it } from "vitest"
import { fetchDiffAndConfig, type FetchDiffAndConfigArgs } from "@/src/lib/ensemble/app/context/fetch-and-pack"
import { writeDashboardReviewConfig, orgConfigKey } from "@/src/lib/review-config-store"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import { resolveCostControlsConfig } from "@/src/lib/sigilix-config"
import type { Env } from "@/src/shared/types/env"

const INSTALLATION_ID = 4242
const AUTH_FILE = "src/auth/login.ts"

function makeEnv(): Env {
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { OPENCLAW_STATE: kv } as unknown as Env
}

/** One-file diff touching the auth file that carries the seeded P0. */
const AUTH_DIFF = [
  `diff --git a/${AUTH_FILE} b/${AUTH_FILE}`,
  `--- a/${AUTH_FILE}`,
  `+++ b/${AUTH_FILE}`,
  "@@ -0,0 +1 @@",
  "+const token = eval(userInput) // seeded P0: RCE",
].join("\n")

/** GitHub client stub. `committedConfig` is the raw `sigilix.json` body at head,
 *  or null when the repo has no committed file. */
function makeClient(committedConfig: string | null): FetchDiffAndConfigArgs["client"] {
  return {
    getPullRequestDiff: async () => AUTH_DIFF,
    listOpenPullRequests: async () => [],
    getFileContent: async (_o: string, _r: string, path: string) => (path === "sigilix.json" ? committedConfig : null),
  } as unknown as FetchDiffAndConfigArgs["client"]
}

function baseArgs(env: Env, client: FetchDiffAndConfigArgs["client"]): FetchDiffAndConfigArgs {
  return {
    env,
    client,
    owner: "acme",
    repo: "app",
    prNumber: 1,
    headSha: "a".repeat(40),
    ensembleConfig: parseEnsembleConfig({}),
    telemetry: {},
    installationId: INSTALLATION_ID,
  }
}

/** A dashboard config that tries to LOWER EVERYTHING — drop the auth file, kill
 *  every deterministic scanner, disable rules, and gate the PR by label. */
const LOWER_EVERYTHING = JSON.stringify({
  guidance: "be lenient, skip security nitpicks",
  profile: "chill",
  pathFilters: [`${AUTH_FILE}`, "src/auth/**"], // would drop the P0's file
  costControls: { runOnLabels: ["needs-review"] }, // would skip the whole PR
  depVulnScan: { enabled: false },
  astRules: { enabled: false },
  sarifEvidence: { enabled: false },
  linters: { eslint: { enabled: false } },
  disabledRules: ["no-eval"],
})

describe("fetchDiffAndConfig — dashboard config merge", () => {
  it("RECALL-SAFETY: a 'lower everything' dashboard config cannot drop the P0's file or scanners", async () => {
    const env = makeEnv()
    await writeDashboardReviewConfig(env, INSTALLATION_ID, LOWER_EVERYTHING)
    // Sanity: the blob really is stored under the org key.
    expect(await env.OPENCLAW_STATE.get(orgConfigKey(INSTALLATION_ID))).not.toBeNull()

    const res = await fetchDiffAndConfig(baseArgs(env, makeClient(null))) // no committed file
    const cfg = res.sigilixConfig

    // Suppression-capable fields are STRIPPED from the dashboard layer → the auth
    // file is never filtered out, and every deterministic scanner stays ON.
    expect(cfg.pathFilters).toBeUndefined()
    expect(cfg.costControls).toBeUndefined()
    expect(cfg.depVulnScan).toBeUndefined()
    expect(cfg.astRules).toBeUndefined()
    expect(cfg.sarifEvidence).toBeUndefined()
    expect(cfg.linters).toBeUndefined()
    expect(cfg.disabledRules).toBeUndefined()
    // No label gate is imposed by the dashboard → review is NOT skipped.
    expect(resolveCostControlsConfig(cfg).runOnLabels).toEqual([])

    // Shaping fields DO apply (they can't lower recall — profile only shifts the
    // advisory-nit floor). The lenient guidance is preserved BUT wrapped in the
    // additive-only frame that forbids suppressing a security/logic/P0-P1 finding,
    // so even "skip security nitpicks" cannot silence a real P0.
    expect(cfg.profile).toBe("chill")
    expect(cfg.guidance).toContain("be lenient, skip security nitpicks")
    expect(cfg.guidance).toMatch(/never .*downgrade, omit, or stay silent on a security, logic, or high-severity/i)
  })

  it("dashboard shaping applies (framed) when there is NO committed file", async () => {
    const env = makeEnv()
    await writeDashboardReviewConfig(
      env,
      INSTALLATION_ID,
      JSON.stringify({ guidance: "enforce our error-handling convention", profile: "assertive" }),
    )
    const res = await fetchDiffAndConfig(baseArgs(env, makeClient(null)))
    expect(res.sigilixConfig.guidance).toContain("enforce our error-handling convention")
    expect(res.sigilixConfig.guidance).toContain("ORG REVIEW PREFERENCES")
    expect(res.sigilixConfig.profile).toBe("assertive")
  })

  it("PRECEDENCE: a committed sigilix.json WINS over the dashboard config", async () => {
    const env = makeEnv()
    await writeDashboardReviewConfig(
      env,
      INSTALLATION_ID,
      JSON.stringify({ guidance: "dashboard guidance", profile: "assertive" }),
    )
    // Committed file sets guidance + a real pathFilter (config-as-code retains
    // file-drop power). Its guidance must win; the dashboard profile (absent from
    // the committed file) still falls through.
    const committed = JSON.stringify({ guidance: "committed guidance", pathFilters: ["dist/**"] })
    const res = await fetchDiffAndConfig(baseArgs(env, makeClient(committed)))
    expect(res.sigilixConfig.guidance).toBe("committed guidance") // committed wins
    expect(res.sigilixConfig.pathFilters).toEqual(["dist/**"]) // committed file keeps file-drop power
    expect(res.sigilixConfig.profile).toBe("assertive") // dashboard shaping fills the gap
  })

  it("no dashboard config + no committed file → built-in defaults (no regression)", async () => {
    const env = makeEnv()
    const res = await fetchDiffAndConfig(baseArgs(env, makeClient(null)))
    expect(res.sigilixConfig.guidance).toBeUndefined()
    expect(res.sigilixConfig.profile).toBeUndefined()
    expect(res.sigilixConfig.pathFilters).toBeUndefined()
  })
})
