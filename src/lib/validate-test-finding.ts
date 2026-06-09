// SIG-385: moved to ensemble/domain/gates — re-export shim so existing importers
// (5 lib modules + the per-gate test suites) are unchanged.
export * from "./ensemble/domain/gates/validate-test-finding"
