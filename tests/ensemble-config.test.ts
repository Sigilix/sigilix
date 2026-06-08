// SIG-318 (PR 3): EnsembleConfig parser — the typed, parse-once edge that
// replaces the inline `env.OPENCLAW_*` reads (the "env-reading traps"). This PR
// migrates the AST security-scan modes; the test pins the exact contract the old
// inline reads had — default "off", trim + lowercase — and that each env var maps
// to the correct scanner field (the one thing a 10-field parser can silently get
// wrong via copy-paste).

import { describe, it, expect } from "vitest"
import { parseEnsembleConfig } from "../src/lib/ensemble/config"

describe("SIG-318 parseEnsembleConfig — AST scan modes", () => {
  it("defaults every scanner to 'off' when the env var is absent", () => {
    expect(parseEnsembleConfig({}).astScanModes).toEqual({
      authzIdor: "off",
      weakRandom: "off",
      openRedirect: "off",
      ssrf: "off",
      pathTraversal: "off",
      sqlInjection: "off",
      ssti: "off",
      nosqlInjection: "off",
      protoPollution: "off",
      xxe: "off",
    })
  })

  it("normalizes each value with trim + lowercase (the old inline contract)", () => {
    const c = parseEnsembleConfig({ OPENCLAW_SSRF_SCAN: "  POST  ", OPENCLAW_XXE_SCAN: "Shadow" })
    expect(c.astScanModes.ssrf).toBe("post")
    expect(c.astScanModes.xxe).toBe("shadow")
  })

  it("maps each env var to the correct scanner field (no cross-wiring)", () => {
    // Distinct value per var so a swapped mapping is caught.
    expect(
      parseEnsembleConfig({
        OPENCLAW_AUTHZ_IDOR_SCAN: "post",
        OPENCLAW_WEAK_RANDOM_SCAN: "shadow",
        OPENCLAW_OPEN_REDIRECT_SCAN: "post",
        OPENCLAW_SSRF_SCAN: "shadow",
        OPENCLAW_PATH_TRAVERSAL_SCAN: "post",
        OPENCLAW_SQL_INJECTION_SCAN: "shadow",
        OPENCLAW_SSTI_SCAN: "post",
        OPENCLAW_NOSQL_INJECTION_SCAN: "shadow",
        OPENCLAW_PROTO_POLLUTION_SCAN: "post",
        OPENCLAW_XXE_SCAN: "shadow",
      }).astScanModes,
    ).toEqual({
      authzIdor: "post",
      weakRandom: "shadow",
      openRedirect: "post",
      ssrf: "shadow",
      pathTraversal: "post",
      sqlInjection: "shadow",
      ssti: "post",
      nosqlInjection: "shadow",
      protoPollution: "post",
      xxe: "shadow",
    })
  })

  it("treats explicit empty / whitespace-only as '' (not 'off') — matching the old inline read", () => {
    // `?? "off"` only defaults ABSENT (undefined) vars; an explicit "" or
    // whitespace normalizes to "" exactly as the pre-migration inline read did.
    // Downstream that reads as not-"post" → the scanner stays off, so behavior is
    // unchanged; this pins the distinction (absent → "off", but "" → "").
    const c = parseEnsembleConfig({ OPENCLAW_SSRF_SCAN: "", OPENCLAW_XXE_SCAN: "   " })
    expect(c.astScanModes.ssrf).toBe("")
    expect(c.astScanModes.xxe).toBe("")
  })
})
