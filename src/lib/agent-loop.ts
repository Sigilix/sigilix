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
//   withComposedTimeout()— hard timeout that races factory(signal)
//                          against an abort promise so a tool that
//                          ignores its signal still gets killed.

import { chat, isChatDisabledError } from "./ollama-chat"
import type {
  ChatArgs,
  ChatMessage,
  ChatResult,
  ChatToolDef,
} from "./ollama-chat"
import type { AgentTool } from "./agent-tools"
import type { Env } from "../index"

// ──────────────────────────────────────────────────────────────── types

export type AgentLoopResult =
  | { ok: true; answer: unknown; stats: AgentLoopStats }
  | AgentLoopFailure

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
  toolCalls: Array<{ name: string; ok: boolean; elapsedMs: number; argsHash: string }>
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
  }
  log: (event: AgentLoopEvent) => void
}

// ──────────────────────────────────────────────────────────────── public

export async function runAgentLoop(
  args: AgentLoopArgs,
): Promise<AgentLoopResult> {
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
          content:
            "You've used your tool budget. Answer or abstain now — no more tool calls.",
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
        telemetryState.toolCalls.push({
          name: toolName,
          ok: true,
          elapsedMs: elapsed,
          argsHash,
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
        telemetryState.toolCalls.push({
          name: toolName,
          ok: false,
          elapsedMs: elapsed,
          argsHash,
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
 * Hard timeout that COMPOSES with an external signal AND races the
 * factory against an abort promise. Either the factory returns first
 * or the abort wins (rejects). Critical: a factory that ignores its
 * signal still gets its await killed when the cap fires (round-6
 * Codex catch).
 *
 * Pre-aborted-parent race (joint Codex+Kimi round 5, refined Codex
 * round 6): the abortPromise factory checks `ctrl.signal.aborted`
 * synchronously on entry and rejects immediately if so. Without this,
 * a parentSignal already aborted on entry would trigger `abort()`
 * BEFORE the listener attached, leaving abortPromise pending forever.
 */
export async function withComposedTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const abort = (): void => {
    if (!ctrl.signal.aborted) {
      ctrl.abort(new DOMException("Operation aborted", "AbortError"))
    }
  }

  // Install abortPromise listener BEFORE the parent-aborted check, so
  // the immediate abort() below has a listener to reject the race.
  const abortPromise = new Promise<never>((_, reject) => {
    if (ctrl.signal.aborted) {
      reject(new DOMException("Operation aborted", "AbortError"))
      return
    }
    ctrl.signal.addEventListener(
      "abort",
      () => {
        reject(new DOMException("Operation aborted", "AbortError"))
      },
      { once: true },
    )
  })

  if (parentSignal?.aborted) abort()

  timer = setTimeout(abort, ms)
  const onParentAbort = abort
  parentSignal?.addEventListener("abort", onParentAbort, { once: true })

  try {
    return await Promise.race([factory(ctrl.signal), abortPromise])
  } finally {
    if (timer) clearTimeout(timer)
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
function validateAgainstSchema(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
): SchemaValidation {
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
  let body = content.trim()
  // Strip optional ```json fence.
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence?.[1]) body = fence[1].trim()
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
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
function parseAndValidateFinalAnswer(
  content: string,
  schema: Record<string, unknown>,
): unknown {
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
  if (typeof args.prNumber === "number") out.prNumber = args.prNumber
  if (!result.ok) {
    out.fallback = result.reason
    if (result.reason === "final_answer_did_not_parse") {
      out.failureRawAnswer = result.rawAnswer
    }
  }
  return out
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
