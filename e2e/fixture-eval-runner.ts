// SIG-398/SIG-393 — the shared live-runner half of the fixture eval:
// message building + one-role execution via `runShadowSpecialist`. Split
// from the live test so lever experiments (the SIG-393 re-sweep
// prototype) drive the same code path instead of forking it. Engine
// imports live HERE; `fixture-eval-lib.ts` stays engine-free/pure.

import { runShadowSpecialist } from "@/src/lib/shadow-bakeoff-runner"
import { SPECIALIST_CONFIGS } from "@/src/lib/triage-pr-review-ensemble"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"
import type { SpecialistRole } from "@/src/lib/ensemble-router"
import { shadowFindingsToFixtureFindings, type LocalRawFinding } from "@/evals/local-adapter"
import type { FixtureFinding } from "@/evals/fixture-types"

export const ALL_ROLES: SpecialistRole[] = ["logic", "security", "performance", "tests"]
export const PER_ROLE_TIMEOUT_MS = 280_000

export function rolesFromEnv(raw: string | undefined): SpecialistRole[] {
  if (!raw) return ALL_ROLES
  const picked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SpecialistRole => (ALL_ROLES as string[]).includes(s))
  return picked.length > 0 ? picked : ALL_ROLES
}

export function configFor(role: SpecialistRole, envPrefix = "FIXTURE_EVAL_MODEL_") {
  const override = process.env[`${envPrefix}${role.toUpperCase()}`]?.trim()
  // Override nulls the fallback so every scored run is the requested model
  // (a fallback would silently mix a second model in) — LOGIC_RECALL_MODEL rule.
  return override ? { ...SPECIALIST_CONFIGS[role], primary: override, fallback: null } : SPECIALIST_CONFIGS[role]
}

/** Build the minimal-context specialist message for a fixture diff slice. */
export function buildFixtureMessage(args: { title: string; diff: string; guidance?: string }): string {
  return buildSpecialistInitialMessage({
    prNumber: 0,
    title: args.title,
    body: "",
    diff: args.diff,
    retrievalSnapshot: "",
    namespace: "eval",
    ...(args.guidance !== undefined ? { guidance: args.guidance } : {}),
  })
}

export interface RoleRunResult {
  findings: FixtureFinding[]
  errored: boolean
  elapsedMs: number
}

/**
 * One specialist, one message, prod config + prompt. `refRole` controls
 * the adapter ref prefix so experiment passes stay distinguishable in
 * scorer output (e.g. `resweep-security-2`).
 */
export async function runRole(args: {
  role: SpecialistRole
  userMessage: string
  apiKey: string
  refRole?: string
}): Promise<RoleRunResult> {
  try {
    const r = await runShadowSpecialist({
      role: args.role,
      shadowConfig: configFor(args.role),
      apiKey: args.apiKey,
      systemPrompt: SPECIALIST_PROMPTS[args.role],
      userMessage: args.userMessage,
      chatEnabled: "on",
      signal: AbortSignal.timeout(PER_ROLE_TIMEOUT_MS),
      perfCtx: { owner: "eval", repo: "fixture-eval", prNumber: 0, headSha: "0".repeat(40) },
    })
    // logic-recall-eval rule: a non-throwing failure (parse-fail / timeout)
    // must not read as "the model found nothing" — flag the role errored.
    const errored = !r.verdictOk || r.failureReason !== undefined
    const raw = (r.rawFindings ?? []) as readonly LocalRawFinding[]
    return {
      findings: errored ? [] : shadowFindingsToFixtureFindings(args.refRole ?? args.role, raw),
      errored,
      elapsedMs: r.elapsedMs,
    }
  } catch {
    return { findings: [], errored: true, elapsedMs: 0 }
  }
}
