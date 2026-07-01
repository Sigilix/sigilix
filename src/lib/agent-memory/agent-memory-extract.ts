// Agent-memory store — POST /v1/memory/extract route handler.
//
// The local CLI agent posts a single conversation exchange (one user turn + the
// assistant's reply); a CHEAP model distills 0–3 durable, reusable facts from it,
// and each lands in the SAME per-(user, repo) store the PUT route writes to
// (`storeMemoryFact` → dedup → KV record + Vectorize upsert). This is the
// auto-capture leg of the agent's long-term memory — the human never has to call
// PUT explicitly for a fact worth remembering across sessions.
//
// SOFT-FAIL BY DESIGN (spec): extraction is best-effort enrichment, not a verdict.
// A missing api key, a model/embed/Vectorize failure, or an unparseable response
// must NOT 500 — the route returns `{ stored: 0, facts: [] }` (200) and the agent
// proceeds. 500 ONLY on a truly unexpected throw outside the soft seams. Auth /
// body-cap / JSON / field-validation gates mirror the PUT + query routes exactly.

import type { Env } from "@/src/shared/types/env"
import { resolveApiKey } from "@/src/lib/api-key-resolver"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import {
  LEARNING_EXTRACTOR_CONFIG,
  LEARNING_EXTRACTOR_TIMEOUT_MS,
  runWithRetryAndFallback,
} from "@/src/lib/ensemble/adapters/model-provider"
import { modelApiKeys, selectConfigApiKey } from "@/src/lib/ensemble/adapters/model-provider-routing"
import type { AgentMemoryKind } from "./types"
import { ALL_AGENT_MEMORY_KINDS } from "./types"
import { MAX_BODY_BYTES, canonicalTenantId, json, scopeMemoryUserId, storeMemoryFact } from "./agent-memory-route"

// The model may surface a few facts per exchange, but most exchanges yield none —
// the conservative prompt prefers empty over noise. Cap so a runaway response
// can't fan out into the store.
const MAX_EXTRACTED_FACTS = 3
// A single fact is one sentence; reject anything longer than a short note so a
// model that dumps the whole reply into `content` can't pollute the store.
const MAX_FACT_CONTENT_CHARS = 600

// ─── Prompt + JSON schema ────────────────────────────────────

/** One distilled fact the model proposes — validated by {@link parseMemoryExtraction}. */
export interface ExtractedMemoryFact {
  kind: AgentMemoryKind
  content: string
}

/** JSON schema for the structured response (mirrors LEARNING_EXTRACTION_SCHEMA). */
const MEMORY_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...ALL_AGENT_MEMORY_KINDS] },
          content: { type: "string" },
        },
        required: ["kind", "content"],
      },
    },
  },
  required: ["memories"],
} as const

/**
 * Build the extraction prompt for one exchange. Mirrors the SIG-104 learnings
 * extractor's shape (system = task + strict-JSON contract + conservative
 * anti-pollution rules; user = the exchange), adapted for AGENT memory kinds.
 */
export function buildMemoryExtractionPrompt(args: { userMessage: string; assistantMessage: string }): {
  system: string
  user: string
} {
  const system = [
    "You distill DURABLE, REUSABLE facts from a single coding-agent conversation exchange (one user turn + the assistant's reply), to remember across future sessions on this repo.",
    `Extract 0–${MAX_EXTRACTED_FACTS} facts. Output STRICT JSON only: {"memories":[{"kind":"...","content":"..."}]}.`,
    `Allowed kinds: ${ALL_AGENT_MEMORY_KINDS.join(", ")}.`,
    "  - decision   — a choice that was made and should stay consistent going forward.",
    "  - dead_end   — an approach that failed, so it is not retried.",
    "  - correction — a fix the user applied to the agent's output.",
    "  - preference — a durable user preference (e.g. tabs over spaces, no comments).",
    "  - task_state — where a multi-step task was left off.",
    "Each `content` must be a single, self-contained sentence that stands on its own without the surrounding chat.",
    "",
    "Be CONSERVATIVE — prefer an empty list over noise:",
    "- Return an empty `memories` array when nothing is durable.",
    "- Reject ephemeral chatter, acknowledgements, greetings, and one-off Q&A that does not generalize.",
    "- Reject anything specific to a single command run that won't matter next session.",
    "- Do NOT invent facts the exchange does not support.",
    "- Redact secrets and personal data from `content`.",
  ].join("\n")

  const user = ["Conversation exchange:", "", "USER:", args.userMessage, "", "ASSISTANT:", args.assistantMessage].join(
    "\n",
  )

  return { system, user }
}

function isKind(value: unknown): value is AgentMemoryKind {
  return typeof value === "string" && (ALL_AGENT_MEMORY_KINDS as readonly string[]).includes(value)
}

/**
 * Parse the model's JSON into a validated, capped list of facts. Re-validates
 * every entry: drops one with a bad/absent kind or empty content, trims content,
 * and caps the result at {@link MAX_EXTRACTED_FACTS}. Returns [] on a missing /
 * non-array `memories` or an unparseable response (never throws into the caller).
 */
export function parseMemoryExtraction(raw: string): ExtractedMemoryFact[] {
  const parsed = parseFirstJsonObject(raw)
  if (parsed === null) return []
  const memories = parsed.memories
  if (!Array.isArray(memories)) return []

  const facts: ExtractedMemoryFact[] = []
  for (const entry of memories) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    if (!isKind(e.kind)) continue
    if (typeof e.content !== "string") continue
    const content = e.content.trim()
    if (content === "") continue
    facts.push({ kind: e.kind, content: content.slice(0, MAX_FACT_CONTENT_CHARS) })
    if (facts.length >= MAX_EXTRACTED_FACTS) break
  }
  return facts
}

// ─── Model call (cheap, fail-open) ───────────────────────────

/**
 * Run the cheap extractor over one exchange → a validated fact list. Same
 * fail-open shape as the SIG-104 learning extractor: no api key OR any model /
 * parse failure → [] (the route then stores nothing and answers 200). Never
 * throws.
 */
export async function extractMemoryFacts(
  env: Env,
  args: { userMessage: string; assistantMessage: string },
): Promise<ExtractedMemoryFact[]> {
  try {
    const apiKey = selectConfigApiKey(LEARNING_EXTRACTOR_CONFIG, modelApiKeys(env))
    if (!apiKey) return []

    const { system, user } = buildMemoryExtractionPrompt(args)
    const result = await runWithRetryAndFallback<ExtractedMemoryFact[]>({
      config: LEARNING_EXTRACTOR_CONFIG,
      apiKey,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      signal: new AbortController().signal,
      chatEnabled: env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
      format: MEMORY_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
      // parseMemoryExtraction always returns an array (never null), so an empty
      // list is treated by the runner as a VALID "nothing durable" verdict — NOT
      // a parse failure (no retry, no fallback). A truly unparseable response
      // collapses to [] the same way, which is the desired soft-fail (0 stored).
      parseAnswer: (content: string) => parseMemoryExtraction(content),
      parseFailureLabel: "memory_extractor_did_not_parse",
      startedAt: Date.now(),
      perAttemptTimeoutMs: LEARNING_EXTRACTOR_TIMEOUT_MS,
    })
    return result.verdict ?? []
  } catch {
    return []
  }
}

// ─── POST /v1/memory/extract — distill + store ───────────────

interface ExtractBody {
  userId: string
  repoId: string
  userMessage: string
  assistantMessage: string
}

function parseExtractBody(raw: unknown): ExtractBody | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (typeof b.userId !== "string" || b.userId.trim() === "") return "userId (non-empty string) is required"
  if (typeof b.repoId !== "string" || b.repoId.trim() === "") return "repoId (non-empty string) is required"
  if (typeof b.userMessage !== "string" || b.userMessage.trim() === "")
    return "userMessage (non-empty string) is required"
  if (typeof b.assistantMessage !== "string" || b.assistantMessage.trim() === "")
    return "assistantMessage (non-empty string) is required"
  // Canonicalize the tenant scope to ONE form (lowercased) so the KV keyspace and
  // the Vectorize namespace derive from the same value (mirrors the PUT route).
  return {
    userId: canonicalTenantId(b.userId),
    repoId: canonicalTenantId(b.repoId),
    userMessage: b.userMessage,
    assistantMessage: b.assistantMessage,
  }
}

/** One stored fact in the response (the input kind/content + the record id +
 *  whether it deduped against an existing record). */
interface StoredFactResult {
  kind: AgentMemoryKind
  content: string
  id: string
  deduped: boolean
}

/**
 * POST /v1/memory/extract — distill 0–3 durable facts from a conversation
 * exchange via a cheap model, then store each through the shared write path
 * (`storeMemoryFact`: dedup → KV + Vectorize). 503 until keyed; 401 on a bad
 * bearer; 400/413 on a bad/oversized body. SOFT: a missing key / model / embed /
 * Vectorize / parse failure → `{ stored: 0, facts: [] }` (200), NEVER 500; 500
 * only on a truly unexpected throw. Returns
 * `{ stored, facts: [{ kind, content, id, deduped }] }`.
 */
export async function handleMemoryExtractRoute(request: Request, env: Env): Promise<Response> {
  // #155 slice 2: resolve the bearer through the per-tenant API-key resolver (a D1
  // api_key lookup), falling back to the legacy shared secret
  // (env.OPENCLAW_SIGILIX_API_KEY -> LEGACY_TENANT_INSTALLATION_ID) so an existing
  // global-key caller is unaffected. FAIL-CLOSED: a missing/bad bearer, a revoked
  // key, OR a genuine D1 fault during the lookup all resolve to null here -> 401,
  // never a bypass (see api-key-resolver.ts — this inverts the repo's usual
  // fail-open D1 default on purpose, because this gates authentication).
  //
  // SIG-494: a real per-tenant key's subject is namespaced under
  // `inst:<installationId>:` (scopeMemoryUserId below) before the distilled facts
  // are stored, so extract can only write into its OWN installation's memory — see
  // agent-memory-route.ts's handleMemoryWriteRoute comment. Legacy key stays broad.
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "memory_endpoint_not_configured" }, 503)
  }
  const caller = await resolveApiKey(request, env)
  if (!caller) return json({ error: "unauthorized" }, 401)

  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null)
      return json({ error: "payload_too_large", detail: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    raw = JSON.parse(capped)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseExtractBody(raw)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  try {
    // Soft: an empty list (nothing durable, no key, or a model/parse failure)
    // short-circuits to a clean `{ stored: 0, facts: [] }`.
    const facts = await extractMemoryFacts(env, {
      userMessage: parsed.userMessage,
      assistantMessage: parsed.assistantMessage,
    })

    // SIG-494: confine to the caller's installation namespace (legacy key → unchanged).
    const userId = scopeMemoryUserId(parsed.userId, caller.installationId)
    const stored: StoredFactResult[] = []
    for (const fact of facts) {
      try {
        const result = await storeMemoryFact(env, {
          userId,
          repoId: parsed.repoId,
          kind: fact.kind,
          content: fact.content,
        })
        stored.push({ kind: fact.kind, content: fact.content, id: result.id, deduped: result.deduped })
      } catch (err) {
        // A single fact's write failing must not collapse the batch — skip it,
        // telemeter, keep storing the rest (soft-fail, recall-of-the-others-safe).
        emitTelemetry("agent-memory-extract-store-failed", {
          kind: fact.kind,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return json({ stored: stored.length, facts: stored }, 200)
  } catch (err) {
    // The legs above are soft, so this only fires on a truly unexpected throw.
    // Still answer cleanly — extraction is best-effort enrichment, not a verdict.
    emitTelemetry("agent-memory-extract-unexpected", { err: err instanceof Error ? err.message : String(err) })
    return json({ stored: 0, facts: [] }, 200)
  }
}

function emitTelemetry(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }))
}
