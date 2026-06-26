// src/do/tenant-concurrency.ts
import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
import { emptyState, decideAcquire, release, findExpiredLeaseIds, type FairnessState } from "@/src/features/tenancy"

const STATE_KEY = "fairness"
const REAP_INTERVAL_MS = 60_000

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export class TenantConcurrencyDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/acquire") return this.handleAcquire(request)
    if (request.method === "POST" && url.pathname === "/release") return this.handleRelease(request)
    return json(404, { error: "unknown route" })
  }

  private async load(): Promise<FairnessState> {
    return (await this.ctx.storage.get<FairnessState>(STATE_KEY)) ?? emptyState()
  }

  private async handleAcquire(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json(400, { error: "invalid json" })
    }
    const { leaseId, cap } = body as { leaseId: unknown; cap: unknown }
    if (typeof leaseId !== "string" || typeof cap !== "number") {
      return json(400, { error: "leaseId (string) and cap (number) required" })
    }
    const result = decideAcquire({ state: await this.load(), leaseId, cap, nowMs: Date.now(), rand: Math.random() })
    await this.ctx.storage.put(STATE_KEY, result.state)
    if (result.state.leases.length > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + REAP_INTERVAL_MS)
    }
    return json(200, { granted: result.granted, retryAfterMs: result.retryAfterMs })
  }

  private async handleRelease(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json(400, { error: "invalid json" })
    }
    const { leaseId } = body as { leaseId: unknown }
    if (typeof leaseId !== "string") {
      return json(400, { error: "leaseId (string) required" })
    }
    const state = release(await this.load(), leaseId)
    await this.ctx.storage.put(STATE_KEY, state)
    if (state.leases.length === 0) await this.ctx.storage.deleteAlarm()
    return json(200, { ok: true })
  }

  override async alarm(): Promise<void> {
    let state = await this.load()
    for (const leaseId of findExpiredLeaseIds(state, Date.now())) {
      state = release(state, leaseId)
      console.log(JSON.stringify({ event: "fairness-lease-reclaimed", leaseId, tenant: this.ctx.id.toString() }))
    }
    await this.ctx.storage.put(STATE_KEY, state)
    if (state.leases.length > 0) await this.ctx.storage.setAlarm(Date.now() + REAP_INTERVAL_MS)
  }
}
