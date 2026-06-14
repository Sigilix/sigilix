// SIG-382: re-export shim. The per-repo Sigilix config surface
// (ARC-174) was decomposed out of this 1,822-line god-file into pure
// domain modules + an IO adapter:
//
//   - `@/shared/domain/config/types`   — types + public/shared consts
//   - `@/shared/domain/config/parse`   — raw → SigilixConfig parser
//   - `@/shared/domain/config/resolve` — SigilixConfig → resolved/rendered
//   - `@/shared/adapters/config/load`  — the only IO (fetch + parse)
//
// This file now re-exports all four so the existing importers compile
// unchanged. No logic lives here. See
// docs/superpowers/plans/2026-06-09-sig-382-config-split.md.

// `types` is re-exported EXPLICITLY (not `export *`) to preserve this module's
// exact original public surface. `SPECIALIST_ROLES` had to become an `export` in
// `types.ts` so `parse` and `resolve` can share it across files, but it was
// module-private in the original god-file — so it is deliberately NOT surfaced
// here (the canonical public role list is `ALL_SPECIALISTS`).
export type {
  SigilixProfile,
  SigilixConfig,
  DispatcherConfig,
  DispatcherSafetyNetPattern,
  ReviewMemoryCategoryRef,
  SarifFindingCategoryRef,
  SigilixPathInstruction,
  MatchedSigilixPathInstruction,
  SigilixCommandName,
  SigilixCommandPromptConfig,
  SigilixCommandModelConfig,
  SigilixCommandConfig,
  SigilixConfigPath,
  SigilixConfigFormat,
  SigilixConfigSource,
  McpToolId,
  McpConfig,
} from "@/src/shared/domain/config/types"
export {
  SIGILIX_CONFIG_PATH,
  SIGILIX_CONFIG_PATH_JSON,
  SIGILIX_CONFIG_PATH_YAML,
  SIGILIX_CONFIG_PATH_YML,
  SIGILIX_CONFIG_PATHS,
  KNOWN_MODELS,
  EMPTY_CONFIG,
  MCP_TOOL_IDS,
} from "@/src/shared/domain/config/types"
export * from "@/src/shared/domain/config/parse"
export * from "@/src/shared/domain/config/resolve"
export * from "@/src/shared/adapters/config/load"
