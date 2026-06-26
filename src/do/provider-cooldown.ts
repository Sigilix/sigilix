// src/do/provider-cooldown.ts
import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"

const STATE_KEY = "cooldown"
const MAX_COOLDOWN_MS = 300_000 // 5 min — caps unbounded extension from 429 storms

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export class ProviderCooldownDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/set") return this.handleSet(request)
    if (request.method === "GET" && url.pathname === "/get") return this.handleGet()
    return json(404, { error: "unknown route" })
  }

  private async handleSet(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return json(400, { error: "invalid json" })
    }
    if (typeof body !== "object" || body === null) return json(400, { error: "invalid body" })
    const { cooldownMs } = body as { cooldownMs: unknown }
    if (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs < 0) {
      return json(400, { error: "cooldownMs (non-negative finite number) required" })
    }
    const now = Date.now()
    const stored = (await this.ctx.storage.get<{ cooldownUntil: number }>(STATE_KEY))?.cooldownUntil ?? 0
    // max-merge so a shorter later cooldown never shrinks a longer active one;
    // min-cap so a 429 storm can't extend the cooldown beyond MAX_COOLDOWN_MS.
    const cooldownUntil = Math.min(now + MAX_COOLDOWN_MS, Math.max(stored, now + cooldownMs))
    await this.ctx.storage.put(STATE_KEY, { cooldownUntil })
    return json(200, { cooldownUntil })
  }

  private async handleGet(): Promise<Response> {
    const stored = (await this.ctx.storage.get<{ cooldownUntil: number }>(STATE_KEY))?.cooldownUntil ?? 0
    const remainingMs = Math.max(0, stored - Date.now())
    return json(200, { remainingMs })
  }
}
