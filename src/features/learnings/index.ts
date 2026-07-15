export { archiveLearningEntries, loadArchivedLearnings } from "./adapters/archive"
export type { ArchivedLearningEntry, ArchivedLearningStore } from "./adapters/archive"
export { emitLearningAudit } from "./adapters/audit"
export { hasRepoWriteAccess } from "./adapters/authz"
export {
  recordConfirmationMap,
  recordConfirmationMapForThread,
  resolveConfirmationMap,
} from "./adapters/confirmation-map"
export { extractLearning } from "./adapters/extractor-model"
export { captureInstructiveLearning } from "./adapters/instructive-capture"
export type { CaptureInstructiveLearningArgs, CaptureInstructiveLearningResult } from "./adapters/instructive-capture"
export { appendLearning, forgetLearning, hardDeleteLearnings, loadLearnings } from "./adapters/store"
export { loadEffectiveLearnings } from "./adapters/org-apply"
export { applySurfaceMemory, renderSurfaceMemoryForPrompt } from "./adapters/surface-apply"
export type { SurfaceMemoryApplied } from "./adapters/surface-apply"
export { mirrorLearningToOrgScope } from "./adapters/org-mirror"
export { classifyLearningMemory } from "./domain/classify"
export type { ClassifiedLearningMemory, ClassifyLearningMemoryInput } from "./domain/classify"
export { parseLearningsCommand } from "./domain/command"
export { EPHEMERAL_MEMORY_TYPES, MEMORY_DECAY_WINDOW_DAYS, isMemoryDecayEligible } from "./domain/decay"
export {
  CONSOLIDATE_MIN_CLUSTER_SIZE,
  CONSOLIDATE_SIMILARITY_THRESHOLD,
  canonicalPolarityAllowed,
  chooseCanonicalType,
  clusterBySimilarity,
  clusterHasPolarityConflict,
  cosine,
  isDurableConsolidationCandidate,
  resolveClusterConflict,
} from "./domain/consolidate"
export type { ClusterConflictResolution, ClusterOptions } from "./domain/consolidate"
export { buildConsolidationPrompt, parseConsolidation } from "./domain/consolidate-prompt"
export type { ConsolidationInput, ParsedConsolidation } from "./domain/consolidate-prompt"
export { runConsolidation } from "./adapters/consolidator-model"
export { buildExtractionPrompt, parseExtraction } from "./domain/extractor"
export {
  resolveCliOrgMemoryMode,
  resolveLearningsMode,
  resolveMemoryConsolidateMode,
  resolveMemoryDecayMode,
  resolveMemoryProvenanceMode,
  resolveOrgMemoryApplyMode,
  resolveOrgMemoryCaptureMode,
  resolveSurfaceMemoryApplyMode,
} from "./domain/mode"
export type {
  CliOrgMemoryMode,
  MemoryConsolidateMode,
  MemoryDecayMode,
  MemoryProvenanceMode,
  OrgMemoryApplyMode,
  OrgMemoryCaptureMode,
  SurfaceMemoryApplyMode,
} from "./domain/mode"
export { buildMemoryProvenance, renderMemoryProvenance, resolveAppliedMemoryProvenance } from "./domain/provenance"
export type { MemoryProvenance, MemoryProvenanceItem } from "./domain/provenance"
export {
  renderBoostedCategoriesForPrompt,
  renderConfirmReply,
  renderForgetConfirm,
  renderLearningsForPrompt,
  renderOverviewFooter,
  renderSurfaceLearningsForPrompt,
} from "./domain/render"
export {
  MAX_LEARNINGS,
  computeLearningId,
  learningsArchiveKey,
  learningsKey,
  normalizeRule,
  parseLearningsKey,
  removeEntry,
  selectRelevantForPaths,
  upsertEntry,
} from "./domain/store-ops"
export { decideLearningSuppressions } from "./domain/suppress"
export type {
  LearningCarveOutKeep,
  LearningSuppressDecision,
  LearningSuppressResult,
  SuppressBasis,
  SuppressibleFinding,
} from "./domain/suppress"
export { LEARNING_MEMORY_TYPES } from "./domain/types"
export type {
  LearningEntry,
  LearningLifespanAnchor,
  LearningMemoryType,
  LearningPolarity,
  LearningScope,
  LearningSource,
  LearningSourceKind,
  LearningStore,
  LearningsMode,
} from "./domain/types"
export type { ExtractLearningArgs } from "./adapters/extractor-model"
export type { ExtractedLearning, ExtractionSurface } from "./domain/extractor"
