// SIG-276 Phase 2 — write-time claim extractor.
//
// At finding-WRITE time the ensemble runs this classifier once per PR
// over the FINAL filtered findings (see `triage-pr-review-ensemble.ts`,
// just before `findingMarkers`). For each finding it emits 0-3 bounded
// `ReviewMemoryClaim`s naming the GENERAL pattern the finding asserts.
// Those claims ride the comment marker (`marker.ts`) to the dismissal-
// capture path, where Phase 2 PR B copies them onto the signal so memory
// can generalize on the specific pattern a team dismisses, not just its
// category.
//
// Two hard contracts:
//   - Privacy: output is enum-bounded only — `type` + `confidence` +
//     `extractorVersion`. No reviewer/finding free-text ever survives
//     `parseClaimExtractionResponse`.
//   - Fail-open: a missing/garbled classifier response degrades to NO
//     claims (markers emit unchanged). A wrong claim teaches the wrong
//     pattern, so the extractor biases hard toward omission.

import type { ReviewMemoryClaimMarkerData, ReviewMemoryClaimType } from "./types"
import { ALL_REVIEW_MEMORY_CLAIM_TYPES } from "./types"

/** Bumped whenever the extractor's prompt/semantics change. Stored on
 *  every emitted claim so Phase 4 can scope drift (see SIG-276). */
export const CLAIM_EXTRACTOR_VERSION = 1
/** Claims below this confidence are dropped at parse time. */
export const MIN_CLAIM_CONFIDENCE = 0.5
/** Hard cap on claims kept per finding. */
export const MAX_CLAIMS_PER_FINDING = 3

const CLAIM_TYPE_SET: ReadonlySet<ReviewMemoryClaimType> = new Set(ALL_REVIEW_MEMORY_CLAIM_TYPES)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function isClaimType(v: string): v is ReviewMemoryClaimType {
  return (CLAIM_TYPE_SET as ReadonlySet<string>).has(v)
}

/** The minimal finding view the classifier needs — no IDs, no markers. */
export interface ClaimExtractionFinding {
  headline: string
  body: string
  category: string
}

/**
 * JSON schema handed to the model as the Ollama `format` constraint so
 * the response shape is machine-parseable. Validation is still enforced
 * by `parseClaimExtractionResponse` — the schema is a hint, not a trust
 * boundary.
 */
export const CLAIM_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: [...ALL_REVIEW_MEMORY_CLAIM_TYPES] },
                confidence: { type: "number" },
              },
              required: ["type", "confidence"],
            },
          },
        },
        required: ["index", "claims"],
      },
    },
  },
  required: ["findings"],
} as const

/**
 * Pure: validate the classifier's raw JSON content into index-aligned
 * claim lists. Returns an array of EXACTLY `findingCount` entries (entry
 * i = finding i's surviving claims, defaulting to `[]`), or `null` when
 * the response is structurally unusable so the caller can fail open.
 *
 * Every claim is re-validated here regardless of the schema hint: type
 * must be a known enum value, confidence a finite number in
 * `[MIN_CLAIM_CONFIDENCE, 1]`. Only `type` / `confidence` /
 * `extractorVersion` survive — any extra field the model emits is
 * discarded (privacy contract).
 */
export function parseClaimExtractionResponse(
  content: string,
  findingCount: number,
): ReviewMemoryClaimMarkerData[][] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const findings = parsed.findings
  if (!Array.isArray(findings)) return null

  const result: ReviewMemoryClaimMarkerData[][] = Array.from({ length: findingCount }, () => [])

  for (const entry of findings) {
    if (!isRecord(entry)) continue
    const idx = entry.index
    if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= findingCount) {
      continue
    }
    const rawClaims = entry.claims
    if (!Array.isArray(rawClaims)) continue
    // `idx` is bounded `[0, findingCount)` above, so `result[idx]` exists.
    const bucket = result[idx]!
    for (const rc of rawClaims) {
      if (bucket.length >= MAX_CLAIMS_PER_FINDING) break
      if (!isRecord(rc)) continue
      const type = rc.type
      const confidence = rc.confidence
      if (typeof type !== "string" || !isClaimType(type)) continue
      if (typeof confidence !== "number" || !Number.isFinite(confidence)) continue
      if (confidence < MIN_CLAIM_CONFIDENCE || confidence > 1) continue
      bucket.push({
        type,
        confidence,
        extractorVersion: CLAIM_EXTRACTOR_VERSION,
      })
    }
  }
  return result
}

/**
 * Pure: build the classifier prompt. The user message lists each finding
 * by index so the response can align back; the system message pins the
 * allowed vocabulary and the omission bias.
 */
export function buildClaimExtractionPrompt(findings: ReadonlyArray<ClaimExtractionFinding>): {
  system: string
  user: string
} {
  const system = [
    "You classify code-review findings into a FIXED vocabulary of claim types.",
    "A claim names the GENERAL pattern a finding asserts so it can generalize across files and PRs.",
    "Allowed claim types — use ONLY these exact strings:",
    ...ALL_REVIEW_MEMORY_CLAIM_TYPES.map((t) => `  - ${t}`),
    "",
    "For each finding emit 0-3 claims that genuinely match. Prefer FEWER, high-confidence claims.",
    "Emit none if no type fits — a wrong claim is worse than no claim. Never invent a claim type.",
    "Each claim has a confidence in [0,1]. Do not echo or paraphrase the finding text.",
    'Respond with JSON only: {"findings":[{"index":<n>,"claims":[{"type":"<claim>","confidence":<0..1>}]}]}',
  ].join("\n")

  const user = [
    "Findings to classify:",
    "",
    ...findings.map((f, i) => [`[${i}] (${f.category}) ${f.headline}`, f.body].filter(Boolean).join("\n")),
  ].join("\n\n")

  return { system, user }
}

/**
 * Run the extractor over `findings`. `runClassifier` performs the actual
 * model round-trip (injected so the ensemble owns model/timeout/abort and
 * tests stay deterministic) and returns the raw response content, or
 * `null` on any model-side failure. Always returns an array aligned to
 * `findings`; never throws.
 */
export async function extractClaims(args: {
  findings: ReadonlyArray<ClaimExtractionFinding>
  runClassifier: (system: string, user: string) => Promise<string | null>
}): Promise<ReviewMemoryClaimMarkerData[][]> {
  const n = args.findings.length
  if (n === 0) return []
  const empty = (): ReviewMemoryClaimMarkerData[][] => args.findings.map(() => [])
  try {
    const { system, user } = buildClaimExtractionPrompt(args.findings)
    const content = await args.runClassifier(system, user)
    if (content === null) return empty()
    return parseClaimExtractionResponse(content, n) ?? empty()
  } catch {
    return empty()
  }
}
