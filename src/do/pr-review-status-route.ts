import type { RunState } from "./types"
import {
  type ReviewStatusPhase,
  type ReviewStatusSnapshot,
  reviewStatusPhaseRank,
} from "@/src/lib/pr-review-status-render"
import { emit, jsonResponse, nowIso } from "./pr-review-run-internals"

const STATE_KEY = "state"

interface StatusProgressRequest {
  runId: string
  sequence: number
  phase: ReviewStatusPhase
  snapshot: ReviewStatusSnapshot
}

export async function handleStatusProgress(storage: DurableObjectStorage, request: Request): Promise<Response> {
  const body = (await request.json()) as Partial<StatusProgressRequest>
  if (!isStatusProgressRequest(body)) {
    return jsonResponse(400, { accepted: false, reason: "invalid-payload" })
  }
  const { runId, phase, sequence, snapshot: requestedSnapshot } = body

  const existing = await storage.get<RunState>(STATE_KEY)
  if (!existing || existing.runId !== runId) {
    return jsonResponse(410, { accepted: false, reason: "stale-runId" })
  }

  const currentPhase = existing.reviewStatus?.phase
  if (currentPhase === "posted") {
    return jsonResponse(200, { accepted: false, phase: currentPhase, reason: "terminal-phase" })
  }
  if (currentPhase !== undefined && reviewStatusPhaseRank(currentPhase) > reviewStatusPhaseRank(phase)) {
    return jsonResponse(200, { accepted: false, phase: currentPhase, reason: "stale-phase" })
  }
  const currentSequence = existing.reviewStatusSequence ?? -1
  if (currentPhase === phase && currentSequence > sequence) {
    return jsonResponse(200, { accepted: false, phase: currentPhase, reason: "stale-sequence" })
  }

  const snapshot: ReviewStatusSnapshot = {
    ...requestedSnapshot,
    phase,
    sequence,
    headSha: requestedSnapshot.headSha || existing.headSha,
  }
  const updated: RunState = {
    ...existing,
    reviewStatus: snapshot,
    reviewStatusSequence: sequence,
    lastActivityAt: nowIso(),
  }
  await storage.put(STATE_KEY, updated)
  emit("pr-review-status-comment-state", {
    owner: existing.owner,
    repo: existing.repo,
    prNumber: existing.prNumber,
    runId: existing.runId,
    phase,
    sequence,
  })
  return jsonResponse(200, { accepted: true, phase })
}

function isStatusProgressRequest(body: Partial<StatusProgressRequest>): body is StatusProgressRequest {
  const sequence = body.sequence
  return (
    typeof body.runId === "string" &&
    typeof sequence === "number" &&
    Number.isInteger(sequence) &&
    sequence >= 0 &&
    isReviewStatusPhase(body.phase) &&
    typeof body.snapshot === "object" &&
    body.snapshot !== null
  )
}

function isReviewStatusPhase(value: unknown): value is ReviewStatusPhase {
  return (
    value === "queued" ||
    value === "retrieval" ||
    value === "specialists" ||
    value === "synth" ||
    value === "posted" ||
    value === "degraded" ||
    value === "skipped" ||
    value === "failed"
  )
}
