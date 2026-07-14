// SIG-196: Slack Web API wrapper — postMessage, thread fetch, cap+redact.
// Privacy contract: the bot token and message text are NEVER logged.

import { containsCredentialToken } from "@/src/lib/secret-scan"
import { markdownToMrkdwn } from "@/src/lib/slack/slack-mrkdwn"

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
    // Slack renders mrkdwn, not standard Markdown — convert the outgoing text so
    // **bold** / # headings / [text](url) render correctly (this is the single
    // post choke point, so every bot reply is converted).
    const body: Record<string, string> = { channel, text: markdownToMrkdwn(text) }
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
// isSlackOrgTeacher — org-teach authorization
// ---------------------------------------------------------------------------

/**
 * Result of an org-teach authorization check: whether the actor may write an
 * ORG-scope learning (which shapes every teammate's PR reviews), plus a stable
 * `reason` so an over-denial ("couldn't determine" — API error / missing scope)
 * is distinguishable in the logs from a correct denial ("not-admin").
 */
export interface OrgTeachAuthz {
  authorized: boolean
  reason: string
}

/**
 * FAIL-CLOSED workspace-admin check for the Slack surface. An ORG-scope learning
 * shapes every teammate's reviews, so only a Slack workspace admin/owner is
 * authorized to teach one; everyone else still gets their normal Q&A, we just do
 * not capture their message.
 *
 * Uses Slack's `users.info` (requires the `users:read` scope). Any error,
 * missing scope, malformed response, or absent admin field resolves to NOT
 * authorized (never throws), so a failure can only REDUCE capture. The `reason`
 * distinguishes a genuine "not-admin" denial from a "couldn't determine" drop so
 * over-denial is auditable.
 */
export async function isSlackOrgTeacher(args: {
  botToken: string | null | undefined
  userId: string | null | undefined
}): Promise<OrgTeachAuthz> {
  const { botToken, userId } = args
  if (!botToken) return { authorized: false, reason: "no-bot-token" }
  if (!userId) return { authorized: false, reason: "no-user-id" }
  try {
    const url = new URL(`${SLACK_API}/users.info`)
    url.searchParams.set("user", userId)
    // Bounded: this call sits on the reply-blocking path, so a hung users.info
    // must not stall the answer. A timeout aborts → caught below → fail-closed.
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(5000),
    })
    const json = (await resp.json()) as {
      ok?: unknown
      error?: unknown
      user?: { is_admin?: unknown; is_owner?: unknown; is_primary_owner?: unknown }
    }
    if (!json.ok || !json.user) {
      const err = typeof json.error === "string" && json.error.length > 0 ? `api-${json.error}` : "api-error"
      return { authorized: false, reason: err }
    }
    const u = json.user
    const isAdmin = u.is_admin === true || u.is_owner === true || u.is_primary_owner === true
    return isAdmin ? { authorized: true, reason: "admin" } : { authorized: false, reason: "not-admin" }
  } catch {
    return { authorized: false, reason: "lookup-error" }
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
