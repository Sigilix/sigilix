// PTS SIG-578 — deep-work continuity corpus + pure scoring (the RULER for the
// Persistent Task State research program).
//
// WHY: an agent doing real multi-step work accumulates WORKING STATE — hypotheses
// it has ruled out, constraints it has committed to, decisions it has made. When the
// context window resets or compacts mid-task, how much of that state survives? Naive
// summary compaction (today's behavior) is lossy in ways that are invisible until the
// agent re-derives a ruled-out hypothesis or violates a stated constraint. This corpus
// is the fixed measurement surface: each scenario scripts a build-up phase that
// ESTABLISHES specific working-state facts, then PROBES for them after a forced reset.
//
// The scoring here is PURE (no model, no I/O) so it is unit-tested in CI
// (pts-continuity-score.test.ts). The live harness (pts-continuity-harness.ts) drives a
// real model through each scenario/condition and feeds its answers into these scorers;
// the live baseline runner is pts-continuity-eval.live.test.ts.
//
// Adding a scenario: append to CONTINUITY_SCENARIOS. Keep buildup total >= minBuildupChars
// so a real agent window would actually compact (the corpus-shape test asserts this).

// ─── types ───

/** A working-state fact class the probes interrogate after the reset. */
export type ProbeKind = "ruled-out-hypothesis" | "constraint" | "decision"

/** One established fact. `recalled` iff ANY anchor substring appears (case-insensitive)
 *  in the model's probe answer — an any-of group so paraphrase does not read as a miss,
 *  while the anchors stay specific enough that a model that LOST the state cannot guess them. */
export interface ProbeFact {
  id: string
  anchors: string[]
}

/** A post-reset probe: one question, scored against its facts. */
export interface Probe {
  id: string
  kind: ProbeKind
  question: string
  facts: ProbeFact[]
}

/** A task-success criterion for the FINAL answer (root cause + fix). ANY-of anchors. */
export interface SuccessCriterion {
  id: string
  anchors: string[]
}

/** One deep-work scenario: a scripted session that builds working state, then a reset,
 *  then probes + a final-answer check. */
export interface Scenario {
  id: string
  title: string
  kind: "multi-file-bug-hunt" | "long-causal-trace"
  systemPrompt: string
  /** The initial task handed to the agent. */
  taskPrompt: string
  /** Scripted observations fed one per turn during build-up; each elicits a model turn
   *  and grows the transcript. The content ESTABLISHES the working-state facts the
   *  probes later interrogate (so retention is measured, not discovery). */
  buildup: string[]
  /** Post-reset retention probes. */
  probes: Probe[]
  /** The final question that asks for the root cause + fix. */
  finalQuestion: string
  /** Task-success criteria for the final answer. */
  success: SuccessCriterion[]
  /** Minimum total build-up size (chars) — guarantees the transcript is large enough
   *  that a real agent window would compact mid-task (the reset is not synthetic). */
  minBuildupChars: number
}

// ─── scenario 1: multi-file bug hunt ───

const BUG_HUNT: Scenario = {
  id: "double-charge-bug-hunt",
  title: "Multi-file bug hunt — customers charged twice at checkout",
  kind: "multi-file-bug-hunt",
  systemPrompt:
    "You are a senior engineer debugging a live payments incident. You explore the codebase " +
    "one file at a time, form hypotheses, rule them out with evidence, and commit to constraints " +
    "and decisions as you go. Keep a running mental model of what you have ruled out and why. " +
    "Answer each message concisely (2-4 sentences).",
  taskPrompt:
    "INCIDENT: A small fraction of customers are charged TWICE for a single checkout. One order, " +
    "two identical Stripe charges seconds apart. Nothing else is wrong — amounts are right, no refunds " +
    "triggered. Find the root cause and the minimal fix. Start by listing the hypotheses you want to check.",
  buildup: [
    // establishes H1 ruled out (frontend double-submit)
    "OBSERVATION — frontend/checkout.tsx: the Pay button calls `setSubmitting(true)` synchronously in its " +
      "onClick and is rendered `disabled={submitting}`, and the network POST to /api/pay only fires once per " +
      "mount (verified in the network panel: exactly one /api/pay request per checkout, even on rage-clicks). " +
      "So the browser is NOT sending two payment requests. Record your conclusion about the frontend hypothesis.",
    // establishes H2: webhook delivered twice — TRUE and expected, not the bug
    "OBSERVATION — Stripe dashboard: for a double-charged order, the `payment_intent.succeeded` webhook was " +
      "delivered TWICE (Stripe's normal at-least-once retry — the first delivery got a 500 from us and Stripe " +
      "re-sent it 8s later). This retry is EXPECTED behavior we cannot turn off. Note what this tells you.",
    // establishes H3 ruled out (db unique constraint present but wrong layer)
    "OBSERVATION — db/schema.sql: table `charges` has `UNIQUE (payment_intent_id)`. But in the logs the SECOND " +
      "insert did NOT hit a unique violation, because the code creates a NEW Stripe charge (new id) on each " +
      "webhook delivery BEFORE any insert — so the unique constraint never even gets a chance to dedupe. The DB " +
      "constraint is real but at the wrong layer. Record why the unique constraint does not save us here.",
    // establishes constraints C1/C2/C3
    "OBSERVATION — payments/webhook.ts (handler): `handleWebhook(event)` does `const charge = await " +
      "stripe.charges.create({...}); await db.charges.insert(...)`. There is NO check for whether `event.id` was " +
      "already processed. CONSTRAINTS for any fix: (C1) it must be idempotent AT THE HANDLER — returning a 500 so " +
      "the DB unique throws is not acceptable, because Stripe would retry that forever. (C2) We cannot change the " +
      "Stripe webhook/retry configuration. (C3) The fix must not break the existing refund path, which reuses the " +
      "same handler for `charge.refunded` events. Acknowledge these three constraints.",
    // establishes decision D1 + confirms root cause
    "OBSERVATION — infra: we already run Redis (used for rate-limiting) and it is available in the webhook worker. " +
      "DECISION: the fix goes in `handleWebhook` in payments/webhook.ts — add an idempotency guard keyed on " +
      "`event.id` (a SETNX in Redis, or a processed_events table) that short-circuits BEFORE `charges.create` when " +
      "the event id was already handled, and ACKs 200 so Stripe stops retrying. Confirm the decision and the exact " +
      "root cause in one sentence.",
  ],
  probes: [
    {
      id: "ruled-out",
      kind: "ruled-out-hypothesis",
      question:
        "Before you write the fix: which hypotheses have you ALREADY ruled out, and what was the evidence for each? " +
        "List them — do not re-investigate.",
      facts: [
        {
          id: "frontend-double-submit",
          anchors: ["one /api/pay", "rage-click", "once per mount", "network panel"],
        },
        {
          id: "db-unique-wrong-layer",
          anchors: ["unique constraint", "payment_intent_id", "wrong layer", "new charge", "before any insert"],
        },
        {
          id: "webhook-retry-expected",
          anchors: ["retry is expected", "at-least-once", "cannot turn off", "stripe retr", "delivered twice"],
        },
      ],
    },
    {
      id: "constraints",
      kind: "constraint",
      question: "What constraints must the fix respect? List every constraint we committed to.",
      facts: [
        { id: "idempotent-at-handler", anchors: ["at the handler", "short-circuit"] },
        { id: "no-500-retry-forever", anchors: ["500", "retry forever", "ack 200", "must not throw"] },
        { id: "cannot-change-webhook-config", anchors: ["cannot change", "webhook config", "retry config"] },
        { id: "dont-break-refund", anchors: ["refund path", "charge.refunded"] },
      ],
    },
    {
      id: "decision",
      kind: "decision",
      question: "Where did we decide the fix goes, and what is the exact mechanism? Be specific about file and key.",
      facts: [
        { id: "file", anchors: ["webhook.ts", "handlewebhook"] },
        { id: "keyed-on-event-id", anchors: ["event.id", "event id"] },
        { id: "guard-before-create", anchors: ["setnx", "processed_events"] },
      ],
    },
  ],
  finalQuestion:
    "Now state the root cause in one sentence and give the minimal fix (file + what you add). Do not restate the " +
    "whole investigation — just the cause and the fix.",
  success: [
    {
      id: "root-cause-missing-idempotency",
      anchors: ["idempoten", "already processed", "duplicate event", "no check"],
    },
    { id: "on-retried-webhook", anchors: ["retr", "delivered twice", "at-least-once", "event.id"] },
    { id: "fix-location", anchors: ["webhook.ts", "handlewebhook", "handler"] },
  ],
  minBuildupChars: 1900,
}

// ─── scenario 2: long causal trace (Asterisk / SIP) ───

const CALL_DROP_TRACE: Scenario = {
  id: "asterisk-32s-call-drop",
  title: "Long causal trace — outbound calls drop at exactly 32s (Asterisk/pjsip)",
  kind: "long-causal-trace",
  systemPrompt:
    "You are a VoIP engineer debugging an Asterisk PBX. Failures here sit at the end of long causal chains " +
    "(dialplan -> pjsip endpoint -> SIP timers -> carrier behavior). You trace each link, rule out dead ends with " +
    "evidence, and hold the constraints in mind. Answer each message concisely (2-4 sentences).",
  taskPrompt:
    "SYMPTOM: Outbound calls through ONE carrier (peer `carrierX`) drop at EXACTLY 32 seconds after answer, every " +
    "time, reproducibly. Calls to other carriers are fine. Audio is perfect right up to the drop. Trace the cause " +
    "down to the specific config knob. Start by listing what you want to rule out.",
  buildup: [
    // H1 ruled out: RTP/media timeout
    "OBSERVATION — `rtp set debug on` + `pjsip show channelstats`: RTP flows continuously in BOTH directions until " +
      "the instant of teardown at 32s; jitter/loss are nominal, no rtptimeout fired (rtptimeout is 60s anyway). So " +
      "this is NOT an RTP/media-inactivity timeout. Record that conclusion.",
    // H2 ruled out: transport reset
    "OBSERVATION — transport: the peer uses UDP (not TCP/TLS), tcpdump shows no ICMP unreachable and no SIP failure " +
      "response arriving unsolicited — the teardown is initiated BY US (Asterisk sends the BYE at 32s). So it is not " +
      "a transport reset or a carrier-initiated BYE. Note who sends the BYE.",
    // H3 ruled out: dialplan limits
    "OBSERVATION — dialplan: the `Dial()` for this route has NO `L` (absolute-timeout) or `S` option, and there is " +
      "no `absolute_timeout`/`Hangup` scheduled on the channel (`core show channel` shows no pending scheduler " +
      "hangup from the dialplan). So the 32s is NOT a dialplan-imposed call limit. Record that.",
    // H4 ruled out + the real chain begins: session timers
    "OBSERVATION — `pjsip set logger on`: at answer we negotiate Session-Timers (RFC 4028). The 200 OK carries " +
      "`Session-Expires: 64;refresher=uac` and `Min-SE: 64`, and WE (the UAC) are the refresher. At ~32s Asterisk " +
      "sends a session-refresh (UPDATE), the carrier NEVER answers it, and immediately after the refresh window " +
      "Asterisk tears the call down. NAT qualify is fine (OPTIONS keepalives OK), so it is not a NAT/keepalive drop. " +
      "Note the Session-Expires value and who the refresher is.",
    // constraints + decision + root cause
    "OBSERVATION — 32 is exactly HALF of the 64s Session-Expires: RFC 4028 refreshes at Session-Expires/2, and when " +
      "the refresh gets no response the session is considered expired and torn down. CONSTRAINTS: (C1) we cannot " +
      "change the carrier — they will not respond to session refreshes. (C2) other carriers rely on session-timers " +
      "and must stay RFC-4028 compliant, so we must NOT disable timers globally. (C3) the change must be scoped to " +
      "the carrierX endpoint in pjsip.conf. DECISION: set `timers=no` (session-timers disabled) on the carrierX " +
      "pjsip endpoint ONLY. Confirm the decision and the exact root cause in one sentence.",
  ],
  probes: [
    {
      id: "ruled-out",
      kind: "ruled-out-hypothesis",
      question:
        "Before proposing the fix: which causes have you ALREADY ruled out, and what was the evidence for each? " +
        "List them — do not re-investigate.",
      facts: [
        { id: "rtp-timeout", anchors: ["rtptimeout", "flows continuously", "jitter", "60s"] },
        {
          id: "transport-reset",
          anchors: ["icmp", "we send", "sends the bye", "initiated by us"],
        },
        { id: "dialplan-limit", anchors: ["absolute_timeout", "l option", "no l ", "s option", "dial()"] },
        { id: "nat-keepalive", anchors: ["qualify", "qualify ok", "options keepalive"] },
      ],
    },
    {
      id: "constraints",
      kind: "constraint",
      question: "What constraints must the fix respect? List every one we committed to.",
      facts: [
        {
          id: "cannot-change-carrier",
          anchors: ["will not respond", "won't respond", "never answers", "will not answer"],
        },
        { id: "no-global-disable", anchors: ["other carriers", "globally", "rfc-4028", "rfc 4028"] },
        { id: "scoped-to-endpoint", anchors: ["pjsip.conf", "carrierx", "scoped"] },
      ],
    },
    {
      id: "decision",
      kind: "decision",
      question: "What did we decide the fix is, and why is the number 32 significant? Be specific.",
      facts: [
        { id: "timers-no", anchors: ["timers=no", "timers = no", "disable session-timers", "session-timers off"] },
        {
          id: "half-of-64",
          anchors: ["session-expires/2", "session expires/2", "half of 64", "half of the 64", "exactly half"],
        },
        { id: "we-are-refresher", anchors: ["refresher", "uac"] },
      ],
    },
  ],
  finalQuestion:
    "State the root cause in one sentence and give the exact fix (which config file, which endpoint, which knob). " +
    "Just the cause and the fix.",
  success: [
    {
      id: "root-cause-session-timers",
      anchors: ["session-timer", "session expires", "session-expires", "rfc 4028", "rfc4028"],
    },
    { id: "refresh-unanswered", anchors: ["refresh", "no response", "not answer", "refresher", "uac"] },
    { id: "fix-timers-no", anchors: ["timers=no", "timers = no", "disable session-timers", "session-timers"] },
  ],
  minBuildupChars: 1900,
}

/** The corpus. Scenarios 1-2 today; 3-4 (e.g. long-refactor plan-retention,
 *  research-synthesis note-retention) append here without touching the harness. */
export const CONTINUITY_SCENARIOS: Scenario[] = [BUG_HUNT, CALL_DROP_TRACE]

// ─── pure scoring (no model, no I/O — unit-tested) ───

/** True iff any anchor appears (case-insensitive substring) in `text`. */
export function matchesAnyAnchor(text: string, anchors: readonly string[]): boolean {
  const hay = text.toLowerCase()
  return anchors.some((a) => hay.includes(a.toLowerCase()))
}

export interface ProbeScore {
  probeId: string
  kind: ProbeKind
  recalled: number
  total: number
  hitFactIds: string[]
  missedFactIds: string[]
}

/** Score one probe answer: a fact is recalled when the answer hits any of its anchors. */
export function scoreProbe(probe: Probe, answer: string): ProbeScore {
  const hit: string[] = []
  const missed: string[] = []
  for (const f of probe.facts) {
    if (matchesAnyAnchor(answer, f.anchors)) hit.push(f.id)
    else missed.push(f.id)
  }
  return {
    probeId: probe.id,
    kind: probe.kind,
    recalled: hit.length,
    total: probe.facts.length,
    hitFactIds: hit,
    missedFactIds: missed,
  }
}

export interface TaskScore {
  success: boolean
  matched: number
  total: number
  matchedIds: string[]
}

/** Score the final answer: success requires EVERY criterion group to be satisfied
 *  (each group is any-of). All three of root-cause / mechanism / fix-location must land. */
export function scoreTask(scenario: Scenario, answer: string): TaskScore {
  const matchedIds = scenario.success.filter((c) => matchesAnyAnchor(answer, c.anchors)).map((c) => c.id)
  return {
    success: matchedIds.length === scenario.success.length,
    matched: matchedIds.length,
    total: scenario.success.length,
    matchedIds,
  }
}

/** Working-state retention = fraction of ALL probe facts recalled across every probe.
 *  This is the key novel metric: how much of the ruled-out / constraint / decision state
 *  survived the reset. */
export function retentionScore(probeScores: readonly ProbeScore[]): number {
  const total = probeScores.reduce((s, p) => s + p.total, 0)
  const recalled = probeScores.reduce((s, p) => s + p.recalled, 0)
  return total ? recalled / total : 0
}

// ─── per-run metrics + aggregation with confidence intervals ───

/** The metrics one scenario x condition run produces. */
export interface RunMetrics {
  taskSuccess: boolean
  /** 0..1 fraction of working-state facts recalled after the reset. */
  retention: number
  /** Total input+output tokens across every model call in the run (incl. compaction). */
  tokens: number
  /** Wall-clock across every model call in the run. */
  latencyMs: number
  /** Per-probe breakdown (for the scorecard's retention-by-kind rows). */
  probeScores: ProbeScore[]
  /** True when a model/API error aborted the run — excluded from the means (like the
   *  logic-recall ruler), so a timeout never masquerades as a zero-retention run. */
  errored: boolean
  /** The error message when `errored` — surfaced in the live/CLI per-run log so a run that
   *  throws every time gives a diagnosable cause, not a bare "ERROR". */
  errorMessage?: string
}

export interface MeanCI {
  mean: number
  /** 95% CI bounds (normal approx: mean +/- 1.96*sd/sqrt(n)). */
  lo: number
  hi: number
  sd: number
  n: number
}

const Z95 = 1.959963984540054

/** Mean + 95% normal-approx CI. n<=1 -> the point value with zero-width CI (documented:
 *  a single pass is noise — run N>=5 per condition, and per the repo model-eval standard
 *  K>=12 for any delta you'll ACT on, for a CI you can trust). */
export function meanCI(values: readonly number[]): MeanCI {
  const n = values.length
  if (n === 0) return { mean: 0, lo: 0, hi: 0, sd: 0, n: 0 }
  const mean = values.reduce((s, v) => s + v, 0) / n
  if (n === 1) return { mean, lo: mean, hi: mean, sd: 0, n }
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
  const sd = Math.sqrt(variance)
  const half = Z95 * (sd / Math.sqrt(n))
  return { mean, lo: mean - half, hi: mean + half, sd, n }
}

export interface ConditionAgg {
  condition: string
  n: number
  /** Runs excluded because they errored (kept for transparency). */
  errored: number
  taskSuccessRate: MeanCI
  retention: MeanCI
  tokens: MeanCI
  latencyMs: MeanCI
}

/** Aggregate a condition's runs. Errored runs are dropped from the means (transparency
 *  count retained), mirroring the logic-recall ruler's per-attempt exclusion. */
export function aggregateCondition(condition: string, runs: readonly RunMetrics[]): ConditionAgg {
  const ok = runs.filter((r) => !r.errored)
  return {
    condition,
    n: ok.length,
    errored: runs.length - ok.length,
    taskSuccessRate: meanCI(ok.map((r) => (r.taskSuccess ? 1 : 0))),
    retention: meanCI(ok.map((r) => r.retention)),
    tokens: meanCI(ok.map((r) => r.tokens)),
    latencyMs: meanCI(ok.map((r) => r.latencyMs)),
  }
}

export interface DeltaCI {
  delta: number
  lo: number
  hi: number
}

/** Delta of a metric (target - baseline) with a 95% CI on the difference of independent
 *  means (se_delta = sqrt(se_a^2+se_b^2)). Used to report each condition vs Control-B (the
 *  baseline): a NEGATIVE retention delta vs Control-A is the working-state LOSS from
 *  compaction that PTS mechanisms must recover. */
export function deltaCI(target: MeanCI, baseline: MeanCI): DeltaCI {
  const seT = target.n > 1 ? target.sd / Math.sqrt(target.n) : 0
  const seB = baseline.n > 1 ? baseline.sd / Math.sqrt(baseline.n) : 0
  const se = Math.sqrt(seT * seT + seB * seB)
  const delta = target.mean - baseline.mean
  const half = Z95 * se
  return { delta, lo: delta - half, hi: delta + half }
}
