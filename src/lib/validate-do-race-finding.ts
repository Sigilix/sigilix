// SIG-307: DurableObject intra-instance race-condition false-positive detector.
//
// A Durable Object serializes EVERY invocation of a given instance — requests
// and alarms run one-at-a-time behind Cloudflare's input gates, and `await`
// inside a handler does NOT let another invocation of the same instance
// interleave (the input gate is held). So a finding that claims a race
// condition / concurrent-access bug on a DO instance's own state is a
// categorical false positive — the model over-fires "race"/"concurrency"
// language on code that cannot race (observed: "DO alarm scheduling race" on
// byte-identical-to-shipped DO code, refuted).
//
// This is the SIG-141 shape (authz-on-DO = always FP) for the concurrency
// category. It is intentionally NARROW: it fires only when BOTH (a) the finding
// makes an intra-instance race/concurrency CLAIM, and (b) the caller has
// confirmed the finding's line is inside a DurableObject class body. The
// await/external-state nuance (a real cross-await consistency bug against
// EXTERNAL state — another worker/DO, KV, storage, D1 — IS possible) is carved
// out by EXTERNAL_STATE_REGEX, so those findings are kept. The matched finding
// is DEMOTED to the body, not dropped (FN-safe: a residual real finding stays
// visible), which is why this ships always-on rather than shadow-first.

import type { PrReviewFinding } from "./triage-pr-review"

/** Race / concurrent-access language — the over-fire signal. */
const RACE_CLAIM_REGEX =
  /\b(race condition|data race|race|concurrent(?:ly)?|concurrency|thread[- ]?safe(?:ty)?|atomic(?:ity|ities)?|interleav\w*|TOCTOU|time-of-check)\b/i

/**
 * Phrasing that points at EXTERNAL-state consistency rather than an
 * intra-instance race — these are NOT categorically false on a DO (a DO can
 * read external state across an await and act on a stale value). When present,
 * we do NOT treat the finding as a DO-race FP.
 */
// CLEARLY-external actors/services only. NOT `storage`/`cache` — those are often
// the DO's OWN serialized state, where a race finding is the FP we want to demote
// (an in-memory "cache map" race is intra-instance). KV/D1/R2/database/queue are
// genuinely external (cross-system, eventually-consistent) → keep those findings.
const EXTERNAL_STATE_REGEX =
  /\b(external|cross-instance|across instances|remote|upstream|third-party|(?:other|another)\s+(?:durable object|do|instance|request|worker)|kv|d1|r2|database|queue)\b/i

/**
 * Real intra-instance concurrency that CAN occur at INIT time: a constructor's
 * async work runs BEFORE `blockConcurrencyWhile` can gate it, so the first
 * incoming request can interleave with constructor I/O. So init/constructor/
 * blockConcurrencyWhile-phrased findings are kept (Codex #283 — the premise
 * "DOs serialize EVERY invocation" is too strong at construction time).
 */
const INIT_CONCURRENCY_REGEX =
  /\b(blockConcurrencyWhile|constructor|initializ\w*|\binit\b|on (?:construction|startup)|cold[- ]?start|first request)\b/i

/**
 * True when the finding makes an intra-instance, STEADY-STATE race/concurrency
 * claim (and so, on a DurableObject method, is a categorical false positive —
 * DOs serialize every post-construction invocation via input gates). Pure. The
 * caller confirms the finding's line is inside a DO class body
 * (`lineInDurableObjectClass`) and that the finding isn't a testing/docs note.
 */
export function findingClaimsIntraInstanceRace(finding: PrReviewFinding): boolean {
  const text = `${finding.headline ?? ""}\n${finding.body ?? ""}`
  if (!RACE_CLAIM_REGEX.test(text)) return false
  // Cross-instance / external-state claims are real — keep them.
  if (EXTERNAL_STATE_REGEX.test(text)) return false
  // Init/constructor races are real (pre-gate constructor I/O) — keep them.
  if (INIT_CONCURRENCY_REGEX.test(text)) return false
  return true
}
