// SIG-395 — invariant lens: pure dispatch policy.
//
// The lens fires per FAMILY, gated on cheap textual preconditions over the
// diff — not on the re-sweep's effort gate, because cross-cutting bugs
// need BREADTH (a rule site and a violation site), not density. Deliberate
// bias: preconditions are PERMISSIVE — a false dispatch wastes one cheap
// concurrent model call; a missed family loses a whole bug class.
//
// Evidence + design: docs/superpowers/specs/2026-06-11-sig-395-invariant-lens-spec.md

export type InvariantLensMode = "off" | "shadow" | "on"
export type InvariantLensRecallContract = "blocking" | "shadow-background" | "pending-check-amendment"

/** Normalize `OPENCLAW_INVARIANT_LENS_MODE` (default "off"). */
export function parseInvariantLensMode(raw: string | undefined): InvariantLensMode {
  const v = (raw ?? "").trim().toLowerCase()
  return v === "shadow" || v === "on" ? v : "off"
}

/** Normalize `OPENCLAW_INVARIANT_LENS_RECALL_CONTRACT`.
 *  Default/fallback is blocking so unknown values cannot detach recall work. */
export function parseInvariantLensRecallContract(raw: string | undefined): InvariantLensRecallContract {
  const v = (raw ?? "").trim().toLowerCase()
  return v === "shadow-background" || v === "pending-check-amendment" ? v : "blocking"
}

export type InvariantLensExecutionDecision =
  | { kind: "background"; effectiveRecallContract: "shadow-background" }
  | {
      kind: "blocking"
      effectiveRecallContract: "blocking"
      refusalReason?: "mode-on-requires-blocking" | "pending-check-amendment-unavailable"
    }

/**
 * Decide whether the lens may run outside the synth-critical path. The only
 * detachable path shipped today is telemetry-only shadow work. Any recall-
 * affecting contract fails closed until a merge-gated amendment lane owns the
 * PR's blocking signal through deep-lane completion.
 */
export function decideInvariantExecution(args: {
  mode: InvariantLensMode
  recallContract: InvariantLensRecallContract
}): InvariantLensExecutionDecision {
  if (args.recallContract === "pending-check-amendment") {
    return {
      kind: "blocking",
      effectiveRecallContract: "blocking",
      refusalReason: "pending-check-amendment-unavailable",
    }
  }
  if (args.recallContract === "shadow-background" && args.mode === "shadow") {
    return { kind: "background", effectiveRecallContract: "shadow-background" }
  }
  if (args.recallContract === "shadow-background" && args.mode === "on") {
    return { kind: "blocking", effectiveRecallContract: "blocking", refusalReason: "mode-on-requires-blocking" }
  }
  return { kind: "blocking", effectiveRecallContract: "blocking" }
}

/**
 * Per-family dispatch preconditions. Each is a PREDICATE over (lowercased
 * text, raw diff) — predicates, not one big regex, because the diff can be
 * megabytes and these run synchronously on the Worker's main thread during
 * the fanout window: every test below is linear, single-pass. (The
 * code-review measured a lazy `[\s\S]*?` proximity variant of data-scoping
 * at ~2.6s on an 80k-route diff — proximity bought nothing over
 * presence-AND, so it was removed.)
 */
type Precondition = (text: string, raw: string) => boolean
const FAMILY_PRECONDITIONS: Record<string, Precondition> = {
  units: (t) => /cents|dollars|price|amount|currency|total/.test(t),
  // Presence-AND of an ownership key and a route handler — two independent
  // linear scans; the lazy-quantifier proximity check was quadratic.
  "data-scoping": (t) => /customer_id|tenant|user_id|owner/.test(t) && /\.(get|post|put|delete)\(/.test(t),
  "discriminant-totality": (t) => /"\s*\|\s*"|enum |switch \(|\btype\b\s*:/.test(t),
  "error-contracts": (t) => /status\(|statuscode|\b404\b|\b400\b/.test(t),
  "crypto-integrity": (t) => /hmac|signature|secret|crypto|timingsafe|digest/.test(t),
  // Runs on the RAW diff: ` as [A-Z]` is deliberately case-sensitive (a
  // cast to a Type name), which lowercased text cannot express.
  "wire-contracts": (_t, raw) => /interface | as unknown as | as [A-Z]|snake_case|camelCase/.test(raw),
}

export interface InvariantDispatchDecision {
  fire: boolean
  reasons: string[]
  dispatched: string[]
  skipped: Array<{ id: string; reason: "precondition-unmet" }>
}

/**
 * Decide which auditor families to dispatch for this diff. The breadth
 * gate (≥2 changed files OR ≥150 added lines) reflects what an invariant
 * IS: a rule established at one site and violated at another — a single
 * small file has nowhere to cross.
 */
export function decideInvariantDispatch(args: {
  mode: InvariantLensMode
  familyIds: readonly string[]
  diff: string
  changedFileCount: number
  addedLineCount: number
}): InvariantDispatchDecision {
  if (args.mode === "off") {
    return { fire: false, reasons: ["mode-off"], dispatched: [], skipped: [] }
  }
  const reasons: string[] = []
  if (args.changedFileCount >= 2) reasons.push(`changed-files:${args.changedFileCount}`)
  if (args.addedLineCount >= 150) reasons.push(`added-lines:${args.addedLineCount}`)
  const breadth = args.changedFileCount >= 2 || args.addedLineCount >= 150
  if (!breadth) {
    return { fire: false, reasons: ["breadth-unmet"], dispatched: [], skipped: [] }
  }

  const text = args.diff.toLowerCase()
  const dispatched: string[] = []
  const skipped: Array<{ id: string; reason: "precondition-unmet" }> = []
  for (const id of args.familyIds) {
    const pre = FAMILY_PRECONDITIONS[id]
    // An unknown family (future addition without a precondition) dispatches —
    // permissive by design; tighten only with evidence.
    if (!pre || pre(text, args.diff)) dispatched.push(id)
    else skipped.push({ id, reason: "precondition-unmet" })
  }
  return { fire: dispatched.length > 0, reasons, dispatched, skipped }
}

/** Count added lines in a unified diff (excluding +++ headers). */
export function countAddedLines(diff: string): number {
  let n = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) n += 1
  }
  return n
}
