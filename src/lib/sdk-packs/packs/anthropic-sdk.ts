// SIG-298 follow-on — SDK guidance pack: Anthropic SDK. Self-authored from
// Anthropic's public API docs (docs.anthropic.com). NOT a partner
// integration — no endorsement claim, no logo; the label is "SDK guidance."

import type { SdkPack } from "@/src/lib/sdk-packs/types"

const DOCS_URL = "https://docs.anthropic.com"

export const anthropicSdkPack: SdkPack = {
  id: "anthropic-sdk",
  vendor: "Anthropic SDK",
  docsUrl: DOCS_URL,
  matchers: {
    packages: ["@anthropic-ai/sdk"],
    importPatterns: [/from\s+["']@anthropic-ai\/sdk["']/, /require\(\s*["']@anthropic-ai\/sdk["']\s*\)/],
  },
  rules: [
    {
      id: "streaming-error-mid-stream",
      title: "A streamed message can error or stop mid-stream",
      guidance:
        "Consuming `messages.stream()` / SSE output without handling `stop_reason` values like `max_tokens` or an in-stream error event leaves the caller unable to distinguish a clean completion from a truncated or failed one — check `stop_reason`, don't assume the stream ending means success.",
      severityHint: "P2",
      docsUrl: "https://docs.anthropic.com/en/api/streaming",
    },
    {
      id: "retry-backoff-on-429-529",
      title: "Retries need backoff, especially on 529 (overloaded)",
      guidance:
        "A custom retry loop around a 429 (rate limit) or 529 (overloaded) response without exponential backoff amplifies load exactly when the API is already struggling — prefer the SDK's built-in retry (`maxRetries`) over a hand-rolled tight loop.",
      severityHint: "P2",
      docsUrl: "https://docs.anthropic.com/en/api/errors",
    },
    {
      id: "max-tokens-required-and-bounded",
      title: "`max_tokens` is required and caps the response, not the input",
      guidance:
        '`max_tokens` must be set and bounds ONLY the output; an unbounded or overly generous `max_tokens` on a high-traffic endpoint is a cost/latency risk, and a `max_tokens` set too low silently truncates the response (check `stop_reason === "max_tokens"` before treating output as complete).',
      severityHint: "P2",
      docsUrl: "https://docs.anthropic.com/en/api/messages",
    },
    {
      id: "prompt-injection-from-untrusted-content",
      title: "Untrusted content interpolated into the prompt is a prompt-injection surface",
      guidance:
        "Content from web fetches, uploaded documents, or tool results interpolated directly into the user/system message without separation can carry embedded instructions that override intended behavior — wrap untrusted content in clear delimiters and instruct the model to treat it as data, not commands.",
      severityHint: "P1",
      docsUrl: "https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering",
    },
    {
      id: "api-key-hardcoded-or-client-exposed",
      title: "API key must not be hardcoded or shipped to the browser",
      guidance:
        "An `Anthropic` client instantiated in browser-reachable code, or a key hardcoded in source instead of read from a server-only env var, exposes the key to anyone inspecting network traffic or the bundle — proxy calls through a server endpoint.",
      severityHint: "P1",
      docsUrl: "https://docs.anthropic.com/en/api/getting-started",
    },
    {
      id: "tool-use-input-not-validated",
      title: "Tool-use `input` from the model isn't automatically safe",
      guidance:
        "A `tool_use` block's `input` is still untrusted (the model can hallucinate a value or be steered by injected content) — validate/sanitize it before using it to build a DB query, file path, or shell command, same as any other external input.",
      severityHint: "P1",
      docsUrl: "https://docs.anthropic.com/en/docs/build-with-claude/tool-use",
    },
    {
      id: "context-window-not-checked-before-call",
      title: "No pre-flight check against the model's context window",
      guidance:
        "Concatenating unbounded conversation history or retrieved documents into a request without truncating or estimating token count first produces a hard-to-debug 400 at request time instead of a graceful truncation or summarization fallback.",
      severityHint: "P2",
      docsUrl: "https://docs.anthropic.com/en/docs/build-with-claude/context-windows",
    },
  ],
}
