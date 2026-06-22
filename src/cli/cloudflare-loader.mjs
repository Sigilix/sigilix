// SIG-304 (review CLI) Phase 1b — a Node ESM resolve hook that redirects the
// Workers-only `cloudflare:workers` specifier to a plain-Node stub, so the
// `sigilix` CLI (which reuses Worker engine code) loads outside the Workers
// runtime. Registered by bin.ts via `module.register` BEFORE the engine imports.

import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"

const SHIM = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "cloudflare-workers-shim.mjs")).href

// `.wasm` (the QuickJS reproduction harness) → a null stub. Reproduction is off on
// the local CLI path (the harness is never instantiated), so the import just needs
// to resolve for the graph to load.
const WASM_STUB = "data:text/javascript,export default null"

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: SHIM, shortCircuit: true }
  if (specifier.endsWith(".wasm")) return { url: WASM_STUB, shortCircuit: true }
  return next(specifier, context)
}
