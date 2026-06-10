// SIG-285 PR 1 — verification-by-execution rollout posture (mirrors the
// graph/runner shadow→enforce pattern).
//
//   - `off`     (default): no verification, no telemetry, byte-identical review.
//   - `shadow`: derive + run worker-native checks, emit verdict telemetry, but
//               NEVER alter a finding's score or rendering (observe-only — the
//               point of PR 1 is to measure the refutable-FP fraction first).
//   - `enforce`: reserved. PR 1 treats it identically to `shadow` (compute +
//               telemetry, no behavior change); the conservative REFUTED-only
//               demotion + body-routing lands in PR 4.
// Anything else is treated as `off` defensively.

import type { Env } from "@/src/shared/types/env"

export type VerificationMode = "off" | "shadow" | "enforce"

export function readVerificationMode(env: Env): VerificationMode {
  const raw = (env.OPENCLAW_VERIFICATION_MODE ?? "").trim().toLowerCase()
  if (raw === "shadow") return "shadow"
  if (raw === "enforce") return "enforce"
  return "off"
}

/**
 * SIG-285 re-anchor (inline-first): whether to APPLY the re-anchor mutation
 * (move a refuted inline finding to the correct line) when verification is in
 * `enforce`. Default OFF — the mutation ships INERT; flip `OPENCLAW_VERIFICATION
 * _REANCHOR` to "on" after the `/metrics/validation` `verification-reanchor` rate
 * (measured in shadow by PR1) confirms it's worth it. Only meaningful in
 * `enforce` mode; in `shadow` the re-anchor stays measurement-only regardless.
 */
export function readReanchorEnabled(env: Env): boolean {
  return (env.OPENCLAW_VERIFICATION_REANCHOR ?? "").trim().toLowerCase() === "on"
}
