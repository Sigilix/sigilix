// SIG-298 follow-on — SDK guidance pack: PostHog. Self-authored from
// PostHog's public docs (posthog.com/docs). NOT a partner integration — no
// endorsement claim, no logo; the label is "SDK guidance."

import type { SdkPack } from "@/src/lib/sdk-packs/types"

const DOCS_URL = "https://posthog.com/docs"

export const posthogPack: SdkPack = {
  id: "posthog",
  vendor: "PostHog",
  docsUrl: DOCS_URL,
  matchers: {
    packages: ["posthog-js", "posthog-node", "posthog-react-native"],
    importPatterns: [/from\s+["']posthog-/, /require\(\s*["']posthog-/],
  },
  rules: [
    {
      id: "pii-in-event-properties",
      title: "Don't capture raw PII in event properties",
      guidance:
        "Event properties (emails, full names, phone numbers, free-text form input) captured verbatim are stored and often forwarded to downstream tools — sensitive PII should be hashed, truncated, or omitted, and `posthog.config.mask_all_text` / element allowlisting used for autocapture on forms.",
      severityHint: "P1",
      docsUrl: "https://posthog.com/docs/privacy",
    },
    {
      id: "feature-flag-fallback-not-handled",
      title: "A feature-flag check needs a defined fallback while flags are loading",
      guidance:
        "`useFeatureFlagEnabled` / `isFeatureEnabled` can return `undefined` before flags have loaded from the PostHog API — code that treats `undefined` as falsy (hiding a feature) or truthy (showing it) without an explicit loading state can flicker or briefly expose/hide gated functionality on every page load.",
      severityHint: "P2",
      docsUrl: "https://posthog.com/docs/feature-flags/adding-feature-flag-code",
    },
    {
      id: "flag-check-without-bootstrap-causes-flash",
      title: "Server-rendered gated UI needs flag bootstrapping to avoid flash-of-wrong-content",
      guidance:
        "A feature flag checked only client-side after hydration causes a visible flash of the wrong UI on first paint for SSR/SSG pages — use `bootstrap` (server-evaluated flags passed to the client) for any flag that gates above-the-fold content.",
      severityHint: "P3",
      docsUrl: "https://posthog.com/docs/feature-flags/bootstrapping",
    },
    {
      id: "identify-called-with-unstable-id",
      title: "`identify()` with an unstable/reused id merges unrelated users",
      guidance:
        "Calling `posthog.identify()` with an id that can be reused across different real users (e.g. a shared device id, or calling it again after logout with a new anonymous session before a fresh login) can merge two people's event history under one identity — identify with a stable, unique user id only after real authentication.",
      severityHint: "P2",
      docsUrl: "https://posthog.com/docs/product-analytics/identify",
    },
    {
      id: "missing-reset-on-logout",
      title: "Missing `posthog.reset()` on logout leaks the next user's session",
      guidance:
        "Without calling `posthog.reset()` on logout, the next person to use a shared device (or the next anonymous session) inherits the previous user's distinct_id and can have their events attributed to the prior identity.",
      severityHint: "P2",
      docsUrl: "https://posthog.com/docs/product-analytics/identify#resetting-a-user",
    },
    {
      id: "capture-in-hot-path-uncapped",
      title: "Uncapped `capture()` calls in a hot loop or high-frequency handler",
      guidance:
        "Calling `posthog.capture()` inside a scroll/mousemove handler, a tight render loop, or per-row in a large list without debouncing/sampling can flood event volume and skew analytics as well as add client-side overhead — batch, debounce, or sample high-frequency events.",
      severityHint: "P3",
      docsUrl: "https://posthog.com/docs/product-analytics/capture-events",
    },
  ],
}
