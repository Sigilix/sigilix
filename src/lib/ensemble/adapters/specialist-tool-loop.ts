import type { ChatArgs, ChatMessage, ChatResult, ChatToolDef, LlmUsage, ToolCall } from "@/src/shared/ports/model"

const DEFAULT_MAX_TOOL_CALLS = 2
const DEFAULT_TOOL_TIMEOUT_MS = 5_000

export interface SpecialistRuntimeTool {
  id: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

export interface SpecialistToolConversationArgs {
  chat: (args: ChatArgs) => Promise<ChatResult>
  model: string
  apiKey: string
  messages: ChatMessage[]
  signal: AbortSignal
  chatEnabled: "on" | "off"
  tools: SpecialistRuntimeTool[]
  format: Record<string, unknown>
  reasoning?: "high" | "medium" | "low"
  /** Provider passes 0 explicitly; direct callers also default to deterministic tool turns. */
  temperature?: number
  toolTimeoutMs?: number
  maxToolCalls?: number
}

export async function runSpecialistToolConversation(args: SpecialistToolConversationArgs): Promise<ChatResult> {
  const toolsByName = new Map(args.tools.map((tool) => [tool.id, tool]))
  const messages: ChatMessage[] = [
    ...args.messages,
    {
      role: "system",
      content:
        "You may call the provided review tools once. Use at most two total tool calls. " +
        "Additional tool calls will return budget-exceeded errors. " +
        "A tool result with status other than complete is not proof of absence; caveat or continue from other evidence.",
    },
  ]
  const toolTurn = await args.chat({
    model: args.model,
    apiKey: args.apiKey,
    messages,
    chatEnabled: args.chatEnabled,
    signal: args.signal,
    tools: args.tools.map(toChatToolDef),
    temperature: args.temperature ?? 0,
  })
  const usage = addUsage({}, toolTurn.usage)
  if (toolTurn.hasToolCalls) {
    const toolTurnMessage = withStableToolCallIds(toolTurn.message)
    messages.push(toolTurnMessage)
    const calls = toolTurnMessage.tool_calls ?? []
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!
      const content = await executeToolCall({
        call,
        tool: toolsByName.get(call.function.name),
        signal: args.signal,
        timeoutMs: args.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
        withinBudget: index < (args.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS),
      })
      messages.push({
        role: "tool",
        tool_call_id: call.id ?? `auto_${index}`,
        tool_name: call.function.name,
        content,
      })
    }
  }
  messages.push({
    role: "system",
    content:
      "Produce the final PR-review JSON now. Do not call tools again. " +
      "A file_grep status of empty only means the literal query found no visible-corpus matches; it is not proof the code is safe. " +
      "Do not treat truncated, empty, unavailable, or error tool results as exhaustive proof.",
  })
  const final = await args.chat({
    model: args.model,
    apiKey: args.apiKey,
    messages,
    chatEnabled: args.chatEnabled,
    signal: args.signal,
    format: args.format,
    ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
    temperature: args.temperature ?? 0,
  })
  return { ...final, usage: addUsage(usage, final.usage) }
}

function toChatToolDef(tool: SpecialistRuntimeTool): ChatToolDef {
  return {
    type: "function",
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function withStableToolCallIds(message: ChatMessage): ChatMessage {
  if (!message.tool_calls?.length) return message
  return {
    ...message,
    tool_calls: message.tool_calls.map((call, index) => (call.id ? call : { ...call, id: `auto_${index}` })),
  }
}

async function executeToolCall(args: {
  call: ToolCall
  tool: SpecialistRuntimeTool | undefined
  signal: AbortSignal
  timeoutMs: number
  withinBudget: boolean
}): Promise<string> {
  if (!args.withinBudget) return stringifyToolResult(toolError("budget_exceeded", "Tool-call budget exceeded."))
  if (!args.tool)
    return stringifyToolResult(toolError("tool_not_allowed", `Tool ${args.call.function.name} is not allowed.`))
  const parsed = parseToolArguments(args.call.function.arguments)
  if (!parsed.ok) return stringifyToolResult(toolError("invalid_args", parsed.error))
  const validation = validateAgainstSchema(parsed.value, args.tool.parameters)
  if (!validation.ok) return stringifyToolResult(toolError("invalid_args", validation.error))
  try {
    const result = await withToolTimeout(
      (signal) => args.tool!.execute(parsed.value, signal),
      args.timeoutMs,
      args.signal,
    )
    return stringifyToolResult(result)
  } catch (error) {
    if (isAbortError(error)) return stringifyToolResult(toolError("timeout", "Tool call exceeded timeout."))
    return stringifyToolResult(toolError("execution_failed", formatError(error)))
  }
}

function addUsage(base: LlmUsage, next: LlmUsage | undefined): LlmUsage {
  const out: LlmUsage = { ...base }
  if (next?.inputTokens !== undefined) out.inputTokens = (out.inputTokens ?? 0) + next.inputTokens
  if (next?.outputTokens !== undefined) out.outputTokens = (out.outputTokens ?? 0) + next.outputTokens
  // SIG-417: sum the actual per-call cost across the tool turn + final turn so a
  // multi-turn tool conversation doesn't lose its per-turn `usage.cost`. Undefined
  // is skipped (no provider cost reported) — never zero-filled, same as tokens.
  if (next?.costUsd !== undefined) out.costUsd = (out.costUsd ?? 0) + next.costUsd
  return out
}

function toolError(code: string, message: string): Record<string, unknown> {
  return { ok: false, status: "error", error: { code, message } }
}

function stringifyToolResult(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, val: unknown) => {
      if (typeof val !== "object" || val === null) return val
      if (seen.has(val)) return "[Circular]"
      seen.add(val)
      return val
    })
  } catch {
    return JSON.stringify(toolError("not_serializable", "Tool result was not JSON-serializable."))
  }
}

type ParsedArgs = { ok: true; value: Record<string, unknown> } | { ok: false; error: string }

function parseToolArguments(raw: string | Record<string, unknown>): ParsedArgs {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return { ok: true, value: raw }
  if (typeof raw !== "string") return { ok: false, error: "tool arguments missing or wrong type" }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> }
    }
    return { ok: false, error: "tool arguments must be a JSON object" }
  } catch (error) {
    return { ok: false, error: `tool arguments are not valid JSON: ${formatError(error)}` }
  }
}

function validateAgainstSchema(value: Record<string, unknown>, schema: Record<string, unknown>): ParsedArgs {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((v): v is string => typeof v === "string")
    : []
  for (const key of required) {
    if (value[key] === undefined || value[key] === null) return { ok: false, error: `missing required field '${key}'` }
  }
  const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<
    string,
    { type?: string; minimum?: number }
  >
  for (const [key, prop] of Object.entries(props)) {
    if (!(key in value)) continue
    const actual = value[key]
    if (prop.type === "string" && typeof actual !== "string")
      return { ok: false, error: `field '${key}' must be a string` }
    if (prop.type === "integer") {
      if (typeof actual !== "number" || !Number.isInteger(actual))
        return { ok: false, error: `field '${key}' must be an integer` }
      if (typeof prop.minimum === "number" && actual < prop.minimum)
        return { ok: false, error: `field '${key}' must be >= ${prop.minimum}` }
    }
  }
  return { ok: true, value }
}

async function withToolTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parentSignal: AbortSignal,
): Promise<T> {
  if (parentSignal.aborted) throw new DOMException("Operation aborted", "AbortError")
  const ctrl = new AbortController()
  const abort = (): void => {
    if (!ctrl.signal.aborted) ctrl.abort(new DOMException("Operation aborted", "AbortError"))
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      abort()
      reject(new DOMException("Operation aborted", "AbortError"))
    }, ms)
  })
  parentSignal.addEventListener("abort", abort, { once: true })
  if (parentSignal.aborted) {
    parentSignal.removeEventListener("abort", abort)
    throw new DOMException("Operation aborted", "AbortError")
  }
  try {
    const result = await Promise.race([factory(ctrl.signal), timeout])
    settled = true
    return result
  } catch (error) {
    settled = true
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parentSignal.removeEventListener("abort", abort)
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 200 ? `${message.slice(0, 200)}...(truncated)` : message
}
