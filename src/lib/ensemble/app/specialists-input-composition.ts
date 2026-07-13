// SIG-369(b) PR-1 — the logic-input-composition wiring for the specialists phase
// (app layer). Extracted from `specialists.ts` so that file stays under the 1k
// COMPLIANCE.md §4 size budget while keeping the feature in one cohesive place:
//
//   - `setupLogicInputComposition` builds the recorder + the per-attempt observer
//     and captures the EXACT model input (system prompt + post-budget initial
//     message + tools-available) — but ONLY for the logic role in shadow mode.
//     Off / non-logic → returns empty, so the caller passes no observer and the
//     specialist path is byte-identical to today.
//   - `emitAndAttachLogicInputComposition` assembles the composition after the
//     fan-out settles, attaches it to the KV review-telemetry record, and emits
//     the `logic-input-composition` event. Wrapped so a telemetry throw can never
//     break the review path.
//
// TELEMETRY ONLY — no context cut, no behavior change when the flag is off.

import type { SpecialistRole } from "@/src/shared/domain/specialist-role"
import {
  type LogicInputComposition,
  type LogicInputCompositionMode,
  type LogicInputCompositionRecorder,
  buildLogicInputComposition,
  makeLogicInputCompositionRecorder,
} from "@/src/lib/ensemble/domain/logic-input-composition"
import { type EnsembleRunCtx, emitLogicInputComposition } from "@/src/lib/ensemble-perf-telemetry"
import {
  SPECIALIST_CONFIGS,
  SPECIALIST_MODELS,
  type SpecialistRunArgs,
} from "@/src/lib/ensemble/adapters/model-provider"
import type { TokenUsageByModel } from "@/src/lib/ensemble-slo-telemetry"

/** The captured logic model input + live recorder, held by the caller between the
 *  fan-out kickoff and the post-fan-out emit. */
export interface LogicInputCompositionCapture {
  recorder: LogicInputCompositionRecorder
  systemPrompt: string
  initialMessage: string
  toolsAvailable: boolean
}

/** What `setupLogicInputComposition` returns: the per-attempt observer to pass
 *  into `runSpecialist` and the capture to read after the fan-out. Both absent on
 *  the off / non-logic path (the caller then passes no observer). */
export interface LogicInputCompositionSetup {
  onInputComposition?: NonNullable<SpecialistRunArgs["onInputComposition"]>
  capture?: LogicInputCompositionCapture
}

/**
 * Build the recorder + per-attempt observer and capture the exact model input —
 * but only for the logic role in shadow mode. The observer feeds each settled
 * attempt's per-call input split + tool-loop stats into the recorder; it runs
 * inside `runSpecialist`'s existing protected `onAttempt` block, so it inherits
 * the fail-open guard. Returns `{}` otherwise (byte-identical to today).
 */
export function setupLogicInputComposition(args: {
  role: SpecialistRole
  mode: LogicInputCompositionMode
  systemPrompt: string
  initialMessage: string
  toolsAvailable: boolean
}): LogicInputCompositionSetup {
  if (args.role !== "logic" || args.mode !== "shadow") return {}
  const recorder = makeLogicInputCompositionRecorder()
  const onInputComposition: NonNullable<SpecialistRunArgs["onInputComposition"]> = (info) => {
    for (const inputTokens of info.perCallInputTokens) recorder.recordCall(inputTokens)
    recorder.recordToolActivity(info.toolCallsMade, info.toolResultTokens)
  }
  return {
    onInputComposition,
    capture: {
      recorder,
      systemPrompt: args.systemPrompt,
      initialMessage: args.initialMessage,
      toolsAvailable: args.toolsAvailable,
    },
  }
}

/** The telemetry slice this helper writes — the logic-composition field plus the
 *  per-review token totals it reconciles against. A structural subset of the
 *  orchestrator's `EnsembleTelemetry`. */
export interface LogicInputCompositionTelemetrySink {
  tokenUsageByModel: TokenUsageByModel
  logicInputComposition?: LogicInputComposition
}

/**
 * Assemble the logic input composition (shadow only — `capture` is null
 * otherwise), attach it to the telemetry record, and emit the
 * `logic-input-composition` event. `summedInputTokens` reconciles with
 * `tokenUsageByModel[<logic model>].inputTokens` (the same per-call usage feeds
 * both). Wrapped so a telemetry throw can never break the review path.
 */
export function emitAndAttachLogicInputComposition(args: {
  capture: LogicInputCompositionCapture | null | undefined
  telemetry: LogicInputCompositionTelemetrySink
  perfCtx: EnsembleRunCtx
  owner: string
  repo: string
  prNumber: number
  headSha: string
}): void {
  const { capture } = args
  if (!capture) return
  try {
    const composition = buildLogicInputComposition({
      systemPrompt: capture.systemPrompt,
      initialMessage: capture.initialMessage,
      toolsAvailable: capture.toolsAvailable,
      recorder: capture.recorder,
    })
    args.telemetry.logicInputComposition = composition
    // Reconcile against the logic attempt's model keys. Logic normally answers on its
    // PRIMARY (`deepseek/deepseek-v4-pro`, OpenRouter — 2026-07-13), but on an OpenRouter outage
    // it can answer on its cross-provider fallback (`deepseek-v4-pro:cloud`, Ollama Turbo), so sum
    // inputTokens across BOTH possible logic model keys; otherwise the reconciliation reads a
    // spurious mismatch when the fallback fires. `undefined` when neither key is present (no
    // logic call), preserving the "no data" signal.
    const logicModel = SPECIALIST_MODELS.logic
    const logicModelKeys = [logicModel, SPECIALIST_CONFIGS.logic.fallback].filter((m): m is string => m !== null)
    const presentSums = logicModelKeys
      .map((m) => args.telemetry.tokenUsageByModel[m]?.inputTokens)
      .filter((n): n is number => n !== undefined)
    emitLogicInputComposition(args.perfCtx, composition, {
      logicModel,
      summedFromTokenUsage: presentSums.length > 0 ? presentSums.reduce((a, b) => a + b, 0) : undefined,
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "logic-input-composition-call-site-error",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        headSha: args.headSha.slice(0, 7),
        message: err instanceof Error ? err.message : String(err),
      }),
    )
  }
}
