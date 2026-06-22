// SIG-304 Phase 2.3 — produce the published thin-client artifact. esbuild-bundles
// the engine-free entrypoint (src/cli/bin-remote.ts) into a single Node ESM file and
// FAILS if any engine symbol / model key leaked into the artifact (the moat gate, run
// on the real output — the SIG-406 lesson: assert the artifact, not the source). The
// vitest `thin-client-moat` test enforces this in CI; this script writes the file for
// publishing. `npm run thin-client:build` → dist/sigilix.mjs.

import { build } from "esbuild"
import { mkdirSync, writeFileSync } from "node:fs"
import { assertNoEngineLeak } from "@/src/cli/thin-client-policy"

async function main(): Promise<void> {
  const result = await build({
    entryPoints: ["src/cli/bin-remote.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node20",
    tsconfig: "tsconfig.json",
    // No minify (the moat gate reads esbuild's module banners) and no banner
    // (esbuild preserves bin-remote.ts's own shebang; a second would be a syntax error).
    minify: false,
    logLevel: "silent",
  })
  const code = result.outputFiles[0]!.text
  // The fail-closed allowlist (shared with the CI moat-gate test) — proven on the artifact.
  try {
    assertNoEngineLeak(code)
  } catch (err) {
    process.stderr.write(
      `MOAT LEAK — refusing to write the bundle: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }
  mkdirSync("dist", { recursive: true })
  writeFileSync("dist/sigilix.mjs", code)
  process.stdout.write(
    `thin client bundled → dist/sigilix.mjs (${Math.round(code.length / 1024)} KB), no engine leaked\n`,
  )
}

void main()
