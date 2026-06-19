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
  receiptScanIndex?: Map<string, ReceiptScanResult[]> | null
}): VerifyAndBuildArgs {
  const env = opts.env
  const ensembleConfig = parseEnsembleConfig(env)
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
