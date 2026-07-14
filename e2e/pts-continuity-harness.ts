// PTS SIG-578 — deep-work continuity harness (the runner).
//
// Drives one scenario through one CONDITION: build up working state over several model
// turns, force a mid-task context reset, then probe for the retained working state and
// ask for the final answer. Returns RunMetrics (task success, working-state retention,
// tokens-to-completion, latency). The scoring is the pure logic in pts-continuity-corpus.ts.
//
// The three conditions are all expressed as a COMPACTOR (the pluggable reset mechanism):
//   - Control-A (upper bound): `identityCompactor` — no reset, full transcript survives.
//   - Control-B (baseline / today): `naiveSummaryCompactor` — the transcript is replaced
//     by a single naive LLM summary, exactly what a naive agent does when the window fills.
//   - Treatment: a PTS mechanism (compaction v2 / KV / cartridge) dropped in via
//     `registerTreatmentCompactor`. Empty by default — the harness SKIPS treatment until a
//     later SIG-578-series issue registers one. This is the clean seam the program builds on.
//
// The model is injected as a `ModelClient` so the run loop is testable WITHOUT a network
// call (pts-continuity-score.test.ts drives it with a scripted client). The live/CLI path
// uses `gatewayModelClient`, which routes through the real model gateway
// (`@/src/shared/adapters/model` chat) — Ollama / OpenRouter / Bedrock by model-id shape.

import { chat } from "@/src/shared/adapters/model"
import { selectModelApiKey, type ModelApiKeys } from "@/src/lib/ensemble/adapters/model-provider-routing"
import type { ChatMessage } from "@/src/shared/ports/model"
import {
  scoreProbe,
  scoreTask,
  retentionScore,
  type Scenario,
  type ProbeScore,
  type RunMetrics,
} from "./pts-continuity-corpus"

// ─── model client seam ───

export interface ModelReply {
  text: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

/** One model round-trip: given the full message list (system-first), return the assistant
 *  text + usage. The only external dependency the run loop has, so a test can supply a
 *  deterministic scripted client and no network is touched. */
export interface ModelClient {
  send(messages: ChatMessage[]): Promise<ModelReply>
}

/** A ModelClient backed by the real gateway. Temperature 0 for determinism — the gateway
 *  exposes no seed, so temp 0 is the only determinism lever (documented). Token usage falls
 *  back to a chars/4 estimate when the provider omits it (Ollama always reports; some
 *  OpenRouter providers do not), so the tokens metric is never a misleading zero.
 *
 *  `perCallTimeoutMs` bounds EVERY round-trip with an AbortSignal (mirrors the logic-recall
 *  ruler's `AbortSignal.timeout(PER_CASE_TIMEOUT_MS)`). Without it a hung call would run to
 *  chat()'s 10-min default and trip the vitest `it()` timeout mid-run instead of failing the
 *  single run gracefully as `errored`. Default 120s/call — a run is ~10 sequential calls. */
export function gatewayModelClient(
  model: string,
  apiKey: string,
  opts: { perCallTimeoutMs?: number } = {},
): ModelClient {
  const perCallTimeoutMs = opts.perCallTimeoutMs ?? 120_000
  return {
    async send(messages: ChatMessage[]): Promise<ModelReply> {
      const started = Date.now()
      const res = await chat({
        model,
        apiKey,
        messages,
        temperature: 0,
        chatEnabled: "on",
        signal: AbortSignal.timeout(perCallTimeoutMs),
      })
      const latencyMs = Date.now() - started
      const text = res.message.content ?? ""
      const inTok = res.usage?.inputTokens
      const outTok = res.usage?.outputTokens
      const estIn = Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4)
      const estOut = Math.ceil(text.length / 4)
      return {
        text,
        inputTokens: inTok ?? estIn,
        outputTokens: outTok ?? estOut,
        latencyMs,
      }
    },
  }
}

/** Wraps a ModelClient so EVERY call (harness turns AND compactor calls) accrues into one
 *  shared token/latency tally — the compaction step's own model cost is part of the
 *  condition's tokens-to-completion, so it must be counted too. */
interface MeteredClient extends ModelClient {
  readonly tokens: number
  readonly latencyMs: number
}

function meter(inner: ModelClient): MeteredClient {
  let tokens = 0
  let latencyMs = 0
  return {
    async send(messages: ChatMessage[]): Promise<ModelReply> {
      const r = await inner.send(messages)
      tokens += r.inputTokens + r.outputTokens
      latencyMs += r.latencyMs
      return r
    },
    get tokens(): number {
      return tokens
    },
    get latencyMs(): number {
      return latencyMs
    },
  }
}

// ─── compactor seam (the Treatment hook) ───

export interface CompactionInput {
  systemPrompt: string
  /** The full pre-reset transcript, system-excluded (user/assistant turns in order). */
  transcript: ChatMessage[]
  scenario: Pick<Scenario, "id" | "kind">
  /** For LLM-based compactors (the naive-summary baseline, and future PTS mechanisms that
   *  distill). Calls here are metered into the run's tokens-to-completion. */
  model: ModelClient
}

export interface Compactor {
  id: string
  /** Produce the post-reset transcript (system-excluded); the caller re-prepends system.
   *  Returning the input unchanged = no reset (the Control-A upper bound). */
  compact(input: CompactionInput): Promise<ChatMessage[]>
}

/** Control-A: no reset — the full transcript survives. Upper bound on retention. */
export const identityCompactor: Compactor = {
  id: "identity",
  compact: async (input) => input.transcript,
}

const SUMMARY_SYSTEM =
  "You are compacting a long agent conversation to free the context window. Summarize the " +
  "work so far so the agent can continue. Be concise."

/** Control-B: naive summary compaction — the entire transcript is replaced by ONE
 *  free-form LLM summary, exactly what a naive agent does when its window fills. Lossy by
 *  construction; the baseline every PTS mechanism must beat. */
export const naiveSummaryCompactor: Compactor = {
  id: "naive-summary",
  async compact(input): Promise<ChatMessage[]> {
    const transcriptText = input.transcript.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")
    const reply = await input.model.send([
      { role: "system", content: SUMMARY_SYSTEM },
      { role: "user", content: `Summarize this conversation so far:\n\n${transcriptText}` },
    ])
    return [{ role: "user", content: `Summary of the work so far:\n${reply.text}` }]
  },
}

// ─── treatment registry ───

const TREATMENT_COMPACTORS = new Map<string, Compactor>()

/** Register a PTS treatment compactor (compaction v2 / KV / cartridge). A later
 *  SIG-578-series issue calls this at import time; until then the treatment condition
 *  is skipped. This is the whole extension point of the program. */
export function registerTreatmentCompactor(compactor: Compactor): void {
  TREATMENT_COMPACTORS.set(compactor.id, compactor)
}

/** Test-only: clear the treatment registry so registry-touching tests don't leak state into
 *  one another (the registry is module-global). Not used by the live/CLI path. */
export function __resetTreatmentCompactorsForTest(): void {
  TREATMENT_COMPACTORS.clear()
}

/** Resolve the treatment compactor by name (env `PTS_TREATMENT` or arg). Returns null when
 *  none is registered — the harness then reports treatment as SKIPPED rather than failing. */
export function resolveTreatmentCompactor(name?: string): Compactor | null {
  if (TREATMENT_COMPACTORS.size === 0) return null
  if (name) return TREATMENT_COMPACTORS.get(name) ?? null
  const first = [...TREATMENT_COMPACTORS.values()][0]
  return first ?? null
}

export type ConditionId = "control-a" | "control-b" | "treatment"

export interface Condition {
  id: ConditionId
  label: string
  compactor: Compactor
}

/** The three standard conditions. `treatment` is present only when a compactor is
 *  registered (or explicitly supplied) — otherwise callers omit it. */
export function standardConditions(treatment?: Compactor | null): Condition[] {
  const conditions: Condition[] = [
    { id: "control-a", label: "Control-A (no reset, full context)", compactor: identityCompactor },
    { id: "control-b", label: "Control-B (naive summary compaction)", compactor: naiveSummaryCompactor },
  ]
  if (treatment) conditions.push({ id: "treatment", label: `Treatment (${treatment.id})`, compactor: treatment })
  return conditions
}

// ─── the run loop ───

export interface RunArgs {
  scenario: Scenario
  compactor: Compactor
  model: ModelClient
}

/**
 * Run one scenario under one compactor:
 *  1. seed the task, then feed each build-up observation as a turn (transcript grows);
 *  2. RESET — run the compactor to produce the post-reset transcript;
 *  3. probe each retention question INDEPENDENTLY against the post-reset context (so probe
 *     answers never leak state into one another);
 *  4. ask the final question and score task success.
 * All model calls (including the compactor's) are metered into tokens + latency. A model
 * error marks the run `errored` (excluded from the means downstream) rather than scoring a
 * false zero.
 */
export async function runContinuitySession(args: RunArgs): Promise<RunMetrics> {
  const { scenario } = args
  const model = meter(args.model)
  const sys: ChatMessage = { role: "system", content: scenario.systemPrompt }
  const transcript: ChatMessage[] = []

  const emptyMetrics = (message: string): RunMetrics => ({
    taskSuccess: false,
    retention: 0,
    tokens: model.tokens,
    latencyMs: model.latencyMs,
    probeScores: [],
    errored: true,
    errorMessage: message,
  })

  try {
    // 1. build-up — task, then one turn per observation.
    const turns = [scenario.taskPrompt, ...scenario.buildup]
    for (const content of turns) {
      transcript.push({ role: "user", content })
      const reply = await model.send([sys, ...transcript])
      transcript.push({ role: "assistant", content: reply.text })
    }

    // 2. RESET.
    const postTranscript = await args.compactor.compact({
      systemPrompt: scenario.systemPrompt,
      transcript,
      scenario: { id: scenario.id, kind: scenario.kind },
      model,
    })

    // 3. probes — independent, each against the post-reset context snapshot.
    const probeScores: ProbeScore[] = []
    for (const probe of scenario.probes) {
      const reply = await model.send([sys, ...postTranscript, { role: "user", content: probe.question }])
      probeScores.push(scoreProbe(probe, reply.text))
    }

    // 4. final answer.
    const finalReply = await model.send([sys, ...postTranscript, { role: "user", content: scenario.finalQuestion }])
    const task = scoreTask(scenario, finalReply.text)

    return {
      taskSuccess: task.success,
      retention: retentionScore(probeScores),
      tokens: model.tokens,
      latencyMs: model.latencyMs,
      probeScores,
      errored: false,
    }
  } catch (e) {
    return emptyMetrics(e instanceof Error ? e.message : String(e))
  }
}

// ─── convenience: build the gateway client + key by model-id shape ───

/** Select the API key for `model` by id shape (OpenRouter slash id -> OpenRouter key;
 *  `:cloud` tag -> Ollama key; Bedrock registry id -> Bedrock envelope). Returns null when
 *  the selected provider's key is unset, so callers can SKIP cleanly (never substitute a
 *  wrong-provider key). Mirrors the logic-recall ruler's `selectConfigApiKey` gating. */
export function continuityApiKey(model: string, keys: ModelApiKeys): string | null {
  return selectModelApiKey(model, keys) ?? null
}
