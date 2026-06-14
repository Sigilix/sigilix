// SIG-291: safe YAML parsing for repo config. This module is pure:
// raw text in, JSON-compatible value or structured parse failure out.

import { JSON_SCHEMA, load } from "js-yaml"

type JsonCompatible = null | string | number | boolean | JsonCompatible[] | { [key: string]: JsonCompatible }

export type YamlParseResult = { ok: true; value: JsonCompatible } | { ok: false; reason: string }

type AnchorAwareState = { anchor?: string | null }

function normalizeJsonCompatible(value: unknown, seen = new Set<object>()): YamlParseResult {
  if (value === null) return { ok: true, value: null }
  switch (typeof value) {
    case "string":
    case "boolean":
      return { ok: true, value }
    case "number":
      return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: "YAML contains a non-finite number" }
    case "object":
      break
    default:
      return { ok: false, reason: `YAML contains unsupported ${typeof value} value` }
  }

  if (seen.has(value)) return { ok: false, reason: "YAML anchors/aliases are not supported" }
  seen.add(value)

  if (Array.isArray(value)) {
    const out: JsonCompatible[] = []
    for (const item of value) {
      const normalized = normalizeJsonCompatible(item, seen)
      if (!normalized.ok) return normalized
      out.push(normalized.value)
    }
    seen.delete(value)
    return { ok: true, value: out }
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, reason: "YAML must parse to plain JSON-compatible objects" }
  }

  const out: Record<string, JsonCompatible> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeJsonCompatible(child, seen)
    if (!normalized.ok) return normalized
    out[key] = normalized.value
  }
  seen.delete(value)
  return { ok: true, value: out }
}

export function parseYamlConfigDocument(raw: string): YamlParseResult {
  let parsed: unknown
  try {
    parsed = load(raw, {
      schema: JSON_SCHEMA,
      listener(_eventType, state) {
        const anchor = (state as AnchorAwareState).anchor
        if (anchor !== null && anchor !== undefined) {
          throw new Error("YAML anchors/aliases are not supported")
        }
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : "YAML parse failed"
    return { ok: false, reason: `YAML parse failed: ${msg}` }
  }

  return normalizeJsonCompatible(parsed)
}
