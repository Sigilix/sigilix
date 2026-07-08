// sig-free-tier-entitlements — the human-facing upgrade copy for a gated surface
// (pure strings). One voice across Slack, Linear, and the CLI BYOK notice so the
// paid boundary reads consistently wherever a person hits it. CI-triage has no
// natural surface (a failed-CI upsell comment would be spammy) so it clean-skips
// with a log only — there is deliberately no ci_triage line here.
//
// cli_byok DOES have copy: unlike the three worker surfaces, "bring your own
// model key" never routes through the Worker (the CLI talks to the user's own
// provider directly), so it has no server gate — the enforcement is a display/
// config gate in the CLI/portal plus the Terms. This string is the copy those
// client surfaces show an un-entitled plan next to a disabled BYOK control.

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
    case "cli_byok":
      return `Bringing your own model key in the Sigilix CLI is a Pro feature — upgrade at ${UPGRADE_URL} to enable it.`
    case "ci_triage":
      return null
  }
}
