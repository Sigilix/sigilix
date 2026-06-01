// SIG-285 PR 2: GET /metrics/verification — authenticated read of the rolling
// verification-by-execution verdict distribution. Answers the load-bearing
// question (what fraction of findings are mechanically REFUTABLE) without log
// access. Guarded by the shared OPENCLAW_VALIDATION_METRICS_TOKEN (same as the
// other /metrics/* endpoints); reports the current OPENCLAW_VERIFICATION_MODE so
// the reader knows the numbers reflect shadow vs off.

import type { Env } from "../index"
import { requireBearerToken } from "./auth-bearer"
import { queryVerificationMetrics } from "./verification-metrics-client"
import { readVerificationMode } from "./verification/mode"
import { parseReceiptJoinMode } from "./verification/verify-finding-receipt"
import { parseTrustLedgerMode } from "./trust-ledger-thread"

const DEFAULT_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 30

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function parseWindowDays(raw: string | null): number | null {
  if (raw === null) return DEFAULT_WINDOW_DAYS
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) return null
  return n
}

export async function handleVerificationMetricsRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_VALIDATION_METRICS_TOKEN
  if (!token) {
    return json({ error: "metrics_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }

  const windowDays = parseWindowDays(new URL(request.url).searchParams.get("window"))
  if (windowDays === null) {
    return json({ error: "invalid_window", detail: `window must be 1-${MAX_WINDOW_DAYS} days` }, 400)
  }

  const metrics = await queryVerificationMetrics(env, windowDays)

  return json(
    {
      window: metrics.window,
      mode: readVerificationMode(env),
      total: metrics.total,
      // The headline signals: how much is checkable + how much would demote.
      refutableFraction: metrics.refutableFraction,
      refutedFraction: metrics.refutedFraction,
      byVerdict: metrics.byVerdict,
      counts: metrics.counts,
      // SIG-285 v2 PR2: the receipt-join measurement (separate corpus). Its
      // `refutableEligibleFraction` is THE load-bearing number deciding whether
      // PR4/5 (demote) is worth building vs receipts-as-trust.
      receiptJoinMode: parseReceiptJoinMode(env.OPENCLAW_RECEIPTJOIN_MODE),
      receiptJoin: metrics.receiptJoin,
      // SIG Trust Ledger v0: the per-finding trust tier distribution (separate
      // corpus). `trustLedgerMode` tells the reader whether the numbers are
      // accruing (shadow/on) or the ledger is off.
      trustLedgerMode: parseTrustLedgerMode(env.OPENCLAW_TRUST_LEDGER),
      trustLedger: metrics.trustLedger,
    },
    200,
  )
}
