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
// EXTERNAL state is possible) is why the claim regex is scoped to race/
// concurrent-ACCESS language and excludes external-consistency phrasing, and why
// it ships shadow-first.

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
const EXTERNAL_STATE_REGEX =
  /\b(external|other (?:do|durable object|instance|worker)|cross-instance|across instances|another (?:do|instance|request)|remote|upstream|third-party)\b/i

/**
 * True when the finding makes an intra-instance race/concurrency claim (and so,
 * on a DurableObject method, is a categorical false positive). Pure. The caller
 * is responsible for confirming the finding's line is inside a DO class body
 * (`lineInDurableObjectClass`).
 */
export function findingClaimsIntraInstanceRace(finding: PrReviewFinding): boolean {
  const text = `${finding.headline ?? ""}\n${finding.body ?? ""}`
  if (!RACE_CLAIM_REGEX.test(text)) return false
  // A cross-instance / external-state claim is NOT an intra-instance race — keep it.
  if (EXTERNAL_STATE_REGEX.test(text)) return false
  return true
}
