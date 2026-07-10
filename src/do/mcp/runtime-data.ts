const MAX_SCHEMA_BYTES = 12 * 1024
const MAX_ARGUMENT_BYTES = 8 * 1024
const MAX_RESULT_CHARS = 12_000
const MAX_DEPTH = 8
const MAX_OBJECT_KEYS = 128
const MAX_ARRAY_ITEMS = 64

const SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "allOf",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
])

export interface SanitizedMcpResult {
  untrusted: true
  content: Array<{ type: "text"; text: string }>
  truncated: boolean
}

/** Strip remote prose/metadata from a discovered input schema and enforce a
 *  small JSON budget before the descriptor can enter a model context. */
export function sanitizeMcpInputSchema(value: unknown): Record<string, unknown> | null {
  const state = { keys: 0 }
  const sanitized = sanitizeSchemaValue(value, 0, state, false)
  if (!isPlainObject(sanitized) || sanitized.type !== "object") return null
  // Canonical key ordering prevents remote object insertion order from becoming
  // a hidden descriptor channel and makes the model-facing schema byte-stable.
  const canonical = sortJsonValue(sanitized) as Record<string, unknown>
  try {
    if (new TextEncoder().encode(JSON.stringify(canonical)).length > MAX_SCHEMA_BYTES) return null
  } catch {
    return null
  }
  return canonical
}

/** Parsed tool arguments must be a plain, bounded JSON object. */
export function areBoundedMcpArguments(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const state = { keys: 0 }
  if (!validateJsonValue(value, 0, state)) return false
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_ARGUMENT_BYTES
  } catch {
    return false
  }
}

/** Keep text data only, remove control characters, cap output, and mark the
 *  result explicitly untrusted. Images, resources, annotations, metadata, and
 *  structuredContent are never forwarded to a model. */
export function sanitizeMcpResult(value: unknown): SanitizedMcpResult | null {
  if (!isPlainObject(value) || value.isError === true || !Array.isArray(value.content)) return null
  const content: Array<{ type: "text"; text: string }> = []
  let remaining = MAX_RESULT_CHARS
  let truncated = false
  for (const item of value.content) {
    if (!isPlainObject(item) || item.type !== "text" || typeof item.text !== "string") continue
    if (remaining <= 0) {
      truncated = true
      break
    }
    const neutral = stripControls(item.text)
    const text = neutral.slice(0, remaining)
    if (text.length < neutral.length) truncated = true
    if (text) content.push({ type: "text", text })
    remaining -= text.length
  }
  if (content.length === 0) return null
  return { untrusted: true, content, truncated }
}

function sanitizeSchemaValue(value: unknown, depth: number, state: { keys: number }, propertyMap: boolean): unknown {
  if (depth > MAX_DEPTH) return undefined
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") return value.slice(0, 256)
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) return undefined
    const items = value.map((item) => sanitizeSchemaValue(item, depth + 1, state, false))
    return items.some((item) => item === undefined) ? undefined : items
  }
  if (!isPlainObject(value)) return undefined
  const out = Object.create(null) as Record<string, unknown>
  for (const [key, child] of Object.entries(value)) {
    // `properties` is a map of caller-visible argument names; every other
    // object is a schema node whose keys must be structural JSON-Schema keys.
    if (!propertyMap && !SCHEMA_KEYS.has(key)) continue
    state.keys += 1
    if (state.keys > MAX_OBJECT_KEYS || key.length > 128) return undefined
    if (!propertyMap && key === "required") {
      if (
        !Array.isArray(child) ||
        child.some((item) => typeof item !== "string" || item.length === 0 || item.length > 128)
      ) {
        return undefined
      }
      out[key] = [...new Set(child as string[])]
      continue
    }
    const next = sanitizeSchemaValue(child, depth + 1, state, !propertyMap && key === "properties")
    if (next !== undefined) out[key] = next
  }
  return out
}

function validateJsonValue(value: unknown, depth: number, state: { keys: number }): boolean {
  if (depth > MAX_DEPTH) return false
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "string") return value.length <= 2_048
  if (Array.isArray(value)) {
    return value.length <= MAX_ARRAY_ITEMS && value.every((item) => validateJsonValue(item, depth + 1, state))
  }
  if (!isPlainObject(value)) return false
  const entries = Object.entries(value)
  state.keys += entries.length
  if (state.keys > MAX_OBJECT_KEYS) return false
  return entries.every(([key, child]) => key.length <= 128 && validateJsonValue(child, depth + 1, state))
}

function stripControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isPlainObject(value)) return value
  const out = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value).sort()) out[key] = sortJsonValue(value[key])
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}
