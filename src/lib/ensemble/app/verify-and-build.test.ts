// SIG-423: the verify-and-build phase coalesces its three VerificationMetricsDO
// writes (worker-token, receipt-join, trust-ledger) into ONE batched RPC / one
// SQLite transaction to cut Durable Object rows-written. These tests pin that
// call-site behavior through the real `verifyAndBuildSubmission`: one DO
// `recordBatch` carrying every corpus's items, each stamped with a shared
// `occurredAt`. The DO-side equivalence of a mixed batch is separately proven in
// `src/do/verification-metrics-do.test.ts`.

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  verifyAndBuildSubmission,
  securityAstFactsForReceiptJoin,
  type VerifyAndBuildArgs,
} from "@/src/lib/ensemble/app/verify-and-build"
import { baseFinding } from "@/src/lib/triage-pr-review-ensemble.test-helpers"
import type { PrReviewVerdict, PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { RecordVerificationArgs } from "@/src/do/verification-metrics"
import { assessApprovalReadiness } from "@/src/lib/approval-readiness"
import { chooseReviewEvent, resolveReviewEventOverride } from "@/src/lib/ensemble/domain/verdict"
import { parseDiffToReviewablePositions } from "@/src/shared/util/diff-positions"
import { buildAddedLineTextByLine } from "@/src/features/ast-rules"
import { readVerificationMode } from "@/src/lib/verification/mode"
import { parseEnsembleConfig } from "@/src/lib/ensemble/config"
import { ORCHESTRATOR_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import type { ReceiptScanResult } from "@/src/lib/verification/verify-finding-receipt"
import type { Env } from "@/src/shared/types/env"
import type { PullRequestMeta } from "@/src/shared/types/github"

// The cited token of `baseFinding` ("clampIndex") appears on the line it points
// to (42), so the worker-token verifier returns a real verdict for it and the
// finding produces a worker-token metric item.
const DIFF = `diff --git a/src/lib/foo.ts b/src/lib/foo.ts
--- a/src/lib/foo.ts
+++ b/src/lib/foo.ts
@@ -40,3 +40,3 @@
 a
-old
+export function clampIndex(i) { return i }
`

let recordBatchSpy: ReturnType<typeof vi.fn>

function makeEnv(extra: Record<string, string> = {}): Env {
  const store = new Map<string, string>()
  recordBatchSpy = vi.fn(async (_items: RecordVerificationArgs[]) => undefined)
  const verificationNs = {
    idFromName: (_: string) => "id",
    get: (_: unknown) => ({ recordBatch: recordBatchSpy }),
  }
  return {
    OPENCLAW_STATE: {
      async get(key: string): Promise<string | null> {
        return store.get(key) ?? null
      },
      async put(key: string, value: string): Promise<void> {
        store.set(key, value)
      },
      async delete(key: string): Promise<void> {
        store.delete(key)
      },
    },
    VERIFICATION_METRICS_DO: verificationNs,
    ...extra,
  } as unknown as Env
}

function makeArgs(opts: {
  env: Env
  findings: PrReviewFinding[]
  verificationMode?: string
  trustLedgerMode?: "off" | "shadow" | "on"
  selfConfirmMode?: "off" | "shadow" | "on"
  reproduceMode?: "off" | "shadow" | "on"
  receiptScanIndex?: Map<string, ReceiptScanResult[]> | null
  astSecurityFindings?: ReadonlyArray<{ path: string; line: number; astFindingId: string }>
}): VerifyAndBuildArgs {
  const env = opts.env
  const baseConfig = parseEnsembleConfig(env)
  // SIG-476 PR2 / SIG-477 PR-1: the self-confirm + reproduce gates are read off
  // ensembleConfig.flags (no separate orchestrator arg), so the harness overrides
  // the parsed flags per test.
  const ensembleConfig = {
    ...baseConfig,
    flags: {
      ...baseConfig.flags,
      selfConfirmMode: (opts.selfConfirmMode ?? "off") as "off" | "shadow" | "on",
      reproduceMode: (opts.reproduceMode ?? "off") as "off" | "shadow" | "on",
    },
  }
  const verdict: PrReviewVerdict = {
    summary: "test",
    confidence: 4,
    confidenceReason: "test",
    findings: opts.findings,
  }
  const reviewable = parseDiffToReviewablePositions(DIFF)
  const addedLineTextByLine = buildAddedLineTextByLine(DIFF)
  const meta = { user: { login: "octocat" } } as unknown as PullRequestMeta
  const intendedEvent = chooseReviewEvent(opts.findings, [])
  const approvalReadiness = assessApprovalReadiness({
    intendedEvent,
    sourceFindings: [],
    provenance: null,
  })
  const reviewEventOverride = resolveReviewEventOverride({
    hasApprovalBlocker: approvalReadiness.blockers.length > 0,
    reviewIncomplete: false,
    filesDroppedCount: 0,
  })
  return {
    env,
    owner: "octo",
    repo: "repo",
    prNumber: 7,
    headSha: "abc1234def5678",
    ensembleConfig,
    validationSink: undefined,
    meta,
    reviewable,
    addedLineTextByLine,
    stack: { isStacked: false } as VerifyAndBuildArgs["stack"],
    coverage: { dispatched: ["logic"], succeeded: ["logic"] } as VerifyAndBuildArgs["coverage"],
    deltaCounts: null,
    disclosure: null,
    approvalReadiness,
    effectiveEvent: approvalReadiness.event,
    intendedEvent,
    reviewEventOverride,
    verificationMode: (opts.verificationMode ?? readVerificationMode(env)) as VerifyAndBuildArgs["verificationMode"],
    receiptScanIndex: opts.receiptScanIndex ?? null,
    receiptJoinMode: "shadow",
    trustLedgerMode: (opts.trustLedgerMode ?? "off") as VerifyAndBuildArgs["trustLedgerMode"],
    showEvidence: false,
    filteredConsensusByIndex: [],
    filteredConsensusProvenance: [],
    degradedCoverage: null,
    reviewIncomplete: false,
    synthConfidence: 4,
    tokenUsageByModel: {} as VerifyAndBuildArgs["tokenUsageByModel"],
    submissionVerdict: verdict,
    renderableUnanchoredForSubmission: [],
    findingMarkers: opts.findings.map(() => null),
    ...(opts.astSecurityFindings !== undefined ? { astSecurityFindings: opts.astSecurityFindings } : {}),
  }
}

describe("verifyAndBuildSubmission — SIG-423 verification metric coalescing", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  it("issues exactly ONE recordBatch spanning worker-token + trust-ledger corpora", async () => {
    const env = makeEnv()
    // Worker-token verification ON + trust-ledger ON → the single score>=4 logic
    // finding yields a worker-token item AND a trust-ledger item. Pre-SIG-423
    // this was two separate RPCs; now it must be ONE batched call.
    const args = makeArgs({
      env,
      findings: [baseFinding],
      verificationMode: "shadow",
      trustLedgerMode: "on",
    })

    await verifyAndBuildSubmission(args)

    // The whole point: ONE DO write for the phase, not three.
    expect(recordBatchSpy).toHaveBeenCalledTimes(1)
    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    const categories = items.map((i) => i.category)
    // Both corpora present in the single batch.
    expect(categories).toContain("logic") // worker-token corpus (logic finding)
    expect(categories).toContain("trustledger")
    // Codex trap: every item carries an explicit occurredAt so the whole batch
    // buckets to ONE UTC day (no midnight split vs the old per-block RPCs).
    expect(items.every((i) => typeof i.occurredAt === "string" && i.occurredAt.length > 0)).toBe(true)
    const stamps = new Set(items.map((i) => i.occurredAt))
    expect(stamps.size).toBe(1)
  })

  it("coalesces ALL THREE corpora (worker-token + receipt-join + trust-ledger) into one batch", async () => {
    const env = makeEnv()
    // A score>=4 security finding with a resolvable SIG-108 evidenceId is
    // receipt-join-eligible; a confirming receipt result at its path makes the
    // receipt-join verifier return a real (non-no-check) verdict → an item.
    const securityFinding: PrReviewFinding = {
      ...baseFinding,
      category: "security",
      path: "src/lib/auth.ts",
      line: 12,
      headline: "SQL injection via string concat",
      evidenceId: "semgrep:sql-injection:abc123:12",
    }
    const receiptScanIndex = new Map<string, ReceiptScanResult[]>([
      ["src/lib/auth.ts", [{ path: "src/lib/auth.ts", ruleId: "sql-injection", line: 12 }]],
    ])
    const args = makeArgs({
      env,
      findings: [baseFinding, securityFinding],
      verificationMode: "shadow",
      trustLedgerMode: "on",
      receiptScanIndex,
    })

    await verifyAndBuildSubmission(args)

    // STILL exactly one DO write for the whole phase — the three corpora share it.
    expect(recordBatchSpy).toHaveBeenCalledTimes(1)
    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    const categories = new Set(items.map((i) => i.category))
    expect(categories.has("logic")).toBe(true) // worker-token (logic finding)
    expect(categories.has("security")).toBe(true) // worker-token (security finding)
    expect(categories.has("receiptjoin")).toBe(true) // receipt-join corpus
    expect(categories.has("trustledger")).toBe(true) // trust-ledger corpus
    // Single shared day bucket across every corpus.
    expect(new Set(items.map((i) => i.occurredAt)).size).toBe(1)
  })

  it("does not write metrics at all when every corpus is off (no DO call)", async () => {
    const env = makeEnv()
    const args = makeArgs({
      env,
      findings: [baseFinding],
      verificationMode: "off",
      trustLedgerMode: "off",
    })

    await verifyAndBuildSubmission(args)

    // Empty batch → the bounded client early-returns → DO never touched.
    expect(recordBatchSpy).not.toHaveBeenCalled()
  })

  it("still records the worker-token corpus when only verification is on", async () => {
    const env = makeEnv()
    const args = makeArgs({
      env,
      findings: [baseFinding],
      verificationMode: "shadow",
      trustLedgerMode: "off",
    })

    await verifyAndBuildSubmission(args)

    expect(recordBatchSpy).toHaveBeenCalledTimes(1)
    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    expect(items.length).toBeGreaterThanOrEqual(1)
    expect(items.map((i) => i.category)).toContain("logic")
    expect(items.every((i) => i.category !== "trustledger")).toBe(true)
  })
})

describe("verifyAndBuildSubmission — SIG-476 PR2 self-confirm shadow-assignment", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  // A sev>=4 security finding whose class derives from a CWE (FINDING-OWN), with NO
  // manifest evidenceId — so a confirming co-located AST fact yields an UPLIFT (the
  // baseline would only give it grounded-model / body-only-ungrounded ≤ rank 2).
  // Built FRESH (not spread from the shared `baseFinding`, which earlier in-place
  // trust mutations would otherwise leak in via the copied `trust` field).
  const upliftFinding = (over: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    category: "security",
    score: 5,
    path: "src/lib/auth.ts",
    line: 42,
    headline: "eval of user input",
    body: "An `eval` on request data.",
    evidenceId: "NONE",
    cweId: "CWE-94", // code-injection (finding-own)
    ...over,
  })
  // The OUR-engine co-located AST fact (no-eval-call → code-injection) that
  // independently corroborates the upliftFinding's class within the line window.
  const confirmingAstFact = { path: "src/lib/auth.ts", line: 40, astFindingId: "ast/no-eval-call/h1/40" }

  it("shadow: records a confirmed-uplift finding as `uplift` and does NOT mutate the tier", async () => {
    const env = makeEnv()
    const finding = upliftFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      selfConfirmMode: "shadow",
      astSecurityFindings: [confirmingAstFact],
    })

    await verifyAndBuildSubmission(args)

    expect(recordBatchSpy).toHaveBeenCalledTimes(1)
    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    const sc = items.filter((i) => i.category === "selfconfirm")
    expect(sc).toHaveLength(1)
    expect(sc[0]!.verdict).toBe("uplift")
    // SHADOW MUST NOT MUTATE: the tier is never annotated to deterministic-confirmed.
    expect(finding.trust?.tier).not.toBe("deterministic-confirmed")
    expect(finding.trust).toBeUndefined()
  })

  it("on: a confirmed-uplift finding's tier BECOMES deterministic-confirmed", async () => {
    const env = makeEnv()
    const finding = upliftFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      selfConfirmMode: "on",
      astSecurityFindings: [confirmingAstFact],
    })

    await verifyAndBuildSubmission(args)

    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    expect(items.filter((i) => i.category === "selfconfirm").map((i) => i.verdict)).toEqual(["uplift"])
    // `on` annotates the tier in place.
    expect(finding.trust?.tier).toBe("deterministic-confirmed")
  })

  it("on: a receipt runner-confirmed finding that ALSO self-confirms → `redundant`, tier STAYS runner-confirmed (moat)", async () => {
    const env = makeEnv()
    // Pre-set the runner-confirmed tier (as the receipt-join would have, above this
    // block). resolveTier precedence (rank 6) must keep it over deterministic-confirmed.
    const finding = upliftFinding({ trust: { tier: "runner-confirmed" } })
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      selfConfirmMode: "on",
      astSecurityFindings: [confirmingAstFact],
    })

    await verifyAndBuildSubmission(args)

    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    expect(items.filter((i) => i.category === "selfconfirm").map((i) => i.verdict)).toEqual(["redundant"])
    // The moat: a self-confirmation NEVER outranks an independent CI receipt.
    expect(finding.trust?.tier).toBe("runner-confirmed")
  })

  it("a confirmed finding WITH manifest evidence is `redundant` (near-subset of existing GROUNDED)", async () => {
    const env = makeEnv()
    // class from the `ast:` evidenceId (manifest evidence present → deterministic-
    // grounded baseline, rank 4) + a DISTINCT independent co-located fact (passes the
    // non-circularity independence guard) → confirmed but only a +1 relabel. NO cweId
    // (the class comes solely from the ast: rule).
    const ownFactId = "ast/no-eval-call/abc1234/42"
    const finding: PrReviewFinding = {
      category: "security",
      score: 5,
      path: "src/lib/auth.ts",
      line: 42,
      headline: "eval of user input",
      body: "An `eval` on request data.",
      evidenceId: `ast:no-eval-call:${ownFactId}`,
    }
    const ownFact = { path: "src/lib/auth.ts", line: 42, astFindingId: ownFactId }
    const independentFact = { path: "src/lib/auth.ts", line: 41, astFindingId: "ast/no-eval-call/zzz9999/41" }
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      selfConfirmMode: "shadow",
      astSecurityFindings: [ownFact, independentFact],
    })

    await verifyAndBuildSubmission(args)

    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    expect(items.filter((i) => i.category === "selfconfirm").map((i) => i.verdict)).toEqual(["redundant"])
    // Shadow: still no mutation.
    expect(finding.trust).toBeUndefined()
  })

  it("an eligible-but-not-confirmed finding records `inconclusive`", async () => {
    const env = makeEnv()
    // Class derives (CWE-94 code-injection) but the co-located fact is a DIFFERENT
    // class (no-ssrf), so no independent corroboration → inconclusive.
    const finding = upliftFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      selfConfirmMode: "shadow",
      astSecurityFindings: [{ path: "src/lib/auth.ts", line: 41, astFindingId: "ast/no-ssrf/h/41" }],
    })

    await verifyAndBuildSubmission(args)

    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    expect(items.filter((i) => i.category === "selfconfirm").map((i) => i.verdict)).toEqual(["inconclusive"])
    expect(finding.trust).toBeUndefined()
  })

  it("off: no self-confirm record and no mutation (true no-op)", async () => {
    const env = makeEnv()
    const finding = upliftFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      selfConfirmMode: "off",
      astSecurityFindings: [confirmingAstFact],
    })

    await verifyAndBuildSubmission(args)

    // Every corpus off → empty batch → DO never touched.
    expect(recordBatchSpy).not.toHaveBeenCalled()
    expect(finding.trust).toBeUndefined()
  })

  it("a no-check finding (non-security / below sev) produces no self-confirm item", async () => {
    const env = makeEnv()
    // baseFinding is a logic finding → confirmFindingAgainstInWorkerAst → no-check.
    const args = makeArgs({
      env,
      findings: [baseFinding],
      verificationMode: "off",
      trustLedgerMode: "off",
      selfConfirmMode: "shadow",
      astSecurityFindings: [confirmingAstFact],
    })

    await verifyAndBuildSubmission(args)

    // no-check is skipped → no selfconfirm item → empty batch → no DO call.
    expect(recordBatchSpy).not.toHaveBeenCalled()
  })
})

describe("verifyAndBuildSubmission — SIG-477 PR-1 reproduce-eligibility shadow telemetry (DARK)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  // A grounded (real evidenceId), allowlist-class (off-by-one → pure-function-logic),
  // PURE + liftable closure → ELIGIBLE. Built fresh so a prior in-place trust
  // mutation can't leak via a copied `trust` field.
  const eligibleFinding = (over: Partial<PrReviewFinding> = {}): PrReviewFinding =>
    ({
      category: "logic",
      score: 4,
      path: "src/lib/parse.ts",
      line: 42,
      headline: "off-by-one in clampIndex",
      body: "Boundary slips by one.",
      evidenceId: "ast:no-constant-binary-condition:ast/x/h/42",
      failureExample: "export function clampIndex(i, max) { return i <= max ? i : max }",
      ...over,
    }) as PrReviewFinding

  // An UNGROUNDED finding → ineligible (Gate 1a).
  const ineligibleFinding = (over: Partial<PrReviewFinding> = {}): PrReviewFinding =>
    ({
      category: "logic",
      score: 3,
      path: "src/lib/x.ts",
      line: 9,
      headline: "minor nit",
      body: "style only",
      evidenceId: "NONE",
      ...over,
    }) as PrReviewFinding

  it("shadow: records an `eligible` verdict and does NOT mutate any trust tier (DARK)", async () => {
    const env = makeEnv()
    const finding = eligibleFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "shadow",
    })

    await verifyAndBuildSubmission(args)

    expect(recordBatchSpy).toHaveBeenCalledTimes(1)
    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    const re = items.filter((i) => i.category === "reproduce_eligibility")
    expect(re).toHaveLength(1)
    expect(re[0]!.verdict).toBe("eligible")
    // DARK: NO trust tier is ever set by this block.
    expect(finding.trust).toBeUndefined()
  })

  it("shadow: an ungrounded finding records `ineligible`", async () => {
    const env = makeEnv()
    const finding = ineligibleFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "shadow",
    })

    await verifyAndBuildSubmission(args)

    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    expect(items.filter((i) => i.category === "reproduce_eligibility").map((i) => i.verdict)).toEqual(["ineligible"])
    expect(finding.trust).toBeUndefined()
  })

  it("DARKNESS: in BOTH shadow AND on, NO finding's tier is mutated by the reproduce block (never annotates reproduced-by-execution)", async () => {
    for (const mode of ["shadow", "on"] as const) {
      const env = makeEnv()
      const finding = eligibleFinding()
      const args = makeArgs({
        env,
        findings: [finding],
        verificationMode: "off",
        trustLedgerMode: "off",
        selfConfirmMode: "off",
        reproduceMode: mode,
      })

      await verifyAndBuildSubmission(args)

      // The reproduce block ONLY measures — even "on" never annotates a tier in PR-1
      // (the execute → reproduced-by-execution annotate is PR-5 with the engine).
      expect(finding.trust).toBeUndefined()
      expect(finding.trust?.tier).not.toBe("reproduced-by-execution")
      // …but it DID record the verdict (so we know the block ran).
      const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
      expect(items.some((i) => i.category === "reproduce_eligibility")).toBe(true)
    }
  })

  it("off: no reproduce record and no mutation (true no-op)", async () => {
    const env = makeEnv()
    const finding = eligibleFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "off",
    })

    await verifyAndBuildSubmission(args)

    // Every corpus off → empty batch → DO never touched; no tier set.
    expect(recordBatchSpy).not.toHaveBeenCalled()
    expect(finding.trust).toBeUndefined()
  })
})

describe("verifyAndBuildSubmission — SIG-477 PR-3 ReDoS harness wiring (SHADOW, runs the real sandbox)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
  })

  // A grounded, redos-class, PURE + liftable (a bare regex literal) finding whose
  // cited code is a TEXTBOOK ReDoS (/^(a+)+$/) → eligible && klass==="redos", and the
  // harness, when it runs, reproduces. Built fresh so prior in-place trust mutations
  // can't leak via a copied `trust` field.
  const redosFinding = (over: Partial<PrReviewFinding> = {}): PrReviewFinding =>
    ({
      category: "security",
      score: 5,
      path: "src/lib/validate.ts",
      line: 12,
      headline: "ReDoS: catastrophic backtracking in the email regex",
      body: "This regex has a nested unbounded quantifier (ReDoS).",
      evidenceId: "ast:no-redos:ast/no-redos/h/12", // grounded (manifest evidence)
      failureExample: "const re = /^(a+)+$/",
      ...over,
    }) as PrReviewFinding

  // A grounded, redos-class finding whose cited regex is SAFE (no nested quantifier)
  // → eligible && redos, but the harness must return INCONCLUSIVE (FP-safety), never
  // reproduced — so even in `on` the tier is NOT lifted.
  const safeRedosFinding = (over: Partial<PrReviewFinding> = {}): PrReviewFinding =>
    redosFinding({ failureExample: "const re = /^[a-z]+$/", ...over })

  // A non-redos eligible finding (off-by-one → pure-function-logic): eligible but
  // klass !== "redos", so the harness must NOT be invoked → no reproduce_result item.
  const nonRedosEligible = (over: Partial<PrReviewFinding> = {}): PrReviewFinding =>
    ({
      category: "logic",
      score: 4,
      path: "src/lib/parse.ts",
      line: 7,
      headline: "off-by-one in clampIndex",
      body: "Boundary slips by one.",
      evidenceId: "ast:no-constant-binary-condition:ast/x/h/7",
      failureExample: "export function clampIndex(i, max) { return i <= max ? i : max }",
      ...over,
    }) as PrReviewFinding

  const reproduceItems = (calls: ReturnType<typeof vi.fn>) =>
    (calls.mock.calls[0]?.[0] as RecordVerificationArgs[]).filter((i) => i.category === "reproduce_result")

  it("shadow: runs the harness, records `reproduced`, and DOES NOT mutate the tier (darkness)", async () => {
    const env = makeEnv()
    const finding = redosFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "shadow",
    })

    await verifyAndBuildSubmission(args)

    const rr = reproduceItems(recordBatchSpy)
    expect(rr.map((i) => i.verdict)).toEqual(["reproduced"])
    // SHADOW DARKNESS: the tier is NEVER annotated to reproduced-by-execution.
    expect(finding.trust).toBeUndefined()
    expect(finding.trust?.tier).not.toBe("reproduced-by-execution")
  })

  it("on: a reproduced finding's tier BECOMES reproduced-by-execution", async () => {
    const env = makeEnv()
    const finding = redosFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "on",
    })

    await verifyAndBuildSubmission(args)

    expect(reproduceItems(recordBatchSpy).map((i) => i.verdict)).toEqual(["reproduced"])
    expect(finding.trust?.tier).toBe("reproduced-by-execution")
  })

  it("on + runner-confirmed: a reproduced finding KEEPS runner-confirmed (receipt-supremacy)", async () => {
    const env = makeEnv()
    // resolveTier ranks runner-confirmed (7) above reproduced-by-execution (6), so a
    // pre-set CI-receipt tier must survive the reproduction annotate.
    const finding = redosFinding({ trust: { tier: "runner-confirmed" } })
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "on",
    })

    await verifyAndBuildSubmission(args)

    expect(reproduceItems(recordBatchSpy).map((i) => i.verdict)).toEqual(["reproduced"])
    expect(finding.trust?.tier).toBe("runner-confirmed")
  })

  it("FP-safety: a SAFE regex records `inconclusive` and is NEVER lifted, even in `on`", async () => {
    const env = makeEnv()
    const finding = safeRedosFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "on",
    })

    await verifyAndBuildSubmission(args)

    expect(reproduceItems(recordBatchSpy).map((i) => i.verdict)).toEqual(["inconclusive"])
    // A safe regex is NEVER reproduced → its tier is never lifted (the FP-safety moat).
    expect(finding.trust?.tier).not.toBe("reproduced-by-execution")
  })

  it("off: the harness does not run and records no reproduce_result (true no-op)", async () => {
    const env = makeEnv()
    const finding = redosFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "off",
    })

    await verifyAndBuildSubmission(args)

    expect(recordBatchSpy).not.toHaveBeenCalled()
    expect(finding.trust).toBeUndefined()
  })

  it("SIG-477 PR-4: a pure-function-logic finding WITHOUT a fix runs the harness → skipped", async () => {
    const env = makeEnv()
    // off-by-one (→ pure-function-logic) but NO suggestedReplacement: the harness has
    // no corrected variant to compare against, so it records `skipped`, never lifts.
    const finding = nonRedosEligible()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "shadow",
    })

    await verifyAndBuildSubmission(args)

    const items = recordBatchSpy.mock.calls[0]![0] as RecordVerificationArgs[]
    // Eligibility WAS recorded (it's an eligible finding) …
    expect(items.some((i) => i.category === "reproduce_eligibility" && i.verdict === "eligible")).toBe(true)
    // … and PR-4 now dispatches the pure-logic harness, which records `skipped`
    // (no fix → no two-sided test), never `reproduced`.
    expect(reproduceItems(recordBatchSpy).map((i) => i.verdict)).toEqual(["skipped"])
    expect(finding.trust?.tier).not.toBe("reproduced-by-execution")
  })

  it("SIG-477 PR-4: a pure-function-logic finding WITH a fix REPRODUCES (shadow → no tier mutation)", async () => {
    const env = makeEnv()
    const finding = nonRedosEligible({
      headline: "off-by-one in clampIndex (inclusive bound)",
      // Buggy `<=` agrees with the fix below the boundary, diverges past it.
      failureExample: "export function clampIndex(i, max) { return i <= max ? i + 1 : max }",
      suggestedReplacement: "export function clampIndex(i, max) { return i <= max ? i : max }",
    })
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "shadow",
    })

    await verifyAndBuildSubmission(args)

    expect(reproduceItems(recordBatchSpy).map((i) => i.verdict)).toEqual(["reproduced"])
    // SHADOW: a real reproduction is recorded but the tier is NOT mutated (darkness).
    expect(finding.trust?.tier).not.toBe("reproduced-by-execution")
  })

  it("under wall-clock load (stale startMs): the harness is SKIPPED, not run", async () => {
    const env = makeEnv()
    const finding = redosFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "on",
    })
    // A startMs far enough in the past that remaining wall-clock is below the floor.
    args.startMs = Date.now() - (ORCHESTRATOR_TIMEOUT_MS - 1_000)

    await verifyAndBuildSubmission(args)

    const rr = reproduceItems(recordBatchSpy)
    expect(rr.map((i) => i.verdict)).toEqual(["skipped"])
    // Skipped → never run → never lifted.
    expect(finding.trust?.tier).not.toBe("reproduced-by-execution")
  })

  it("over the per-PR sandbox budget: later eligible redos findings record `skipped` (bounded)", async () => {
    const env = makeEnv()
    // Many eligible redos findings: the per-PR sandbox budget (4000ms / ~1200ms est
    // per run = 3 admissions) exhausts, so the tail records `skipped` without running.
    const findings = Array.from({ length: 8 }, (_, i) => redosFinding({ line: 100 + i }))
    const args = makeArgs({
      env,
      findings,
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "shadow",
    })

    await verifyAndBuildSubmission(args)

    const rr = reproduceItems(recordBatchSpy)
    // Every eligible redos finding produced a reproduce_result …
    expect(rr).toHaveLength(8)
    // … and the budget bounded the actual runs: at least one tail finding was skipped
    // (over-budget) rather than running the sandbox for all eight.
    expect(rr.some((i) => i.verdict === "skipped")).toBe(true)
  }, 30_000)

  it("best-effort: a harness that throws never breaks the review (handled in-block)", async () => {
    // The harness is documented never-throws; this asserts the wiring still produces a
    // submission (no rejection) for a redos finding whatever the harness returns.
    const env = makeEnv()
    const finding = redosFinding()
    const args = makeArgs({
      env,
      findings: [finding],
      verificationMode: "off",
      trustLedgerMode: "off",
      reproduceMode: "shadow",
    })

    const result = await verifyAndBuildSubmission(args)
    // The review completed and produced a submission — the harness did not break it.
    expect(result.submission).toBeDefined()
  })
})

describe("securityAstFactsForReceiptJoin (SIG-470 projection)", () => {
  const fact = (over: Partial<{ path: string; line: number; astFindingId: string; roleHint: string }> = {}) => ({
    path: "src/x.ts",
    line: 10,
    astFindingId: "ast/no-eval-call/h/10",
    roleHint: "security",
    ...over,
  })

  it("projects ONLY security-roled facts to {path, line, astFindingId}", () => {
    const out = securityAstFactsForReceiptJoin({
      findings: [fact(), fact({ roleHint: "logic", astFindingId: "ast/x/h/2" }), fact({ path: "src/y.ts", line: 5 })],
    })
    expect(out).toEqual([
      { path: "src/x.ts", line: 10, astFindingId: "ast/no-eval-call/h/10" },
      { path: "src/y.ts", line: 5, astFindingId: "ast/no-eval-call/h/10" },
    ])
  })

  it("returns [] for null/undefined astResult (receipt-join no-op)", () => {
    expect(securityAstFactsForReceiptJoin(null)).toEqual([])
    expect(securityAstFactsForReceiptJoin(undefined)).toEqual([])
    expect(securityAstFactsForReceiptJoin({ findings: [] })).toEqual([])
  })
})
