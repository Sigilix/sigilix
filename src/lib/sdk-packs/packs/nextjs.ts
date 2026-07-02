// SIG-298 follow-on — SDK guidance pack: Next.js. Self-authored from Next.js's
// public docs (nextjs.org/docs). NOT a partner integration — no endorsement
// claim, no logo; the label is "SDK guidance."

import type { SdkPack } from "@/src/lib/sdk-packs/types"

const DOCS_URL = "https://nextjs.org/docs"

export const nextjsPack: SdkPack = {
  id: "nextjs",
  vendor: "Next.js",
  docsUrl: DOCS_URL,
  matchers: {
    packages: ["next"],
    importPatterns: [/from\s+["']next\//, /from\s+["']next["']/],
    pathGlobs: ["**/app/**/*.tsx", "**/app/**/*.ts", "**/pages/api/**/*.ts", "**/middleware.ts"],
  },
  rules: [
    {
      id: "server-client-boundary-secrets",
      title: "Don't leak server-only values across the client boundary",
      guidance:
        'A Server Component or route handler passing an object with a secret/token field as a prop into a Client Component, or importing a server-only module (DB client, service-role key) into a file marked `"use client"`, ships that value to the browser bundle.',
      severityHint: "P1",
      docsUrl: "https://nextjs.org/docs/app/building-your-application/rendering/composition-patterns",
    },
    {
      id: "route-handler-default-caching",
      title: "Route Handler GET caching defaults can serve stale data",
      guidance:
        'A `GET` Route Handler that reads dynamic data (DB, auth-scoped, or per-request) without `export const dynamic = "force-dynamic"` or a `no-store` fetch option may be statically cached and served stale/shared across users — this is a common source of "why is everyone seeing the same data" bugs.',
      severityHint: "P1",
      docsUrl: "https://nextjs.org/docs/app/building-your-application/caching",
    },
    {
      id: "dynamic-apis-need-await",
      title: "`cookies()` / `headers()` / `params` / `searchParams` are async",
      guidance:
        "Since Next.js 15, `cookies()`, `headers()`, `draftMode()`, and the `params`/`searchParams` props are Promises — accessing them synchronously (no `await`) either throws or silently returns a Promise object where a value was expected; a partially-migrated diff mixing both patterns is a real bug, not a style nit.",
      severityHint: "P1",
      docsUrl: "https://nextjs.org/docs/app/building-your-application/upgrading/version-15",
    },
    {
      id: "middleware-runs-on-every-matched-request",
      title: "Middleware matcher scope and cost",
      guidance:
        "Middleware runs on the Edge runtime for every request matching its `matcher` (or all requests if unset) — expensive work (DB calls, large deps) in middleware, or a matcher that's broader than intended (catching static assets, `_next/*`), adds latency/cost to routes that didn't need it.",
      severityHint: "P2",
      docsUrl: "https://nextjs.org/docs/app/building-your-application/routing/middleware",
    },
    {
      id: "server-action-missing-auth-check",
      title: "Server Actions are public HTTP endpoints — re-check auth inside them",
      guidance:
        "A Server Action is callable directly (not just from the UI that references it) once its action id is known — it must re-verify auth/authorization itself, not rely on the calling component being behind a client-side auth gate.",
      severityHint: "P1",
      docsUrl:
        "https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations#authentication-and-authorization",
    },
    {
      id: "revalidatepath-tag-scope",
      title: "`revalidatePath`/`revalidateTag` scope mismatches",
      guidance:
        "Calling `revalidatePath` with the wrong path (or a static path when the actual route is dynamic, e.g. missing the `[id]` segment) silently no-ops — the cache never actually invalidates and the mutation's effect doesn't show up until the next full rebuild/deploy.",
      severityHint: "P2",
      docsUrl: "https://nextjs.org/docs/app/api-reference/functions/revalidatePath",
    },
    {
      id: "env-var-public-prefix",
      title: "`NEXT_PUBLIC_` env vars are bundled into client JS",
      guidance:
        "Any env var prefixed `NEXT_PUBLIC_` is inlined into the client bundle at build time and is visible to anyone — a secret, service-role key, or internal API URL accidentally given that prefix is a public leak, not a config typo.",
      severityHint: "P1",
      docsUrl:
        "https://nextjs.org/docs/app/building-your-application/configuring/environment-variables#bundling-environment-variables-for-the-browser",
    },
    {
      id: "image-remote-patterns",
      title: "`next/image` remote sources must be allowlisted",
      guidance:
        "`next/image` requires remote image hosts to be explicitly allowlisted via `images.remotePatterns` in `next.config.js` — a broad wildcard pattern (or `unoptimized: true` used to route around the allowlist for a user-controlled URL) can turn the image optimizer into an open proxy/SSRF vector.",
      severityHint: "P2",
      docsUrl: "https://nextjs.org/docs/app/api-reference/components/image#remotepatterns",
    },
  ],
}
