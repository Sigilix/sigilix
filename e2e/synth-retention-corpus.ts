// SIG-350 synthesizer-retention corpus + oracle.
//
// This is deliberately not a loose keyword benchmark. Each case defines
// source finding IDs that must survive or must be filtered, and the scorer
// checks provenance, path/line/category, required diagnosis tokens, severity,
// and distinct-bug collapse.

import type { FindingCategory, PrReviewFinding, PrReviewVerdict } from "@/src/lib/triage-pr-review"
import type { SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import type { SpecialistRole } from "@/src/lib/ensemble-router"
import { applySynthSourceFindingFloor } from "@/src/lib/degraded-finding-floor"

export interface SynthSourceFinding extends PrReviewFinding {
  id: string
}

export interface SynthSourceVerdict {
  role: SpecialistRole
  verdict: Omit<PrReviewVerdict, "findings"> & { findings: SynthSourceFinding[] }
}

export interface SynthExpectedKeep {
  /** Distinct product bug identity. Different bugIds may not share one output finding. */
  bugId: string
  /** Set only when one customer-facing finding is allowed to represent this bug alongside others. */
  allowCombination?: boolean
  sourceFindingId: string
  path: string
  targetLine: number
  minScore: number
  /** Optional when the source role is not the final customer-facing category. */
  category?: FindingCategory
  /** Tokens that must appear in the synthesized finding text to avoid vague keyword matches. */
  requiredTokens: readonly string[]
}

export interface SynthExpectedDrop {
  sourceFindingId: string
  reason: "false-positive" | "duplicate" | "advisory"
}

export interface SynthRetentionCase {
  id: string
  title: string
  diff: string
  note: string
  specialistVerdicts: readonly SynthSourceVerdict[]
  mustKeep: readonly SynthExpectedKeep[]
  mustDrop: readonly SynthExpectedDrop[]
}

export interface SynthRetentionOutput {
  verdict: PrReviewVerdict
  provenance: SynthesizerProvenance
  elapsedMs: number
  modelUsed: string
  failureReason?: string
}

export interface SynthRetentionCaseScore {
  id: string
  totalMustKeep: number
  retained: number
  recall: number
  totalMustDrop: number
  falsePositivesKept: number
  fpFilteringRate: number
  unsupportedFindings: number
  misattributedFindings: number
  hallucinated: boolean
  severityDriftSourceIds: string[]
  misdiagnosedSourceIds: string[]
  missedSourceIds: string[]
  duplicateCollapses: number
  precision: number
  elapsedMs: number
  modelUsed: string
  failureReason?: string
}

export interface SynthRetentionSummary {
  cases: number
  recall: number
  fpFilteringRate: number
  hallucinationRate: number
  severityDrift: number
  misattributions: number
  duplicateCollapses: number
  precision: number
  p95ElapsedMs: number
  errors: number
}

const WINDOW = 3

function finding(
  id: string,
  overrides: Partial<PrReviewFinding> &
    Pick<PrReviewFinding, "path" | "line" | "score" | "category" | "headline" | "body">,
): SynthSourceFinding {
  return {
    scope: "line",
    ...overrides,
    id,
  }
}

function verdict(summary: string, findings: SynthSourceFinding[]): SynthSourceVerdict["verdict"] {
  return {
    summary,
    confidence: 4,
    confidenceReason: findings.length > 0 ? "Source verdict for synth eval." : "No issues in this role.",
    findings,
  }
}

function samePath(found: string, expected: string): boolean {
  const norm = (p: string): string => p.replace(/^[ab]\//, "")
  const f = norm(found)
  const e = norm(expected)
  return f === e || f.endsWith("/" + e) || e.endsWith("/" + f)
}

function diagnosticTextOf(f: PrReviewFinding): string {
  return [f.headline, f.body, f.failureExample, f.fixExample, f.testGap]
    .filter((v): v is string => typeof v === "string")
    .join("\n")
    .toLowerCase()
}

function knownSourceIds(c: SynthRetentionCase): Set<string> {
  return new Set(c.specialistVerdicts.flatMap((v) => v.verdict.findings.map((f) => f.id)))
}

/**
 * Mirror the post-synth product gates that materially affect the retention
 * oracle: SIG-351 source-floor restoration plus the provenance hallucination
 * guard. The full Worker path runs additional validators/anchor gates, but the
 * retention corpus is source-ID based; this keeps the live K runs measuring the
 * customer-visible review signal rather than raw synth bookkeeping mistakes.
 */
export function applySynthRetentionProductGates(
  c: SynthRetentionCase,
  output: SynthRetentionOutput,
): SynthRetentionOutput {
  const knownIds = knownSourceIds(c)
  const floored = applySynthSourceFindingFloor({
    findings: output.verdict.findings,
    provenanceFindings: output.provenance.findings,
    provenanceDropped: output.provenance.dropped,
    specialists: c.specialistVerdicts.map((v) => ({ role: v.role, findings: v.verdict.findings })),
  })
  const findings: PrReviewFinding[] = []
  const provenanceFindings: SynthesizerProvenance["findings"] = []
  for (let i = 0; i < floored.findings.length; i++) {
    const provenance = floored.provenanceFindings[i]
    if (!provenance) continue
    const sourceIds = provenance.sourceFindingIds
    if (sourceIds.length === 0) continue
    if (!sourceIds.every((id) => knownIds.has(id))) continue
    findings.push(floored.findings[i]!)
    provenanceFindings.push(provenance)
  }

  return {
    ...output,
    verdict: { ...output.verdict, findings },
    provenance: { ...output.provenance, findings: provenanceFindings },
  }
}

function validateSynthRetentionCase(c: SynthRetentionCase): void {
  for (const keep of c.mustKeep) {
    if (keep.requiredTokens.length === 0) {
      throw new Error(`Synth retention case ${c.id} mustKeep ${keep.sourceFindingId} has empty requiredTokens`)
    }
  }
}

function sourceIdsAt(output: SynthRetentionOutput, index: number): readonly string[] {
  return output.provenance.findings[index]?.sourceFindingIds ?? []
}

function outputSupportsExpected(finding: PrReviewFinding, expected: SynthExpectedKeep): boolean {
  if (!samePath(finding.path, expected.path)) return false
  if (Math.abs(finding.line - expected.targetLine) > WINDOW) return false
  if (expected.category !== undefined && finding.category !== expected.category) return false
  const text = diagnosticTextOf(finding)
  return expected.requiredTokens.every((token) => text.includes(token.toLowerCase()))
}

export function scoreSynthRetentionCase(c: SynthRetentionCase, output: SynthRetentionOutput): SynthRetentionCaseScore {
  validateSynthRetentionCase(c)
  const knownIds = knownSourceIds(c)
  const outputRows = output.verdict.findings.map((finding, index) => ({
    finding,
    index,
    sourceIds: sourceIdsAt(output, index),
  }))

  const unsupportedOutputIndexes = new Set<number>()
  for (const row of outputRows) {
    if (row.sourceIds.length === 0 || row.sourceIds.some((id) => !knownIds.has(id))) {
      unsupportedOutputIndexes.add(row.index)
    }
  }

  const falsePositivesKept = c.mustDrop.filter((drop) =>
    outputRows.some((row) => row.sourceIds.includes(drop.sourceFindingId) && row.finding.score >= 2),
  ).length

  const severityDriftSourceIds: string[] = []
  const misdiagnosedSourceIds: string[] = []
  const missedSourceIds: string[] = []
  const misattributedOutputIndexes = new Set<number>()
  const candidates: Array<{ expected: SynthExpectedKeep; outputIndex: number }> = []

  for (const expected of c.mustKeep) {
    const matchingRows = outputRows.filter((row) => row.sourceIds.includes(expected.sourceFindingId))
    if (matchingRows.length === 0) {
      missedSourceIds.push(expected.sourceFindingId)
      continue
    }
    const row = matchingRows[0]!
    if (row.finding.score < expected.minScore) {
      severityDriftSourceIds.push(expected.sourceFindingId)
      missedSourceIds.push(expected.sourceFindingId)
      continue
    }
    if (!outputSupportsExpected(row.finding, expected)) {
      misdiagnosedSourceIds.push(expected.sourceFindingId)
      missedSourceIds.push(expected.sourceFindingId)
      unsupportedOutputIndexes.add(row.index)
      misattributedOutputIndexes.add(row.index)
      continue
    }
    candidates.push({ expected, outputIndex: row.index })
  }

  let retained = 0
  let duplicateCollapses = 0
  const byOutput = new Map<number, Array<{ expected: SynthExpectedKeep; outputIndex: number }>>()
  for (const candidate of candidates) {
    const group = byOutput.get(candidate.outputIndex) ?? []
    group.push(candidate)
    byOutput.set(candidate.outputIndex, group)
  }
  for (const group of byOutput.values()) {
    const bugIds = new Set(group.map((g) => g.expected.bugId))
    if (bugIds.size <= 1) {
      retained += group.length
      continue
    }
    if (group.every((g) => g.expected.allowCombination === true)) {
      retained += group.length
      continue
    }
    duplicateCollapses += bugIds.size - 1
    retained += 1
    for (const g of group.slice(1)) {
      missedSourceIds.push(g.expected.sourceFindingId)
    }
  }

  const totalMustKeep = c.mustKeep.length
  const totalMustDrop = c.mustDrop.length
  const unsupportedFindings = unsupportedOutputIndexes.size
  const misattributedFindings = misattributedOutputIndexes.size
  const badPositiveCount = falsePositivesKept + unsupportedFindings
  const precisionDenominator = retained + badPositiveCount

  return {
    id: c.id,
    totalMustKeep,
    retained,
    recall: totalMustKeep > 0 ? retained / totalMustKeep : 1,
    totalMustDrop,
    falsePositivesKept,
    fpFilteringRate: totalMustDrop > 0 ? (totalMustDrop - falsePositivesKept) / totalMustDrop : 1,
    unsupportedFindings,
    misattributedFindings,
    hallucinated: unsupportedFindings > 0,
    severityDriftSourceIds,
    misdiagnosedSourceIds,
    missedSourceIds: [...new Set(missedSourceIds)],
    duplicateCollapses,
    precision: precisionDenominator > 0 ? retained / precisionDenominator : 1,
    elapsedMs: output.elapsedMs,
    modelUsed: output.modelUsed,
    ...(output.failureReason !== undefined ? { failureReason: output.failureReason } : {}),
  }
}

export function summarizeSynthRetentionResults(results: readonly SynthRetentionCaseScore[]): SynthRetentionSummary {
  const sum = (pick: (r: SynthRetentionCaseScore) => number): number => results.reduce((total, r) => total + pick(r), 0)
  const elapsed = results.map((r) => r.elapsedMs).sort((a, b) => a - b)
  const p95Index = elapsed.length === 0 ? -1 : Math.min(elapsed.length - 1, Math.ceil(elapsed.length * 0.95) - 1)
  const totalMustKeep = sum((r) => r.totalMustKeep)
  const totalMustDrop = sum((r) => r.totalMustDrop)
  const totalPrecisionDenominator = sum((r) => r.retained + r.falsePositivesKept + r.unsupportedFindings)
  return {
    cases: results.length,
    recall: totalMustKeep > 0 ? sum((r) => r.retained) / totalMustKeep : 1,
    fpFilteringRate: totalMustDrop > 0 ? (totalMustDrop - sum((r) => r.falsePositivesKept)) / totalMustDrop : 1,
    hallucinationRate: results.length > 0 ? results.filter((r) => r.hallucinated).length / results.length : 0,
    severityDrift: sum((r) => r.severityDriftSourceIds.length),
    misattributions: sum((r) => r.misattributedFindings),
    duplicateCollapses: sum((r) => r.duplicateCollapses),
    precision: totalPrecisionDenominator > 0 ? sum((r) => r.retained) / totalPrecisionDenominator : 1,
    p95ElapsedMs: p95Index >= 0 ? elapsed[p95Index]! : 0,
    errors: results.filter((r) => r.failureReason !== undefined).length,
  }
}

export function formatSynthRetentionSummary(summary: SynthRetentionSummary): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
  return [
    `SYNTH RETENTION - ${summary.cases} scored case(s)`,
    `recall ${pct(summary.recall)}  FP-filter ${pct(summary.fpFilteringRate)}  hallucination-case-rate ${pct(summary.hallucinationRate)}  precision ${pct(summary.precision)}`,
    `severity-drift ${summary.severityDrift}  misattributions ${summary.misattributions}  duplicate-collapses ${summary.duplicateCollapses}  p95 ${summary.p95ElapsedMs}ms${summary.errors ? `  errors ${summary.errors}` : ""}`,
  ].join("\n")
}

function buildDistinctBugCollisionCase(): SynthRetentionCase {
  const path = "src/checkout.ts"
  return {
    id: "distinct-bugs-same-file",
    title: "Checkout carries two distinct same-file failures",
    note: "A synth must not merge unrelated bugs just because they share a hot checkout file.",
    diff: `diff --git a/src/checkout.ts b/src/checkout.ts
--- a/src/checkout.ts
+++ b/src/checkout.ts
@@ -1,6 +1,12 @@
 export async function checkout(cart: Cart, token: string) {
+  if (await seenToken(token)) return { ok: true }
+  const order = await createOrder(cart)
+  await charge(order)
+  await markTokenSeen(token)
+  return order
 }
`,
    specialistVerdicts: [
      {
        role: "logic",
        verdict: verdict("Inventory is not reserved.", [
          finding("logic-0", {
            path,
            line: 5,
            score: 4,
            category: "logic",
            headline: "`checkout` charges before reserving inventory",
            body: "The new flow calls `charge(order)` but never calls `reserveInventory`, so two checkouts can sell the same item.",
          }),
        ]),
      },
      {
        role: "performance",
        verdict: verdict("Idempotency is marked too late.", [
          finding("performance-0", {
            path,
            line: 2,
            score: 4,
            category: "logic",
            headline: "`checkout` has a race in idempotency handling",
            body: "The `seenToken` check happens before `markTokenSeen`, so concurrent retries with the same token can double-charge.",
          }),
        ]),
      },
    ],
    mustKeep: [
      {
        bugId: "inventory-reservation",
        sourceFindingId: "logic-0",
        path,
        targetLine: 5,
        minScore: 4,
        requiredTokens: ["reserveInventory"],
      },
      {
        bugId: "idempotency-race",
        sourceFindingId: "performance-0",
        path,
        targetLine: 5,
        minScore: 4,
        requiredTokens: ["idempotency", "token"],
      },
    ],
    mustDrop: [],
  }
}

export const SYNTH_RETENTION_CASES: SynthRetentionCase[] = [
  {
    id: "fp-filter-plus-tp-retention",
    title: "Retain authz TP while dropping unsupported SSRF FP",
    note: "Mirrors the monitor PR class: synth must keep grounded logic/security bugs but drop impossible security claims.",
    diff: `diff --git a/src/api/orders.ts b/src/api/orders.ts
--- a/src/api/orders.ts
+++ b/src/api/orders.ts
@@ -1,5 +1,8 @@
 export async function getOrder(req: Request, env: Env) {
+  const id = new URL(req.url).searchParams.get("id")!
+  const order = await env.DB.orders.get(id)
+  return Response.json(order)
 }
`,
    specialistVerdicts: [
      {
        role: "logic",
        verdict: verdict("Missing authorization check.", [
          finding("logic-0", {
            path: "src/api/orders.ts",
            line: 5,
            score: 4,
            category: "logic",
            headline: "Missing tenant authorization before returning an order",
            body: "The handler reads an arbitrary order ID and returns it without checking the caller's `tenantId`.",
          }),
        ]),
      },
      {
        role: "security",
        verdict: verdict("One security finding.", [
          finding("security-0", {
            path: "src/parse/ndjson.ts",
            line: 4,
            score: 4,
            category: "security",
            headline: "SSRF via Content-Type",
            body: "The parser trusts a response Content-Type header, but this PR only reads bytes from a local object binding.",
            cweId: "CWE-918",
            evidenceId: "NONE",
          }),
        ]),
      },
    ],
    mustKeep: [
      {
        bugId: "missing-order-authz",
        sourceFindingId: "logic-0",
        path: "src/api/orders.ts",
        targetLine: 5,
        minScore: 4,
        category: "logic",
        requiredTokens: ["tenantId"],
      },
    ],
    mustDrop: [
      {
        sourceFindingId: "security-0",
        reason: "false-positive",
      },
    ],
  },
  buildDistinctBugCollisionCase(),
]
