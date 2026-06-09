// ARC-188: defensive SARIF v2.1.0 parser.
//
// Hand-rolled validation (no `ajv`) — v2 spec §3.3 keeps the bundle
// delta ≤ 5 KB gzipped. Only validates the fields the runner + SBOM
// builder actually read; everything else passes through untouched
// since SARIF producers add custom fields freely.
//
// Returns a tagged result so the caller can emit
// `sarif-evidence-parse-failed` or `unsupported-sarif-version`
// telemetry without doing its own try/catch.

import type {
  SarifReport,
  SarifResult,
  SarifRun,
} from "./types"

export type ParseSarifOk = { ok: true; report: SarifReport }
export type ParseSarifErr = { ok: false; reason: string }
export type ParseSarifResult = ParseSarifOk | ParseSarifErr

const SUPPORTED_VERSION = "2.1.0"

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/**
 * Parse a SARIF v2.1.0 report. Never throws.
 *
 * Drops individual results that lack a `message.text` (the only
 * field the runner needs to render), but keeps the surrounding run
 * intact. A whole-report parse failure (malformed JSON, wrong
 * version, missing `runs` array) returns `ok: false`.
 */
export function parseSarif(raw: string): ParseSarifResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "raw must be a string" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : "JSON parse failed"
    return { ok: false, reason: `JSON parse failed: ${msg}` }
  }
  if (!isObject(parsed)) {
    return { ok: false, reason: "top-level must be an object" }
  }
  if (parsed.version !== SUPPORTED_VERSION) {
    return {
      ok: false,
      reason: `unsupported-sarif-version: expected ${SUPPORTED_VERSION}, got ${String(parsed.version)}`,
    }
  }
  if (!Array.isArray(parsed.runs)) {
    return { ok: false, reason: "`runs` must be an array" }
  }

  // Coerce + lightly validate each run. Producers vary; we keep
  // unknown fields and only enforce the shape the rest of the
  // pipeline reads.
  const runs: SarifRun[] = []
  for (const r of parsed.runs) {
    if (!isObject(r)) continue
    const tool = isObject(r.tool) ? r.tool : null
    const driver = tool && isObject(tool.driver) ? tool.driver : null
    if (!driver || typeof driver.name !== "string" || driver.name.length === 0) {
      // SARIF requires `runs[].tool.driver.name`; without it the
      // resolver can't identify the producer. Skip the run instead
      // of failing the whole report.
      continue
    }
    const results: SarifResult[] = []
    if (Array.isArray(r.results)) {
      for (const res of r.results) {
        if (!isObject(res)) continue
        // Drop results with no message text — nothing to render.
        const messageText = isObject(res.message) && typeof res.message.text === "string"
          ? res.message.text
          : null
        if (!messageText) continue
        results.push(res as unknown as SarifResult)
      }
    }
    runs.push({
      ...r,
      tool: tool as unknown as SarifRun["tool"],
      results,
    } as unknown as SarifRun)
  }

  return {
    ok: true,
    report: {
      version: SUPPORTED_VERSION,
      ...(typeof parsed.$schema === "string" ? { $schema: parsed.$schema } : {}),
      runs,
    },
  }
}
