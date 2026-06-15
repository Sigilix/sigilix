// SIG-249 live smoke/eval: replay a source specialist finding with complete
// `moreInfo` through the real synthesizer path and measure whether the final
// posted finding preserves the six structured sections.
//
//   OPENROUTER_API_KEY=sk-or-... npm run more-info-eval
//   SIG249_MORE_INFO_REPEATS=5 SIG249_MORE_INFO_MIN_RATE=0.8 OPENROUTER_API_KEY=... npm run more-info-eval
//
// This is read-only and skips in normal CI unless the selected synth model's key
// is exported. It does not gate production findings; it validates prompt behavior.

import { describe, expect, it } from "vitest"
import {
  runSynthesizer,
  selectConfigApiKey,
  SYNTHESIZER_CONFIG,
  SYNTHESIZER_TIMEOUT_MS,
  type SynthesizerProvenance,
} from "@/src/lib/triage-pr-review-ensemble"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/lib/triage-pr-review"
import { FINDING_MORE_INFO_SECTION_KEYS } from "@/src/shared/domain/finding-more-info"
import {
  SYNTHESIZER_PROMPT,
  buildSynthesizerInitialMessage,
  renderSpecialistVerdictsForSynth,
} from "@/src/prompts/pr-review-specialists"

const REPEATS = (() => {
  const n = Number(process.env.SIG249_MORE_INFO_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
const MIN_RATE = (() => {
  const n = Number(process.env.SIG249_MORE_INFO_MIN_RATE ?? 0.8)
  return Number.isFinite(n) && n >= 0 ? Math.min(1, n) : 0.8
})()
const MODEL_OVERRIDE = process.env.SIG249_MORE_INFO_MODEL?.trim()
const CONFIG = MODEL_OVERRIDE ? { ...SYNTHESIZER_CONFIG, primary: MODEL_OVERRIDE, fallback: null } : SYNTHESIZER_CONFIG
const API_KEY = selectConfigApiKey(CONFIG, {
  ollama: process.env.OLLAMA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
})
const PER_RUN_TIMEOUT_MS = SYNTHESIZER_TIMEOUT_MS + 30_000
// Eval-only depth guard: this is not a production minimum. It catches empty,
// placeholder, or "see above" sections while still allowing concise
// reviewer-facing prose.
const MIN_SECTION_CHARS = 30
const MIN_BODY_CHARS = 90

const IDOR_DIFF = `diff --git a/src/routes/invoices.ts b/src/routes/invoices.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/routes/invoices.ts
@@ -0,0 +1,38 @@
+interface Env {
+  DB: D1Database
+}
+
+interface SessionUser {
+  id: string
+  organizationId: string
+}
+
+async function requireUser(request: Request): Promise<SessionUser> {
+  const userId = request.headers.get("x-user-id")
+  const organizationId = request.headers.get("x-organization-id")
+  if (!userId || !organizationId) throw new Response("unauthorized", { status: 401 })
+  return { id: userId, organizationId }
+}
+
+export async function getInvoice(request: Request, env: Env): Promise<Response> {
+  const user = await requireUser(request)
+  const url = new URL(request.url)
+  const invoiceId = url.searchParams.get("invoiceId")
+  if (!invoiceId) return new Response("missing invoiceId", { status: 400 })
+
+  const invoice = await env.DB.prepare(
+    "SELECT id, organization_id, total_cents FROM invoices WHERE id = ?",
+  )
+    .bind(invoiceId)
+    .first<{ id: string; organization_id: string; total_cents: number }>()
+
+  if (!invoice) return new Response("not found", { status: 404 })
+  return Response.json({
+    id: invoice.id,
+    organizationId: invoice.organization_id,
+    totalCents: invoice.total_cents,
+    requestedBy: user.id,
+  })
+}
`

const sourceFinding: PrReviewFinding & { id: string } = {
  id: "security-0",
  path: "src/routes/invoices.ts",
  line: 30,
  startLine: 17,
  scope: "line",
  score: 5,
  category: "security",
  headline: "`getInvoice` returns invoices without verifying tenant ownership",
  body: "`getInvoice` authenticates a user but never checks that `invoice.organization_id` matches `user.organizationId` before returning invoice data. Add an authorization check after loading the invoice and before `Response.json`.",
  moreInfo: {
    threatModel:
      "Any authenticated user who can guess or obtain an `invoiceId` can request another organization's invoice metadata.",
    codeCitations:
      "`requireUser` returns `organizationId`, but the handler only queries by `invoiceId` and returns `invoice.organization_id` without comparing it to the user.",
    existingProtections:
      "The route checks that the caller is logged in and that the invoice exists; neither proves the caller belongs to the invoice's organization.",
    mitigation:
      "Compare `invoice.organization_id` with `user.organizationId` and return 403 before emitting the JSON body when they differ.",
    alternatives:
      "Adding a database row policy would also prevent this class, but this patch can fix the route locally with a direct ownership guard.",
    severityCalibration:
      "Score 5 because this is cross-tenant data exposure on invoice metadata and the exploit only needs a valid session plus an invoice id.",
  },
  cweId: "CWE-639",
  evidenceId: "NONE",
  independentAssessment:
    "`user.organizationId` is available, but no comparison with `invoice.organization_id` appears before the response.",
}

const sourceVerdict: PrReviewVerdict & { findings: Array<typeof sourceFinding> } = {
  summary: "Security found a cross-tenant invoice read.",
  confidence: 5,
  confidenceReason: "The missing ownership check is visible in the changed handler.",
  findings: [sourceFinding],
}

const userMessage = buildSynthesizerInitialMessage({
  prNumber: 249,
  diff: IDOR_DIFF,
  specialistVerdictsBlock: renderSpecialistVerdictsForSynth([{ role: "security", verdict: sourceVerdict }]),
})

const PERF_CTX = {
  owner: "eval",
  repo: "sig-249-more-info",
  prNumber: 249,
  headSha: "0".repeat(40),
}

function hasCompleteMoreInfo(finding: PrReviewFinding): boolean {
  return FINDING_MORE_INFO_SECTION_KEYS.every((key) => {
    const value = finding.moreInfo?.[key]
    return typeof value === "string" && value.trim().length >= MIN_SECTION_CHARS
  })
}

function isTargetFinding(finding: PrReviewFinding): boolean {
  const text = `${finding.category} ${finding.headline} ${finding.body}`.toLowerCase()
  return (
    finding.score >= 4 &&
    (text.includes("tenant") ||
      text.includes("organization") ||
      text.includes("idor") ||
      text.includes("authorization") ||
      text.includes("cross-tenant") ||
      text.includes("ownership"))
  )
}

function hasSubstantiveBody(finding: PrReviewFinding): boolean {
  const body = finding.body.trim().toLowerCase()
  return (
    body.length >= MIN_BODY_CHARS &&
    (body.includes("invoice") || body.includes("billing") || body.includes("record")) &&
    (body.includes("organization") || body.includes("tenant") || body.includes("cross-org")) &&
    (body.includes("ownership") ||
      body.includes("authorization") ||
      body.includes("authorize") ||
      body.includes("access") ||
      body.includes("belongs") ||
      body.includes("compare") ||
      body.includes("permission") ||
      body.includes("match"))
  )
}

async function runOnce(): Promise<{
  verdict: PrReviewVerdict | null
  provenance: SynthesizerProvenance | null
  model: string
  elapsedMs: number
  error?: string
}> {
  const startedAt = Date.now()
  try {
    const result = await runSynthesizer({
      apiKey: API_KEY as string,
      systemPrompt: SYNTHESIZER_PROMPT,
      userMessage,
      chatEnabled: "on",
      signal: AbortSignal.timeout(PER_RUN_TIMEOUT_MS),
      perfCtx: PERF_CTX,
      configOverride: CONFIG,
    })
    return {
      verdict: result.verdict,
      provenance: result.provenance,
      model: result.modelUsed,
      elapsedMs: result.elapsedMs,
      ...(result.failureReason ? { error: result.failureReason } : {}),
    }
  } catch (err) {
    return {
      verdict: null,
      provenance: null,
      model: String(CONFIG.primary),
      elapsedMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

describe.skipIf(!API_KEY)("SIG-249 More Info synth live eval", () => {
  it(
    "measures final synthesized finding More Info retention across repeated Nemotron runs",
    async () => {
      let verdictRuns = 0
      let targetHits = 0
      let substantiveBodyHits = 0
      let completeMoreInfoHits = 0
      let provenanceHits = 0
      let errors = 0

      for (let i = 0; i < REPEATS; i++) {
        const result = await runOnce()
        if (!result.verdict) {
          errors++
          console.log(`  [${i + 1}/${REPEATS}] ERROR ${result.error ?? "no verdict"} (${result.model})`)
          continue
        }
        verdictRuns++
        const target = result.verdict.findings.find(isTargetFinding)
        const complete = target ? hasCompleteMoreInfo(target) : false
        const substantiveBody = target ? hasSubstantiveBody(target) : false
        const provenanceKeepsSource =
          result.provenance?.findings.some((p) => p.sourceFindingIds.includes(sourceFinding.id)) ?? false
        if (target) targetHits++
        if (substantiveBody) substantiveBodyHits++
        if (complete) completeMoreInfoHits++
        if (provenanceKeepsSource) provenanceHits++
        console.log(
          `  [${i + 1}/${REPEATS}] target=${target ? "yes" : "no"} substantiveBody=${substantiveBody ? "yes" : "no"} completeMoreInfo=${complete ? "yes" : "no"} provenance=${provenanceKeepsSource ? "yes" : "no"} findings=${result.verdict.findings.length} (${result.model} - ${result.elapsedMs}ms)`,
        )
        if (target && !complete && process.env.SIG249_MORE_INFO_DEBUG) {
          console.log(`      headline=${target.headline}`)
          console.log(`      moreInfo=${JSON.stringify(target.moreInfo ?? null)}`)
        }
      }

      const targetRate = verdictRuns ? targetHits / verdictRuns : 0
      const substantiveBodyRate = verdictRuns ? substantiveBodyHits / verdictRuns : 0
      const completeRate = verdictRuns ? completeMoreInfoHits / verdictRuns : 0
      const provenanceRate = verdictRuns ? provenanceHits / verdictRuns : 0
      console.log(
        `SIG-249 MORE INFO SYNTH - model=${CONFIG.primary} - ${REPEATS}x - verdictRuns=${verdictRuns} errors=${errors} targetRate=${targetRate.toFixed(2)} substantiveBodyRate=${substantiveBodyRate.toFixed(2)} completeMoreInfoRate=${completeRate.toFixed(2)} provenanceRate=${provenanceRate.toFixed(2)} minRate=${MIN_RATE.toFixed(2)}`,
      )
      expect(verdictRuns).toBeGreaterThan(0)
      expect(targetRate).toBeGreaterThan(0)
      expect(substantiveBodyRate).toBeGreaterThanOrEqual(MIN_RATE)
      expect(provenanceRate).toBeGreaterThan(0)
      expect(completeRate).toBeGreaterThanOrEqual(MIN_RATE)
    },
    REPEATS * PER_RUN_TIMEOUT_MS + 30_000,
  )
})
