import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
import { normalizeEnv } from "@/src/shared/util/normalize-env"

const RECORD_KEY = "capability"
const MAX_TOOLS = 16
const MAX_CATALOG_READS = 8
const MAX_CALLS = 4
const MAX_TTL_MS = 15 * 60_000
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AgentMcpToolBinding {
  localName: string
  grantId: string
  vendor: string
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AgentMcpCapabilityRecord {
  version: 1
  capabilityHash: string
  runId: string
  installationId: number
  owner: string
  repo: string
  surface: "agent"
  tools: AgentMcpToolBinding[]
  expiresAt: number
  maxCalls: number
  callsUsed: number
  catalogReadsUsed: number
}

export type AgentMcpCapabilityContext = Omit<AgentMcpCapabilityRecord, "capabilityHash">

export type AgentMcpCapabilityAuthorization =
  | { ok: true; context: AgentMcpCapabilityContext }
  | { ok: false; reason: "missing" | "mismatch" | "expired" | "budget" }

export type AgentMcpCapabilityUse = "catalog" | "invoke" | "revalidate"

function safeEqualHex(a: string, b: string): boolean {
  // Both digests are format-checked as 64 hex characters before this call;
  // this loop always visits every character regardless of matching prefix.
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

function safeIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value)
}

function validRecord(record: AgentMcpCapabilityRecord, now: number): boolean {
  if (
    record.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(record.capabilityHash) ||
    !RUN_ID_PATTERN.test(record.runId) ||
    !Number.isSafeInteger(record.installationId) ||
    record.installationId <= 0 ||
    record.owner.length === 0 ||
    record.owner.length > 100 ||
    record.repo.length === 0 ||
    record.repo.length > 100 ||
    record.surface !== "agent" ||
    !Number.isSafeInteger(record.expiresAt) ||
    record.expiresAt <= now ||
    record.expiresAt - now > MAX_TTL_MS ||
    record.maxCalls !== MAX_CALLS ||
    record.callsUsed !== 0 ||
    record.catalogReadsUsed !== 0 ||
    record.tools.length === 0 ||
    record.tools.length > MAX_TOOLS
  ) {
    return false
  }
  const localNames = new Set<string>()
  const tuples = new Set<string>()
  for (const [index, tool] of record.tools.entries()) {
    const tuple = `${tool.grantId}\u0000${tool.toolName}`
    if (
      tool.localName !== `mcp_${index}` ||
      !safeIdentifier(tool.grantId) ||
      !safeIdentifier(tool.vendor) ||
      !safeIdentifier(tool.toolName) ||
      tool.description.length === 0 ||
      tool.description.length > 1_024 ||
      localNames.has(tool.localName) ||
      tuples.has(tuple)
    ) {
      return false
    }
    localNames.add(tool.localName)
    tuples.add(tuple)
  }
  return true
}

function publicContext(record: AgentMcpCapabilityRecord): AgentMcpCapabilityContext {
  const { capabilityHash: _capabilityHash, ...context } = record
  return context
}

/**
 * One globally-consistent capability object per agent run. Only a SHA-256
 * digest of the opaque bearer is persisted; the raw bearer remains in the
 * trusted dispatch/container process and is never written to Durable Object
 * storage.
 */
export class AgentMcpCapabilityDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, normalizeEnv(env))
  }

  async initialize(record: AgentMcpCapabilityRecord): Promise<boolean> {
    const now = Date.now()
    if (!validRecord(record, now)) return false
    const created = await this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<AgentMcpCapabilityRecord>(RECORD_KEY)) !== undefined) return false
      await transaction.put(RECORD_KEY, record)
      return true
    })
    if (!created) return false
    try {
      await this.ctx.storage.setAlarm(record.expiresAt)
      return true
    } catch (error) {
      await this.clearStorage()
      throw error
    }
  }

  async authorize(capabilityHash: string, use: AgentMcpCapabilityUse): Promise<AgentMcpCapabilityAuthorization> {
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AgentMcpCapabilityRecord>(RECORD_KEY)
      if (!record) return { ok: false, reason: "missing" }
      if (!/^[a-f0-9]{64}$/.test(capabilityHash) || !safeEqualHex(record.capabilityHash, capabilityHash)) {
        return { ok: false, reason: "mismatch" }
      }
      if (Date.now() >= record.expiresAt) {
        await transaction.delete(RECORD_KEY)
        return { ok: false, reason: "expired" }
      }
      if (use === "catalog") {
        if (record.catalogReadsUsed >= MAX_CATALOG_READS) return { ok: false, reason: "budget" }
        record.catalogReadsUsed += 1
        await transaction.put(RECORD_KEY, record)
      } else if (use === "invoke") {
        if (record.callsUsed >= record.maxCalls) return { ok: false, reason: "budget" }
        record.callsUsed += 1
        await transaction.put(RECORD_KEY, record)
      }
      return { ok: true, context: publicContext(record) }
    })
  }

  async revoke(): Promise<void> {
    await this.clearStorage()
  }

  override async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<AgentMcpCapabilityRecord>(RECORD_KEY)
    await this.clearStorage()
    if (record) {
      console.log(JSON.stringify({ event: "agent-mcp-capability-expired", runId: record.runId }))
    }
  }

  private async clearStorage(): Promise<void> {
    // The Worker compatibility date predates deleteAll() clearing alarms.
    // Delete the authorization record first so even a later metadata-cleanup
    // failure cannot leave a usable capability behind.
    await this.ctx.storage.delete(RECORD_KEY)
    let alarmError: unknown
    try {
      await this.ctx.storage.deleteAlarm()
    } catch (error) {
      alarmError = error
    }
    await this.ctx.storage.deleteAll()
    if (alarmError) throw alarmError
  }
}
