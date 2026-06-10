// ARC-190 Task 2 — pure decision helpers for PrReviewRunDO.
//
// Tests the spec §4.5 / §4.6 decision tables in isolation, without
// any DO storage / alarm / queue side-effects. Helpers feed the
// route handlers that land in Task 5.

import { describe, it, expect } from "vitest"
import {
  isSupersededByNewSha,
  decideEnqueueAction,
  decidePickupAction,
  nextBackoffMs,
  decideRunResultAction,
  pruneHistoryRecords,
} from "@/src/do/pr-review-run"
import type { RunRecord, RunState } from "@/src/do/types"

const NOW_ISO = "2026-05-07T06:00:00.000Z"

function makeState(over: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: 1,
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    runId: "11111111-1111-4111-8111-111111111111",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    installationId: 99,
    state: "queued",
    attempts: 1,
    startedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
    ...over,
  }
}

// ─── isSupersededByNewSha ────────────────────────────────────

describe("isSupersededByNewSha", () => {
  it("same SHA → false", () => {
    const s = makeState({ headSha: "x".repeat(40) })
    expect(isSupersededByNewSha(s, "x".repeat(40))).toBe(false)
  })
  it("different SHA → true", () => {
    const s = makeState({ headSha: "x".repeat(40) })
    expect(isSupersededByNewSha(s, "y".repeat(40))).toBe(true)
  })
})

// ─── decideEnqueueAction ─────────────────────────────────────

describe("decideEnqueueAction", () => {
  const incoming = {
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    headSha: "h".repeat(40),
    baseSha: "b".repeat(40),
    installationId: 99,
    deliveryId: "delivery-1",
  }

  it("no existing state → create", () => {
    const r = decideEnqueueAction(null, incoming)
    expect(r.action).toBe("create")
  })

  it("same SHA + state queued → dedupe-active", () => {
    const r = decideEnqueueAction(
      makeState({ headSha: incoming.headSha, state: "queued" }),
      incoming,
    )
    expect(r.action).toBe("dedupe-active")
  })

  it("same SHA + state running → dedupe-active", () => {
    const r = decideEnqueueAction(
      makeState({ headSha: incoming.headSha, state: "running" }),
      incoming,
    )
    expect(r.action).toBe("dedupe-active")
  })

  it("same SHA + state done → dedupe-terminal", () => {
    const r = decideEnqueueAction(
      makeState({ headSha: incoming.headSha, state: "done" }),
      incoming,
    )
    expect(r.action).toBe("dedupe-terminal")
  })

  it("same SHA + state failed → dedupe-terminal", () => {
    const r = decideEnqueueAction(
      makeState({ headSha: incoming.headSha, state: "failed" }),
      incoming,
    )
    expect(r.action).toBe("dedupe-terminal")
  })

  it("different SHA → supersede", () => {
    const r = decideEnqueueAction(
      makeState({ headSha: "OLD".padEnd(40, "0"), state: "running" }),
      incoming,
    )
    expect(r.action).toBe("supersede")
  })
})

// ─── decidePickupAction ──────────────────────────────────────

describe("decidePickupAction", () => {
  it("state queued + matching runId → claim", () => {
    const s = makeState({ state: "queued", runId: "rid-1" })
    expect(decidePickupAction(s, "rid-1", "consumer-A").action).toBe("claim")
  })

  it("state queued but runId mismatch → stale-runId-410", () => {
    const s = makeState({ state: "queued", runId: "rid-1" })
    expect(decidePickupAction(s, "rid-OLD", "consumer-A").action).toBe("stale-runId-410")
  })

  it("state running + matching runId + different consumerId → duplicate-409", () => {
    const s = makeState({
      state: "running", runId: "rid-1", consumerId: "consumer-A",
    })
    expect(decidePickupAction(s, "rid-1", "consumer-B").action).toBe("duplicate-409")
  })

  it("state running + same consumerId → claim (re-pickup)", () => {
    const s = makeState({
      state: "running", runId: "rid-1", consumerId: "consumer-A",
    })
    expect(decidePickupAction(s, "rid-1", "consumer-A").action).toBe("claim")
  })

  it("state done → terminal-410", () => {
    const s = makeState({ state: "done", runId: "rid-1" })
    expect(decidePickupAction(s, "rid-1", "consumer-A").action).toBe("terminal-410")
  })

  it("state failed → terminal-410", () => {
    const s = makeState({ state: "failed", runId: "rid-1" })
    expect(decidePickupAction(s, "rid-1", "consumer-A").action).toBe("terminal-410")
  })

  it("null state → stale-runId-410", () => {
    expect(decidePickupAction(null, "rid-1", "consumer-A").action).toBe("stale-runId-410")
  })
})

// ─── nextBackoffMs ───────────────────────────────────────────

describe("nextBackoffMs", () => {
  it("attempts=1 → 30s", () => {
    expect(nextBackoffMs(1)).toBe(30000)
  })
  it("attempts=2 → 90s", () => {
    expect(nextBackoffMs(2)).toBe(90000)
  })
  it("attempts=3 → 270s", () => {
    expect(nextBackoffMs(3)).toBe(270000)
  })
  it("attempts=4 → 270s (clamped to max)", () => {
    expect(nextBackoffMs(4)).toBe(270000)
  })
  it("attempts=10 → 270s (clamped)", () => {
    expect(nextBackoffMs(10)).toBe(270000)
  })
  it("attempts=0 → 30s (defensive lower clamp)", () => {
    expect(nextBackoffMs(0)).toBe(30000)
  })
})

// ─── decideRunResultAction ───────────────────────────────────

describe("decideRunResultAction", () => {
  const MAX_RETRIES = 3

  it("status=success → transition done", () => {
    const s = makeState({ state: "running", runId: "rid-1", consumerId: "c-A" })
    const r = decideRunResultAction(
      s,
      { runId: "rid-1", consumerId: "c-A", status: "success" },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("done")
    expect(r.nextAlarmAt).toBeUndefined()
  })

  it("status=transient + attempts<max → failed-transient + alarm scheduled", () => {
    const s = makeState({
      state: "running", runId: "rid-1", consumerId: "c-A", attempts: 1,
    })
    const nowMs = Date.parse(NOW_ISO)
    const r = decideRunResultAction(
      s,
      {
        runId: "rid-1", consumerId: "c-A", status: "transient",
        error: { stage: "github-5xx", message: "503" },
      },
      MAX_RETRIES,
      nowMs,
    )
    expect(r.transition).toBe("failed-transient")
    expect(r.nextAlarmAt).toBe(nowMs + 30000)
  })

  it("status=transient + attempts=max → failed (terminal)", () => {
    const s = makeState({
      state: "running", runId: "rid-1", consumerId: "c-A", attempts: 3,
    })
    const r = decideRunResultAction(
      s,
      {
        runId: "rid-1", consumerId: "c-A", status: "transient",
        error: { stage: "github-5xx", message: "503" },
      },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("failed")
    expect(r.nextAlarmAt).toBeUndefined()
  })

  it("status=terminal regardless of attempts → failed", () => {
    const s = makeState({
      state: "running", runId: "rid-1", consumerId: "c-A", attempts: 1,
    })
    const r = decideRunResultAction(
      s,
      {
        runId: "rid-1", consumerId: "c-A", status: "terminal",
        error: { stage: "submit-422", message: "invalid anchor" },
      },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("failed")
  })

  it("consumerId mismatch (superseded consumer) → history", () => {
    const s = makeState({
      state: "running", runId: "rid-1", consumerId: "c-NEW",
    })
    const r = decideRunResultAction(
      s,
      { runId: "rid-1", consumerId: "c-OLD", status: "success" },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("history")
  })

  it("runId mismatch (superseded run) → history", () => {
    const s = makeState({ runId: "rid-NEW", consumerId: "c-A" })
    const r = decideRunResultAction(
      s,
      { runId: "rid-OLD", consumerId: "c-A", status: "success" },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("history")
  })

  // Codex P2: terminal current-state must not be flipped by late
  // success/terminal /run-result. Watchdog-terminal already wrote
  // history; the late result is a leftover from the abandoned
  // attempt and belongs in history.
  it("current state=failed (watchdog-terminal) + late status=success → history (no-flip)", () => {
    const s = makeState({
      state: "failed", runId: "rid-1", consumerId: "c-A", attempts: 3,
    })
    const r = decideRunResultAction(
      s,
      { runId: "rid-1", consumerId: "c-A", status: "success" },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("history")
  })

  it("current state=failed + late status=terminal → history (no-flip)", () => {
    const s = makeState({
      state: "failed", runId: "rid-1", consumerId: "c-A", attempts: 3,
    })
    const r = decideRunResultAction(
      s,
      {
        runId: "rid-1", consumerId: "c-A", status: "terminal",
        error: { stage: "submit-422", message: "x" },
      },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("history")
  })

  it("current state=done + late status=transient → history (no-flip)", () => {
    const s = makeState({
      state: "done", runId: "rid-1", consumerId: "c-A", attempts: 1,
    })
    const r = decideRunResultAction(
      s,
      {
        runId: "rid-1", consumerId: "c-A", status: "transient",
        error: { stage: "github-5xx", message: "503" },
      },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("history")
  })

  // Codex P1: only state==="running" accepts /run-result mutations.
  // Late posts from a watchdog-abandoned attempt must not cancel the
  // retry alarm or reset backoff.
  it("current state=failed-transient (watchdog rescheduled retry) + late same-runId same-consumer success → history (no-flip, retry preserved)", () => {
    const s = makeState({
      state: "failed-transient", runId: "rid-1", consumerId: "c-A", attempts: 1,
    })
    const r = decideRunResultAction(
      s,
      { runId: "rid-1", consumerId: "c-A", status: "success" },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("history")
  })

  it("current state=queued (retry alarm requeued) + late same-runId same-consumer transient → history (no-flip, no double-schedule)", () => {
    const s = makeState({
      state: "queued", runId: "rid-1", consumerId: "c-A", attempts: 2,
    })
    const r = decideRunResultAction(
      s,
      {
        runId: "rid-1", consumerId: "c-A", status: "transient",
        error: { stage: "github-5xx", message: "503" },
      },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("history")
    expect(r.nextAlarmAt).toBeUndefined()
  })

  it("current state=idle + same-runId result → history", () => {
    const s = makeState({
      state: "idle", runId: "rid-1", consumerId: "c-A", attempts: 1,
    })
    const r = decideRunResultAction(
      s,
      { runId: "rid-1", consumerId: "c-A", status: "success" },
      MAX_RETRIES,
    )
    expect(r.transition).toBe("history")
  })
})

// ─── pruneHistoryRecords ─────────────────────────────────────

describe("pruneHistoryRecords", () => {
  function rec(runId: string, ts: string): RunRecord {
    return {
      runId,
      headSha: "a".repeat(40),
      finalState: "done",
      attempts: 1,
      startedAt: ts,
      finishedAt: ts,
    }
  }

  it("empty → empty + 0 evicted", () => {
    expect(pruneHistoryRecords({}, 10)).toEqual({ kept: {}, evicted: 0 })
  })

  it("under cap → unchanged", () => {
    const r = {
      "run:1": rec("run:1", "2026-05-07T01:00:00Z"),
      "run:2": rec("run:2", "2026-05-07T02:00:00Z"),
    }
    const out = pruneHistoryRecords(r, 10)
    expect(out.evicted).toBe(0)
    expect(Object.keys(out.kept).length).toBe(2)
  })

  it("at cap → unchanged", () => {
    const r: Record<string, RunRecord> = {}
    for (let i = 0; i < 10; i++) {
      r[`run:${i}`] = rec(`run:${i}`, `2026-05-07T0${i}:00:00Z`)
    }
    const out = pruneHistoryRecords(r, 10)
    expect(out.evicted).toBe(0)
    expect(Object.keys(out.kept).length).toBe(10)
  })

  it("over cap → evicts oldest by finishedAt", () => {
    const r: Record<string, RunRecord> = {
      "run:0": rec("run:0", "2026-05-07T00:00:00Z"),  // oldest
      "run:1": rec("run:1", "2026-05-07T01:00:00Z"),
      "run:2": rec("run:2", "2026-05-07T02:00:00Z"),
    }
    const out = pruneHistoryRecords(r, 2)
    expect(out.evicted).toBe(1)
    expect(Object.keys(out.kept).sort()).toEqual(["run:1", "run:2"])
  })

  it("limit 0 → evicts all", () => {
    const r: Record<string, RunRecord> = {
      "run:0": rec("run:0", "2026-05-07T00:00:00Z"),
    }
    const out = pruneHistoryRecords(r, 0)
    expect(out.evicted).toBe(1)
    expect(Object.keys(out.kept).length).toBe(0)
  })
})
