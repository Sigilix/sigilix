import type { ActivitySeatAction, ActivitySeatAssociation, ActivitySeatEvidence } from "@/src/features/billing"
import type { GitHubWebhookPayload } from "@/src/index-internals"

const ACTIONS = new Set<ActivitySeatAction>(["opened", "synchronize", "ready_for_review"])
const ASSOCIATIONS = new Set<ActivitySeatAssociation>(["OWNER", "MEMBER"])

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function optionalLogin(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !value.includes("\0")
    ? value
    : undefined
}

/** Extract immutable activity identity only from the already-verified webhook body. */
export async function buildGitHubActivitySeatEvidence(args: {
  payload: GitHubWebhookPayload
  rawBody: string
  deliveryId: string | null
  installationId: number
  repositoryId: number | undefined
  prNumber: number
  headSha: string
  action: string | undefined
  receivedAtMs: number
}): Promise<ActivitySeatEvidence | undefined> {
  const targetId = args.payload.pull_request?.user?.id
  const actorId = args.payload.sender?.id
  const association = args.payload.pull_request?.author_association
  if (
    !args.deliveryId ||
    args.deliveryId.trim().length === 0 ||
    args.deliveryId.length > 128 ||
    args.deliveryId.includes("\0") ||
    !positiveSafeInteger(args.installationId) ||
    !positiveSafeInteger(args.repositoryId) ||
    !positiveSafeInteger(args.prNumber) ||
    args.headSha.trim().length === 0 ||
    args.headSha.length > 128 ||
    args.headSha.includes("\0") ||
    !ACTIONS.has(args.action as ActivitySeatAction) ||
    !ASSOCIATIONS.has(association as ActivitySeatAssociation) ||
    !positiveSafeInteger(targetId) ||
    !positiveSafeInteger(actorId) ||
    !Number.isSafeInteger(args.receivedAtMs) ||
    args.receivedAtMs < 0
  ) {
    return undefined
  }
  const targetLogin = optionalLogin(args.payload.pull_request?.user?.login)
  const actorLogin = optionalLogin(args.payload.sender?.login)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(args.rawBody))
  const payloadSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return {
    deliveryId: args.deliveryId,
    payloadSha256,
    installationId: args.installationId,
    repositoryId: args.repositoryId,
    prNumber: args.prNumber,
    headSha: args.headSha,
    action: args.action as ActivitySeatAction,
    targetGithubUserId: String(targetId),
    ...(targetLogin !== undefined ? { targetLogin } : {}),
    actorGithubUserId: String(actorId),
    ...(actorLogin !== undefined ? { actorLogin } : {}),
    authorAssociation: association as ActivitySeatAssociation,
    receivedAtMs: args.receivedAtMs,
  }
}
