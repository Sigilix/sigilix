// PTS SIG-582 — reasoning-preserving compaction v2 plumbing (no model, CI-safe).
// The retention WIN over the naive baseline is an empirical claim proven by the live eval
// (`PTS_TREATMENT=reasoning-v2 npm run pts-continuity-eval`); here we regression-guard the
// contract: one metered call, correct output shape, the structured extraction prompt, and
// self-registration as the treatment compactor.

import { describe, it, expect } from "vitest"

import type { ChatMessage } from "@/src/shared/ports/model"

import { reasoningPreservingCompactor, COMPACTION_V2_ID, COMPACTION_V2_SYSTEM } from "./pts-compaction-v2"
import {
  runContinuitySession,
  resolveTreatmentCompactor,
  naiveSummaryCompactor,
  type ModelClient,
  type CompactionInput,
} from "./pts-continuity-harness"
import { CONTINUITY_SCENARIOS } from "./pts-continuity-corpus"

const bugHunt = CONTINUITY_SCENARIOS.find((s) => s.id === "double-charge-bug-hunt")!

/** Records every message list the compactor sends, and replies with a fixed extraction. */
function recordingClient(reply = "STRUCTURED_EXTRACTION_OUTPUT"): ModelClient & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = []
  return {
    calls,
    async send(messages) {
      calls.push(messages)
      return { text: reply, inputTokens: 10, outputTokens: 5, latencyMs: 3 }
    },
  }
}

const transcript: ChatMessage[] = [
  { role: "user", content: "OBSERVATION: only one /api/pay fires per checkout, even on rage-clicks." },
  { role: "assistant", content: "Frontend double-submit ruled out." },
  { role: "user", content: "DECISION: guard handleWebhook on event.id with a SETNX." },
  { role: "assistant", content: "Acknowledged." },
]

const input = (model: ModelClient): CompactionInput => ({
  systemPrompt: "sys",
  transcript,
  scenario: { id: bugHunt.id, kind: bugHunt.kind },
  model,
})

describe("reasoningPreservingCompactor", () => {
  it("self-registers as the `reasoning-v2` treatment compactor on import", () => {
    expect(COMPACTION_V2_ID).toBe("reasoning-v2")
    expect(resolveTreatmentCompactor("reasoning-v2")?.id).toBe("reasoning-v2")
  })

  it("makes exactly one model call and returns a single user message", async () => {
    const model = recordingClient()
    const out = await reasoningPreservingCompactor.compact(input(model))
    expect(model.calls).toHaveLength(1)
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe("user")
    expect(out[0]!.content).toContain("STRUCTURED SESSION STATE")
    expect(out[0]!.content).toContain("STRUCTURED_EXTRACTION_OUTPUT")
  })

  it("sends the STRUCTURED extraction prompt (not the naive 'be concise' summary)", async () => {
    const model = recordingClient()
    await reasoningPreservingCompactor.compact(input(model))
    const [sent] = model.calls
    const system = sent!.find((m) => m.role === "system")!.content
    // v2 names the working-state classes to preserve — this is the difference vs naive.
    expect(system).toBe(COMPACTION_V2_SYSTEM)
    for (const section of ["Decisions", "Ruled-out hypotheses", "Constraints", "Open threads", "Key facts"]) {
      expect(system).toContain(section)
    }
    // Instructs verbatim preservation — the mechanism against paraphrase-loss.
    expect(system.toLowerCase()).toContain("verbatim")
    // NOT the naive baseline's prompt.
    expect(system).not.toContain("Be concise")
  })

  it("passes the full pre-reset transcript to the extraction call (nothing dropped pre-model)", async () => {
    const model = recordingClient()
    await reasoningPreservingCompactor.compact(input(model))
    const userMsg = model.calls[0]!.find((m) => m.role === "user")!.content
    expect(userMsg).toContain("event.id")
    expect(userMsg).toContain("/api/pay")
    expect(userMsg).toContain("SETNX")
    // Role-labeled, in order (same serialization as the naive baseline).
    expect(userMsg).toContain("USER:")
    expect(userMsg).toContain("ASSISTANT:")
  })

  it("adds exactly one metered model call in a full run (same call-count shape as naive)", async () => {
    const naiveCalls: string[] = []
    const v2Calls: string[] = []
    const mk = (log: string[]): ModelClient => ({
      async send(messages) {
        log.push(messages.find((m) => m.role === "system")?.content ?? "")
        return { text: "ok", inputTokens: 1, outputTokens: 1, latencyMs: 1 }
      },
    })
    await runContinuitySession({ scenario: bugHunt, compactor: naiveSummaryCompactor, model: mk(naiveCalls) })
    await runContinuitySession({ scenario: bugHunt, compactor: reasoningPreservingCompactor, model: mk(v2Calls) })
    // Both add exactly one compaction call -> identical total call count; only the prompt differs.
    expect(v2Calls.length).toBe(naiveCalls.length)
    expect(v2Calls).toContain(COMPACTION_V2_SYSTEM)
  })

  it("propagates a model error (harness then marks the run errored, never a false zero)", async () => {
    const throwing: ModelClient = {
      async send() {
        throw new Error("boom")
      },
    }
    await expect(reasoningPreservingCompactor.compact(input(throwing))).rejects.toThrow("boom")
    const m = await runContinuitySession({
      scenario: bugHunt,
      compactor: reasoningPreservingCompactor,
      model: throwing,
    })
    expect(m.errored).toBe(true)
  })
})
