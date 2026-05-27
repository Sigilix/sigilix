// SIG-225 — deterministic self-authored-comment filter for Linear
// webhooks.
//
// The webhook handler's legacy self-filter (`isBotHandle(displayName)`)
// fails on bot-authored Comment.create events whose `data.user` is
// populated with the OAuth app owner's identity instead of the bot's.
// Symptom: bot posts a reply, Linear fires Comment.create back, the
// displayName-based filter misses, the SIG-225 thread-walk fires, and
// the bot re-replies into the OLD Sigilix-authored thread → duplicate
// reply in the wrong thread.
//
// This tracker is deterministic: every commentId the bot creates is
// stamped in KV at the moment of `linear.createComment(...)`; the
// webhook handler checks the stamp before any displayName-based
// heuristic. No dependency on what Linear puts in the webhook payload.
//
// The fallback (`isBotHandle`) stays in place for the cold-cache
// window — Cloudflare KV is eventually consistent, so a write from
// the queue worker may not be visible to a webhook worker on a
// different POP for ~60s. The two layers together cover every
// realistic interleaving.

export const BOT_AUTHORED_KV_PREFIX = "bot-authored-comment"
export const BOT_AUTHORED_TTL_SECONDS = 60 * 60 // 1 hour

function keyFor(commentId: string): string {
  return `${BOT_AUTHORED_KV_PREFIX}:${commentId}`
}

/** Stamp a commentId so the webhook handler skips its own re-fire.
 *
 *  Best-effort: failures are swallowed. The bot has already posted
 *  the comment by the time this is called; a KV blip must not abort
 *  the surrounding reply path. The `isBotHandle()` displayName check
 *  is the second-line defense in the rare miss case.
 */
export async function markBotAuthoredComment(
  kv: KVNamespace,
  commentId: string
): Promise<void> {
  if (!commentId || !commentId.trim()) return
  try {
    await kv.put(keyFor(commentId), "1", {
      expirationTtl: BOT_AUTHORED_TTL_SECONDS,
    })
  } catch (err) {
    console.warn("bot-authored-comments: mark failed", {
      commentId,
      err: String(err),
    })
  }
}

/** True if the commentId was stamped by `markBotAuthoredComment`.
 *
 *  Fails open (returns false) on KV errors so the downstream
 *  `isBotHandle()` filter still has a chance to catch the self-reply.
 *  Returning true on a transient blip would silently drop legitimate
 *  user comments that happened to error on the lookup.
 */
export async function isBotAuthoredComment(
  kv: KVNamespace,
  commentId: string
): Promise<boolean> {
  if (!commentId || !commentId.trim()) return false
  try {
    const v = await kv.get(keyFor(commentId))
    return v !== null
  } catch (err) {
    console.warn("bot-authored-comments: probe failed", {
      commentId,
      err: String(err),
    })
    return false
  }
}
