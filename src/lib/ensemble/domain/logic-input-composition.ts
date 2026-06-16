// SIG-369(b) PR-1 — logic-specialist INPUT-composition telemetry (shadow-only).
//
// On a real PR (#568) the packed diff was ~13K tokens but the logic specialist's
// call consumed ~140K INPUT tokens (`tokenUsageByModel[logic model].inputTokens`
// in the per-PR `ensemble-review-telemetry` KV record; logic was `openai/o3` for
// that measurement — it's `moonshotai/kimi-k2.7-code` now, SIG-450). That ~10×
// gap is unexplained, and the logic model is a dominant review cost, so a follow-up
// MUST be able to cut the biggest low-recall-value input block — but only after we
// MEASURE where the tokens go. This module is the
// measurement: it decomposes the logic attempt's input into the system prompt,
// the per-section initial message (REUSING `measureLogicPrompt`), the tool-loop
// (when MCP tools are on, the two-call tool conversation re-sends everything),
// and the per-MODEL-CALL input tokens so a 2-call doubling is visible — then
// reconciles the sum against `tokenUsageByModel[<logic model>].inputTokens`.
//
// This is TELEMETRY ONLY. The `off` (default) path is a pure no-op — no
// measurement, no event, no telemetry field. No context is cut here; the cut is
// a recall-safety-gated follow-up sized by this data. Token estimation uses the
// repo convention `Math.ceil(chars / 4)` (`estimateTokens`), shared with
// `logic-prompt-budget.ts` so the dashboards tokenize consistently.
//
// This module is PURE: the parser, the accumulator, the assembled
// `LogicInputComposition`, and the per-tool-result token helper — no env, no IO,
// no console. The `logic-input-composition` EVENT emitter lives in
// `ensemble-perf-telemetry.ts` (the IO/observability seam), keeping this leaf
// console-free (Codex sign-off C). It imports only pure helpers from the
// `logic-prompt-budget` lib leaf (`estimateTokens` / `measureLogicPrompt`),
// matching the sibling `ensemble/domain/config.ts`; `src/lib/ensemble/*` is not
// yet held to the depcruise inward rule (mid-migration), so this is by local
// precedent, not a rule the lock enforces.

import { type LogicPromptMeasurement, estimateTokens, measureLogicPrompt } from "@/src/lib/logic-prompt-budget"

/**
 * Two-state env flag `OPENCLAW_LOGIC_INPUT_COMPOSITION`:
 *   off    — no measurement, no event, no telemetry field (default).
 *   shadow — measure the logic attempt's input composition, emit a
 *            `logic-input-composition` event AND attach `logicInputComposition`
 *            to the KV review-telemetry record. The model call is UNCHANGED.
 *
 * No `enforce` state: this PR cuts nothing (recall-safety). The cut is a later
 * PR sized by this telemetry.
 */
export type LogicInputCompositionMode = "off" | "shadow"

/**
 * Parser for the `OPENCLAW_LOGIC_INPUT_COMPOSITION` env flag. Case-insensitive,
 * whitespace-tolerant, defaults to "off" for any unknown / missing value — the
 * default-off safety net matches the other Sigilix mode flags (e.g.
 * `parseLogicPromptBudgetMode`).
 */
export function parseLogicInputCompositionMode(raw: string | undefined): LogicInputCompositionMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  return "off"
}

/** The tool-loop slice of the composition. When MCP tools are off (the usual
 *  logic path) `toolsAvailable` is false and the counters are 0. When on, the
 *  tool conversation makes a tool-turn call + a final call (which re-sends
 *  everything), so this surfaces how much input the tool round-trip added. */
export interface LogicInputCompositionToolLoop {
  /** Whether the logic specialist was given MCP tools this run. */
  toolsAvailable: boolean
  /** How many tool calls the model actually executed across the attempt(s). */
  toolCallsMade: number
  /** Estimated tokens of the tool RESULT contents fed back into the final call. */
  toolResultTokens: number
}

/**
 * The logic specialist's input-token decomposition for one ensemble run.
 * Captured only in `shadow` mode; absent otherwise.
 */
export interface LogicInputComposition {
  /** `estimateTokens` of the logic system prompt (`specialistSystemPrompt("logic", …)`). */
  systemPromptTokens: number
  /** Whole initial-message token estimate (`measureLogicPrompt(...).totalTokens`). */
  initialMessageTokens: number
  /** Per-section breakdown of the initial message — REUSED from `measureLogicPrompt`. */
  sections: LogicPromptMeasurement["sections"]
  toolLoop: LogicInputCompositionToolLoop
  /** Input tokens of EACH model call in the logic attempt, SEPARATELY (the
   *  tool-turn call vs the final call vs each retry/fallback) so a 2-call
   *  doubling is visible — not only the attempt total. Only DEFINED per-call
   *  usage is captured; a call whose provider reported no usage is counted in
   *  `callsMissingInputUsage` instead of zero-filled (Codex sign-off B). */
  perCallInputTokens: number[]
  /** Sum of `perCallInputTokens`. Reconciles with
   *  `tokenUsageByModel[<logic model>].inputTokens` (the same per-call
   *  `chat()` usage feeds both accumulators). */
  summedInputTokens: number
  /** Count of model calls whose provider reported NO input-token usage, so
   *  "no data" is distinguishable from "0 tokens" — these are absent from
   *  `perCallInputTokens` / `summedInputTokens`, not zero-filled. */
  callsMissingInputUsage: number
}

/**
 * Live accumulator the specialists phase hangs off the logic `runSpecialist`
 * call's optional per-call observers. `recordCall` is fired once per `chat()`
 * round-trip (single-shot: once; tool conversation: tool-turn + final), so the
 * per-call input split is captured separately. `recordToolActivity` is fired
 * once per tool conversation with the executed-tool-call count + summed
 * tool-result tokens. Pure aside from its own internal accumulation.
 */
export interface LogicInputCompositionRecorder {
  /** Push one `chat()` call's input tokens. `undefined` increments
   *  `callsMissingInputUsage` instead of being coerced to 0 (Codex sign-off B);
   *  mirrors `makeTokenRecorder`'s "no data ≠ zero" rule. */
  recordCall: (inputTokens: number | undefined) => void
  /** Record the tool round-trip's executed-call count + summed result tokens.
   *  Accumulates across attempts (additive), matching `perCallInputTokens`. */
  recordToolActivity: (toolCallsMade: number, toolResultTokens: number) => void
  /** Per-call input tokens captured so far (defined values only). */
  readonly perCallInputTokens: number[]
  /** Sum of `perCallInputTokens`. */
  readonly summedInputTokens: number
  /** Calls whose provider reported no input usage (absent from the array). */
  readonly callsMissingInputUsage: number
  /** Executed tool calls accumulated so far. */
  readonly toolCallsMade: number
  /** Tool-result tokens accumulated so far. */
  readonly toolResultTokens: number
}

export function makeLogicInputCompositionRecorder(): LogicInputCompositionRecorder {
  const perCallInputTokens: number[] = []
  let summedInputTokens = 0
  let callsMissingInputUsage = 0
  let toolCallsMade = 0
  let toolResultTokens = 0
  return {
    recordCall(inputTokens: number | undefined): void {
      if (inputTokens === undefined) {
        callsMissingInputUsage += 1
        return
      }
      perCallInputTokens.push(inputTokens)
      summedInputTokens += inputTokens
    },
    recordToolActivity(calls: number, resultTokens: number): void {
      toolCallsMade += calls
      toolResultTokens += resultTokens
    },
    get perCallInputTokens(): number[] {
      return perCallInputTokens
    },
    get summedInputTokens(): number {
      return summedInputTokens
    },
    get callsMissingInputUsage(): number {
      return callsMissingInputUsage
    },
    get toolCallsMade(): number {
      return toolCallsMade
    },
    get toolResultTokens(): number {
      return toolResultTokens
    },
  }
}

/** Inputs to `buildLogicInputComposition` — the call-site-known prompt sizes plus
 *  the live recorder's accumulated per-call / tool-loop stats. */
export interface BuildLogicInputCompositionArgs {
  systemPrompt: string
  initialMessage: string
  toolsAvailable: boolean
  recorder: LogicInputCompositionRecorder
}

/**
 * Assemble the `LogicInputComposition` from the logic system prompt + initial
 * message (sized here, REUSING `measureLogicPrompt`) and the recorder's
 * accumulated per-call/tool-loop stats. Pure; no env / IO. Safe to call once
 * after the logic attempt has settled.
 */
export function buildLogicInputComposition(args: BuildLogicInputCompositionArgs): LogicInputComposition {
  const measurement = measureLogicPrompt(args.initialMessage)
  return {
    systemPromptTokens: estimateTokens(args.systemPrompt),
    initialMessageTokens: measurement.totalTokens,
    sections: measurement.sections,
    toolLoop: {
      toolsAvailable: args.toolsAvailable,
      toolCallsMade: args.recorder.toolCallsMade,
      toolResultTokens: args.recorder.toolResultTokens,
    },
    perCallInputTokens: [...args.recorder.perCallInputTokens],
    summedInputTokens: args.recorder.summedInputTokens,
    callsMissingInputUsage: args.recorder.callsMissingInputUsage,
  }
}

/**
 * Estimated tokens of the tool-result contents fed back into the final tool-loop
 * call. Pure (chars/4) helper so the tool-loop adapter can size the result block
 * without importing the budget module's internals. Sums each tool message's
 * content length.
 */
export function estimateToolResultTokens(toolResultContents: readonly string[]): number {
  let total = 0
  for (const content of toolResultContents) total += estimateTokens(content)
  return total
}
