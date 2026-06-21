// SIG-487 — the security K-union phase (app layer): a SECOND security-specialist
// pass that runs CONCURRENT with the primary fan-out and (mode `on`) UNIONs its
// findings into the security role's verdict pre-synth. Security is the only
// specialist with no second-pass booster (logic has the invariant-lens + resweep),
// yet it carries the non-deterministic miss-classes (missing-await-auth-style P0s
// caught only on some passes). A K=2 union recovers those the way the logic K=2
// ruler does.
//
// This is a K=2 SAMPLING-RECOVERY union, NOT a differentiated re-draw: in prod
// the primary security pass already carries SECURITY_RECALL_SUFFIX (security is in
// `recallRoles` when OPENCLAW_SECURITY_RECALL_MODE=on), so the 2nd pass runs the
// SAME full-strength prompt — and we deliberately keep it full-strength (same
// recall suffix, same reasoning level, same MCP tools as pass-1). The recovery
// comes from non-determinism: security findings vary run-to-run (e.g. a P0 caught
// only on a deeper pass), and security — unlike logic — has NO second-pass booster,
// so a 2nd independent draw recovers the misses pass-1 happened to drop. The 2×
// security spend is only justified if it actually finds NEW findings, which is
// exactly what the shadow `newFindings`/`overlap` telemetry measures before we flip
// `on`. (We force the recall suffix on regardless of the global recall flag so the
// K-union always sweeps with recall even if that flag is ever turned off.)
//
// Mode contract (`OPENCLAW_SECURITY_KUNION`), mirroring the invariant-lens:
//   off    — inert; `start` returns a settled no-op handle (zero extra calls).
//   shadow — the 2nd pass runs + telemetry (overlap / new-finding / error rate);
//            findings NEVER merge (no behavior change).
//   on     — the 2nd pass's findings merge into the security verdict pre-synth and
//            flow through the UNCHANGED gate stack (a union can only ADD findings,
//            which still pass every downstream believability gate; duplicates are
//            collapsed by the existing synth + near-dup dedup, exactly as the
//            invariant-lens's merged findings are).
//
// Degradation: a 2nd-pass failure (throw / timeout / null verdict) degrades to the
// 1st pass's findings only — it NEVER breaks the review.
//
// Split into start/apply so the caller kicks the 2nd pass off BEFORE awaiting the
// fan-out and merges after verdict collection (zero added wall-clock, like the lens).

import type { Env } from "@/src/shared/types/env"
import { type EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { modelApiKeys, runSpecialist } from "@/src/lib/ensemble/adapters/model-provider"
import { specialistSystemPrompt } from "@/src/prompts/pr-review-specialists"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import { SPECIALIST_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import { composeSignals } from "@/src/lib/ensemble/domain/shadow-grace"
import { assignStableFindingIds } from "@/src/lib/ensemble/domain/findings"
import { headlineJaccard } from "@/src/lib/ensemble/domain/near-dup-collapse"
import { appendRoleRule } from "@/src/lib/ensemble/app/role-message"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { EnsembleConfig } from "@/src/lib/ensemble/domain/config"
import type { RouterDecision } from "@/src/lib/ensemble-router"
import { type SigilixConfig, resolveSpecialistMcpTools } from "@/src/lib/sigilix-config"

/** Two near-dup headlines are "the same finding" above this Jaccard — for the
 *  shadow OVERLAP signal only (how redundant the 2nd pass is). Never used to drop. */
const OVERLAP_JACCARD = 0.6

/** The orchestrator context the K-union reads — a structural subset of the
 *  specialists-phase args, so the caller passes its own `a` object verbatim. */
export interface SecurityKUnionContext {
  env: Env
  owner: string
  repo: string
  prNumber: number
  headSha: string
  perfCtx: EnsembleRunCtx
  orchCtrl: AbortController
  ensembleConfig: EnsembleConfig
  router: RouterDecision
  sigilixConfig: SigilixConfig
  messageForRole: (role: SpecialistRole) => string
}

interface SecondPassOutcome {
  findings: readonly PrReviewFinding[]
  errored: boolean
}

export interface SecurityKUnionHandle {
  mode: EnsembleConfig["flags"]["securityKUnionMode"]
  /** Resolves when the 2nd pass settles (never rejects). */
  outcome: Promise<SecondPassOutcome>
  dispatched: boolean
  startedAtMs: number
}

/** Kick off the 2nd security pass (concurrent with the fan-out). `off` / security-
 *  not-dispatched → a settled no-op handle (zero extra model calls). */
export function startSecurityKUnion(a: SecurityKUnionContext): SecurityKUnionHandle {
  const mode = a.ensembleConfig.flags.securityKUnionMode
  const securityDispatched = a.router.specialists.includes("security")
  const startedAtMs = Date.now()
  if (mode === "off" || !securityDispatched) {
    return { mode, outcome: Promise.resolve({ findings: [], errored: false }), dispatched: false, startedAtMs }
  }
  const chatEnabled = a.env.OLLAMA_CHAT_ENABLE === "on" ? ("on" as const) : ("off" as const)
  // Full-strength 2nd pass: same recall suffix, reasoning level, and MCP tools the
  // primary fan-out gives security (`specialists.ts`) — a faithful K=2 draw, never a
  // weaker re-run. The recall suffix is forced on independent of the global flag.
  const systemPrompt = specialistSystemPrompt(
    "security",
    new Set<SpecialistRole>(["security"]),
    a.ensembleConfig.flags.reasoningPromptRoles,
  )
  const reasoningForRole = a.ensembleConfig.flags.reasoningByRole.get("security")
  const mcpTools = resolveSpecialistMcpTools(a.sigilixConfig, "security")
  const initialMessage = appendRoleRule(a.messageForRole("security"), "security", a.sigilixConfig)
  const outcome: Promise<SecondPassOutcome> = (async () => {
    try {
      const r = await runSpecialist({
        role: "security",
        // SIG-406: runSpecialist selects the key by model-id shape; default security config.
        apiKeys: modelApiKeys(a.env),
        systemPrompt,
        initialMessage,
        chatEnabled,
        // Degrade like the lens/re-sweep: any abort/throw → zero candidates.
        signal: composeSignals(a.orchCtrl.signal, AbortSignal.timeout(SPECIALIST_TIMEOUT_MS)),
        // SIG-287 parity: per-role bounded reasoning (default-off → omitted).
        ...(reasoningForRole !== undefined ? { reasoning: reasoningForRole } : {}),
        perfCtx: a.perfCtx,
        mcpTools,
      })
      const errored = r.verdict === null
      return { findings: errored ? [] : r.verdict!.findings, errored }
    } catch {
      return { findings: [], errored: true }
    }
  })()
  return { mode, outcome, dispatched: true, startedAtMs }
}

/** How many 2nd-pass findings near-duplicate a 1st-pass security finding (shadow signal). */
function overlapCount(firstPass: readonly PrReviewFinding[], secondPass: readonly PrReviewFinding[]): number {
  let overlap = 0
  for (const s of secondPass) {
    if (firstPass.some((f) => f.path === s.path && headlineJaccard(f.headline, s.headline) >= OVERLAP_JACCARD)) {
      overlap += 1
    }
  }
  return overlap
}

/** Await the 2nd pass and (mode `on`) merge its findings into the security verdict.
 *  Shadow telemeters + returns the verdicts untouched. NEVER throws. */
export async function applySecurityKUnion(
  handle: SecurityKUnionHandle,
  succeeded: readonly CollectedVerdict[],
  ctx: { owner: string; repo: string; prNumber: number; headSha: string },
): Promise<readonly CollectedVerdict[]> {
  if (handle.mode === "off" || !handle.dispatched) return succeeded

  const second = await handle.outcome
  const target = succeeded.find((v) => v.role === "security" && v.verdict !== null)
  const firstFindings = target?.verdict?.findings ?? []
  const overlap = overlapCount(firstFindings, second.findings)
  const willMerge = handle.mode === "on" && !second.errored && second.findings.length > 0 && target?.verdict != null

  console.log(
    JSON.stringify({
      event: "security-kunion-result",
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
      headSha: ctx.headSha.slice(0, 7),
      mode: handle.mode,
      errored: second.errored,
      firstPassFindings: firstFindings.length,
      secondPassFindings: second.findings.length,
      overlap,
      newFindings: second.findings.length - overlap,
      merged: willMerge,
      elapsedMs: Date.now() - handle.startedAtMs,
    }),
  )

  // shadow / errored / nothing-to-merge / no security verdict → return untouched.
  if (!willMerge || target?.verdict == null) return succeeded

  // on: append the 2nd-pass findings to the security verdict + re-assign stable ids
  // (duplicates are collapsed by the existing synth + near-dup dedup downstream,
  // exactly as the invariant-lens's merged logic findings are).
  return succeeded.map((v) => {
    if (v !== target) return v
    const merged = assignStableFindingIds(v.role, {
      ...v.verdict!,
      findings: [...v.verdict!.findings, ...second.findings],
    })
    return { ...v, verdict: merged }
  })
}
