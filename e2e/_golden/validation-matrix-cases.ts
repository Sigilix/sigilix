// SIG-360 (PR 8, commit 1): behavior-pinning case list for the
// `validateForSubmission` golden matrix + the never-drop conservation
// property. PURE DATA — no Date.now / Math.random / network. Every fixture
// string is fixed so `encode(validateForSubmission(buildArgs()))` is
// deterministic run-to-run.
//
// Each case copies the SMALLEST triggering arrangement from the matching
// per-gate test (tests/validate-*.test.ts + the vFS describe in
// tests/triage-pr-review-ensemble.test.ts:492); we do not invent trigger
// conditions. The 13 gates are covered across {off, shadow, enforce} (each
// gate's ACTUAL mode union — five gates expose only {shadow, enforce}); plus
// a no-gates baseline, a multi-gate interaction case, and never-drop cases
// (P0/P1 findings that trigger gates under enforce and must survive).
//
// The matrix test (tests/validation-golden-matrix.test.ts) wraps every
// `on*Dropped` callback with a recorder before calling `validateForSubmission`,
// so the builders here only declare the NON-callback args; the callback arg
// NAMES the case wires are listed in `callbacks`.

import type { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { SecurityFact } from "@/src/lib/security-evidence-manifest"
import type { TestingEvidencePack } from "@/src/lib/testing-evidence-pack"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

/** The full vFS args object, minus the `on*Dropped` callbacks the test wraps. */
export type ValidateArgs = Omit<
  Parameters<typeof validateForSubmission>[0],
  | "onSecurityFindingDropped"
  | "onTestFindingDropped"
  | "onTestingFindingDropped"
  | "onLogicFindingDropped"
  | "onLogicRefutationFindingDropped"
  | "onLogicClaimRefutationFindingDropped"
  | "onRefutationSurvivalFindingDropped"
  | "onPerfFindingDropped"
  | "onInlineGroundingFindingDropped"
  | "onAbsenceFindingDropped"
  | "onWindowBlindnessFindingDropped"
  | "onSecurityGroundingFindingDropped"
  | "onSecurityUsageFindingDropped"
>

/** The names of the callback args the matrix test must wrap for a case. */
export type CallbackArg =
  | "onSecurityFindingDropped"
  | "onTestFindingDropped"
  | "onTestingFindingDropped"
  | "onLogicFindingDropped"
  | "onLogicRefutationFindingDropped"
  | "onLogicClaimRefutationFindingDropped"
  | "onRefutationSurvivalFindingDropped"
  | "onPerfFindingDropped"
  | "onInlineGroundingFindingDropped"
  | "onAbsenceFindingDropped"
  | "onWindowBlindnessFindingDropped"
  | "onSecurityGroundingFindingDropped"
  | "onSecurityUsageFindingDropped"

export interface MatrixCase {
  /** Stable fixture id → tests/_golden/validation-matrix/<id>.json. */
  id: string
  /** Which gate this case exercises (grouping / report only). */
  gate: string
  /** Builds the vFS args (callbacks wired by the test layer). */
  buildArgs: () => ValidateArgs
  /** The `on*Dropped` arg names the test wraps with a recorder for this case. */
  callbacks: CallbackArg[]
}

// The validator only reads `verdict.findings[].id` off specialistVerdicts to
// build the hallucination-guard valid-id set; the per-gate tests all mock it
// minimally and cast. One localized cast per builder mirrors that style.
type SpecialistVerdictsArg = Parameters<typeof validateForSubmission>[0]["specialistVerdicts"]

/** P0/P1/P2/P3 tier mapping — mirrors the (non-exported) god-file `severityTier`
 *  at src/lib/triage-pr-review-ensemble.ts (P0 >= 5, P1 === 4, P2 === 3, else P3). */
export function severityTierForScore(score: number): "P0" | "P1" | "P2" | "P3" {
  if (score >= 5) return "P0"
  if (score === 4) return "P1"
  if (score === 3) return "P2"
  return "P3"
}

// ── Shared minimal shapes ─────────────────────────────────────────────

function provenanceFor(
  count: number,
  role: "logic" | "security" | "performance" | "tests",
  sourceId: string,
): SynthesizerProvenance {
  return {
    findings: Array.from({ length: count }, () => ({
      sourceSpecialists: [role],
      sourceFindingIds: [sourceId],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    })),
    dropped: [],
    softened: [],
  }
}

function specialistVerdictsFor(
  role: "logic" | "security" | "performance" | "tests",
  id: string,
  extra?: Record<string, unknown>,
): SpecialistVerdictsArg {
  return [
    { role, verdict: { findings: [{ id, ...(extra ?? {}) }] } },
  ] as unknown as SpecialistVerdictsArg
}

function synthOutput(
  findings: PrReviewFinding[],
  provenance: SynthesizerProvenance,
): { verdict: { summary: string; confidence: number; confidenceReason: string; findings: PrReviewFinding[] }; provenance: SynthesizerProvenance } {
  return {
    verdict: { summary: "T", confidence: 3, confidenceReason: "R.", findings },
    provenance,
  }
}

// ── Gate-1: security (SIG-108) — shadow | enforce ─────────────────────

const SEC_PATH = "src/db.ts"
function securityFinding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: SEC_PATH,
    line: 17,
    score: 4,
    category: "security",
    headline: "SQL injection in query builder",
    body: "User input is concatenated directly into the SQL string.",
    ...overrides,
  }
}
function securityFact(overrides: Partial<SecurityFact> = {}): SecurityFact {
  return {
    evidenceId: "sarif:sql-injection:abc123abc123:17",
    tool: "sarif",
    path: SEC_PATH,
    line: 17,
    cwe: "CWE-89",
    summary: "Possible SQL injection at src/db.ts:17",
    ...overrides,
  }
}
function securityManifestOf(...facts: SecurityFact[]): Map<string, SecurityFact> {
  const m = new Map<string, SecurityFact>()
  for (const f of facts) m.set(f.evidenceId, f)
  return m
}
// A sev-4 security finding citing a FABRICATED evidenceId that doesn't resolve
// to the (real) manifest fact → SIG-108 flags it (fabricated-evidence-id).
function securityCase(mode: "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f = trigger
    ? securityFinding({ cweId: "CWE-89", evidenceId: "sarif:fake:000000000000:17" })
    : securityFinding({ cweId: "CWE-89", evidenceId: "sarif:sql-injection:abc123abc123:17" })
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "security", "security-0")),
    reviewable: new Map([[SEC_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("security", "security-0"),
    securityManifest: securityManifestOf(securityFact()),
    securityValidatorMode: mode,
    trustLedgerEnabled: true,
  }
}

// ── Gate-2: tests specificity (SIG-111) — shadow | enforce ────────────

const TEST_PATH = "src/lib/foo.ts"
function testsPack(overrides: Partial<TestingEvidencePack> = {}): TestingEvidencePack {
  return {
    sourceFilesChanged: [TEST_PATH],
    testFilesChanged: [],
    testFilesInPromptDiff: [],
    testFilesNotInPromptDiff: [],
    siblingMappings: [{ source: TEST_PATH, test: null }],
    inspectedTestFiles: [],
    helperCoverageBySource: {},
    ...overrides,
  }
}
// A sev-4 vague insufficient-test claim that cites a real inspected file but
// names no concrete API/branch → SIG-111 flags it (vague-insufficient-test).
function testsCase(mode: "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = trigger
    ? {
        path: TEST_PATH,
        line: 17,
        score: 4,
        category: "testing",
        headline: "Module needs more tests",
        body: "This module could use additional tests to improve coverage overall.",
        inspectedTestFiles: ["tests/retry.test.ts"],
      }
    : {
        path: TEST_PATH,
        line: 17,
        score: 4,
        category: "testing",
        headline: "New `parseConfig` export ships without tests",
        body: "The new `parseConfig` function has no sibling test file in this PR; its error path is untested.",
        evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"],
      }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "tests", "tests-0")),
    reviewable: new Map([[TEST_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("tests", "tests-0"),
    testingEvidence: testsPack({ inspectedTestFiles: ["tests/retry.test.ts"] }),
    testsValidatorMode: mode,
  }
}

// ── Gate-3: logic evidence (SIG-109) — shadow | enforce ───────────────

const LOGIC_PATH = "src/lib/scan.ts"
function logicEvidence(): { changedLineTextByPath: Map<string, string[]>; astLogicFindings: [] } {
  return {
    changedLineTextByPath: new Map([
      [LOGIC_PATH, ["  for (let i = 0; i <= arr.length; i++) {", "    total += arr[i]"]],
    ]),
    astLogicFindings: [],
  }
}
// A sev-4 vague logic claim with no concrete token on a changed line →
// SIG-109 flags it (unanchored-logic-claim).
function logicCase(mode: "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = trigger
    ? {
        path: LOGIC_PATH,
        line: 17,
        score: 4,
        category: "logic",
        headline: "This change could introduce subtle bugs",
        body: "The refactor here is risky and might break edge cases.",
      }
    : {
        path: LOGIC_PATH,
        line: 17,
        score: 4,
        category: "logic",
        headline: "`<= arr.length` reads one past the end of `arr`",
        body: "The loop guard uses `<=`, so the final iteration accesses `arr[arr.length]`.",
      }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "logic", "logic-0")),
    reviewable: new Map([[LOGIC_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("logic", "logic-0"),
    logicEvidence: logicEvidence(),
    logicValidatorMode: mode,
  }
}

// ── Gate-4: logic-refutation backstop (SIG-308) — off | shadow | enforce ──

// A sev-4 logic finding with no independentAssessment → SIG-308 flags it
// (logic-finding-missing-refutation-survival). logicEvidence omitted so the
// SIG-109 gate no-ops and this gate is exercised in isolation.
function logicRefutationCase(mode: "off" | "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = {
    path: LOGIC_PATH,
    line: 17,
    score: 4,
    category: "logic",
    headline: "`<= arr.length` reads one past the end of `arr`",
    body: "The loop guard uses `<=`, so the final iteration accesses `arr[arr.length]`.",
    ...(trigger ? {} : { independentAssessment: "No bound on `i`; the loop runs to arr.length inclusive with no guard." }),
  }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "logic", "logic-0")),
    reviewable: new Map([[LOGIC_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("logic", "logic-0"),
    logicRefutationMode: mode,
  }
}

// ── Gate-5: logic-claim refutation (SIG-328) — off | shadow | enforce ──

const AUTH_PATH = "src/middleware/auth.ts"
const AUTH_SOURCE = `export function requireAdmin(svc) {
  return async (req, res, next) => {
    if (!(await svc.isAdmin(req.user))) {
      return res.status(403).end()
    }
    next()
  }
}`
// A logic claim PROVABLY false against the cited AST (the guard returns before
// next()) → SIG-328 flags it (control-flow-claim-refuted-by-guard).
function logicClaimRefutationCase(mode: "off" | "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = trigger
    ? {
        path: AUTH_PATH,
        line: 6,
        score: 4,
        category: "logic",
        headline: "`next()` runs after 403 response, causing a double-response error",
        body: "When `svc.isAdmin(req.user)` returns false, the middleware sends `res.status(403).end()` and then calls `next()`.",
      }
    : {
        path: AUTH_PATH,
        line: 6,
        score: 4,
        category: "logic",
        headline: "consider naming `svc` more descriptively",
        body: "The `svc` parameter could be clearer.",
        independentAssessment: "Naming nit; no control-flow claim to refute.",
      }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "logic", "logic-0")),
    reviewable: new Map([[AUTH_PATH, [{ line: 6, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("logic", "logic-0"),
    logicClaimRefutationMode: mode,
    fullFileByPath: new Map([[AUTH_PATH, AUTH_SOURCE]]),
  }
}

// ── Gate-6: refutation-survival (SIG-325) — off | shadow | enforce ────

const NDJSON_PATH = "src/parse/ndjson.ts"
// A sev-4 self-originated security finding (evidenceId "NONE", no resolving
// manifest) lacking an independentAssessment → SIG-325 flags it
// (refutation-survival-missing) on the security lens.
function refutationSurvivalCase(mode: "off" | "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = {
    path: NDJSON_PATH,
    line: 17,
    score: 4,
    category: "security",
    headline: "SSRF via attacker-controlled Content-Type",
    body: "The decode path is driven by an attacker-controlled header.",
    cweId: "CWE-918",
    evidenceId: "NONE",
    ...(trigger
      ? {}
      : { independentAssessment: "source=req.query.url -> sink=fetch(url) -> type=string; no allowlist." }),
  }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "security", "security-0")),
    reviewable: new Map([[NDJSON_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("security", "security-0"),
    refutationSurvivalMode: mode,
    trustLedgerEnabled: true,
  }
}

// ── Gate-7: perf evidence (SIG-110) — shadow | enforce ────────────────

const PERF_PATH = "src/lib/orders.ts"
function perfEvidence(): { changedLineTextByPath: Map<string, string[]>; astPerfFindings: [] } {
  return {
    changedLineTextByPath: new Map([
      [PERF_PATH, ["  for (const r of rows) {", "    await db.query(r.id)"]],
    ]),
    astPerfFindings: [],
  }
}
// A vague sev-4 perf claim with no concrete token / field / AST hit →
// SIG-110 flags it (unanchored-perf-claim).
function perfCase(mode: "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = trigger
    ? {
        path: PERF_PATH,
        line: 17,
        score: 4,
        category: "performance",
        headline: "Performance could be improved",
        body: "This area is slow.",
      }
    : {
        path: PERF_PATH,
        line: 17,
        score: 4,
        category: "performance",
        headline: "N+1 query awaiting `db.query` for each item in `rows`",
        body: "The loop over `rows` awaits a query per iteration; batch it instead.",
        complexityEstimate: "O(n): one round-trip per item in `rows`",
      }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "performance", "performance-0")),
    reviewable: new Map([[PERF_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("performance", "performance-0"),
    perfEvidence: perfEvidence(),
    perfValidatorMode: mode,
  }
}

// ── Gate-8: inline-grounding (SIG-281 PR C) — shadow | enforce ────────

const INLINE_PATH = "src/lib/orders.ts"
const INLINE_ADDED = new Map([[INLINE_PATH, new Map([[17, "  const total = compute(items)"]])]])
// A score-2 ungrounded style nit (no fix/repro/evidence, no resolvable token) →
// SIG-281 PR C demotes it (ungrounded-inline-finding).
function inlineGroundingCase(mode: "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = trigger
    ? {
        path: INLINE_PATH,
        line: 17,
        score: 2,
        category: "style",
        headline: "naming is inconsistent here",
        body: "rename for clarity",
      }
    : {
        path: INLINE_PATH,
        line: 17,
        score: 2,
        category: "style",
        headline: "rename `compute` for clarity",
        body: "rename for clarity",
      }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "logic", "logic-0")),
    reviewable: new Map([[INLINE_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("logic", "logic-0"),
    addedLineTextByLine: INLINE_ADDED,
    inlineGroundingValidatorMode: mode,
  }
}

// ── Gate-9: absence-grounding (SIG-290) — off | shadow | enforce ──────

const ABSENCE_PATH = "src/lib/orders.ts"
const ABSENCE_ADDED = new Map([[ABSENCE_PATH, new Map([[17, "  return userInput.value"]])]])
// A non-testing absence-claim ("no null check") on a path DROPPED from the
// diff (the specialist never saw the content) → SIG-290 demotes it
// (absence-claim-ungrounded-by-truncation).
function absenceGroundingCase(mode: "off" | "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = {
    path: ABSENCE_PATH,
    line: 17,
    score: 3,
    category: "security",
    headline: "no null check on `userInput` before deref",
    body: "A null `userInput` would throw.",
  }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "security", "security-0")),
    reviewable: new Map([[ABSENCE_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("security", "security-0"),
    addedLineTextByLine: ABSENCE_ADDED,
    absenceClaimValidatorMode: mode,
    droppedPaths: trigger ? [ABSENCE_PATH] : [],
  }
}

// ── Gate-10: window-blindness — off | shadow | enforce ────────────────

const WB_PATH = "src/lib/fee.ts"
const WB_FULL_FILE = [
  "export function fee(amount: number): number {",
  "  const raw = amount",
  "  // compute",
  "  // setup",
  "  if (!Number.isFinite(amount)) return 0",
  "  // l6",
  "  // l7",
  "  // l8",
  "  // l9",
  "  // l10",
  "  // l11",
  "  // l12",
  "  // l13",
  "  // l14",
  "  // l15",
  "  // l16",
  "  return computeFee(amount)",
  "}",
].join("\n")
// A sev-5 logic positive-misread ("`amount` can be NaN") whose finite-guard on
// the SAME symbol lives upstream + out-of-window → demotes
// (positive-misread-guard-out-of-window).
function windowBlindnessCase(mode: "off" | "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = trigger
    ? {
        path: WB_PATH,
        line: 17,
        score: 5,
        category: "logic",
        headline: "`amount` can be NaN",
        body: "computeFee(amount) returns NaN; no finite check guards it.",
      }
    : {
        path: WB_PATH,
        line: 17,
        score: 5,
        category: "logic",
        headline: "rename for clarity",
        body: "the variable name could be clearer.",
      }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "logic", "logic-0")),
    reviewable: new Map([[WB_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("logic", "logic-0"),
    fullFileByPath: new Map([[WB_PATH, WB_FULL_FILE]]),
    windowBlindnessValidatorMode: mode,
  }
}

// ── Gate-11: security-grounding (SIG-293) — off | shadow | enforce ────

const SG_PATH = "src/lib/auth.ts"
const SG_CREDENTIAL_LINE = 'const apiKey = "AKIAIOSFODNN7EXAMPLE"'
const SG_CLEAN_LINE = "  console.log(payload.length)"
// A secrets-exposure finding (CWE-798) whose cited line holds no credential and
// no scanner fact corroborates it → SIG-293 demotes it
// (secrets-exposure-ungrounded-no-credential-token).
function securityGroundingCase(mode: "off" | "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = {
    path: SG_PATH,
    line: 17,
    score: 3,
    category: "security",
    cweId: "CWE-798",
    headline: "secret leaked via `payload`",
    body: "Looks like a credential is logged.",
  }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "security", "security-0")),
    reviewable: new Map([[SG_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("security", "security-0"),
    addedLineTextByLine: new Map([[SG_PATH, new Map([[17, trigger ? SG_CLEAN_LINE : SG_CREDENTIAL_LINE]])]]),
    securityGroundingValidatorMode: mode,
  }
}

// ── Gate-12: security-usage (SIG-311) — off | shadow | enforce ────────

const SU_PATH = "src/lib/ast-rules/scan-dynamic-html-sink.ts"
// A sev-5 injection finding on a detector path whose cited token is a mention,
// not a live sink → SIG-311 demotes it.
function securityUsageCase(mode: "off" | "shadow" | "enforce", trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = {
    path: SU_PATH,
    line: 10,
    score: 5,
    category: "security",
    cweId: "CWE-78",
    headline: "Command injection sink via shell interpolation in `exec`",
    body: "`re.exec(line)` executes attacker-controlled input as a shell command.",
  }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "security", "security-0")),
    reviewable: new Map([[SU_PATH, [{ line: 10, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("security", "security-0"),
    addedLineTextByLine: new Map([
      [SU_PATH, new Map([[10, trigger
        ? "  for (const re of HTML_WRITE_SINK_EXTRACTORS) { re.exec(line); }"
        : "  exec(userControlledCommand)"]])],
    ]),
    securityUsageValidatorMode: mode,
  }
}

// ── Gate-13: testing-citation (SIG-113, eTFC inside vFS) ──────────────
// Gated by the PRESENCE of testingEvidence (no mode enum); fires
// onTestingFindingDropped. A category:"testing" finding with no citation drops.

const TC_PATH = "src/lib/foo.ts"
function testingCitationPack(overrides: Partial<TestingEvidencePack> = {}): TestingEvidencePack {
  return {
    sourceFilesChanged: [TC_PATH],
    testFilesChanged: ["tests/foo.test.ts"],
    testFilesInPromptDiff: ["tests/foo.test.ts"],
    testFilesNotInPromptDiff: [],
    siblingMappings: [{ source: TC_PATH, test: "tests/foo.test.ts" }],
    inspectedTestFiles: ["tests/foo.test.ts"],
    helperCoverageBySource: {},
    ...overrides,
  }
}
// `trigger`: a category:"testing" finding citing NO evidence → dropped
// (no-citation). Non-trigger: a testing finding citing a real inspected file.
function testingCitationCase(trigger: boolean): ValidateArgs {
  const f: PrReviewFinding = trigger
    ? {
        path: TC_PATH,
        line: 2,
        score: 3,
        category: "testing",
        headline: "Module ships without tests",
        body: "There is no test for this new function.",
      }
    : {
        path: TC_PATH,
        line: 2,
        score: 3,
        category: "testing",
        headline: "Test for foo() doesn't cover the empty-input branch",
        body: "There is no test for this new function.",
        inspectedTestFiles: ["tests/foo.test.ts"],
      }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "tests", "tests-0")),
    reviewable: new Map([[TC_PATH, [{ line: 2, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("tests", "tests-0"),
    testingEvidence: testingCitationPack(),
  }
}

// ── Baseline + interaction + never-drop scenarios ─────────────────────

// No gates configured beyond defaults — a clean sev-4 logic finding on a
// reviewable line with valid provenance survives untouched.
function baselineCase(): ValidateArgs {
  const f: PrReviewFinding = {
    path: LOGIC_PATH,
    line: 17,
    score: 4,
    category: "logic",
    headline: "off-by-one in `clampIndex`",
    body: "Wrap with a bound check before indexing `arr`.",
  }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "logic", "logic-0")),
    reviewable: new Map([[LOGIC_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("logic", "logic-0"),
  }
}

// Multi-gate interaction: a vague-prefix score-3 nit (dropped by the vague
// filter) + an ungrounded score-2 nit (demoted by inline-grounding enforce) +
// a clean grounded sev-4 finding that survives. Exercises ordering + several
// counters in one call.
function multiGateCase(): ValidateArgs {
  const vague: PrReviewFinding = {
    path: INLINE_PATH,
    line: 17,
    score: 3,
    category: "logic",
    headline: "Consider renaming this",
    body: "rename for clarity",
  }
  const ungrounded: PrReviewFinding = {
    path: INLINE_PATH,
    line: 17,
    score: 2,
    category: "style",
    headline: "naming is inconsistent here",
    body: "rename for clarity",
  }
  const grounded: PrReviewFinding = {
    path: INLINE_PATH,
    line: 17,
    score: 4,
    category: "logic",
    headline: "off-by-one accessing `compute`",
    body: "the loop reads one past the end when calling `compute`.",
  }
  const provenance: SynthesizerProvenance = {
    findings: Array.from({ length: 3 }, () => ({
      sourceSpecialists: ["logic"],
      sourceFindingIds: ["logic-0"],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    })),
    dropped: [],
    softened: [],
  }
  return {
    synthOutput: synthOutput([vague, ungrounded, grounded], provenance),
    reviewable: new Map([[INLINE_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("logic", "logic-0"),
    addedLineTextByLine: INLINE_ADDED,
    inlineGroundingValidatorMode: "enforce",
  }
}

// ── The exported case list ────────────────────────────────────────────

export const MATRIX_CASES: MatrixCase[] = [
  // Gate 1: security (shadow | enforce) × trigger + neutral
  { id: "security-shadow-trigger", gate: "security", buildArgs: () => securityCase("shadow", true), callbacks: ["onSecurityFindingDropped"] },
  { id: "security-shadow-neutral", gate: "security", buildArgs: () => securityCase("shadow", false), callbacks: ["onSecurityFindingDropped"] },
  { id: "security-enforce-trigger", gate: "security", buildArgs: () => securityCase("enforce", true), callbacks: ["onSecurityFindingDropped"] },
  { id: "security-enforce-neutral", gate: "security", buildArgs: () => securityCase("enforce", false), callbacks: ["onSecurityFindingDropped"] },

  // Gate 2: tests specificity (shadow | enforce)
  { id: "tests-shadow-trigger", gate: "tests", buildArgs: () => testsCase("shadow", true), callbacks: ["onTestFindingDropped", "onTestingFindingDropped"] },
  { id: "tests-shadow-neutral", gate: "tests", buildArgs: () => testsCase("shadow", false), callbacks: ["onTestFindingDropped", "onTestingFindingDropped"] },
  { id: "tests-enforce-trigger", gate: "tests", buildArgs: () => testsCase("enforce", true), callbacks: ["onTestFindingDropped", "onTestingFindingDropped"] },
  { id: "tests-enforce-neutral", gate: "tests", buildArgs: () => testsCase("enforce", false), callbacks: ["onTestFindingDropped", "onTestingFindingDropped"] },

  // Gate 3: logic evidence (shadow | enforce)
  { id: "logic-shadow-trigger", gate: "logic", buildArgs: () => logicCase("shadow", true), callbacks: ["onLogicFindingDropped"] },
  { id: "logic-shadow-neutral", gate: "logic", buildArgs: () => logicCase("shadow", false), callbacks: ["onLogicFindingDropped"] },
  { id: "logic-enforce-trigger", gate: "logic", buildArgs: () => logicCase("enforce", true), callbacks: ["onLogicFindingDropped"] },
  { id: "logic-enforce-neutral", gate: "logic", buildArgs: () => logicCase("enforce", false), callbacks: ["onLogicFindingDropped"] },

  // Gate 4: logic-refutation (off | shadow | enforce)
  { id: "logic-refutation-off-trigger", gate: "logic-refutation", buildArgs: () => logicRefutationCase("off", true), callbacks: ["onLogicRefutationFindingDropped"] },
  { id: "logic-refutation-shadow-trigger", gate: "logic-refutation", buildArgs: () => logicRefutationCase("shadow", true), callbacks: ["onLogicRefutationFindingDropped"] },
  { id: "logic-refutation-shadow-neutral", gate: "logic-refutation", buildArgs: () => logicRefutationCase("shadow", false), callbacks: ["onLogicRefutationFindingDropped"] },
  { id: "logic-refutation-enforce-trigger", gate: "logic-refutation", buildArgs: () => logicRefutationCase("enforce", true), callbacks: ["onLogicRefutationFindingDropped"] },
  { id: "logic-refutation-enforce-neutral", gate: "logic-refutation", buildArgs: () => logicRefutationCase("enforce", false), callbacks: ["onLogicRefutationFindingDropped"] },

  // Gate 5: logic-claim refutation (off | shadow | enforce)
  { id: "logic-claim-refutation-off-trigger", gate: "logic-claim-refutation", buildArgs: () => logicClaimRefutationCase("off", true), callbacks: ["onLogicClaimRefutationFindingDropped"] },
  { id: "logic-claim-refutation-shadow-trigger", gate: "logic-claim-refutation", buildArgs: () => logicClaimRefutationCase("shadow", true), callbacks: ["onLogicClaimRefutationFindingDropped"] },
  { id: "logic-claim-refutation-shadow-neutral", gate: "logic-claim-refutation", buildArgs: () => logicClaimRefutationCase("shadow", false), callbacks: ["onLogicClaimRefutationFindingDropped"] },
  { id: "logic-claim-refutation-enforce-trigger", gate: "logic-claim-refutation", buildArgs: () => logicClaimRefutationCase("enforce", true), callbacks: ["onLogicClaimRefutationFindingDropped"] },
  { id: "logic-claim-refutation-enforce-neutral", gate: "logic-claim-refutation", buildArgs: () => logicClaimRefutationCase("enforce", false), callbacks: ["onLogicClaimRefutationFindingDropped"] },

  // Gate 6: refutation-survival (off | shadow | enforce)
  { id: "refutation-survival-off-trigger", gate: "refutation-survival", buildArgs: () => refutationSurvivalCase("off", true), callbacks: ["onRefutationSurvivalFindingDropped"] },
  { id: "refutation-survival-shadow-trigger", gate: "refutation-survival", buildArgs: () => refutationSurvivalCase("shadow", true), callbacks: ["onRefutationSurvivalFindingDropped"] },
  { id: "refutation-survival-shadow-neutral", gate: "refutation-survival", buildArgs: () => refutationSurvivalCase("shadow", false), callbacks: ["onRefutationSurvivalFindingDropped"] },
  { id: "refutation-survival-enforce-trigger", gate: "refutation-survival", buildArgs: () => refutationSurvivalCase("enforce", true), callbacks: ["onRefutationSurvivalFindingDropped"] },
  { id: "refutation-survival-enforce-neutral", gate: "refutation-survival", buildArgs: () => refutationSurvivalCase("enforce", false), callbacks: ["onRefutationSurvivalFindingDropped"] },

  // Gate 7: perf evidence (shadow | enforce)
  { id: "perf-shadow-trigger", gate: "perf", buildArgs: () => perfCase("shadow", true), callbacks: ["onPerfFindingDropped"] },
  { id: "perf-shadow-neutral", gate: "perf", buildArgs: () => perfCase("shadow", false), callbacks: ["onPerfFindingDropped"] },
  { id: "perf-enforce-trigger", gate: "perf", buildArgs: () => perfCase("enforce", true), callbacks: ["onPerfFindingDropped"] },
  { id: "perf-enforce-neutral", gate: "perf", buildArgs: () => perfCase("enforce", false), callbacks: ["onPerfFindingDropped"] },

  // Gate 8: inline-grounding (shadow | enforce)
  { id: "inline-grounding-shadow-trigger", gate: "inline-grounding", buildArgs: () => inlineGroundingCase("shadow", true), callbacks: ["onInlineGroundingFindingDropped"] },
  { id: "inline-grounding-shadow-neutral", gate: "inline-grounding", buildArgs: () => inlineGroundingCase("shadow", false), callbacks: ["onInlineGroundingFindingDropped"] },
  { id: "inline-grounding-enforce-trigger", gate: "inline-grounding", buildArgs: () => inlineGroundingCase("enforce", true), callbacks: ["onInlineGroundingFindingDropped"] },
  { id: "inline-grounding-enforce-neutral", gate: "inline-grounding", buildArgs: () => inlineGroundingCase("enforce", false), callbacks: ["onInlineGroundingFindingDropped"] },

  // Gate 9: absence-grounding (off | shadow | enforce)
  { id: "absence-grounding-off-trigger", gate: "absence-grounding", buildArgs: () => absenceGroundingCase("off", true), callbacks: ["onAbsenceFindingDropped"] },
  { id: "absence-grounding-shadow-trigger", gate: "absence-grounding", buildArgs: () => absenceGroundingCase("shadow", true), callbacks: ["onAbsenceFindingDropped"] },
  { id: "absence-grounding-shadow-neutral", gate: "absence-grounding", buildArgs: () => absenceGroundingCase("shadow", false), callbacks: ["onAbsenceFindingDropped"] },
  { id: "absence-grounding-enforce-trigger", gate: "absence-grounding", buildArgs: () => absenceGroundingCase("enforce", true), callbacks: ["onAbsenceFindingDropped"] },
  { id: "absence-grounding-enforce-neutral", gate: "absence-grounding", buildArgs: () => absenceGroundingCase("enforce", false), callbacks: ["onAbsenceFindingDropped"] },

  // Gate 10: window-blindness (off | shadow | enforce)
  { id: "window-blindness-off-trigger", gate: "window-blindness", buildArgs: () => windowBlindnessCase("off", true), callbacks: ["onWindowBlindnessFindingDropped"] },
  { id: "window-blindness-shadow-trigger", gate: "window-blindness", buildArgs: () => windowBlindnessCase("shadow", true), callbacks: ["onWindowBlindnessFindingDropped"] },
  { id: "window-blindness-shadow-neutral", gate: "window-blindness", buildArgs: () => windowBlindnessCase("shadow", false), callbacks: ["onWindowBlindnessFindingDropped"] },
  { id: "window-blindness-enforce-trigger", gate: "window-blindness", buildArgs: () => windowBlindnessCase("enforce", true), callbacks: ["onWindowBlindnessFindingDropped"] },
  { id: "window-blindness-enforce-neutral", gate: "window-blindness", buildArgs: () => windowBlindnessCase("enforce", false), callbacks: ["onWindowBlindnessFindingDropped"] },

  // Gate 11: security-grounding (off | shadow | enforce)
  { id: "security-grounding-off-trigger", gate: "security-grounding", buildArgs: () => securityGroundingCase("off", true), callbacks: ["onSecurityGroundingFindingDropped"] },
  { id: "security-grounding-shadow-trigger", gate: "security-grounding", buildArgs: () => securityGroundingCase("shadow", true), callbacks: ["onSecurityGroundingFindingDropped"] },
  { id: "security-grounding-shadow-neutral", gate: "security-grounding", buildArgs: () => securityGroundingCase("shadow", false), callbacks: ["onSecurityGroundingFindingDropped"] },
  { id: "security-grounding-enforce-trigger", gate: "security-grounding", buildArgs: () => securityGroundingCase("enforce", true), callbacks: ["onSecurityGroundingFindingDropped"] },
  { id: "security-grounding-enforce-neutral", gate: "security-grounding", buildArgs: () => securityGroundingCase("enforce", false), callbacks: ["onSecurityGroundingFindingDropped"] },

  // Gate 12: security-usage (off | shadow | enforce)
  { id: "security-usage-off-trigger", gate: "security-usage", buildArgs: () => securityUsageCase("off", true), callbacks: ["onSecurityUsageFindingDropped"] },
  { id: "security-usage-shadow-trigger", gate: "security-usage", buildArgs: () => securityUsageCase("shadow", true), callbacks: ["onSecurityUsageFindingDropped"] },
  { id: "security-usage-shadow-neutral", gate: "security-usage", buildArgs: () => securityUsageCase("shadow", false), callbacks: ["onSecurityUsageFindingDropped"] },
  { id: "security-usage-enforce-trigger", gate: "security-usage", buildArgs: () => securityUsageCase("enforce", true), callbacks: ["onSecurityUsageFindingDropped"] },
  { id: "security-usage-enforce-neutral", gate: "security-usage", buildArgs: () => securityUsageCase("enforce", false), callbacks: ["onSecurityUsageFindingDropped"] },

  // Gate 13: testing-citation (presence-gated, no mode enum)
  { id: "testing-citation-trigger", gate: "testing-citation", buildArgs: () => testingCitationCase(true), callbacks: ["onTestingFindingDropped", "onTestFindingDropped"] },
  { id: "testing-citation-neutral", gate: "testing-citation", buildArgs: () => testingCitationCase(false), callbacks: ["onTestingFindingDropped", "onTestFindingDropped"] },

  // Baseline + interaction
  { id: "baseline-no-gates", gate: "baseline", buildArgs: () => baselineCase(), callbacks: [] },
  { id: "multi-gate-interaction", gate: "interaction", buildArgs: () => multiGateCase(), callbacks: ["onInlineGroundingFindingDropped"] },

  // Never-drop: P0/P1 findings that TRIGGER a gate under enforce must survive
  // (inline or body-demoted, never absent). These are the recall-safety pins.
  { id: "never-drop-p1-inline-grounding-enforce", gate: "never-drop", buildArgs: () => inlineGroundingNeverDropP1(), callbacks: ["onInlineGroundingFindingDropped"] },
  { id: "never-drop-p0-window-blindness-enforce", gate: "never-drop", buildArgs: () => windowBlindnessCase("enforce", true), callbacks: ["onWindowBlindnessFindingDropped"] },
  { id: "never-drop-p1-security-enforce", gate: "never-drop", buildArgs: () => securityCase("enforce", true), callbacks: ["onSecurityFindingDropped"] },
  { id: "never-drop-p1-refutation-survival-enforce", gate: "never-drop", buildArgs: () => refutationSurvivalCase("enforce", true), callbacks: ["onRefutationSurvivalFindingDropped"] },
  { id: "never-drop-p1-absence-grounding-enforce", gate: "never-drop", buildArgs: () => absenceGroundingNeverDropP1(), callbacks: ["onAbsenceFindingDropped"] },
]

// A P1 (score-4) ungrounded inline finding under enforce: the inline-grounding
// gate's believability floor NEVER demotes score>=4, so this P1 stays inline.
function inlineGroundingNeverDropP1(): ValidateArgs {
  const f: PrReviewFinding = {
    path: INLINE_PATH,
    line: 17,
    score: 4,
    category: "logic",
    headline: "naming is inconsistent here",
    body: "rename for clarity",
  }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "logic", "logic-0")),
    reviewable: new Map([[INLINE_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("logic", "logic-0"),
    addedLineTextByLine: INLINE_ADDED,
    inlineGroundingValidatorMode: "enforce",
  }
}

// A P1 (score-4) ungrounded absence-claim under enforce: absence-grounding has
// NO score floor, so this P1 is demoted to the body (NOT dropped) — it must
// still appear in unanchoredFindings.
function absenceGroundingNeverDropP1(): ValidateArgs {
  const f: PrReviewFinding = {
    path: ABSENCE_PATH,
    line: 17,
    score: 4,
    category: "security",
    headline: "no null check on `userInput` before deref",
    body: "A null `userInput` would throw.",
  }
  return {
    synthOutput: synthOutput([f], provenanceFor(1, "security", "security-0")),
    reviewable: new Map([[ABSENCE_PATH, [{ line: 17, side: "RIGHT", position: 1 }]]]) as ReviewableMap,
    specialistVerdicts: specialistVerdictsFor("security", "security-0"),
    addedLineTextByLine: ABSENCE_ADDED,
    absenceClaimValidatorMode: "enforce",
    droppedPaths: [ABSENCE_PATH],
  }
}
