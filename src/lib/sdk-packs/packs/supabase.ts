// SIG-298 follow-on — SDK guidance pack: Supabase. Self-authored from
// Supabase's public docs (supabase.com/docs). NOT a partner integration —
// no endorsement claim, no logo; the label is "SDK guidance."

import type { SdkPack } from "@/src/lib/sdk-packs/types"

const DOCS_URL = "https://supabase.com/docs"

export const supabasePack: SdkPack = {
  id: "supabase",
  vendor: "Supabase",
  docsUrl: DOCS_URL,
  matchers: {
    packages: ["@supabase/supabase-js", "@supabase/ssr", "@supabase/auth-helpers-nextjs"],
    importPatterns: [/from\s+["']@supabase\//, /require\(\s*["']@supabase\//],
  },
  rules: [
    {
      id: "service-role-key-exposure",
      title: "Service-role key must never reach client code",
      guidance:
        "The `service_role` key bypasses Row Level Security entirely — a `createClient` call using it inside a Client Component, a public API route without server-only guarding, or a `NEXT_PUBLIC_*`-prefixed env var is a full-database-access credential leak.",
      severityHint: "P1",
      docsUrl: "https://supabase.com/docs/guides/api/api-keys",
    },
    {
      id: "rls-assumed-not-verified",
      title: "A new table needs RLS enabled AND policies, not just RLS enabled",
      guidance:
        "Enabling Row Level Security with no policies defined blocks ALL access (including the owner's own reads) by default, while a table left with RLS disabled is fully open to anyone with the anon/public key — a migration adding a table should also add both `ENABLE ROW LEVEL SECURITY` and the intended policies in the same change.",
      severityHint: "P1",
      docsUrl: "https://supabase.com/docs/guides/database/postgres/row-level-security",
    },
    {
      id: "client-key-vs-server-key-misuse",
      title: "Don't use the anon key where a session-aware server client is required",
      guidance:
        "Server-side code (a Route Handler, Server Action, or API route) that reads/writes user data should use a request-scoped server client (cookie-based session) — using a bare anon-key client instead runs the query as an unauthenticated/anonymous user, which under RLS either fails or, worse, matches an overly permissive anonymous-access policy.",
      severityHint: "P1",
      docsUrl: "https://supabase.com/docs/guides/auth/server-side/nextjs",
    },
    {
      id: "auth-getuser-vs-getsession",
      title: "Use `getUser()`, not `getSession()`, to authorize a server-side request",
      guidance:
        "`getSession()` reads the session from local storage/cookies WITHOUT revalidating against the Supabase Auth server, so it can return a stale or spoofable session in a server context — `getUser()` makes a network call to verify the JWT and is the one to gate access with.",
      severityHint: "P1",
      docsUrl: "https://supabase.com/docs/guides/auth/server-side/nextjs#creating-a-client",
    },
    {
      id: "policy-using-vs-with-check",
      title: "RLS `USING` vs `WITH CHECK` — a write policy needs both for UPDATE",
      guidance:
        "An `UPDATE` policy with only `USING` (no `WITH CHECK`) lets a row be updated INTO a state the policy wouldn't have allowed for a fresh insert — e.g. a user could update a row they own to reassign it to another user_id if `WITH CHECK` isn't also constraining the new row values.",
      severityHint: "P2",
      docsUrl: "https://supabase.com/docs/guides/database/postgres/row-level-security#policies",
    },
    {
      id: "storage-bucket-public-by-default",
      title: "A Storage bucket created as public serves files to anyone with the URL",
      guidance:
        "`createBucket(..., { public: true })` (or a bucket left public in the dashboard) means any file's URL is fetchable by anyone, bypassing RLS entirely — buckets holding user-private or sensitive files should be private, accessed via signed URLs.",
      severityHint: "P1",
      docsUrl: "https://supabase.com/docs/guides/storage/security/access-control",
    },
    {
      id: "realtime-subscription-rls-scope",
      title: "Realtime subscriptions are still subject to RLS — but check the filter",
      guidance:
        "A `postgres_changes` subscription without a scoped filter (e.g. `filter: 'user_id=eq.${id}'`) relies entirely on RLS to prevent leaking other users' row-change events to a client — if RLS on that table is misconfigured, the client-side filter is the only thing actually narrowing what's received.",
      severityHint: "P2",
      docsUrl: "https://supabase.com/docs/guides/realtime/postgres-changes",
    },
  ],
}
