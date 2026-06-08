// SIG-318 (PR 3) — EnsembleConfig: the parse-once, typed view of the ensemble's
// env-derived settings.
//
// `parseEnsembleConfig` is a PURE function of a structural env (it takes the env
// fields it reads, not the live Worker `env`), so it is fully unit-testable and
// the rest of the ensemble can depend on a typed `EnsembleConfig` instead of
// reading `env.OPENCLAW_*` ad hoc — the "env-reading traps" the clean-arch
// decomposition removes. It is migrated one cohesive cluster at a time
// (SIG-318 PR 3+); this PR covers the AST security-scan modes. As later clusters
// (validator gate modes, feature flags, tunables) migrate, this Config grows and
// the single parse call moves up to the orchestrator edge.

/** Normalized `off | shadow | post` mode for an AST security scanner. Kept as a
 *  string to preserve the exact `(value ?? "off").trim().toLowerCase()` contract
 *  the call sites compare against (`mode !== "post"`, `applyAstScanGate(...)`). */
export type AstScanMode = string

/** The AST security-scanner modes, one per scanner rule. */
export interface AstScanModes {
  authzIdor: AstScanMode
  weakRandom: AstScanMode
  openRedirect: AstScanMode
  ssrf: AstScanMode
  pathTraversal: AstScanMode
  sqlInjection: AstScanMode
  ssti: AstScanMode
  nosqlInjection: AstScanMode
  protoPollution: AstScanMode
  xxe: AstScanMode
}

export interface EnsembleConfig {
  astScanModes: AstScanModes
}

/** The structural subset of the Worker env that `parseEnsembleConfig` reads.
 *  Declared here so the parser depends only on the variables it consumes, not on
 *  the full Worker `Env` binding type. */
export interface EnsembleConfigEnv {
  OPENCLAW_AUTHZ_IDOR_SCAN?: string | undefined
  OPENCLAW_WEAK_RANDOM_SCAN?: string | undefined
  OPENCLAW_OPEN_REDIRECT_SCAN?: string | undefined
  OPENCLAW_SSRF_SCAN?: string | undefined
  OPENCLAW_PATH_TRAVERSAL_SCAN?: string | undefined
  OPENCLAW_SQL_INJECTION_SCAN?: string | undefined
  OPENCLAW_SSTI_SCAN?: string | undefined
  OPENCLAW_NOSQL_INJECTION_SCAN?: string | undefined
  OPENCLAW_PROTO_POLLUTION_SCAN?: string | undefined
  OPENCLAW_XXE_SCAN?: string | undefined
}

// The exact normalization the inline call sites used: default "off", trim,
// lowercase. Centralized here so every scanner mode is parsed identically.
const scanMode = (v: string | undefined): AstScanMode => (v ?? "off").trim().toLowerCase()

export function parseEnsembleConfig(env: EnsembleConfigEnv): EnsembleConfig {
  return {
    astScanModes: {
      authzIdor: scanMode(env.OPENCLAW_AUTHZ_IDOR_SCAN),
      weakRandom: scanMode(env.OPENCLAW_WEAK_RANDOM_SCAN),
      openRedirect: scanMode(env.OPENCLAW_OPEN_REDIRECT_SCAN),
      ssrf: scanMode(env.OPENCLAW_SSRF_SCAN),
      pathTraversal: scanMode(env.OPENCLAW_PATH_TRAVERSAL_SCAN),
      sqlInjection: scanMode(env.OPENCLAW_SQL_INJECTION_SCAN),
      ssti: scanMode(env.OPENCLAW_SSTI_SCAN),
      nosqlInjection: scanMode(env.OPENCLAW_NOSQL_INJECTION_SCAN),
      protoPollution: scanMode(env.OPENCLAW_PROTO_POLLUTION_SCAN),
      xxe: scanMode(env.OPENCLAW_XXE_SCAN),
    },
  }
}
