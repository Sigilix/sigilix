// Shared fixtures for the validate-security-finding.*.test.ts sibling
// suites. Not a `*.test.ts` file, so vitest does not treat it as a suite
// (the vitest `include` glob is `src/**/*.test.ts`).

import type { PrReviewFinding } from "@/lib/triage-pr-review"
import type { SecurityFact } from "@/lib/security-evidence-manifest"

export function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/db.ts",
    line: 17,
    score: 4,
    category: "security",
    headline: "SQL injection in query builder",
    body: "User input is concatenated directly into the SQL string.",
    ...overrides,
  }
}

export function fact(overrides: Partial<SecurityFact> = {}): SecurityFact {
  return {
    evidenceId: "sarif:sql-injection:abc123abc123:17",
    tool: "sarif",
    path: "src/db.ts",
    line: 17,
    cwe: "CWE-89",
    summary: "Possible SQL injection at src/db.ts:17",
    ...overrides,
  }
}

export function manifestOf(...facts: SecurityFact[]): Map<string, SecurityFact> {
  const m = new Map<string, SecurityFact>()
  for (const f of facts) m.set(f.evidenceId, f)
  return m
}
