// PTS SIG-582 — reasoning-preserving compaction v2 (the first registered TREATMENT
// for the SIG-578 continuity harness).
//
// WHY: naive summary compaction (Control-B) replaces the whole transcript with ONE
// free-form "be concise" summary. That prose paraphrases away exactly the working state
// the harness scores — the specific evidence that ruled a hypothesis out, each committed
// constraint, the exact decision (file + key). When the window resets, the agent re-derives
// a dead end or violates a constraint it can no longer see.
//
// v2 replaces the free-form summary with a STRUCTURED extraction of the reasoning the agent
// has accumulated — decisions, ruled-out hypotheses (with their evidence), constraints, open
// threads — and a verbatim key-facts scratchpad for the exact identifiers/numbers a prose
// summary loses. Same shape as the naive baseline (a single user message replaces the
// transcript, one extra model call), so the harness measures ONLY the structured-vs-free-form
// variable. Still a TEXT-layer wedge (not the KV/cartridge moat) — but it ships value on
// today's MaaS and is the honest first rung of the ladder.
//
// The classes it extracts are the general working-state classes the SIG-582 ticket names,
// NOT the corpus's specific anchors — the prompt never references a scenario or a probe, so
// this is the real technique, not teaching to the test.
//
// Self-registers as `reasoning-v2` on import. The live eval (pts-continuity-eval.live.test.ts)
// imports this module so `PTS_TREATMENT=reasoning-v2 npm run pts-continuity-eval` runs it as
// the treatment condition; the pure plumbing is regression-guarded in pts-compaction-v2.test.ts.

import type { ChatMessage } from "@/src/shared/ports/model"

import { type Compactor, type CompactionInput, registerTreatmentCompactor } from "./pts-continuity-harness"

export const COMPACTION_V2_ID = "reasoning-v2"

/** System prompt for the structured extraction. Names the general working-state classes
 *  (decisions / ruled-out hypotheses / constraints / open threads) + a verbatim key-facts
 *  scratchpad. Deliberately corpus-agnostic: it never mentions a scenario or a probe. */
export const COMPACTION_V2_SYSTEM =
  "You are compacting a long agent working session to free the context window WITHOUT losing " +
  "the reasoning the agent has accumulated. Output a STRUCTURED state the agent will resume from " +
  "— after this, it is the agent's ENTIRE memory of the session, so anything you omit is lost and " +
  "will be re-derived or violated.\n\n" +
  "Extract these sections from the conversation. Be exhaustive within each:\n\n" +
  "## Decisions\n" +
  "Every decision made, with its specifics — WHAT was decided, WHERE it applies (file/location), " +
  "and the exact mechanism or key.\n\n" +
  "## Ruled-out hypotheses\n" +
  "Every hypothesis considered and REJECTED, each with the specific EVIDENCE that ruled it out, so " +
  "the agent does not re-investigate a dead end.\n\n" +
  "## Constraints\n" +
  "Every constraint the work has committed to. List ALL of them — a missed constraint gets violated.\n\n" +
  "## Open threads\n" +
  "What is still unresolved and the next step.\n\n" +
  "## Key facts\n" +
  "The specific identifiers, values, file names, config knobs, IDs, and numbers from the session — " +
  "COPIED VERBATIM, not paraphrased. These exact details are what a prose summary loses.\n\n" +
  "Rules: preserve exact identifiers and numbers verbatim — do not round, rename, or generalize. " +
  "Include only what the conversation established; invent nothing. Omit a section only if it is " +
  "genuinely empty."

/** Render the pre-reset transcript for the extraction call. Role-labeled, in order — same
 *  serialization the naive baseline uses, so the only difference under test is the prompt. */
function serializeTranscript(transcript: ChatMessage[]): string {
  return transcript.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")
}

/**
 * Reasoning-preserving compaction v2. One metered model call produces a structured state,
 * returned as a single user message (mirroring the naive baseline's shape). A model error
 * propagates to the harness, which marks the run `errored` (never a false zero-retention run).
 */
export const reasoningPreservingCompactor: Compactor = {
  id: COMPACTION_V2_ID,
  async compact(input: CompactionInput): Promise<ChatMessage[]> {
    const reply = await input.model.send([
      { role: "system", content: COMPACTION_V2_SYSTEM },
      {
        role: "user",
        content: `Compact this working session into the structured state:\n\n${serializeTranscript(input.transcript)}`,
      },
    ])
    return [{ role: "user", content: `STRUCTURED SESSION STATE (resume from this):\n\n${reply.text}` }]
  },
}

// Self-register on import so the live eval picks it up as the treatment condition.
registerTreatmentCompactor(reasoningPreservingCompactor)
