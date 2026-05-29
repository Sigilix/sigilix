// SIG-114 — map raw KV JSON to the FP-rate core shapes (pure, testable).
//
// Extracted from the IO script so the mapping of the REAL persisted
// telemetry + review-memory shapes is unit-tested (against fixtures taken
// from live prod records), not buried in the script.

import { ALL_SPECIALISTS } from "../ensemble-router"
import type { FpRateDismissal, FpRateReview, RawSynthFinding, SpecialistRole } from "./types"

export const REVERSE_TS_BASE = 9_999_999_999_999

const KNOWN_ROLES = new Set<string>(ALL_SPECIALISTS as readonly string[])

/** Coerce to a finite number or the fallback (a NaN score must not slip past the score gate). */
function finiteOr(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Recover the review creation time (ms) from a reverse-ts KV key segment.
 * Returns null on a malformed key (a parse failure must NOT default to 0,
 * which would look ancient and bypass the window). Mirrors phase4-calibrate.
 */
export function createdMsFromKey(key: string, prefix: string): number | null {
  const rest = key.slice(prefix.length)
  const sep = rest.indexOf(":")
  if (sep <= 0) return null
  const reverseTs = Number(rest.slice(0, sep))
  if (!Number.isFinite(reverseTs)) return null
  const createdMs = REVERSE_TS_BASE - reverseTs
  return Number.isFinite(createdMs) ? createdMs : null
}

/**
 * Map a raw `ensemble-review-telemetry` value to FpRateReview. Returns null
 * if structurally unusable (no owner/repo/prNumber). `synthFindings` is null
 * when the synthesizer produced no verdict (guard-skip / failure); each
 * finding's roles come from the parallel-indexed provenance entry.
 */
export function mapTelemetryToReview(raw: unknown, createdMs: number): FpRateReview | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, any>
  if (r.owner == null || r.repo == null || r.prNumber == null) return null

  const synth = r.synthesizer
  let synthFindings: RawSynthFinding[] | null = null
  const verdictFindings = synth?.verdict?.findings
  if (Array.isArray(verdictFindings)) {
    const prov: any[] = Array.isArray(synth?.provenance?.findings) ? synth.provenance.findings : []
    synthFindings = verdictFindings.map((f: any, i: number): RawSynthFinding => {
      // Roles come from provenance.sourceSpecialists, UNIONed with the prefix
      // of each sourceFindingId (e.g. "security-0" -> "security"). Production
      // gates treat the source-id prefix as the authoritative role, so this
      // survives a missing/partial sourceSpecialists array.
      const entry: Record<string, unknown> = (prov[i] ?? {}) as Record<string, unknown>
      const fromSpecialists = Array.isArray(entry.sourceSpecialists) ? entry.sourceSpecialists.map(String) : []
      const fromIds = Array.isArray(entry.sourceFindingIds)
        ? (entry.sourceFindingIds as unknown[]).map((x) => String(x).split("-")[0] ?? "")
        : []
      const sourceSpecialists = [...new Set([...fromSpecialists, ...fromIds])].filter(
        (x): x is SpecialistRole => KNOWN_ROLES.has(x),
      )
      return {
        path: String(f?.path ?? ""),
        line: finiteOr(f?.line, 0),
        headline: String(f?.headline ?? ""),
        score: finiteOr(f?.score, 0),
        sourceSpecialists,
      }
    })
  }

  return {
    owner: String(r.owner),
    repo: String(r.repo),
    prNumber: Number(r.prNumber),
    createdMs,
    fellBackReason: r.fellBackReason ?? null,
    synthFindings,
  }
}

/** Extract dismissal signals from a raw `review-memory:*` record. Pure. */
export function mapSignalRecord(rec: unknown): FpRateDismissal[] {
  const signals = (rec as Record<string, any>)?.signals
  if (!Array.isArray(signals)) return []
  const out: FpRateDismissal[] = []
  for (const s of signals) {
    if (s?.kind !== "dismissed-textual" || typeof s?.fid !== "string") continue
    const tsMs = Date.parse(String(s.ts))
    out.push({
      fid: s.fid,
      prNumber: Number(s.prNumber ?? 0),
      commentId: Number(s.commentId ?? 0),
      dismissReason: s.dismissReason,
      tsMs: Number.isFinite(tsMs) ? tsMs : 0,
    })
  }
  return out
}
