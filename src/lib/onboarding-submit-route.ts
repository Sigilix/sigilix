// #155 onboarding-backend slice 3 (portal endpoints) — POST /v1/onboarding.
//
// Session-authed (requireSession) + CORS'd (portal-cors.ts, wired in
// index.ts). Stores the portal setup wizard's full answer payload verbatim
// in KV, keyed by the session's githubUserId (last-write-wins). Validation
// here is loose (types + a byte cap on the whole body) — this is
// user-authored onboarding context, not an authorization boundary, so we
// don't reject on unrecognized-but-well-typed fields.
//
// FOUNDER ADDENDUM: beyond the raw-payload KV blob, three fields also feed
// the EXISTING learnings store as initial repo/org memory context (see
// onboarding-memory-capture.ts for the write-side detail + the
// security-critical scoping rule). That write is best-effort and can never
// fail this endpoint — see captureOnboardingMemory's own doc comment.
//
// Never store or log the session's access token or any GitHub credential —
// this route only ever touches the wizard's own answer fields.

import { requireSession } from "@/src/lib/auth-middleware"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { captureOnboardingMemory } from "@/src/lib/onboarding-memory-capture"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"

// ~32KB — generous for free-text answers + a repo-description map, small
// enough to stay well under KV's per-value limit and the Worker's memory.
const MAX_BODY_BYTES = 32 * 1024
const ONBOARDING_KV_PREFIX = "onboarding:"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** A named cross-repo relationship the wizard's user described, e.g. {from:"api",label:"calls",to:"worker"}. */
export interface OnboardingLink {
  from: string
  label: string
  to: string
}

export interface OnboardingPayload {
  fullName?: string
  challenges?: string[]
  companySize?: string
  hearAbout?: string
  selectedRepos?: string[]
  repoDescriptions?: Record<string, string>
  links?: OnboardingLink[]
  conventions?: string
  model?: string
  sceneId?: string
  ts?: number
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")
  )
}

function isOnboardingLink(v: unknown): v is OnboardingLink {
  if (typeof v !== "object" || v === null) return false
  const l = v as Record<string, unknown>
  return typeof l.from === "string" && typeof l.label === "string" && typeof l.to === "string"
}

function isLinkArray(v: unknown): v is OnboardingLink[] {
  return Array.isArray(v) && v.every(isOnboardingLink)
}

/** Every field is optional; a PRESENT field of the wrong type rejects the whole body. */
function validatePayload(raw: unknown): OnboardingPayload | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (b.fullName !== undefined && typeof b.fullName !== "string") return "fullName must be a string"
  if (b.challenges !== undefined && !isStringArray(b.challenges)) return "challenges must be a string array"
  if (b.companySize !== undefined && typeof b.companySize !== "string") return "companySize must be a string"
  if (b.hearAbout !== undefined && typeof b.hearAbout !== "string") return "hearAbout must be a string"
  if (b.selectedRepos !== undefined && !isStringArray(b.selectedRepos)) return "selectedRepos must be a string array"
  if (b.repoDescriptions !== undefined && !isStringRecord(b.repoDescriptions)) {
    return "repoDescriptions must be an object of string values"
  }
  if (b.links !== undefined && !isLinkArray(b.links)) return "links must be an array of {from,label,to}"
  if (b.conventions !== undefined && typeof b.conventions !== "string") return "conventions must be a string"
  if (b.model !== undefined && typeof b.model !== "string") return "model must be a string"
  if (b.sceneId !== undefined && typeof b.sceneId !== "string") return "sceneId must be a string"
  if (b.ts !== undefined && typeof b.ts !== "number") return "ts must be a number"
  return b as OnboardingPayload
}

/** POST /v1/onboarding — session-authed. Stores the wizard payload, last-write-wins. */
export async function handleOnboardingSubmitRoute(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const authed = await requireSession(request, env, ctx)
  if (!authed) return json({ error: "unauthenticated" }, 401)

  // sig-user-identity: onboarding is a GitHub-App-install feature keyed by the
  // GitHub user id. Google / email-password sessions have none — fail closed.
  const githubUserId = authed.record.githubUserId
  if (githubUserId == null) return json({ error: "github_account_required" }, 403)

  // CSRF guard (SIG-155 slice 3 — see portal-cors.ts's hasJsonContentType doc
  // comment): required because the session cookie is now SameSite=None.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  const raw = await readBodyCapped(request, MAX_BODY_BYTES)
  if (raw === null) return json({ error: "payload too large" }, 413)

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }

  const validated = validatePayload(parsed)
  if (typeof validated === "string") return json({ error: validated }, 400)

  const key = `${ONBOARDING_KV_PREFIX}${githubUserId}`
  try {
    await env.OPENCLAW_STATE.put(key, JSON.stringify(validated))
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "onboarding-submit-store-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "store_failed" }, 500)
  }

  // Best-effort — see captureOnboardingMemory's doc comment. Never allowed
  // to affect this response; the raw payload above is already durably
  // stored by the time this runs.
  await captureOnboardingMemory(env, githubUserId, validated)

  return json({ ok: true }, 200)
}
