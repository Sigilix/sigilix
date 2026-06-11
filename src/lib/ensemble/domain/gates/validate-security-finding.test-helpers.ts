// Shared fixtures for the validate-security-finding.*.test.ts sibling
// suites. Not a `*.test.ts` file, so vitest does not treat it as a suite
// (the vitest `include` glob is `src/**/*.test.ts`).

import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { SecurityFact } from "@/src/lib/security-evidence-manifest"

// Allow tests to pass explicit `undefined` for any optional field (exercising
// the "field absent" path) under exactOptionalPropertyTypes. The builder strips
// the explicit `undefined`s so the result stays a valid object.
type FindingOverrides = { [K in keyof PrReviewFinding]?: PrReviewFinding[K] | undefined }
type FactOverrides = { [K in keyof SecurityFact]?: SecurityFact[K] | undefined }

function applyOverrides<T extends object>(base: T, overrides: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete (base as unknown as Record<string, unknown>)[key]
    else (base as unknown as Record<string, unknown>)[key] = value
  }
  return base
}

export function finding(overrides: FindingOverrides = {}): PrReviewFinding {
  const base: PrReviewFinding = {
    path: "src/db.ts",
    line: 17,
    score: 4,
    category: "security",
    headline: "SQL injection in query builder",
    body: "User input is concatenated directly into the SQL string.",
  }
  return applyOverrides(base, overrides)
}

export function fact(overrides: FactOverrides = {}): SecurityFact {
  const base: SecurityFact = {
    evidenceId: "sarif:sql-injection:abc123abc123:17",
    tool: "sarif",
    path: "src/db.ts",
    line: 17,
    cwe: "CWE-89",
    summary: "Possible SQL injection at src/db.ts:17",
  }
  return applyOverrides(base, overrides)
}

export function manifestOf(...facts: SecurityFact[]): Map<string, SecurityFact> {
  const m = new Map<string, SecurityFact>()
  for (const f of facts) m.set(f.evidenceId, f)
  return m
}
