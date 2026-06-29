// SIG-545 B3c: thread-scoped pending implementation-offer state + the
// affirmative/revise classifier for the offer → negotiate → confirm flow.
//
// When grounded Slack Q&A produces an implementable plan, Sigilix offers to open
// a PR and REMEMBERS that offer for the thread (here). A follow-up @mention in the
// same thread resolves against the stored offer: an affirmative confirms (execute),
// anything else is a revision (re-plan, re-offer).
//
// State lives in OPENCLAW_STATE (KV), keyed per (channel, thread) with a 24h TTL.
// Every accessor is FAIL-CLOSED: a KV fault on get returns null (→ the caller
// behaves exactly as it does with no pending offer), and set/clear swallow faults
// (a lost offer just isn't remembered — never throws into the deferred Slack work).

import type { Env } from "@/src/shared/types/env"

// ─── Constants ────────────────────────────────────────────────────────────────

/** 24h — an offer the user never answers expires rather than lingering forever. */
const OFFER_TTL_SECONDS = 86_400

/**
 * Affirmative follow-up to a pending offer → CONFIRM (execute). Anchored to the
 * WHOLE message (allowing only trailing punctuation + a short courtesy tail) so a
 * counter-proposal that merely STARTS with an affirmative token ("do it this way
 * instead") is NOT misread as a confirm — those fall through to REVISE.
 */
const AFFIRMATIVE_REPLY =
  /^\s*(yes|yep|yeah|yup|sure|ok|okay|go ahead|go|do it|ship it|lgtm|sounds good|sounds great|looks good|perfect|that works|please do|let'?s go|absolutely)\b[\s,.!]*(please|now|thanks|thank you)?[\s,.!]*$/i

/**
 * Decline follow-up to a pending offer → DECLINE (drop the offer). Anchored to the
 * WHOLE message (only trailing punctuation + a short courtesy tail), MIRRORING the
 * affirmative regex, so a bare rejection ("no", "never mind", "no thanks") clears
 * the offer — but a counter-proposal that merely STARTS with a negation ("no, use a
 * queue instead") is NOT misread as a decline and falls through to REVISE (the
 * negotiation path). Evaluated AFTER the affirmative check.
 */
const DECLINE_REPLY =
  /^\s*(no|nope|nah|never ?mind|cancel|stop|forget it|leave it|drop it|not now)\b[\s,.!]*(thanks|thank you|please|for now)?[\s,.!]*$/i

// ─── Public types ─────────────────────────────────────────────────────────────

/** The remembered offer: the agreed plan (→ Linear ticket body) + a ticket title. */
export interface ImplementOffer {
  plan: string
  title: string
}

// ─── Key ──────────────────────────────────────────────────────────────────────

function offerKey(channelId: string, threadTs: string): string {
  return `slack-implement-offer:${channelId}:${threadTs}`
}

// ─── State accessors (fail-closed over KV) ─────────────────────────────────────

/**
 * Read the pending offer for a thread. Returns null on a miss, a malformed
 * value, OR any KV fault — the caller treats all three identically (no pending
 * offer → normal qa/triage/implement routing).
 */
export async function getImplementOffer(
  env: Pick<Env, "OPENCLAW_STATE">,
  channelId: string,
  threadTs: string,
): Promise<ImplementOffer | null> {
  try {
    const raw = await env.OPENCLAW_STATE.get(offerKey(channelId, threadTs))
    if (typeof raw !== "string") return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    const plan = typeof obj.plan === "string" ? obj.plan : ""
    const title = typeof obj.title === "string" ? obj.title : ""
    if (!plan || !title) return null
    return { plan, title }
  } catch {
    return null
  }
}

/** Persist (or replace) the pending offer for a thread with a 24h TTL. Best-effort. */
export async function setImplementOffer(
  env: Pick<Env, "OPENCLAW_STATE">,
  channelId: string,
  threadTs: string,
  offer: ImplementOffer,
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.put(offerKey(channelId, threadTs), JSON.stringify(offer), {
      expirationTtl: OFFER_TTL_SECONDS,
    })
  } catch {
    // best-effort: an offer that fails to persist simply isn't remembered.
  }
}

/** Clear the pending offer for a thread (after a confirm, or a no-team decline). */
export async function clearImplementOffer(
  env: Pick<Env, "OPENCLAW_STATE">,
  channelId: string,
  threadTs: string,
): Promise<void> {
  try {
    await env.OPENCLAW_STATE.delete(offerKey(channelId, threadTs))
  } catch {
    // best-effort
  }
}

// ─── Classifier ─────────────────────────────────────────────────────────────

/**
 * Classify a follow-up reply to a pending offer. An affirmative ("yes", "go
 * ahead", "do it", "ship it", "lgtm", …) → CONFIRM; a short rejection ("no",
 * "never mind", "cancel", …) → DECLINE; everything else (a counter-proposal, a
 * question, a revision) → REVISE. Confirm is checked first so it always wins.
 */
export function classifyOfferReply(mentionText: string): "confirm" | "decline" | "revise" {
  const trimmed = mentionText.trim()
  if (AFFIRMATIVE_REPLY.test(trimmed)) return "confirm"
  if (DECLINE_REPLY.test(trimmed)) return "decline"
  return "revise"
}
