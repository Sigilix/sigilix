// SIG-318 PR 5a: the config-resolution seam for the orchestrator. The Worker edge
// parses EnsembleConfig once and injects it via args.ensembleConfig; non-edge
// callers (tests) fall back to parsing env. This pins both paths — it fails if the
// handler ever reverts to parsing env unconditionally (ignoring the injected config).
import { describe, it, expect } from "vitest"
import { resolveEnsembleConfig } from "../src/lib/triage-pr-review-ensemble"
import { parseEnsembleConfig } from "../src/lib/ensemble/config"

type ResolveArgs = Parameters<typeof resolveEnsembleConfig>[0]
const asEnv = (e: Record<string, string>) => e as unknown as ResolveArgs["env"]

describe("SIG-318 PR 5a — resolveEnsembleConfig (edge-injected vs env fallback)", () => {
  it("returns the injected config verbatim — does not re-parse env", () => {
    const injected = parseEnsembleConfig({ OPENCLAW_SSRF_SCAN: "post" })
    // env would parse to a DIFFERENT config (ssrf "off"); the injected one must win.
    const resolved = resolveEnsembleConfig({
      env: asEnv({ OPENCLAW_SSRF_SCAN: "off" }),
      ensembleConfig: injected,
    })
    expect(resolved).toBe(injected)
    expect(resolved.astScanModes.ssrf).toBe("post")
  })

  it("falls back to parsing env when no config is injected", () => {
    const env = asEnv({ OPENCLAW_SSRF_SCAN: "post" })
    expect(resolveEnsembleConfig({ env })).toEqual(parseEnsembleConfig({ OPENCLAW_SSRF_SCAN: "post" }))
  })
})
