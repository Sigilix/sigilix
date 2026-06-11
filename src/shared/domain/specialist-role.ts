// SIG-382: the four review-specialist roles, extracted to a pure shared/domain
// leaf so pure shared code (config-domain) — and any other consumer — can
// reference the role type without importing `ensemble-router` (a lib/feature
// module), which would invert the dependency rule. The canonical consumer
// (`ensemble-router`) re-exports these, so existing importers are unchanged.
//
// Leaf module: imports nothing.

export type SpecialistRole = "logic" | "security" | "performance" | "tests"

export const ALL_SPECIALISTS: readonly SpecialistRole[] = ["logic", "security", "performance", "tests"] as const
