// KV-backed implementation of AgentLoopTelemetrySink for the Phase 3
// bake-off harness.
//
// Sink contract (per spec v14):
//   - Computes singleShotPromptHash / singleShotSchemaHash /
//     promptBuilderSourceHash via Web Crypto SHA-256 on the UNTRUNCATED
//     inputs (so hashes reflect the actual prompt that ran).
//   - Truncates agentInitialUserMessage and singleShotPrompt to 32KB
//     each, sets per-field truncation flags.
//   - Runs a small secret-pattern scrubber on the truncated copies.
//   - Writes the resulting StoredAgentLoopTelemetryPayload to KV with
//     a reverse-timestamped key (newest-first prefix scan).
//   - Internal 5s wall-clock cap on the write — soft-fails on timeout.
//   - The agent loop ALSO wraps record() in its own withComposedTimeout
//     defense-in-depth.

import type {
  AgentLoopTelemetryRecordInput,
  AgentLoopTelemetrySink,
} from "./agent-loop"

const MAX_FIELD_BYTES = 32 * 1024
const SECRET_PATTERNS: RegExp[] = [
  /gh[poustr]_[A-Za-z0-9_]{36,}/g,
  /sk-[A-Za-z0-9]{40,}/g,
  /xox[baprs]-[A-Za-z0-9-]{20,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key
]
const KEY_PREFIX = "agent-loop-telemetry"
const TTL_DAYS = 30

interface StoredPayload extends Omit<AgentLoopTelemetryRecordInput,
  "agentInitialUserMessage" | "singleShotPrompt" | "promptBuilderSource"> {
  agentInitialUserMessage: string
  agentInitialUserMessageTruncated: boolean
  singleShotPrompt: string
  singleShotPromptTruncated: boolean
  singleShotPromptHash: string
  singleShotSchemaHash: string
  promptBuilderSourceHash: string
}

let memoizedSourceHash: { source: string; hash: string } | null = null

export function makeKvTelemetrySink(kv: KVNamespace): AgentLoopTelemetrySink {
  return {
    async record(input) {
      // Sink's own internal 5s cap (per Kimi round-5). The loop also
      // wraps with the same — defense in depth.
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5_000)
      try {
        const payload = await buildStoredPayload(input)
        const key = `${KEY_PREFIX}:${reverseTimestamp()}:${input.surface}:${input.commentId}`
        await kv.put(key, JSON.stringify(payload), {
          expirationTtl: TTL_DAYS * 24 * 60 * 60,
        })
      } catch (e) {
        // Soft-fail. The loop catches our throw too as another layer
        // of defense. We just log and continue.
        console.warn("[agent-loop-telemetry] sink failed", { error: String(e) })
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

async function buildStoredPayload(
  input: AgentLoopTelemetryRecordInput,
): Promise<StoredPayload> {
  // Hashes computed on UNTRUNCATED inputs (Codex round-3) so they
  // reflect what actually ran, not what got stored.
  const singleShotPromptHash = await sha256Hex(input.singleShotPrompt)
  const singleShotSchemaHash = await sha256Hex(canonicalizeJson(input.singleShotSchema))
  const promptBuilderSourceHash = await memoizedSha256(input.promptBuilderSource)

  const agentTrunc = truncateAndRedact(input.agentInitialUserMessage)
  const singleShotTrunc = truncateAndRedact(input.singleShotPrompt)

  const out: StoredPayload = {
    schemaVersion: input.schemaVersion,
    model: input.model,
    surface: input.surface,
    commentId: input.commentId,
    turns: input.turns,
    toolCalls: input.toolCalls,
    totalMs: input.totalMs,
    finalAnswer: input.finalAnswer,
    agentInitialUserMessage: agentTrunc.text,
    agentInitialUserMessageTruncated: agentTrunc.truncated,
    singleShotPrompt: singleShotTrunc.text,
    singleShotPromptTruncated: singleShotTrunc.truncated,
    singleShotSchema: input.singleShotSchema,
    promptBuilderVersion: input.promptBuilderVersion,
    singleShotPromptHash,
    singleShotSchemaHash,
    promptBuilderSourceHash,
  }
  if (typeof input.prNumber === "number") out.prNumber = input.prNumber
  if (input.fallback) out.fallback = input.fallback
  return out
}

function truncateAndRedact(input: string): { text: string; truncated: boolean } {
  let scrubbed = input
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, "[REDACTED]")
  }
  if (scrubbed.length <= MAX_FIELD_BYTES) {
    return { text: scrubbed, truncated: false }
  }
  return {
    text: scrubbed.slice(0, MAX_FIELD_BYTES) + "\n[…truncated…]",
    truncated: true,
  }
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function memoizedSha256(source: string): Promise<string> {
  if (memoizedSourceHash && memoizedSourceHash.source === source) {
    return memoizedSourceHash.hash
  }
  const hash = await sha256Hex(source)
  memoizedSourceHash = { source, hash }
  return hash
}

/**
 * Stable JSON canonicalization for hashing. Sort keys deeply so
 * `{a:1,b:2}` and `{b:2,a:1}` produce identical hashes.
 */
function canonicalizeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  function walk(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v
    if (seen.has(v as object)) return null // cycle guard
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(walk)
    const obj = v as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = walk(obj[key])
    }
    return sorted
  }
  return JSON.stringify(walk(value))
}

/**
 * Reverse-timestamp string (Kimi round-2) — "9999999999999 - now()"
 * zero-padded, so a KV `list({prefix})` returns newest-first when sorted
 * lexicographically.
 */
function reverseTimestamp(): string {
  return String(9_999_999_999_999 - Date.now()).padStart(13, "0")
}
