#!/usr/bin/env node
// SIG-304 (review CLI) Phase 1 — the `sigilix` entrypoint. Registers a Node
// resolve hook that shims the Workers-only `cloudflare:workers` module, THEN
// (dynamically, so the hook is active first) loads + runs the CLI. Distribution
// (npm bin + a built JS target with `@/` resolved) lands in Phase 2.

import { register } from "node:module"

// Must run before the engine (which reuses Worker code) is imported.
register("./cloudflare-loader.mjs", import.meta.url)

// CLI hygiene: the engine emits a firehose of structured telemetry via
// console.log/info/debug/warn/error (useful in Worker logs, pure noise in a
// terminal). Written live it ALSO interleaves with the animated splash on stderr
// and breaks its in-place redraw (frames stack into scrollback). So BUFFER it:
// drop on a clean run, flush to stderr on error (so failures stay debuggable), or
// stream live when SIGILIX_DEBUG / DEBUG is set. The CLI's own user-facing messages
// use process.stdout/stderr.write directly (not console.*), so they're unaffected.
const fmt = (args: unknown[]): string => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
const toStderr = (...args: unknown[]): void => void process.stderr.write(fmt(args) + "\n")
const DEBUG = Boolean(process.env.SIGILIX_DEBUG || process.env.DEBUG)
const logBuf: string[] = []
const capture = (...args: unknown[]): void => {
  logBuf.push(fmt(args))
  if (logBuf.length > 1000) logBuf.shift() // bound memory on long runs
}
const sink = DEBUG ? toStderr : capture
console.log = sink
console.info = sink
console.debug = sink
console.warn = sink
console.error = sink

async function main(): Promise<number> {
  const { cliMain } = await import("@/src/cli/app/cli-main")
  return cliMain(process.argv.slice(2))
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // On failure, flush the buffered engine telemetry so the error is debuggable.
    if (!DEBUG && logBuf.length > 0) process.stderr.write(logBuf.join("\n") + "\n")
    process.stderr.write(`sigilix: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
