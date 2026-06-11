#!/usr/bin/env node
// Phase 3 bake-off harness — replay each Phase 3 agent-loop run through
// the single-shot path and store the two responses side-by-side for
// later inspection / scoring.
//
//   node scripts/phase3-bakeoff.mjs [--limit=N] [--surface=linear-mention|github-mention] [--out=DIR]
//
// Reads `agent-loop-telemetry:*` records from the production KV namespace
// (OPENCLAW_STATE = df689379ea6240f7808997a75ceaed7e), pages newest-first
// (the keys are reverse-timestamped at write time). For each record:
//
//   1. Pulls singleShotPrompt + singleShotSchema from the stored payload.
//   2. Sends it to Ollama Turbo /api/generate with the schema as `format`,
//      mirroring how the worker calls the single-shot path. Streaming so
//      we don't time out on long generations (matches src/lib/ollama.ts).
//   3. Writes a comparison record to disk: agent's stored finalAnswer,
//      replayed single-shot output, both prompts (already truncated to
//      32KB by the sink), schemas, timing, fallback flag, hashes.
//
// v1 is store-only — no LLM-as-judge pass. We need a corpus first; the
// judge can be a follow-up that consumes these comparison files.
//
// Auth (all three env vars required):
//   OLLAMA_API_KEY          — same key the worker uses (Ollama Turbo)
//   CLOUDFLARE_ACCOUNT_ID   — account that owns the OPENCLAW_STATE KV namespace
//   CLOUDFLARE_API_TOKEN    — token with Workers KV Read on that namespace
//
// We hit the Cloudflare REST API directly rather than shelling out to
// `wrangler kv key list`: wrangler's CLI doesn't accept a cursor flag,
// so it silently caps at 1000 keys per call. Using the REST API
// directly gives us proper cursor pagination + native fetch timeouts
// with no subprocess to babysit.

import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"

const KV_NAMESPACE_ID = "df689379ea6240f7808997a75ceaed7e"
const KEY_PREFIX = "agent-loop-telemetry:"
const OLLAMA_TURBO_URL = "https://ollama.com/api/generate"
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
const KV_LIST_PAGE_SIZE = 1000
const DEFAULT_TIMEOUT_MS = 600_000
const KV_REQUEST_TIMEOUT_MS = 30_000
const ALLOWED_SURFACES = new Set(["linear-mention", "github-mention"])

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
const apiKey = process.env.OLLAMA_API_KEY
const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID
const cfApiToken = process.env.CLOUDFLARE_API_TOKEN
const missingEnv = [
  ["OLLAMA_API_KEY", apiKey],
  ["CLOUDFLARE_ACCOUNT_ID", cfAccountId],
  ["CLOUDFLARE_API_TOKEN", cfApiToken],
]
  .filter(([, v]) => !v)
  .map(([k]) => k)
if (missingEnv.length > 0) {
  console.error(`error: missing required env var(s): ${missingEnv.join(", ")}`)
  process.exit(1)
}
if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 0)) {
  console.error(`error: --limit must be a non-negative integer (got ${args.limit})`)
  process.exit(1)
}

const runId = new Date().toISOString().replace(/[:.]/g, "-")
const outDir = args.out ? resolve(args.out) : resolve(`bakeoff-runs/${runId}`)
await mkdir(outDir, { recursive: true })

console.log(`[bakeoff] run ${runId}`)
console.log(`[bakeoff] output: ${outDir}`)
console.log(`[bakeoff] listing keys with prefix '${KEY_PREFIX}'…`)

const keys = await listKvKeys(KEY_PREFIX)
console.log(`[bakeoff] found ${keys.length} telemetry record(s)`)

let kept = keys
if (args.surface) {
  kept = kept.filter((k) => k.includes(`:${args.surface}:`))
  console.log(`[bakeoff] surface=${args.surface} → ${kept.length} record(s)`)
}
if (args.limit !== null) {
  if (kept.length > args.limit) kept = kept.slice(0, args.limit)
  console.log(`[bakeoff] limit=${args.limit} → ${kept.length} record(s)`)
}

if (kept.length === 0) {
  console.log("[bakeoff] nothing to replay — exiting clean")
  process.exit(0)
}

const summary = []
for (let i = 0; i < kept.length; i++) {
  const key = kept[i]
  const tag = `${i + 1}/${kept.length} ${key}`
  try {
    console.log(`[bakeoff] [${tag}] fetching payload`)
    const payload = await getKvJson(key)
    if (!payload || typeof payload !== "object") {
      console.warn(`[bakeoff] [${tag}] payload not an object — skipping`)
      continue
    }
    if (!payload.singleShotPrompt || !payload.singleShotSchema) {
      console.warn(`[bakeoff] [${tag}] missing singleShotPrompt/Schema — skipping`)
      continue
    }
    if (payload.singleShotPromptTruncated) {
      console.warn(`[bakeoff] [${tag}] singleShotPrompt was truncated at 32KB — replay may diverge from production`)
    }

    console.log(`[bakeoff] [${tag}] replaying single-shot (${payload.model})`)
    const t0 = Date.now()
    const replayed = await ollamaGenerate({
      model: payload.model,
      prompt: payload.singleShotPrompt,
      format: payload.singleShotSchema,
      apiKey,
    })
    const replayMs = Date.now() - t0

    const record = {
      runId,
      key,
      surface: payload.surface,
      commentId: payload.commentId,
      prNumber: payload.prNumber ?? null,
      model: payload.model,
      schemaVersion: payload.schemaVersion,
      promptBuilderVersion: payload.promptBuilderVersion,
      hashes: {
        singleShotPrompt: payload.singleShotPromptHash,
        singleShotSchema: payload.singleShotSchemaHash,
        promptBuilderSource: payload.promptBuilderSourceHash,
      },
      agent: {
        finalAnswer: payload.finalAnswer,
        turns: payload.turns,
        toolCalls: payload.toolCalls,
        totalMs: payload.totalMs,
        fallback: payload.fallback ?? null,
        agentInitialUserMessage: payload.agentInitialUserMessage,
        agentInitialUserMessageTruncated: !!payload.agentInitialUserMessageTruncated,
      },
      singleShotReplay: {
        rawResponse: replayed,
        parsedAnswer: tryParseJson(replayed),
        replayMs,
        replayedAt: new Date().toISOString(),
      },
      singleShotPrompt: payload.singleShotPrompt,
      singleShotPromptTruncated: !!payload.singleShotPromptTruncated,
      singleShotSchema: payload.singleShotSchema,
    }

    const fname = sanitizeKey(key) + ".json"
    await writeFile(join(outDir, fname), JSON.stringify(record, null, 2))
    summary.push({
      key,
      surface: payload.surface,
      model: payload.model,
      agentTurns: payload.turns,
      agentToolCalls: payload.toolCalls?.length ?? 0,
      agentMs: payload.totalMs,
      singleShotMs: replayMs,
      agentFallback: payload.fallback ?? null,
    })
    console.log(
      `[bakeoff] [${tag}] done — agent ${payload.totalMs}ms (${payload.turns} turns), single-shot ${replayMs}ms`,
    )
  } catch (e) {
    console.error(`[bakeoff] [${tag}] failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

await writeFile(
  join(outDir, "_summary.json"),
  JSON.stringify({ runId, generatedAt: new Date().toISOString(), records: summary }, null, 2),
)

console.log("")
console.log(`[bakeoff] wrote ${summary.length} comparison record(s) to ${outDir}`)
console.log(`[bakeoff] summary: ${join(outDir, "_summary.json")}`)

// ─── helpers ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { limit: null, surface: null, out: null }
  for (const arg of argv) {
    // Fail fast on anything that isn't --key=value. Silently dropping
    // typos like `--limt=10` or space-separated `--limit 10` causes
    // unintended full-replay runs because limit stays null.
    if (!arg.startsWith("--") || !arg.includes("=")) {
      throw new Error(`invalid argument '${arg}' — expected --key=value`)
    }
    const eq = arg.indexOf("=")
    const k = arg.slice(2, eq)
    const v = arg.slice(eq + 1)
    if (k === "limit") {
      // Strict: only accept a string of digits. `Number.parseInt("10abc",
      // 10)` would happily return 10, silently masking typos.
      out.limit = /^\d+$/.test(v) ? Number(v) : Number.NaN
    } else if (k === "surface") {
      if (!ALLOWED_SURFACES.has(v)) {
        throw new Error(`invalid --surface '${v}' — allowed: ${[...ALLOWED_SURFACES].join(", ")}`)
      }
      out.surface = v
    } else if (k === "out") {
      out.out = v
    } else {
      throw new Error(`unknown flag --${k}`)
    }
  }
  return out
}

/**
 * Page through every key in the production KV namespace under the given
 * prefix. Uses the Cloudflare REST API with cursor pagination — the
 * wrangler CLI doesn't accept a cursor flag, so it would silently cap
 * at 1000 keys per call.
 */
async function listKvKeys(prefix) {
  const all = []
  let cursor = ""
  for (;;) {
    const params = new URLSearchParams({ prefix, limit: String(KV_LIST_PAGE_SIZE) })
    if (cursor) params.set("cursor", cursor)
    const url = `${CLOUDFLARE_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/keys?${params}`
    const json = await cloudflareJsonGet(url)
    if (!json.success) throw new Error(`KV list failed: ${formatCfErrors(json)}`)
    if (!Array.isArray(json.result)) throw new Error("KV list returned non-array result")
    for (const entry of json.result) all.push(entry.name)
    cursor = json.result_info?.cursor ?? ""
    if (!cursor || json.result.length === 0) break
  }
  // Reverse-timestamped keys sort newest-first lexicographically already,
  // but be explicit so callers don't have to trust REST ordering.
  return all.sort()
}

async function getKvJson(key) {
  // Values endpoint returns the raw stored bytes (not the success-wrapped
  // shape), so we parse the body text directly.
  const url = `${CLOUDFLARE_API_BASE}/accounts/${cfAccountId}/storage/kv/namespaces/${KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), KV_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfApiToken}` },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`KV get HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    return JSON.parse(await res.text())
  } finally {
    clearTimeout(timer)
  }
}

async function cloudflareJsonGet(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), KV_REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${cfApiToken}`,
        accept: "application/json",
      },
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Cloudflare API HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function formatCfErrors(json) {
  if (!Array.isArray(json.errors)) return JSON.stringify(json).slice(0, 300)
  return json.errors.map((e) => `${e.code}: ${e.message}`).join("; ")
}

async function ollamaGenerate({ model, prompt, format, apiKey }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const body = {
      model,
      prompt,
      stream: true,
      options: { temperature: 0 },
      ...(format ? { format } : {}),
    }
    const res = await fetch(OLLAMA_TURBO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`ollama HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    if (!res.body) throw new Error("ollama response missing body")
    return await accumulateStream(res.body)
  } finally {
    clearTimeout(timer)
  }
}

async function accumulateStream(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let accumulated = ""
  let done = false
  let saw = false
  while (!done) {
    const { value, done: streamDone } = await reader.read()
    if (streamDone) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      saw = true
      let chunk
      try {
        chunk = JSON.parse(line)
      } catch {
        continue
      }
      if (chunk.error) throw new Error(`ollama stream error: ${String(chunk.error).slice(0, 500)}`)
      if (typeof chunk.response === "string") accumulated += chunk.response
      if (chunk.done) done = true
    }
  }
  const tail = buffer.trim()
  if (tail) {
    try {
      const chunk = JSON.parse(tail)
      if (chunk.error) throw new Error(`ollama stream error: ${String(chunk.error).slice(0, 500)}`)
      if (typeof chunk.response === "string") accumulated += chunk.response
      saw = true
    } catch {
      // ignore — incomplete final line
    }
  }
  if (!saw) throw new Error("ollama stream produced no chunks")
  return accumulated
}

function tryParseJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function sanitizeKey(key) {
  return key.replace(/[^A-Za-z0-9._-]/g, "_")
}
