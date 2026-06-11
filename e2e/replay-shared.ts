// SIG-392 — shared helpers for the offline replay harnesses
// (gate-survival, synth-load). Both reconstruct production inputs from the
// captured lever-candidate findings, so the finding→role mapping, the
// FixtureFinding→PrReviewFinding adaptation, and the wrangler-mode parse
// live here once.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assignStableFindingIds } from "@/src/lib/ensemble/domain/findings"
import type { CollectedVerdict } from "@/src/lib/ensemble/domain/validation"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { FindingCategory } from "@/src/shared/domain/finding-category"
import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import type { FixtureFinding, Severity } from "@/evals/fixture-types"

export const ROLES = ["logic", "security", "performance", "tests"] as const

function scoreForSeverity(sev: Severity | null): number {
  return sev === "P0" ? 5 : sev === "P1" ? 4 : sev === "P2" ? 3 : 2
}

/**
 * Map a captured finding's ref prefix back to the specialist verdict it
 * belongs to. Pass-1 findings carry `<role>-N`; re-sweep candidates
 * `resweep-<role>-N` (merge into that role); invariant-lens candidates
 * `inv-<family>-N` — those merge into the LOGIC verdict (the engine's
 * SIG-395 merge-target rule).
 */
export function roleOf(ref: string): SpecialistRole {
  for (const r of ROLES) {
    if (ref.startsWith(`${r}-`) || ref.startsWith(`resweep-${r}-`)) return r
  }
  return "logic"
}

/** Adapt a stored FixtureFinding back to the engine's PrReviewFinding shape. */
export function toPrFinding(f: FixtureFinding): PrReviewFinding {
  const headline = f.excerpt.replace(/^\*\*|\*\*$/g, "")
  const body = f.bodyText.startsWith(f.excerpt) ? f.bodyText.slice(f.excerpt.length).trim() : f.bodyText
  const category: FindingCategory =
    f.botCategory === "testing" || f.botCategory === "performance" || f.botCategory === "security"
      ? (f.botCategory as FindingCategory)
      : "logic"
  return {
    path: f.path ?? "",
    line: f.line ?? 1,
    score: scoreForSeverity(f.severity),
    category,
    headline,
    body: body.length > 0 ? body : headline,
  }
}

/** Lever origin of a captured finding, from its ref prefix; null for pass-1. */
export function originOf(ref: string): "resweep" | "lens" | null {
  if (ref.startsWith("resweep-")) return "resweep"
  if (ref.startsWith("inv-")) return "lens"
  return null
}

/**
 * Group captured lever-loaded findings back into per-role specialist
 * verdicts with REAL stable ids (so the hallucination guard's provenance
 * check and the synth verdict block see traceable sources). Also returns
 * the SIG-392 `leverOrigins` map (rebuilt stable id → origin) so replays
 * can stamp the same synth-visible `origin` markers prod stamps in
 * promoted mode.
 */
export function rebuildSpecialistVerdicts(captured: readonly FixtureFinding[]): {
  verdicts: CollectedVerdict[]
  leverOrigins: ReadonlyMap<string, "resweep" | "lens">
} {
  const byRole = new Map<SpecialistRole, PrReviewFinding[]>()
  const leverOrigins = new Map<string, "resweep" | "lens">()
  for (const f of captured) {
    const role = roleOf(f.ref)
    const findings = byRole.get(role) ?? []
    const origin = originOf(f.ref)
    // Stable ids are positional per role — the index this finding lands at
    // is exactly the id assignStableFindingIds will mint below.
    if (origin) leverOrigins.set(`${role}-${findings.length}`, origin)
    byRole.set(role, [...findings, toPrFinding(f)])
  }
  const verdicts = [...byRole.entries()].map(([role, findings]) => ({
    role,
    verdict: assignStableFindingIds(role, {
      summary: "replay",
      confidence: 3,
      confidenceReason: "replay",
      findings,
    } as PrReviewVerdict),
    elapsedMs: 0,
  }))
  return { verdicts, leverOrigins }
}

/** Parse `OPENCLAW_*` string vars out of wrangler.toml [vars] → an env object. */
export function prodEnvFromWrangler(): Record<string, string> {
  const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8")
  const env: Record<string, string> = {}
  for (const m of toml.matchAll(/^(OPENCLAW_[A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)) {
    env[m[1]!] = m[2]!
  }
  return env
}
