// SIG-507 — contribute finalized review findings to the fleet aggregate (the server-side WRITE
// path). Maps each finding to its anonymized signature and folds it into the per-signature aggregate,
// keyed by the ORG id (the k-anonymity unit: K=5 distinct orgs, so one org can't self-cross the gate).
//
// Best-effort + self-contained: it NEVER throws, so the review path is unaffected (recall-safe), and
// it's gated by the per-repo opt-out (default contribute). Only the finding's category / headline /
// severity + trust tier are read; `extractFleetPattern` guarantees no code or identifier is stored,
// and the org id is only hashed into the distinct counter, never persisted.

import type { Env } from "@/src/shared/types/env"
import { isFleetContributeEnabled, type SigilixConfig } from "@/src/lib/sigilix-config"
import { extractFleetPattern } from "@/src/shared/domain/fleet-pattern"
import { recordContribution } from "@/src/lib/fleet/fleet-store"

/** A finalized review finding, narrowed to the fields the fleet needs (a subset of PrReviewFinding). */
export interface ContributableFinding {
  category?: string
  headline?: string
  score?: number
  trust?: { tier?: string } | undefined
}

/**
 * Fold the given findings into the fleet aggregate for `orgId`. No-op when the repo opted out.
 * Never throws (best-effort side-effect — must not affect the posted review).
 */
export async function contributeFindingsToFleet(
  env: Env,
  orgId: string,
  findings: readonly ContributableFinding[],
  config: SigilixConfig | null,
): Promise<void> {
  try {
    if (!isFleetContributeEnabled(config)) return
    for (const f of findings) {
      const pattern = extractFleetPattern({
        category: f.category ?? "",
        headline: f.headline,
        score: f.score,
        // REPRODUCED (sealed execution) / VERIFIED (runner-confirmed) read from the trust tier;
        // absent → false (the reproduce pass is shadow-only today, so this is usually false).
        reproduced: f.trust?.tier === "reproduced-by-execution",
        verified: f.trust?.tier === "runner-confirmed",
      })
      if (pattern) await recordContribution(env, pattern, orgId)
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "fleet-contribution-failed",
        orgId,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
