#!/usr/bin/env node
// SIG-304 (review CLI) Phase 1 — the `sigilix` entrypoint. Registers a Node
// resolve hook that shims the Workers-only `cloudflare:workers` module, THEN
// (dynamically, so the hook is active first) loads + runs the CLI. Distribution
// (npm bin + a built JS target with `@/` resolved) lands in Phase 2.

import { register } from "node:module"

// Must run before the engine (which reuses Worker code) is imported.
register("./cloudflare-loader.mjs", import.meta.url)

// CLI hygiene: the engine emits structured telemetry via console.log/info/debug
// (useful in Worker logs, noise in a terminal). Route them to stderr so stdout
// carries ONLY the rendered review — clean for `| jq`, `--agent`, etc. warn/error
// already write to stderr.
const toStderr = (...args: unknown[]): void => {
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n")
}
console.log = toStderr
console.info = toStderr
console.debug = toStderr

async function main(): Promise<number> {
  const { cliMain } = await import("@/src/cli/app/cli-main")
  return cliMain(process.argv.slice(2))
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`sigilix: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
