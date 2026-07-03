// sig-free-tier-entitlements — the human-facing upgrade copy for a gated surface
// (pure strings). One voice across Slack and Linear so the paid boundary reads
// consistently wherever a person hits it. CI-triage has no natural surface (a
// failed-CI upsell comment would be spammy) so it clean-skips with a log only —
// there is deliberately no ci_triage line here.

import type { EntitledFeature } from "@/src/features/entitlements/domain/entitlements"

const UPGRADE_URL = "app.sigilix.ai"

/**
 * Brief, friendly upgrade note per surface, or null when the surface has no
 * natural place to show one (CI-triage → clean-skip). Keep these one sentence.
 */
export function upsellFor(feature: EntitledFeature): string | null {
  switch (feature) {
    case "slack":
      return `Sigilix's Slack assistant is a Pro feature — upgrade at ${UPGRADE_URL} to enable it.`
    case "linear":
      return `Sigilix's Linear agent is a Pro feature — upgrade at ${UPGRADE_URL} to enable it.`
    case "ci_triage":
    case "cli_byok":
      return null
  }
}
