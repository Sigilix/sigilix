#!/usr/bin/env node
// SIG-304 (review CLI) Phase 1 — the `sigilix` entrypoint. Thin shim: parse argv,
// run, set the process exit code. Distribution (npm bin + a built JS target with the
// `@/` alias resolved) lands in Phase 2; for now this is the typechecked source entry.

import { cliMain } from "@/src/cli/app/cli-main"

cliMain(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`sigilix: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
