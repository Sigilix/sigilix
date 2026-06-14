// SIG-382: export-parity guard for the `src/lib/sigilix-config.ts`
// re-export shim. The config surface was decomposed into
// `@/shared/domain/config/{types,parse,resolve}` + `@/shared/adapters/
// config/load`; the shim re-exports all four. This test imports the
// full original public VALUE surface through the shim and asserts each
// symbol is defined — catching a previously-public symbol accidentally
// made module-private in its new home. (Type-export parity is covered
// by tsc compiling the existing 15 consumers against the shim.)

import { describe, it, expect } from "vitest"

import {
  SIGILIX_CONFIG_PATH,
  SIGILIX_CONFIG_PATH_JSON,
  SIGILIX_CONFIG_PATH_YAML,
  SIGILIX_CONFIG_PATH_YML,
  SIGILIX_CONFIG_PATHS,
  KNOWN_MODELS,
  EMPTY_CONFIG,
  parseSigilixConfig,
  parseSigilixConfigDetailed,
  parseSigilixConfigSource,
  resolvePreMergeGatesConfig,
  resolveCostControlsConfig,
  passesLabelGate,
  resolvePathInstructionsForChangedPaths,
  renderPathInstructionsForPrompt,
  resolveDocsReviewConfig,
  resolvePerfBudgetsConfig,
  isPrOverviewEnabled,
  isPrLabelsEnabled,
  isFindingEvidenceVisible,
  resolveReviewMemoryConfig,
  resolveAstRulesConfig,
  resolveSarifEvidenceConfig,
  resolveCoverageConfig,
  resolveCommandConfig,
  loadSigilixConfig,
  loadSigilixConfigSource,
  loadSigilixConfigRaw,
} from "@/src/lib/sigilix-config"

describe("sigilix-config shim export parity (SIG-382)", () => {
  it("re-exports every public value symbol", () => {
    const exports = {
      SIGILIX_CONFIG_PATH,
      SIGILIX_CONFIG_PATH_JSON,
      SIGILIX_CONFIG_PATH_YAML,
      SIGILIX_CONFIG_PATH_YML,
      SIGILIX_CONFIG_PATHS,
      KNOWN_MODELS,
      EMPTY_CONFIG,
      parseSigilixConfig,
      parseSigilixConfigDetailed,
      parseSigilixConfigSource,
      resolvePreMergeGatesConfig,
      resolveCostControlsConfig,
      passesLabelGate,
      resolvePathInstructionsForChangedPaths,
      renderPathInstructionsForPrompt,
      resolveDocsReviewConfig,
      resolvePerfBudgetsConfig,
      isPrOverviewEnabled,
      isPrLabelsEnabled,
      isFindingEvidenceVisible,
      resolveReviewMemoryConfig,
      resolveAstRulesConfig,
      resolveSarifEvidenceConfig,
      resolveCoverageConfig,
      resolveCommandConfig,
      loadSigilixConfig,
      loadSigilixConfigSource,
      loadSigilixConfigRaw,
    }
    for (const [name, value] of Object.entries(exports)) {
      expect(typeof value, `export \`${name}\` must be defined`).not.toBe("undefined")
    }
    // Guard the count so a future drop is caught even if a name above is
    // removed alongside its assertion.
    expect(Object.keys(exports)).toHaveLength(28)
  })
})
