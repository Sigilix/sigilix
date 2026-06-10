// SIG-318 P2: re-export shim. `diff-positions` (a pure unified-diff →
// reviewable-position transform, zero deps) moved to `@/shared/util`. Re-exported
// here so existing importers compile unchanged; they migrate to
// `@/shared/util/diff-positions` as they relocate (or at the SIG-366 sweep).
export * from "@/src/shared/util/diff-positions"
