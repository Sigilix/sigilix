import { readSkillPolicies } from "./d1-skill-policy-store"
import {
  resolveGovernedSkill,
  type ResolvedSkillContext,
  type SkillResolutionReason,
} from "@/src/features/skills/domain/policy"
import type { GovernedSkillManifest, SkillSurface } from "@/src/features/skills/domain/catalog"
import type { Env } from "@/src/shared/types/env"

export type RuntimeSkillResult =
  | { status: "resolved"; context: ResolvedSkillContext; invalidRowCount: number }
  | { status: "empty"; reasons: Partial<Record<SkillResolutionReason, number>>; invalidRowCount: number }
  | { status: "disabled" }
  | { status: "store_unavailable" }
  | { status: "invalid_policy"; invalidRowCount: number }

interface ResolveRuntimeSkillArgs {
  /** Exact installation derived by the authenticated edge route. This adapter
   * is internal and performs no caller-controlled tenant selection. */
  installationId: number
  surface: SkillSurface
  task: string
  runId: string
  /** Optional NARROWING of the server-owned catalog for a caller whose runtime
   * cannot honor some agent-eligible guidance (e.g. the single-shot triage
   * classifier). It can only remove entries — a caller can never introduce a
   * skill the reviewed catalog does not contain. */
  catalog?: readonly GovernedSkillManifest[]
}

/** Resolve one static guidance skill from exact installation-scoped policy.
 * Failures always mean no guidance; they never fail the user's run. */
export async function resolveRuntimeSkill(
  env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_SKILLS_MODE">,
  args: ResolveRuntimeSkillArgs,
): Promise<RuntimeSkillResult> {
  // Fail closed: only the exact deploy-time opt-in enables skill resolution.
  // Missing, misspelled, or case-shifted values must never turn guidance on.
  if (env.SIGILIX_SKILLS_MODE !== "on") {
    logResolution(args, "disabled")
    return { status: "disabled" }
  }
  const stored = await readSkillPolicies(env, args.installationId)
  if (stored.status === "unavailable") {
    logResolution(args, "store_unavailable")
    return { status: "store_unavailable" }
  }
  const resolved = resolveGovernedSkill({
    policies: stored.policies,
    surface: args.surface,
    task: args.task,
    ...(args.catalog ? { catalog: args.catalog } : {}),
  })
  if (resolved.status === "resolved") {
    console.log(
      JSON.stringify({
        event: "runtime-skill-resolution",
        status: "resolved",
        runId: safeRunId(args.runId),
        surface: args.surface,
        skillId: resolved.context.provenance.id,
        instructionVersion: resolved.context.provenance.instructionVersion,
        instructionSha256: resolved.context.provenance.instructionSha256,
        policyVersion: resolved.context.provenance.policyVersion,
        invalidRowCount: stored.invalidRowCount,
      }),
    )
    return { status: "resolved", context: resolved.context, invalidRowCount: stored.invalidRowCount }
  }
  if (stored.invalidRowCount > 0 && stored.policies.length === 0) {
    logResolution(args, "invalid_policy", { invalidRowCount: stored.invalidRowCount })
    return { status: "invalid_policy", invalidRowCount: stored.invalidRowCount }
  }
  console.log(
    JSON.stringify({
      event: "runtime-skill-resolution",
      status: "empty",
      runId: safeRunId(args.runId),
      surface: args.surface,
      reasons: resolved.reasons,
      invalidRowCount: stored.invalidRowCount,
    }),
  )
  return { status: "empty", reasons: resolved.reasons, invalidRowCount: stored.invalidRowCount }
}

function logResolution(
  args: ResolveRuntimeSkillArgs,
  status: Exclude<RuntimeSkillResult["status"], "resolved" | "empty">,
  extra: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      event: "runtime-skill-resolution",
      status,
      runId: safeRunId(args.runId),
      surface: args.surface,
      ...extra,
    }),
  )
}

function safeRunId(value: string): string {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : "invalid"
}
