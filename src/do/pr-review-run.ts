// ARC-190 Task 2 stub — to be filled in Tasks 2/5/6.
//
// The class MUST be exported from `src/index.ts` (see end of that
// file) for the wrangler `[[durable_objects.bindings]]` to register.
// Until Task 2 lands the helper signatures, the class just 404s on
// every route — the env gate (`OPENCLAW_PR_REVIEW_MODE === "off"`)
// guarantees nothing actually fetches the DO until Task 8 wires the
// webhook integration.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "../index"

export class PrReviewRunDO extends DurableObject<Env> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async fetch(_request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({ error: "not-implemented", reason: "ARC-190 Task 2 pending" }),
      { status: 501, headers: { "content-type": "application/json" } },
    )
  }
}
