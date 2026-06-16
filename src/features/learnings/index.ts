export { emitLearningAudit } from "./adapters/audit"
export { hasRepoWriteAccess } from "./adapters/authz"
export { recordConfirmationMap, resolveConfirmationMap } from "./adapters/confirmation-map"
export { extractLearning } from "./adapters/extractor-model"
export { appendLearning, forgetLearning, hardDeleteLearnings, loadLearnings } from "./adapters/store"
export { parseLearningsCommand } from "./domain/command"
export { buildExtractionPrompt, parseExtraction } from "./domain/extractor"
export { resolveLearningsMode } from "./domain/mode"
export {
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
export type {
  LearningEntry,
  LearningPolarity,
  LearningScope,
  LearningSource,
  LearningSourceKind,
  LearningStore,
  LearningsMode,
} from "./domain/types"
export type { ExtractLearningArgs } from "./adapters/extractor-model"
export type { ExtractedLearning, ExtractionSurface } from "./domain/extractor"
