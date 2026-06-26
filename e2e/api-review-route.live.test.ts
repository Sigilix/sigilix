// SIG-492 M2 — a REAL-ENGINE e2e for POST /v1/review (Mode A, diff-only). The unit
// test (src/lib/api-review-route.test.ts) mocks the engine; this drives a real diff
// through the route end-to-end so the `diffReviewClient(...) as unknown as GitHubClient`
// cast is exercised on the live path: if the engine called a method the diff client
// doesn't implement, the orchestrator would throw and the route would 500 — so a 200
// with a built verdict IS the proof the cast is sound. No GitHub needed (Mode A is
// diff-only); needs OPENROUTER_API_KEY → SKIPS in CI (`npm run build`) so the gate
// stays green. Run manually:
//
//   OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY' .dev.vars | cut -d= -f2-)" \
//   npx vitest run e2e/api-review-route.live.test.ts

import { describe, it, expect } from "vitest"
import { handleReviewApiRoute } from "@/src/lib/api-review-route"
import { createLocalEnv } from "@/src/cli/adapters/local-env"
import type { Env } from "@/src/shared/types/env"

const OR_KEY = process.env.OPENROUTER_API_KEY
const TOKEN = "live-test-key"

// A small, blatantly-buggy new file so the ensemble reliably returns ≥1 finding:
// a raw-string SQL query (injection), an assignment-in-condition auth bypass, and an
// un-awaited async authorization check. The diff is the ONLY context (Mode A is
// ungrounded), which is exactly the surface this endpoint serves.
const DIFF = `diff --git a/src/pay.ts b/src/pay.ts
new file mode 100644
--- /dev/null
+++ b/src/pay.ts
@@ -0,0 +1,12 @@
+export async function isAuthorized(req: { userId: string }): Promise<boolean> {
+  return checkAcl(req.userId)
+}
+
+export async function refund(req: { userId: string; role: string; amount: number; targetId: string }, db: Db) {
+  // assignment, not comparison — always true → privilege escalation
+  if (req.role = "admin") return forceRefund(db, req.targetId, req.amount)
+  // missing await — the Promise is truthy, so the guard never blocks
+  if (!isAuthorized(req)) throw new Error("forbidden")
+  // string-concatenated SQL → injection
+  return db.query("UPDATE accounts SET balance = balance + " + req.amount + " WHERE id = '" + req.targetId + "'")
+}
`

function reviewRequest(diff: string): Request {
  return new Request("https://api.sigilix.ai/v1/review", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ owner: "live", repo: "live", prNumber: 1, headSha: "deadbeef", diff }),
  })
}

describe.skipIf(!OR_KEY)("SIG-492 — POST /v1/review Mode A live (diff-client cast soundness)", () => {
  it("runs the real engine through the route, returns a verdict, and the diff-client cast does not throw", async () => {
    const env = {
      ...createLocalEnv({ processEnv: { ...process.env, OPENROUTER_API_KEY: OR_KEY, OLLAMA_CHAT_ENABLE: "on" } }),
      OPENCLAW_SIGILIX_API_KEY: TOKEN,
    } as unknown as Env

    const res = await handleReviewApiRoute(reviewRequest(DIFF), env, { waitUntil: () => {} } as unknown as ExecutionContext)

    // A missing-method throw on the injected client would surface as 500 (review_failed);
    // 200 with a verdict proves the cast is sound on the real engine path.
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { verdict?: { findings?: unknown[] }; unanchoredFindings?: unknown[] } | null
    expect(body, "a real review of a buggy diff must return a built DryRunReview (not 200 null)").not.toBeNull()
    expect(body!.verdict).toBeDefined()
    expect(Array.isArray(body!.verdict!.findings)).toBe(true)
    // The diff is egregiously buggy → the ensemble should surface at least one finding.
    expect(body!.verdict!.findings!.length).toBeGreaterThan(0)
  }, 300_000)
})
