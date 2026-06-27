// SIG-196: Slack Web API wrapper — postMessage, thread fetch, cap+redact.
// Privacy contract: the bot token and message text are NEVER logged.

import { containsCredentialToken } from "@/src/lib/secret-scan"

const SLACK_API = "https://slack.com/api"

// ---------------------------------------------------------------------------
// postSlackMessage
// ---------------------------------------------------------------------------

/**
 * Post a message (optionally into a thread) via Slack's chat.postMessage API.
 * Returns `{ ok: true }` on success, `{ ok: false }` on API error or network
 * failure. Never throws.
 */
export async function postSlackMessage(args: {
  botToken: string
  channel: string
  threadTs?: string
  text: string
}): Promise<{ ok: boolean }> {
  const { botToken, channel, threadTs, text } = args
  try {
    const body: Record<string, string> = { channel, text }
    if (threadTs !== undefined) {
      body["thread_ts"] = threadTs
    }
    const resp = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    })
    const json = (await resp.json()) as { ok?: unknown }
    return { ok: Boolean(json.ok) }
  } catch {
    return { ok: false }
  }
}

// ---------------------------------------------------------------------------
// fetchSlackThread
// ---------------------------------------------------------------------------

/**
 * Fetch the messages in a Slack thread via conversations.replies.
 * Returns an array of message `.text` values (strings, non-empty, oldest→newest),
 * capped to `maxMessages` (default 20). Returns `[]` on error. Never throws.
 */
export async function fetchSlackThread(args: {
  botToken: string
  channel: string
  threadTs: string
  maxMessages?: number
}): Promise<string[]> {
  const { botToken, channel, threadTs, maxMessages } = args
  const limit = maxMessages ?? 20
  try {
    const url = new URL(`${SLACK_API}/conversations.replies`)
    url.searchParams.set("channel", channel)
    url.searchParams.set("ts", threadTs)
    url.searchParams.set("limit", String(limit))

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${botToken}` },
    })
    const json = (await resp.json()) as { ok?: unknown; messages?: unknown[] }
    if (!json.ok) return []

    const messages = Array.isArray(json.messages) ? json.messages : []
    const texts: string[] = []
    for (const msg of messages) {
      if (texts.length >= limit) break
      const t = (msg as Record<string, unknown>)["text"]
      if (typeof t === "string" && t.length > 0) {
        texts.push(t)
      }
    }
    return texts
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// capAndRedactThread
// ---------------------------------------------------------------------------

/**
 * Join thread messages, redact any message containing a credential token,
 * then truncate the joined result to `maxChars` (default 6000), appending
 * "…" if truncated.
 *
 * Redaction is per-message and runs BEFORE join+cap so no credential token
 * survives into the model/memory context.
 */
export function capAndRedactThread(messages: string[], maxChars?: number): string {
  const cap = maxChars ?? 6000
  const redacted = messages.map((m) => (containsCredentialToken(m) ? "[redacted: contained a secret]" : m))
  const joined = redacted.join("\n")
  if (joined.length <= cap) return joined
  return joined.slice(0, cap) + "…"
}
