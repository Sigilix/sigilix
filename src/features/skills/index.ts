// SIG-561 — governed guidance-only skills. Cross-feature callers import from
// this narrow barrel; instruction content cannot grant a runtime capability.
export {
  GOVERNED_SKILL_CATALOG,
  SKILL_SURFACES,
  governedSkillById,
  type GovernedSkillManifest,
  type SkillSurface,
} from "./domain/catalog"
export {
  applySkillGuidance,
  disabledSkillSurfaces,
  parseSkillSurfacePolicy,
  publicSkillManifest,
  renderSkillProvenanceNote,
  resolveGovernedSkill,
  validateRequestedSkillPolicy,
  type ResolvedSkillContext,
  type StoredSkillPolicy,
} from "./domain/policy"
export {
  configureSkillPolicy,
  readSkillPolicies,
  revokeSkillPolicy,
  type SkillPolicyReadResult,
  type SkillPolicyWriteResult,
} from "./adapters/d1-skill-policy-store"
export { resolveRuntimeSkill, type RuntimeSkillResult } from "./adapters/runtime"
