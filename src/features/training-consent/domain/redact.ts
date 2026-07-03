// sig-training-data-consent — pre-store redaction seam (pure).
//
// EVERY record that enters the training store passes through here FIRST — that
// ordering is enforced structurally by `retainForTraining` (redact → store), and
// asserted by a test. This is deliberately a SELF-CONTAINED, conservative
// redactor rather than a call into `src/lib/secret-scan.ts`: the COMPLIANCE
// dependency rule forbids a feature reaching into a `src/lib` god-file, and
// secret-scan is unified-DIFF-shaped (wrong input for arbitrary training text).
// It masks the highest-signal leak classes; it is the SEAM where a richer
// PII/secret pipeline is dropped in later (the legal prerequisites in the README
// call for a full DLP pass before the retention flag is ever turned on).

import type { TrainingRecord } from "@/src/features/training-consent/domain/types"

const REDACTED = "[REDACTED]"

// Ordered, non-overlapping-enough patterns for the common high-signal leaks.
// Conservative by design: over-redaction is acceptable for a training corpus;
// under-redaction is not.
const PATTERNS: ReadonlyArray<RegExp> = [
  // Email addresses (basic RFC-ish).
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Common provider token prefixes + a long token body.
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[baprs]|AKIA|ASIA|AIza)[-_A-Za-z0-9]{16,}\b/g,
  // Bearer / Authorization header values.
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g,
  // PEM private-key blocks.
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  // JWT-shaped triples (header.payload.signature).
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
]

/** Mask every known leak class in a single string. Never throws. */
export function redactText(input: string): string {
  let out = input
  for (const re of PATTERNS) out = out.replace(re, REDACTED)
  return out
}

/**
 * Redact a training record: masks the payload, the `id`, AND every metadata
 * value. Returns a NEW record (never mutates the input). This is the function
 * `retainForTraining` calls before handing anything to the store.
 *
 * The `id` is redacted too because it is NOT opaque — call sites build it from
 * capture-surface fields (e.g. `owner/repo` from a request body), and it is
 * written into the R2 OBJECT KEY, the stored body, and telemetry. A caller that
 * smuggles a secret/PII into `owner`/`repo` would otherwise leak it via the key
 * even though the payload was masked. Redacting here closes that class for every
 * kind and every present/future call site (the store never sees a raw id).
 */
export function redactTrainingRecord(record: TrainingRecord): TrainingRecord {
  const meta = record.meta
    ? Object.fromEntries(Object.entries(record.meta).map(([k, v]) => [k, redactText(v)]))
    : undefined
  return {
    kind: record.kind,
    id: redactText(record.id),
    payload: redactText(record.payload),
    ...(meta ? { meta } : {}),
  }
}
