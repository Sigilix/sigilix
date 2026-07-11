import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

const DO_BASE = "https://mcp-connections.do"
const MAX_DELAY_SECONDS = 24 * 60 * 60
type ExpireJob = Extract<JobMessage, { type: "mcp-memory-expire" }>

/** Queue consumer for absolute MCP-memory TTL. At-least-once delivery and an
 * early delivery are both normal: the tenant DO's expected-expiry predicate is
 * the source of truth, and an early message is re-sent for the remainder. */
export async function handleMcpMemoryExpireJob(job: ExpireJob, env: Env): Promise<void> {
  validateJob(job)
  const stub = env.MCP_CONNECTIONS.get(env.MCP_CONNECTIONS.idFromName(`tenant:${job.installationId}`))
  const response = await stub.fetch(`${DO_BASE}/broker/memory/expire`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      memoryId: job.memoryId,
      expectedExpiresAt: job.expectedExpiresAt,
    }),
  })
  if (!response.ok) throw new Error(`mcp memory expiry failed (${response.status})`)
  const value = (await response.json()) as { outcome?: unknown; rescheduleAt?: unknown }
  if (value.outcome !== "early") return
  if (!Number.isSafeInteger(value.rescheduleAt) || Number(value.rescheduleAt) <= Date.now()) {
    throw new Error("invalid MCP memory expiry reschedule")
  }
  const delaySeconds = Math.max(
    1,
    Math.min(MAX_DELAY_SECONDS, Math.ceil((Number(value.rescheduleAt) - Date.now()) / 1_000)),
  )
  await env.OPENCLAW_JOBS.send(job, { delaySeconds })
}

function validateJob(job: ExpireJob): void {
  if (
    !Number.isSafeInteger(job.installationId) ||
    job.installationId <= 0 ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(job.memoryId) ||
    !Number.isSafeInteger(job.expectedExpiresAt) ||
    job.expectedExpiresAt < 0
  ) {
    throw new TypeError("invalid MCP memory expiry job")
  }
}
