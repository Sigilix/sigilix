// SIG-304 Phase 2.3 — the MOAT GATE. Bundles the published thin-client entrypoint
// (bin-remote.ts) and asserts the ARTIFACT against a fail-closed ALLOWLIST (the
// SIG-406 lesson: a green build never proves what shipped — assert the artifact).
// Negative cases prove the gate actually FIRES on a leak.

import { describe, it, expect } from "vitest"
import { build } from "esbuild"
import { resolve } from "node:path"
import { assertNoEngineLeak } from "./thin-client-policy"

async function bundleBinRemote(): Promise<string> {
  const result = await build({
    entryPoints: [resolve(process.cwd(), "src/cli/bin-remote.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    tsconfig: resolve(process.cwd(), "tsconfig.json"),
    logLevel: "silent",
  })
  return result.outputFiles[0]!.text
}

describe("thin-client moat gate", () => {
  it("the real bin-remote bundle is engine-free (allowlist passes)", async () => {
    const code = await bundleBinRemote()
    expect(() => assertNoEngineLeak(code)).not.toThrow()
    expect(code).toContain("/v1/review") // sanity: it actually bundled the hosted driver
  }, 30_000)

  // The gate must FIRE — these prove it isn't a no-op (the prior denylist never caught a real leak).
  it("FAILS CLOSED on a leaked engine module (e.g. a specialist prompt)", () => {
    const leaked = "// src/cli/bin-remote.ts\n// src/prompts/specialists/logic.ts\nconst P = 'secret prompt'\n"
    expect(() => assertNoEngineLeak(leaked)).toThrow(/non-allowlisted/)
  })
  it("FAILS CLOSED on a leaked engine app/adapter module", () => {
    const leaked = "// src/cli/bin-remote.ts\n// src/lib/ensemble/app/orchestrator.ts\nfn()\n"
    expect(() => assertNoEngineLeak(leaked)).toThrow(/non-allowlisted/)
  })
  it("FAILS CLOSED on a leaked model-key symbol", () => {
    expect(() => assertNoEngineLeak("// src/cli/bin-remote.ts\nconst k = env.OPENROUTER_API_KEY\n")).toThrow(
      /OPENROUTER_API_KEY/,
    )
  })
  it("FAILS CLOSED when module banners are absent (e.g. minified)", () => {
    expect(() => assertNoEngineLeak("function a(){return 1}")).toThrow(/failing closed/)
  })
})
