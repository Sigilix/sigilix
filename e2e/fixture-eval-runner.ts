// SIG-398/SIG-393 — the shared live-runner half of the fixture eval:
// message building + one-role execution via `runShadowSpecialist`. Split
// from the live test so lever experiments (the SIG-393 re-sweep
// prototype) drive the same code path instead of forking it. Engine
// imports live HERE; `fixture-eval-lib.ts` stays engine-free/pure.

import { runShadowSpecialist } from "@/src/lib/shadow-bakeoff-runner"
import { SPECIALIST_CONFIGS, selectConfigApiKey, type ModelConfig } from "@/src/lib/triage-pr-review-ensemble"
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

/** SIG-406: both provider keys from the live-eval env. A `:cloud` model override
 *  routes to OLLAMA_API_KEY (Ollama Turbo, no OpenRouter spend); an OpenRouter id
 *  (e.g. the prod default `openai/o3`) routes to OPENROUTER_API_KEY. */
export function evalApiKeys(): { ollama: string | undefined; openrouter: string | undefined } {
  return { ollama: process.env.OLLAMA_API_KEY, openrouter: process.env.OPENROUTER_API_KEY }
}

/** True when EITHER provider key is present — the live-eval skip-gate. */
export function hasAnyEvalApiKey(): boolean {
  const k = evalApiKeys()
  return Boolean(k.ollama || k.openrouter)
}

/** Pick the API key matching a config's model by id-shape, via the prod selector
 *  (so the cross-provider-fallback guard applies here too). */
export function evalApiKeyFor(config: ModelConfig): string | undefined {
  return selectConfigApiKey(config, evalApiKeys())
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
  /** SIG-406: optional explicit override. When omitted, the key is selected by the
   *  role's EFFECTIVE model shape (`configFor(role)`) — a `:cloud` override → the
   *  Ollama key, an OpenRouter id → the OpenRouter key. */
  apiKey?: string
  refRole?: string
}): Promise<RoleRunResult> {
  const config = configFor(args.role)
  const apiKey = args.apiKey ?? evalApiKeyFor(config)
  if (!apiKey) {
    // SIG-406: the key for THIS role's effective model provider isn't set — fail fast
    // + clear instead of passing "" into the model call (which fails late / empties
    // the measurement). The default OpenRouter config needs OPENROUTER_API_KEY; a
    // `:cloud` model override needs OLLAMA_API_KEY (Ollama Turbo, no OpenRouter spend).
    console.warn(
      `[fixture-eval] ${args.role}: no API key set for model "${config.primary}" — ` +
        `set OPENROUTER_API_KEY (or OLLAMA_API_KEY for a :cloud override). Role skipped.`,
    )
    return { findings: [], errored: true, elapsedMs: 0 }
  }
  try {
    const r = await runShadowSpecialist({
      role: args.role,
      shadowConfig: config,
      apiKey,
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
