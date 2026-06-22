// SIG-304 Phase 2.3 — the MOAT POLICY, shared by the bundle grep-gate test and the
// publish build script (single source of truth — no drift). The published thin
// client must ship NO engine IP: not the orchestrator, specialists, model adapters,
// model keys, AND not the specialist PROMPTS (src/prompts/**, the crown jewels).
//
// A denylist can never be complete (a new engine file slips through), so this is an
// ALLOWLIST that FAILS CLOSED: the bundle may contain ONLY these pure presentation /
// domain modules; anything else is treated as a leak. It relies on esbuild's
// un-minified `// <path>` module banners — if those are absent (e.g. someone enables
// minify) the gate also fails closed rather than passing blind.

/** Source-path prefixes the thin-client bundle is allowed to contain — all pure
 *  (no models, prompts, network, or env). Everything else fails the gate. */
export const ALLOWED_BUNDLE_PREFIXES: readonly string[] = [
  "src/cli/", // the thin client itself (incl. renderers + splash)
  "src/lib/ensemble/domain/", // pure verdict/severity domain (NOT app/ or adapters/)
  "src/lib/trust-ledger-render", // pure proof-pill render
  "src/lib/badge-", // pure SVG badge geometry/assets
  "src/shared/domain/", // pure shared domain types/helpers
  "src/shared/types/", // pure shared type decls
]

/** Symbols that must never appear in the artifact (survive minification, unlike the
 *  path banners) — the engine entry + any model key. */
export const FORBIDDEN_BUNDLE_SYMBOLS: readonly string[] = [
  "handlePrReviewEnsemble",
  "OPENROUTER_API_KEY",
  "OLLAMA_API_KEY",
]

/**
 * Throw if a thin-client `bundle` (esbuild output, NOT minified) contains any
 * non-allowlisted src/ module or a forbidden symbol. Used by both the CI moat-gate
 * test and the publish script so the artifact is proven engine-free.
 */
export function assertNoEngineLeak(bundle: string): void {
  const modules = [...new Set([...bundle.matchAll(/^\/\/ (src\/[^\n]+)$/gm)].map((m) => m[1]!))]
  // Fail closed: if esbuild's module banners are gone (minified / format change) we
  // can't verify the allowlist, so refuse rather than pass blind.
  if (!modules.includes("src/cli/bin-remote.ts")) {
    throw new Error("moat gate: no esbuild module banners in the bundle (minified?) — cannot verify; failing closed")
  }
  const leaked = modules.filter((m) => !ALLOWED_BUNDLE_PREFIXES.some((p) => m.startsWith(p)))
  if (leaked.length > 0) {
    throw new Error(
      `moat gate: thin-client bundle contains non-allowlisted module(s) — engine IP may have leaked: ${leaked.join(", ")}`,
    )
  }
  for (const sym of FORBIDDEN_BUNDLE_SYMBOLS) {
    if (bundle.includes(sym)) throw new Error(`moat gate: thin-client bundle leaked the symbol "${sym}"`)
  }
}
