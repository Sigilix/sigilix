// SIG-298 follow-on — SDK guidance pack: OpenAI SDK. Self-authored from
// OpenAI's public API docs (platform.openai.com/docs). NOT a partner
// integration — no endorsement claim, no logo; the label is "SDK guidance."

import type { SdkPack } from "@/src/lib/sdk-packs/types"

const DOCS_URL = "https://platform.openai.com/docs"

export const openaiSdkPack: SdkPack = {
  id: "openai-sdk",
  vendor: "OpenAI SDK",
  docsUrl: DOCS_URL,
  matchers: {
    packages: ["openai"],
    importPatterns: [/from\s+["']openai["']/, /require\(\s*["']openai["']\s*\)/],
  },
  rules: [
    {
      id: "streaming-error-mid-stream",
      title: "A streamed response can error mid-stream",
      guidance:
        "Consuming `stream: true` output with a bare `for await` loop and no try/catch around the iteration means a mid-stream error (rate limit, disconnect, content filter) leaves partial output rendered to the user with no error state — wrap the stream consumption, not just the initial call.",
      severityHint: "P2",
      docsUrl: "https://platform.openai.com/docs/api-reference/streaming",
    },
    {
      id: "retry-backoff-on-429-500",
      title: "Retries need backoff, not a tight loop",
      guidance:
        "A hand-rolled retry around a rate-limited (429) or 5xx response without exponential backoff (or without honoring a `Retry-After` header) amplifies load during an outage and can trip the account's rate limit further — the SDK's own built-in retry (`maxRetries`) already does this; a custom retry loop should match it.",
      severityHint: "P2",
      docsUrl: "https://platform.openai.com/docs/guides/rate-limits",
    },
    {
      id: "token-limit-not-checked-before-call",
      title: "No pre-flight check against the model's context window",
      guidance:
        "Concatenating unbounded user content (a long conversation history, a large retrieved document) into a prompt without truncating or checking token count against the model's context window produces a hard-to-debug 400 at request time instead of a graceful truncation.",
      severityHint: "P2",
      docsUrl: "https://platform.openai.com/docs/guides/text-generation",
    },
    {
      id: "prompt-injection-from-untrusted-content",
      title: "Untrusted content interpolated into the prompt is a prompt-injection surface",
      guidance:
        'Fetched web content, user-uploaded files, or tool-call outputs interpolated directly into the system/user prompt without separation or sanitization can carry instructions that override the intended behavior (e.g. "ignore previous instructions") — treat that content as data, not as trusted instruction text.',
      severityHint: "P1",
      docsUrl: "https://platform.openai.com/docs/guides/safety-best-practices",
    },
    {
      id: "api-key-hardcoded-or-client-exposed",
      title: "API key must not be hardcoded or shipped to the browser",
      guidance:
        "An `OpenAI` client instantiated in browser-reachable code (or with a key hardcoded in source rather than read from a server-only env var) exposes the key to anyone inspecting network requests or the bundle — all calls should proxy through a server endpoint.",
      severityHint: "P1",
      docsUrl: "https://platform.openai.com/docs/quickstart",
    },
    {
      id: "function-tool-output-not-validated",
      title: "Tool/function-call arguments from the model aren't automatically safe",
      guidance:
        "Arguments the model returns for a function/tool call are still untrusted input (the model can hallucinate a value or be steered by injected content) — validate/sanitize them before using them to build a DB query, file path, or shell command, same as any other user input.",
      severityHint: "P1",
      docsUrl: "https://platform.openai.com/docs/guides/function-calling",
    },
    {
      id: "timeout-not-set-on-long-calls",
      title: "No explicit timeout on a call that can hang",
      guidance:
        "Without an explicit `timeout` (client-level or per-request), a slow or stalled completion can hold a server request/connection open far longer than the caller's own HTTP timeout expects, tying up resources — set an explicit timeout matched to the endpoint's own SLA.",
      severityHint: "P3",
      docsUrl: "https://platform.openai.com/docs/api-reference",
    },
  ],
}
