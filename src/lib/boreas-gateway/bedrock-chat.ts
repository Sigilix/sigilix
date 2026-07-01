// #158 (model-gateway failover chain) — leg 3: AWS Bedrock (serverless), a
// SCAFFOLD per founder doctrine: implemented now, DISABLED at launch until real
// OPENCLAW_AWS_* credentials + a per-model OPENCLAW_<MODEL>_FALLBACK_BEDROCK_MODEL
// exist. `isBedrockConfigured` gates every entry point — with any of the four
// required values unset, this leg is SKIPPED entirely (not attempted, not
// logged as a failure), which is the intended launch state.
//
// Bedrock's Runtime Converse REST API is NOT wire-compatible with OpenAI's
// chat-completions shape, so this module translates both directions:
//   - request:  OpenAI `messages` (system/user/assistant) -> Converse
//               `system` + `messages` (Converse has no system role in `messages`).
//   - response: Converse `output.message` -> a single OpenAI chat.completion
//               JSON object, so the route's caller sees the same response shape
//               regardless of which leg served it.
//
// KNOWN LIMITATION (documented, not hidden): Converse's streaming variant
// (`converse-stream`) uses the `vnd.amazon.eventstream` binary framing, not
// Server-Sent Events — translating that to an OpenAI-compatible SSE stream is
// real work with no test coverage possible until real Bedrock access exists.
// This scaffold always calls the NON-STREAMING Converse endpoint and returns a
// single accumulated JSON response, even when the caller requested
// `stream:true`. Acceptable because the leg is disabled at launch; revisit
// before flipping OPENCLAW_AWS_* on for a model whose callers rely on streaming.

import { signAwsRequestV4 } from "./aws-sigv4"
import { BEDROCK_SIGV4_SERVICE, bedrockConverseUrl } from "./constants"

export interface BedrockLegResult {
  response: Response
  upstreamModel: string
}

export interface BedrockCreds {
  region: string
  accessKeyId: string
  secretAccessKey: string
}

export interface BedrockCredsInput {
  region: string | undefined
  accessKeyId: string | undefined
  secretAccessKey: string | undefined
}

/** True only when ALL of region/access-key/secret/model-id are set — see file header. */
export function isBedrockConfigured(
  creds: BedrockCredsInput | undefined,
  modelId: string | undefined,
): creds is BedrockCreds {
  return Boolean(creds?.region?.trim() && creds?.accessKeyId?.trim() && creds?.secretAccessKey?.trim() && modelId)
}

interface OpenAiMessage {
  role?: unknown
  content?: unknown
}

/** Best-effort string extraction — OpenAI `content` may be a string or a content-part array. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "",
      )
      .join("")
  }
  return ""
}

/**
 * Translate an OpenAI-shaped `messages` array into Bedrock Converse's `system` +
 * `messages`. Converse requires STRICTLY ALTERNATING user/assistant turns and
 * rejects empty content blocks, so this also (a) folds any non-system,
 * non-assistant role (e.g. "tool") into "user" rather than dropping it, (b)
 * MERGES adjacent same-role turns (concatenated with a newline) instead of
 * emitting consecutive same-role messages Converse would reject, and (c) drops
 * any turn that ends up with empty text after merging.
 */
export function openAiMessagesToConverse(messages: unknown): {
  system: { text: string }[]
  converseMessages: { role: "user" | "assistant"; content: { text: string }[] }[]
} {
  const system: { text: string }[] = []
  const merged: { role: "user" | "assistant"; text: string }[] = []
  if (!Array.isArray(messages)) return { system, converseMessages: [] }
  for (const raw of messages as OpenAiMessage[]) {
    const role = typeof raw.role === "string" ? raw.role : "user"
    const text = contentToText(raw.content)
    if (role === "system") {
      system.push({ text })
      continue
    }
    // Converse only knows "user" | "assistant"; fold anything else (e.g. "tool") into "user"
    // rather than dropping it silently.
    const converseRole: "user" | "assistant" = role === "assistant" ? "assistant" : "user"
    const last = merged[merged.length - 1]
    if (last && last.role === converseRole) {
      last.text = last.text ? `${last.text}\n${text}` : text
    } else {
      merged.push({ role: converseRole, text })
    }
  }
  const converseMessages = merged
    .filter((m) => m.text.length > 0)
    .map((m) => ({ role: m.role, content: [{ text: m.text }] }))
  return { system, converseMessages }
}

interface ConverseResponse {
  output?: { message?: { content?: { text?: string }[] } }
  stopReason?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

const FINISH_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  content_filtered: "content_filter",
}

/** Translate a Converse response body into a single OpenAI chat.completion JSON object. */
export function converseResponseToOpenAi(body: ConverseResponse, modelId: string): Record<string, unknown> {
  const text = (body.output?.message?.content ?? []).map((p) => p.text ?? "").join("")
  const finishReason = (body.stopReason && FINISH_REASON_MAP[body.stopReason]) || "stop"
  return {
    id: `bedrock-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: body.usage?.inputTokens ?? 0,
      completion_tokens: body.usage?.outputTokens ?? 0,
      total_tokens: body.usage?.totalTokens ?? 0,
    },
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/**
 * Attempt the Bedrock leg. Always returns a Response (never throws) — a
 * connect error/timeout/signing failure is caught and turned into a generic
 * 502, matching the other legs' failure shape (no AWS error detail, no
 * credential material, ever surfaced to the caller or logged).
 */
export async function attemptBedrockLeg(
  rawPayload: Record<string, unknown>,
  modelId: string,
  creds: BedrockCreds,
  timeoutMs: number,
): Promise<BedrockLegResult> {
  try {
    const { system, converseMessages } = openAiMessagesToConverse(rawPayload.messages)
    const converseBody: Record<string, unknown> = { messages: converseMessages }
    if (system.length > 0) converseBody.system = system

    const url = bedrockConverseUrl(creds.region, modelId)
    const bodyStr = JSON.stringify(converseBody)
    const signed = await signAwsRequestV4({
      method: "POST",
      url,
      region: creds.region,
      service: BEDROCK_SIGV4_SERVICE,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      extraHeaders: { "content-type": "application/json" },
      body: bodyStr,
    })

    // The timeout covers the fetch AND the (non-streaming, always-fully-read)
    // response body read — a hanging Bedrock body read is just as much a "leg is
    // flaky" condition as a hanging connect, and this leg never streams (see the
    // file header), so there's no legitimate long-lived read to protect here.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: signed.headers,
        body: bodyStr,
        signal: controller.signal,
      })

      if (!upstream.ok) {
        // Drain the body (never logged/returned — may carry AWS account/ARN detail) and
        // synthesize a generic failure response so the chain can decide retryability
        // purely from `upstream.status`.
        await upstream.body?.cancel()
        return {
          response: json({ error: "boreas_upstream_error", detail: "upstream request failed" }, upstream.status),
          upstreamModel: modelId,
        }
      }

      const converseJson = (await upstream.json()) as ConverseResponse
      return { response: json(converseResponseToOpenAi(converseJson, modelId), 200), upstreamModel: modelId }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "gateway-leg-error", leg: "bedrock", detail: String(err) }))
    return {
      response: json({ error: "boreas_upstream_error", detail: "upstream request failed" }, 502),
      upstreamModel: modelId,
    }
  }
}
