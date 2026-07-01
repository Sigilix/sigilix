export { emitLearningAudit } from "./adapters/audit"
export { hasRepoWriteAccess } from "./adapters/authz"
export {
  recordConfirmationMap,
  recordConfirmationMapForThread,
  resolveConfirmationMap,
} from "./adapters/confirmation-map"
export { extractLearning } from "./adapters/extractor-model"
export { appendLearning, forgetLearning, hardDeleteLearnings, loadLearnings } from "./adapters/store"
export { classifyLearningMemory } from "./domain/classify"
export type { ClassifiedLearningMemory, ClassifyLearningMemoryInput } from "./domain/classify"
export { parseLearningsCommand } from "./domain/command"
export { buildExtractionPrompt, parseExtraction } from "./domain/extractor"
export { resolveLearningsMode } from "./domain/mode"
export {
  renderBoostedCategoriesForPrompt,
  renderConfirmReply,
  renderForgetConfirm,
  renderLearningsForPrompt,
  renderOverviewFooter,
} from "./domain/render"
export {
  computeLearningId,
  learningsKey,
  normalizeRule,
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
