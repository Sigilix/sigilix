// SIG-318 P2: re-export shim. `validate-injection-taint` (SIG-292 injection/XSS
// taint-grounding detector, a pure security-analysis leaf) moved to
// `@/shared/domain`. Re-exported here so existing importers compile unchanged.
export * from "@/shared/domain/validate-injection-taint"
