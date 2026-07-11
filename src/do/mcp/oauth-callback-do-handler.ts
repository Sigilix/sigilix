import {
  McpOAuthCallbackRegistry,
  parsePendingMcpOAuthCallbackRoute,
  type McpOAuthCallbackRoute,
} from "./oauth-callback-routing"
import { json } from "./mcp-connections-support"
import type { Env } from "@/src/shared/types/env"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"

const MAX_BODY_BYTES = 16 * 1024

/** Strongly-consistent state-machine endpoints hosted in the state-hash DO. */
export class McpOAuthCallbackDoHandler {
  private readonly routes: McpOAuthCallbackRegistry

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: Env,
  ) {
    this.routes = new McpOAuthCallbackRegistry(storage)
  }

  async handle(action: string, request: Request): Promise<Response> {
    const body = await readObject(request)
    if (body instanceof Response) return body
    if (action === "create") {
      const candidate = parsePendingMcpOAuthCallbackRoute(body)
      if (!candidate) return json({ error: "invalid_route" }, 400)
      const route = this.routes.create(candidate)
      if (!route) return json({ error: "route_conflict" }, 409)
      await this.storage.setAlarm(route.expiresAt)
      return json({ route }, 201)
    }
    const stateHash = typeof body.stateHash === "string" ? body.stateHash : ""
    const ownerScope = typeof body.ownerScope === "string" ? body.ownerScope : ""
    const stableSubject = typeof body.stableSubject === "string" ? body.stableSubject : ""
    if (action === "read") {
      const route = this.routes.readBound(stateHash, ownerScope, stableSubject)
      return route ? json({ route }) : json({ error: "not_found" }, 404)
    }
    if (action === "claim") {
      const claimId = typeof body.claimId === "string" ? body.claimId : ""
      const result = this.routes.claim(stateHash, ownerScope, stableSubject, claimId)
      if (!result) return json({ error: "not_found" }, 404)
      if (result.outcome === "terminal" && result.expired && !(await this.cleanup(result.route))) {
        this.routes.deferFailedCleanup(result.route.stateHash, Date.now() + 60_000)
      }
      const next = this.routes.nextAlarm()
      if (next !== null) await this.storage.setAlarm(next)
      return json(result)
    }
    if (action === "finalize") {
      const claimId = typeof body.claimId === "string" ? body.claimId : ""
      const status = body.status === "completed" || body.status === "failed" ? body.status : null
      if (!status) return json({ error: "invalid_status" }, 400)
      const route = this.routes.finalize(stateHash, ownerScope, stableSubject, claimId, status)
      if (!route) return json({ error: "claim_lost" }, 409)
      await this.storage.setAlarm(route.expiresAt)
      return json({ route })
    }
    return json({ error: "not_found" }, 404)
  }

  async alarm(): Promise<void> {
    const expired = this.routes.expireDue()
    if (expired?.status === "failed") {
      const terminalRetentionElapsed = expired.expiresAt <= Date.now()
      if (await this.cleanup(expired)) {
        if (terminalRetentionElapsed) this.routes.deleteFailed(expired.stateHash)
      } else {
        this.routes.deferFailedCleanup(expired.stateHash, Date.now() + 60_000)
      }
    }
    const next = this.routes.nextAlarm()
    if (next !== null) await this.storage.setAlarm(next)
  }

  private async cleanup(route: McpOAuthCallbackRoute): Promise<boolean> {
    const owner = this.env.MCP_CONNECTIONS.get(this.env.MCP_CONNECTIONS.idFromName(route.ownerScope))
    const tenant = this.env.MCP_CONNECTIONS.get(this.env.MCP_CONNECTIONS.idFromName(route.tenantScope))
    const [ownerClean, tenantClean] = await Promise.all([
      retry(owner, `https://mcp-connections.do/servers/${encodeURIComponent(route.serverId)}`, "DELETE"),
      cleanupTenantGrant(tenant, route.grantId),
    ])
    return ownerClean && tenantClean
  }
}

async function cleanupTenantGrant(stub: DurableObjectStub, grantId: string): Promise<boolean> {
  const failUrl = `https://mcp-connections.do/grants/${encodeURIComponent(grantId)}/fail`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await stub.fetch(failUrl, { method: "POST" })
      if (response.status === 404) return true
      if (!response.ok) continue
      const value = (await response.json()) as { grant?: { status?: unknown } }
      if (value.grant?.status === "failed" || value.grant?.status === "revoked") return true
      break
    } catch {
      // Retry once before taking the terminal revoke path.
    }
  }
  return retry(stub, `https://mcp-connections.do/broker/servers/${encodeURIComponent(grantId)}`, "DELETE")
}

async function retry(stub: DurableObjectStub, url: string, method: "DELETE" | "POST"): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await stub.fetch(url, { method })
      if (response.ok || response.status === 404) return true
    } catch {
      // Alarm retry persists below when both immediate attempts fail.
    }
  }
  return false
}

async function readObject(request: Request): Promise<Record<string, unknown> | Response> {
  const raw = await readBodyCapped(request, MAX_BODY_BYTES)
  if (raw === null) return json({ error: "payload_too_large" }, 413)
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : json({ error: "invalid json" }, 400)
  } catch {
    return json({ error: "invalid json" }, 400)
  }
}
