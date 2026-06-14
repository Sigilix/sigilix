// Phase 3 agent loop. Orchestrates GLM-5.1's tool-call protocol over
// Ollama Turbo `/api/chat`. Replaces the single-shot prompt → answer
// path in mention-reply.ts and github-mention.ts when the per-surface
// agentic flag is on.
//
// Architecture (see arc-phase3-spec-v14.md for the locked design after
// 14 rounds of dual sign-off):
//
//   runAgentLoop()       — outer fn, exactly ONE return point (after
//                          telemetry epilogue). Catches unexpected
//                          throws from runLoopBody and maps to
//                          internal_error so telemetry STILL runs on
//                          every exit path.
//   runLoopBody()        — inner state machine; returns its result and
//                          accumulated telemetry state explicitly, no
//                          shared mutation.
//   withComposedTimeout()— hard timeout that aborts factory's signal
//                          on timer/parent abort, then awaits factory's
//                          settlement up to a small grace window so
//                          abort-aware factories can return their own
//                          structured failure (Phase 4a.2). If factory
//                          ignores the signal past the grace, the
//                          wrapper throws to unblock the caller.

import { chat } from "@/src/shared/adapters/model"
import { isChatDisabledError } from "@/src/shared/adapters/model/ollama-chat"
import type { ChatArgs, ChatMessage, ChatResult, ChatToolDef } from "@/src/shared/ports/model"
import type { AgentTool } from "./agent-tools"
import { parseFirstJsonObject } from "@/src/shared/util/json-extract"
import type { Env } from "@/src/shared/types/env"

// ──────────────────────────────────────────────────────────────── types

export type AgentLoopResult = { ok: true; answer: unknown; stats: AgentLoopStats } | AgentLoopFailure

export interface AgentLoopStats {
  toolTurns: number
  totalMs: number
  toolCallCount: number
}

export type AgentLoopFailure =
  | { ok: false; reason: "tool_args_invalid_after_retry" }
  | { ok: false; reason: "tool_execution_failed"; toolName: string; error: string }
  | { ok: false; reason: "unknown_tool"; toolName: string }
  | { ok: false; reason: "final_answer_did_not_parse"; rawAnswer: string }
  | { ok: false; reason: "chat_error"; error: string }
  | { ok: false; reason: "chat_disabled" }
  | { ok: false; reason: "wall_clock_exceeded" }
  | { ok: false; reason: "internal_error"; error: string }

export interface LoopTelemetryState {
  startMs: number
  turns: number
  toolCalls: Array<{
    name: string
    ok: boolean
    elapsedMs: number
    argsHash: string
    result?: RetrieveCodebaseToolSummary
  }>
}

export interface RetrieveCodebaseToolSummary {
  ok?: boolean
  repo?: string
  count?: number
  error?: string
}

export interface LinearMentionRetrievalContext {
  availableRepos: string[]
  mappedRepo: string | null
  repoStatus: string
  initialRetrievalNamespace: string | null
  initialChunkCount: number
}

export interface LinearMentionRetrievalTelemetry extends LinearMentionRetrievalContext {
  calledRetrieveCodebase: boolean
  retrieveCodebaseCallCount: number
  retrievalNamespace: string | null
  chunkCount: number
  toolRetrievals: RetrieveCodebaseToolSummary[]
}

export interface AgentLoopTelemetryRecordInput {
  schemaVersion: 2
  model: string
  surface: "linear-mention" | "github-mention"
  commentId: string
  prNumber?: number
  agentInitialUserMessage: string
  singleShotPrompt: string
  singleShotSchema: Record<string, unknown>
  promptBuilderVersion: string
  promptBuilderSource: string
  turns: number
  toolCalls: LoopTelemetryState["toolCalls"]
  totalMs: number
  finalAnswer: unknown
  linearMentionRetrieval?: LinearMentionRetrievalTelemetry
  fallback?: string
  /** Raw model output when fallback is `final_answer_did_not_parse`.
   *  Only set on that failure mode — null/absent for any other path.
   *  The sink truncates + redacts before persisting (same treatment
   *  as agentInitialUserMessage / singleShotPrompt). Without this we
   *  can see the loop failed but not WHY — was the JSON malformed,
   *  was it the wrong shape, was it prose, etc. */
  failureRawAnswer?: string
}

export interface AgentLoopTelemetrySink {
  record(input: AgentLoopTelemetryRecordInput): Promise<void>
}

export type AgentLoopEvent =
  | { kind: "start"; surface: string; commentId: string }
  | { kind: "turn"; turn: number; toolCalls: number; elapsedMs: number }
  | { kind: "tool"; name: string; ok: boolean; elapsedMs: number }
  | { kind: "done"; result: AgentLoopResult }
  | { kind: "telemetry-soft-fail"; error: string }

export interface AgentLoopArgs {
  model: string
  apiKey: string
  env: Env
  surface: "linear-mention" | "github-mention"
  commentId: string
  prNumber?: number
  systemPrompt: string
  initialUserMessage: string
  tools: AgentTool[]
  maxToolTurns?: number
  totalTimeoutMs?: number
  toolTimeoutMs?: number
  finalAnswerSchema: Record<string, unknown>
  telemetry: AgentLoopTelemetrySink
  telemetryContext: {
    singleShotPrompt: string
    singleShotSchema: Record<string, unknown>
    promptBuilderVersion: string
    promptBuilderSource: string
    linearMentionRetrieval?: LinearMentionRetrievalContext
  }
  log: (event: AgentLoopEvent) => void
}

// ──────────────────────────────────────────────────────────────── public

export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const ctrl = new AbortController()
  const totalTimeoutMs = args.totalTimeoutMs ?? 120_000
  const loopTimer = setTimeout(() => ctrl.abort(), totalTimeoutMs)
  const startMs = Date.now()
  let loopResult: AgentLoopResult
  // Initialize empty fallback state so the catch path has something
  // sensible to pass to telemetry even when runLoopBody throws before
  // returning.
  let telemetryState: LoopTelemetryState = { startMs, turns: 0, toolCalls: [] }

  args.log({ kind: "start", surface: args.surface, commentId: args.commentId })

  try {
    const out = await runLoopBody({ ...args, signal: ctrl.signal, startMs })
    loopResult = out.result
    telemetryState = out.telemetryState
  } catch (e) {
    // Codex round-9 catch: any unexpected throw maps to internal_error
    // so the telemetry epilogue still runs. v12 explicit-return
    // contract means telemetryState is the minimal fallback (the helper
    // never returned its accumulated state).
    loopResult = { ok: false, reason: "internal_error", error: String(e) }
  } finally {
    clearTimeout(loopTimer)
  }

  args.log({ kind: "done", result: loopResult })

  // POST-LOOP TELEMETRY EPILOGUE — runs on EVERY exit path because
  // runLoopBody returns its result and runAgentLoop has a single return
  // statement after this block. The withComposedTimeout takes NO parent
  // signal — Codex round-7 catch: passing the loop signal here would
  // cause wall_clock_exceeded failures (the very ones we want to debug)
  // to skip telemetry because the wrapper sees a pre-aborted parent.
  try {
    await withComposedTimeout(
      () => args.telemetry.record(buildTelemetryRecordInput(loopResult, args, telemetryState)),
      5_000,
    )
  } catch (e) {
    // Soft-fail. Telemetry is post-hoc best-effort, not load-bearing.
    args.log({ kind: "telemetry-soft-fail", error: String(e) })
  }

  return loopResult
}

// ──────────────────────────────────────────────────────────────── helpers

interface RunLoopBodyArgs extends AgentLoopArgs {
  signal: AbortSignal
  startMs: number
}

interface RunLoopBodyResult {
  result: AgentLoopResult
  telemetryState: LoopTelemetryState
}

async function runLoopBody(args: RunLoopBodyArgs): Promise<RunLoopBodyResult> {
  const telemetryState: LoopTelemetryState = {
    startMs: args.startMs,
    turns: 0,
    toolCalls: [],
  }

  // OLLAMA_CHAT_ENABLE check is the first operation (Codex round-13
  // catch — was previously in runAgentLoop with "returns immediately"
  // wording that violated the structural single-return-point rule).
  if (args.env.OLLAMA_CHAT_ENABLE !== "on") {
    return {
      result: { ok: false, reason: "chat_disabled" },
      telemetryState,
    }
  }

  const messages: ChatMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.initialUserMessage },
  ]
  const toolsByName = new Map<string, AgentTool>()
  for (const t of args.tools) toolsByName.set(t.name, t)
  const toolDefs: ChatToolDef[] = args.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  const perLoopContext = new Map<string, unknown>()
  const maxToolTurns = args.maxToolTurns ?? 3
  const toolTimeoutMs = args.toolTimeoutMs ?? 5_000
  let toolTurnsUsed = 0
  let lastTurnHadBadArgs = false

  const chatBase: Pick<ChatArgs, "model" | "apiKey" | "signal" | "chatEnabled"> = {
    model: args.model,
    apiKey: args.apiKey,
    signal: args.signal,
    chatEnabled: args.env.OLLAMA_CHAT_ENABLE === "on" ? "on" : "off",
  }

  while (true) {
    const turnStart = Date.now()
    let result: ChatResult
    try {
      // NO `format` on tool-call turns — it can suppress tool emission.
      result = await chat({ ...chatBase, messages, tools: toolDefs })
    } catch (e) {
      if (isAbortError(e)) {
        return { result: { ok: false, reason: "wall_clock_exceeded" }, telemetryState }
      }
      if (isChatDisabledError(e)) {
        return { result: { ok: false, reason: "chat_disabled" }, telemetryState }
      }
      return {
        result: { ok: false, reason: "chat_error", error: String(e) },
        telemetryState,
      }
    }

    if (!result.hasToolCalls) {
      // Final answer this turn — parse + VALIDATE against schema and
      // return. Schema-shape validation (CR PR #24 catch) means a
      // parseable-but-wrong-shape response routes through the same
      // fallback path as a parse failure, instead of escaping into the
      // handler's downstream verdict parser where the loop's fallback
      // opportunity is already gone.
      const parsed = parseAndValidateFinalAnswer(result.message.content, args.finalAnswerSchema)
      if (parsed === null) {
        return {
          result: {
            ok: false,
            reason: "final_answer_did_not_parse",
            rawAnswer: result.message.content,
          },
          telemetryState,
        }
      }
      return {
        result: {
          ok: true,
          answer: parsed,
          stats: {
            toolTurns: telemetryState.turns,
            totalMs: Date.now() - args.startMs,
            toolCallCount: telemetryState.toolCalls.length,
          },
        },
        telemetryState,
      }
    }

    // Forced final-answer path when tool budget exhausted (Kimi round 2:
    // do NOT append the assistant's tool_calls message; that would leave
    // an orphan assistant tool_calls entry without matching role:"tool"
    // responses, violating Ollama's protocol).
    if (toolTurnsUsed >= maxToolTurns) {
      const messagesForFinal: ChatMessage[] = [
        ...messages,
        {
          role: "system",
          content: "You've used your tool budget. Answer or abstain now — no more tool calls.",
        },
      ]
      let forced: ChatResult
      try {
        forced = await chat({
          ...chatBase,
          messages: messagesForFinal,
          tools: [],
          format: args.finalAnswerSchema,
        })
      } catch (e) {
        if (isAbortError(e)) {
          return { result: { ok: false, reason: "wall_clock_exceeded" }, telemetryState }
        }
        if (isChatDisabledError(e)) {
          return { result: { ok: false, reason: "chat_disabled" }, telemetryState }
        }
        return {
          result: { ok: false, reason: "chat_error", error: String(e) },
          telemetryState,
        }
      }
      // Codex round-3 defensive: even with tools:[] + format, Ollama
      // might still emit tool_calls. Treat as parse failure.
      if (forced.hasToolCalls) {
        return {
          result: {
            ok: false,
            reason: "final_answer_did_not_parse",
            rawAnswer: forced.message.content,
          },
          telemetryState,
        }
      }
      const parsed = parseAndValidateFinalAnswer(forced.message.content, args.finalAnswerSchema)
      if (parsed === null) {
        return {
          result: {
            ok: false,
            reason: "final_answer_did_not_parse",
            rawAnswer: forced.message.content,
          },
          telemetryState,
        }
      }
      return {
        result: {
          ok: true,
          answer: parsed,
          stats: {
            toolTurns: telemetryState.turns,
            totalMs: Date.now() - args.startMs,
            toolCallCount: telemetryState.toolCalls.length,
          },
        },
        telemetryState,
      }
    }

    // Not budget-exhausted yet — append the assistant tool_calls message
    // and dispatch each tool call.
    messages.push(result.message)
    let badArgsThisTurn = false
    const turnToolCalls = result.message.tool_calls ?? []

    for (let index = 0; index < turnToolCalls.length; index += 1) {
      const toolCall = turnToolCalls[index]!
      const toolName = toolCall.function.name
      const tool = toolsByName.get(toolName)
      if (!tool) {
        return {
          result: { ok: false, reason: "unknown_tool", toolName },
          telemetryState,
        }
      }

      // Codex round-5: malformed `arguments` JSON is a recoverable
      // validation error, not chat_error. chat() preserves the raw
      // value; we parse + validate here.
      const argsParse = parseToolArguments(toolCall.function.arguments)
      const callId = toolCall.id ?? String(index)
      if (!argsParse.ok) {
        messages.push({
          role: "tool",
          tool_call_id: callId,
          tool_name: toolName,
          content: `Invalid JSON in arguments for ${toolName}: ${argsParse.error}. Re-emit with valid JSON.`,
        })
        badArgsThisTurn = true
        continue
      }
      const validation = validateAgainstSchema(argsParse.value, tool.parameters)
      if (!validation.ok) {
        messages.push({
          role: "tool",
          tool_call_id: callId,
          tool_name: toolName,
          content: `Invalid args for ${toolName}: ${validation.error}. Re-emit with valid args.`,
        })
        badArgsThisTurn = true
        continue
      }

      const toolStart = Date.now()
      const argsHash = await hashJson(argsParse.value)
      try {
        // Tool execute() RETURNS structured failures (recoverable,
        // appended as tool message); THROWS only on runtime failures.
        // AbortError from the loop's signal is re-thrown so the wall-
        // clock catch maps it to wall_clock_exceeded.
        const toolResult = await withComposedTimeout(
          (sig) => tool.execute(argsParse.value, sig, perLoopContext),
          toolTimeoutMs,
          args.signal,
        )
        const elapsed = Date.now() - toolStart
        const resultSummary = summarizeToolResult(toolName, toolResult)
        telemetryState.toolCalls.push({
          name: toolName,
          ok: true,
          elapsedMs: elapsed,
          argsHash,
          ...(resultSummary ? { result: resultSummary } : {}),
        })
        args.log({ kind: "tool", name: toolName, ok: true, elapsedMs: elapsed })
        messages.push({
          role: "tool",
          tool_call_id: callId,
          tool_name: toolName,
          content: stringifyToolResult(toolResult),
        })
      } catch (e) {
        if (isAbortError(e)) {
          return { result: { ok: false, reason: "wall_clock_exceeded" }, telemetryState }
        }
        const elapsed = Date.now() - toolStart
        const resultSummary = summarizeThrownToolError(toolName, e)
        telemetryState.toolCalls.push({
          name: toolName,
          ok: false,
          elapsedMs: elapsed,
          argsHash,
          ...(resultSummary ? { result: resultSummary } : {}),
        })
        return {
          result: {
            ok: false,
            reason: "tool_execution_failed",
            toolName,
            error: String(e),
          },
          telemetryState,
        }
      }
    }

    // Single-retry budget for bad args (Kimi round-2): if turn N had
    // bad args AND turn N-1 also had bad args, fail.
    if (badArgsThisTurn && lastTurnHadBadArgs) {
      return {
        result: { ok: false, reason: "tool_args_invalid_after_retry" },
        telemetryState,
      }
    }
    lastTurnHadBadArgs = badArgsThisTurn
    toolTurnsUsed += 1
    telemetryState.turns += 1
    args.log({
      kind: "turn",
      turn: telemetryState.turns,
      toolCalls: turnToolCalls.length,
      elapsedMs: Date.now() - turnStart,
    })
  }
}

// ──────────────────────────────────────────────────────────────── withComposedTimeout

/**
 * Grace window (ms) for the factory to settle its own structured
 * failure after `withComposedTimeout` aborts. Phase 4a.2 fix: when the
 * timer or parent signal fires, an abort-aware factory (e.g.
 * `runWithRetryAndFallback`) sees `signal.aborted` and returns a
 * `wrapFailure(...)` with `attemptsUsed`, `modelUsed`, `elapsedMs`
 * populated. Awaiting that settlement preserves diagnostic telemetry
 * across the abort path. If the factory ignores its signal past this
 * window, the wrapper throws — preserving the round-6 Codex
 * hard-timeout guarantee for non-cancellation-aware factories.
 */
export const WITH_COMPOSED_TIMEOUT_ABORT_GRACE_MS = 500

/**
 * Hard timeout that COMPOSES with an external signal. Either the
 * factory returns first (success or its own structured failure) or
 * the timeout/parent-signal aborts the factory.
 *
 * Phase 4a.2: on abort, the wrapper does NOT immediately throw — it
 * gives the factory a `WITH_COMPOSED_TIMEOUT_ABORT_GRACE_MS` window to
 * detect the aborted signal and settle on its own (abort-aware code
 * paths return a `wrapFailure(...)` with proper diagnostics). The
 * round-6 Codex hard-timeout guarantee is preserved: if the factory
 * ignores its signal and never settles, the grace window expires and
 * the wrapper rejects with `Operation aborted`, killing the await.
 *
 * The abort branch is the NORMAL path for abort-aware factories, not
 * a fallback: when the timer / parent fires, the factory's own abort
 * listener fires first (registered earlier) and resolves the factory
 * promise with its structured failure, then the wrapper's `abortFired`
 * listener fires. The grace-window race observes the factory already
 * settled and returns its value. Don't "fix" the resolve-not-reject
 * pattern below — rejecting on `abortFired` is what produced the
 * Phase 4a.1 lost-settlement bug.
 *
 * Pre-aborted parent: if `parentSignal.aborted` is true on entry, the
 * factory is never invoked — we throw `Operation aborted` synchronously
 * (the caller asked us to bail before doing any work).
 */
export async function withComposedTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError")
  }

  const ctrl = new AbortController()

  const abort = (): void => {
    if (!ctrl.signal.aborted) {
      ctrl.abort(new DOMException("Operation aborted", "AbortError"))
    }
  }

  const timer = setTimeout(abort, ms)
  const onParentAbort = abort
  parentSignal?.addEventListener("abort", onParentAbort, { once: true })

  try {
    const factoryPromise = factory(ctrl.signal)

    // Watch for abort. Resolves (does not reject) when ctrl aborts so
    // the race below can detect "abort fired" without losing factory's
    // settlement.
    const abortFired = new Promise<void>((resolve) => {
      if (ctrl.signal.aborted) {
        resolve()
        return
      }
      ctrl.signal.addEventListener("abort", () => resolve(), { once: true })
    })

    const winner = await Promise.race<{ kind: "value"; value: T } | { kind: "abort" }>([
      factoryPromise.then((value) => ({ kind: "value" as const, value })),
      abortFired.then(() => ({ kind: "abort" as const })),
    ])

    if (winner.kind === "value") return winner.value

    // Abort fired. Give factory a brief grace window to settle on its
    // own (it sees the aborted signal and should produce a structured
    // wrapFailure). If it ignores the signal past the grace, throw to
    // unblock the caller — round-6 Codex hard-timeout guarantee.
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        factoryPromise,
        new Promise<T>((_, reject) => {
          graceTimer = setTimeout(
            () => reject(new DOMException("Operation aborted", "AbortError")),
            WITH_COMPOSED_TIMEOUT_ABORT_GRACE_MS,
          )
        }),
      ])
    } finally {
      if (graceTimer !== undefined) clearTimeout(graceTimer)
    }
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener("abort", onParentAbort)
  }
}

// ──────────────────────────────────────────────────────────────── parsing

interface ParsedArgs {
  ok: true
  value: Record<string, unknown>
}
interface ParseArgsError {
  ok: false
  error: string
}

function parseToolArguments(raw: string | Record<string, unknown>): ParsedArgs | ParseArgsError {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return { ok: true, value: raw as Record<string, unknown> }
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> }
      }
      return { ok: false, error: "tool arguments must be a JSON object, not array/scalar/null" }
    } catch (e) {
      return { ok: false, error: `tool arguments are not valid JSON: ${String(e)}` }
    }
  }
  return { ok: false, error: "tool arguments missing or wrong type" }
}

interface SchemaValidation {
  ok: boolean
  error?: string
}

/**
 * Minimal JSON-Schema shape check. Validates required fields exist
 * and types match. Does NOT support full JSON Schema (no allOf,
 * pattern, etc.) — enough for our 3 tool schemas. Phase 4 can swap
 * in a real validator if needed.
 */
function validateAgainstSchema(value: Record<string, unknown>, schema: Record<string, unknown>): SchemaValidation {
  const required = (schema.required as string[] | undefined) ?? []
  for (const key of required) {
    if (!(key in value) || value[key] === undefined || value[key] === null) {
      return { ok: false, error: `missing required field '${key}'` }
    }
  }
  const props = (schema.properties as Record<string, { type?: string; minimum?: number }> | undefined) ?? {}
  for (const [key, propSchema] of Object.entries(props)) {
    if (!(key in value)) continue
    const v = value[key]
    if (propSchema.type === "string" && typeof v !== "string") {
      return { ok: false, error: `field '${key}' must be a string` }
    }
    if (propSchema.type === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) {
        return { ok: false, error: `field '${key}' must be an integer` }
      }
      if (typeof propSchema.minimum === "number" && v < propSchema.minimum) {
        return { ok: false, error: `field '${key}' must be >= ${propSchema.minimum}` }
      }
    }
  }
  return { ok: true }
}

function parseAnswerJson(content: string): unknown {
  // Use parseFirstJsonObject so prose-prefixed and prose-suffixed JSON
  // both extract cleanly. Observed in production (PR #32 telemetry on
  // ARC-149): GLM-5.1 emits a final answer like
  //
  //   "No mention of Todd Bowles found in either repo... [prose]
  //
  //   ```json
  //   { ... }
  //   ```"
  //
  // The previous parser required the entire content to be a JSON
  // object (with at most a surrounding fence), so prose-then-fenced-
  // JSON failed to parse and the loop fell back to single-shot.
  // parseFirstJsonObject handles all the common malformations the
  // single-shot path already tolerates (markdown fence, prose wrap,
  // jsonrepair fallback for unescaped newlines / smart quotes / etc.).
  return parseFirstJsonObject(content)
}

/**
 * Parse + validate the final answer against finalAnswerSchema. Returns
 * null if either parse OR validation fails — the caller treats both as
 * `final_answer_did_not_parse` and falls back to single-shot.
 *
 * (CR catch on PR #24: previously the loop only did JSON.parse, so any
 * parseable JSON of the wrong shape — missing `answer`, wrong types,
 * etc. — was treated as success. The handler's downstream verdict
 * parser then rejected it AFTER the loop's fallback opportunity was
 * already gone, leaving the user with no reply at all.)
 */
function parseAndValidateFinalAnswer(content: string, schema: Record<string, unknown>): unknown {
  const parsed = parseAnswerJson(content)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const validation = validateAgainstSchema(obj, schema)
  return validation.ok ? parsed : null
}

function stringifyToolResult(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ ok: false, error: "tool result was not JSON-serializable" })
  }
}

function summarizeToolResult(toolName: string, value: unknown): RetrieveCodebaseToolSummary | undefined {
  if (toolName !== "retrieve_codebase" || value === null || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const out: RetrieveCodebaseToolSummary = {}
  if (typeof record.ok === "boolean") out.ok = record.ok
  if (typeof record.repo === "string") out.repo = record.repo
  if (typeof record.count === "number" && Number.isFinite(record.count)) out.count = record.count
  if (typeof record.error === "string") out.error = truncateTelemetryError(record.error)
  return Object.keys(out).length > 0 ? out : undefined
}

function summarizeThrownToolError(toolName: string, error: unknown): RetrieveCodebaseToolSummary | undefined {
  if (toolName !== "retrieve_codebase") return undefined
  return { ok: false, error: truncateTelemetryError(formatThrownValue(error)) }
}

function formatThrownValue(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return JSON.stringify(error) ?? "null"
  } catch {
    return `[unserializable: ${typeof error}]`
  }
}

function truncateTelemetryError(error: string): string {
  const cap = 1_000
  return error.length <= cap ? error : `${error.slice(0, cap - 1)}…`
}

// ──────────────────────────────────────────────────────────────── telemetry

export function buildTelemetryRecordInput(
  result: AgentLoopResult,
  args: AgentLoopArgs,
  telemetryState: LoopTelemetryState,
): AgentLoopTelemetryRecordInput {
  const totalMs = Date.now() - telemetryState.startMs
  const out: AgentLoopTelemetryRecordInput = {
    schemaVersion: 2,
    model: args.model,
    surface: args.surface,
    commentId: args.commentId,
    agentInitialUserMessage: args.initialUserMessage,
    singleShotPrompt: args.telemetryContext.singleShotPrompt,
    singleShotSchema: args.telemetryContext.singleShotSchema,
    promptBuilderVersion: args.telemetryContext.promptBuilderVersion,
    promptBuilderSource: args.telemetryContext.promptBuilderSource,
    turns: telemetryState.turns,
    toolCalls: telemetryState.toolCalls,
    totalMs,
    finalAnswer: result.ok ? result.answer : null,
  }
  const linearMentionRetrieval = buildLinearMentionRetrievalTelemetry(
    args.telemetryContext.linearMentionRetrieval,
    telemetryState.toolCalls,
  )
  if (linearMentionRetrieval) out.linearMentionRetrieval = linearMentionRetrieval
  if (typeof args.prNumber === "number") out.prNumber = args.prNumber
  if (!result.ok) {
    out.fallback = result.reason
    if (result.reason === "final_answer_did_not_parse") {
      out.failureRawAnswer = result.rawAnswer
    }
  }
  return out
}

function buildLinearMentionRetrievalTelemetry(
  context: LinearMentionRetrievalContext | undefined,
  toolCalls: LoopTelemetryState["toolCalls"],
): LinearMentionRetrievalTelemetry | undefined {
  if (!context) return undefined
  const calledRetrieveCodebase = toolCalls.some((call) => call.name === "retrieve_codebase")
  const retrieveCodebaseCallCount = toolCalls.filter((call) => call.name === "retrieve_codebase").length
  const allToolRetrievals = toolCalls
    .filter((call) => call.name === "retrieve_codebase")
    .map((call) => call.result)
    .filter((result): result is RetrieveCodebaseToolSummary => result !== undefined)
  const firstResolved = allToolRetrievals.find(
    (result) => result.ok === true && (result.repo !== undefined || typeof result.count === "number"),
  )
  return {
    availableRepos: context.availableRepos,
    mappedRepo: context.mappedRepo ?? null,
    repoStatus: context.repoStatus,
    initialRetrievalNamespace: context.initialRetrievalNamespace ?? null,
    initialChunkCount: context.initialChunkCount ?? 0,
    calledRetrieveCodebase,
    retrieveCodebaseCallCount,
    retrievalNamespace: calledRetrieveCodebase ? (firstResolved?.repo ?? null) : null,
    chunkCount: calledRetrieveCodebase ? (firstResolved?.count ?? 0) : 0,
    toolRetrievals: allToolRetrievals.slice(0, 5),
  }
}

// ──────────────────────────────────────────────────────────────── misc

function isAbortError(error: unknown): boolean {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name
    return typeof name === "string" && name === "AbortError"
  }
  return false
}

async function hashJson(value: unknown): Promise<string> {
  const text = JSON.stringify(value)
  const bytes = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest("SHA-256", bytes)
  const arr = Array.from(new Uint8Array(buf))
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("")
}
