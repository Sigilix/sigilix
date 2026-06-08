// SIG-318 (PR 1): the ensemble timeout-budget domain unit.
//
// The five budget invariants used to be inline module-load `if (…) throw`
// checks, which could only ever observe the ONE valid permutation. Extracting
// them into `assertEnsembleBudgetInvariants` makes every bad permutation
// exercisable — that is the point of this test. It also pins the god-file's
// re-export surface so the extraction stays behaviorally invisible to existing
// importers (tests + siblings that import the schedule from the god-file).

import { describe, it, expect } from "vitest"
import {
  assertEnsembleBudgetInvariants,
  type EnsembleBudgetTimeouts,
  SPECIALIST_TIMEOUT_MS,
  SYNTHESIZER_TIMEOUT_MS,
  SYNTHESIZER_RETRY_TIMEOUT_MS,
  RESERVED_HEADROOM_MS,
  ORCHESTRATOR_TIMEOUT_MS,
  RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
  PER_ATTEMPT_TIMEOUT_MS,
  GRAPH_RPC_TIMEOUT_MS,
  GRAPH_EXPANSION_TIMEOUT_MS,
  SYNTH_RETRY_FINALIZE_RESERVE_MS,
  CF_QUEUE_CONSUMER_CEILING_MS,
  SHADOW_FINALIZE_GRACE_MS,
} from "../src/lib/ensemble/domain/budget"
// Importing the god-file proves the module-load assertion still fires through
// the re-export chain (a violated real budget would crash this import) and lets
// us check the re-exported surface below.
import * as ensemble from "../src/lib/triage-pr-review-ensemble"

// The real production budget, imported from the same constants the runtime
// guard uses (ARC-288: never hardcode a duplicate that can drift).
const REAL: EnsembleBudgetTimeouts = {
  specialistMs: SPECIALIST_TIMEOUT_MS,
  synthesizerMs: SYNTHESIZER_TIMEOUT_MS,
  synthesizerRetryMs: SYNTHESIZER_RETRY_TIMEOUT_MS,
  reservedHeadroomMs: RESERVED_HEADROOM_MS,
  orchestratorMs: ORCHESTRATOR_TIMEOUT_MS,
  retrievalPreflightMs: RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
  synthRetryFinalizeReserveMs: SYNTH_RETRY_FINALIZE_RESERVE_MS,
  cfQueueConsumerCeilingMs: CF_QUEUE_CONSUMER_CEILING_MS,
  shadowFinalizeGraceMs: SHADOW_FINALIZE_GRACE_MS,
}

describe("SIG-318 ensemble budget — load-time invariants", () => {
  it("the real production budget satisfies every invariant", () => {
    // budget.ts runs exactly this at module load; a regression that violated it
    // would crash the whole suite at import. Pinned here so intent is explicit.
    expect(() => assertEnsembleBudgetInvariants(REAL)).not.toThrow()
  })

  it("throws when specialist + synth + headroom exceeds the orchestrator wall", () => {
    expect(() =>
      assertEnsembleBudgetInvariants({ ...REAL, specialistMs: REAL.orchestratorMs }),
    ).toThrow(/timeout invariant violated/)
  })

  it("throws when synth retry + finalize exceeds the reserved headroom", () => {
    expect(() =>
      assertEnsembleBudgetInvariants({ ...REAL, synthesizerRetryMs: REAL.reservedHeadroomMs }),
    ).toThrow(/synth-retry budget invariant violated/)
  })

  it("throws when pre-flight + retry + finalize exceeds the reserved headroom", () => {
    // Bump pre-flight to one ms past the slack left after retry + finalize, so
    // THIS invariant (not the synth-retry one above it) is the one that trips.
    const slack = REAL.reservedHeadroomMs - (REAL.synthesizerRetryMs + REAL.synthRetryFinalizeReserveMs)
    expect(() =>
      assertEnsembleBudgetInvariants({ ...REAL, retrievalPreflightMs: slack + 1 }),
    ).toThrow(/headroom-envelope invariant violated/)
  })

  it("throws when the orchestrator wall reaches the CF queue-consumer ceiling", () => {
    expect(() =>
      assertEnsembleBudgetInvariants({ ...REAL, orchestratorMs: REAL.cfQueueConsumerCeilingMs }),
    ).toThrow(/queue-ceiling invariant violated/)
  })

  it("throws when shadow grace + orchestrator exceeds the CF ceiling", () => {
    expect(() =>
      assertEnsembleBudgetInvariants({
        ...REAL,
        shadowFinalizeGraceMs: REAL.cfQueueConsumerCeilingMs - REAL.orchestratorMs + 1,
      }),
    ).toThrow(/shadow-grace invariant violated/)
  })
})

describe("SIG-318 ensemble budget — god-file re-export surface", () => {
  it("re-exports the full timeout schedule unchanged (existing importers unaffected)", () => {
    expect(ensemble.SPECIALIST_TIMEOUT_MS).toBe(SPECIALIST_TIMEOUT_MS)
    expect(ensemble.SYNTHESIZER_TIMEOUT_MS).toBe(SYNTHESIZER_TIMEOUT_MS)
    expect(ensemble.SYNTHESIZER_RETRY_TIMEOUT_MS).toBe(SYNTHESIZER_RETRY_TIMEOUT_MS)
    expect(ensemble.RESERVED_HEADROOM_MS).toBe(RESERVED_HEADROOM_MS)
    expect(ensemble.ORCHESTRATOR_TIMEOUT_MS).toBe(ORCHESTRATOR_TIMEOUT_MS)
    expect(ensemble.RETRIEVAL_PREFLIGHT_TIMEOUT_MS).toBe(RETRIEVAL_PREFLIGHT_TIMEOUT_MS)
    expect(ensemble.PER_ATTEMPT_TIMEOUT_MS).toBe(PER_ATTEMPT_TIMEOUT_MS)
    expect(ensemble.GRAPH_RPC_TIMEOUT_MS).toBe(GRAPH_RPC_TIMEOUT_MS)
    expect(ensemble.GRAPH_EXPANSION_TIMEOUT_MS).toBe(GRAPH_EXPANSION_TIMEOUT_MS)
    expect(ensemble.SYNTH_RETRY_FINALIZE_RESERVE_MS).toBe(SYNTH_RETRY_FINALIZE_RESERVE_MS)
    expect(ensemble.SHADOW_FINALIZE_GRACE_MS).toBe(SHADOW_FINALIZE_GRACE_MS)
  })
})
