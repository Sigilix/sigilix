// SIG-477 PR-3 — the FIRST execution harness: ReDoS (catastrophic backtracking).
//
// This is the first thing that ACTUALLY RUNS a finding's cited code in the QuickJS
// sandbox (PR-2's `runInSandbox`) and observes an OBJECTIVE failure — so a
// `reproduced` verdict means "we re-ran the regex and watched it blow up", never a
// model judgment. PR-3 wires it in SHADOW (measure only — no tier mutation, no
// customer pill); the customer flip is PR-5.
//
// ── THE HONEST DECISION (a deterministic TWO-SIDED test) ────────────────────
// A regex is "reproduced" as catastrophic ONLY when BOTH sides hold:
//   (1) a BENIGN input returns fast (the regex isn't just slow/broken/our pump
//       char is wrong) — otherwise the result is INCONCLUSIVE, never reproduced;
//   (2) a small ADVERSARIAL "pump" input (a long run of an accepted char + a
//       mismatch suffix that forces backtracking) TIMES OUT at small N, and does
//       so on a RE-RUN (determinism) — superlinear blow-up at small N is the
//       catastrophic-backtracking signature.
// If a SAFE regex (no nested unbounded quantifier) is fed in, side (2) never
// fires for ANY candidate pump char/length → INCONCLUSIVE. A safe regex is NEVER
// "reproduced" — that FP-safety is the whole point of the two-sided test. The
// harness NEVER refutes (absence of a found catastrophic input is inconclusive,
// not proof the regex is safe) and NEVER throws.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { parseSource, walkAst, type SourceExt, type AstNode } from "@/src/features/ast-rules"
import { runInSandbox, type SandboxCaps } from "./sandbox-runner"

/** The cited-code fields the harness reads to lift the regex. All optional — a
 *  finding may carry any subset (the eligibility gate already ensured at least one
 *  holds liftable code). `PrReviewFinding.body` is required on the full type, so we
 *  declare an all-optional input here rather than `Pick` (which would inherit
 *  `body`'s required-ness and force every caller to pass it). Includes the SAME
 *  source fields the eligibility gate's `citedCode` scans (failureExample / astEvidence
 *  / body / the fix fields), so an eligible finding is never `skipped` for a regex the
 *  gate already saw — but the candidate ORDER prefers the BUGGY code (see below). */
export interface RedosHarnessInput {
  failureExample?: PrReviewFinding["failureExample"]
  astEvidence?: PrReviewFinding["astEvidence"]
  suggestedReplacement?: PrReviewFinding["suggestedReplacement"]
  fixExample?: PrReviewFinding["fixExample"]
  body?: PrReviewFinding["body"]
}

/** The harness outcome. `reproduced` = the two-sided test fired (benign fast +
 *  adversarial timed out, deterministically); `inconclusive` = we could NOT prove
 *  catastrophic backtracking (the safe-regex / weird-regex / no-input-found case —
 *  NEVER a refutation); `skipped` = nothing to run (no extractable regex) or a
 *  fail-safe on any unexpected error. `detail` is a stable machine-readable tag. */
export interface RedosHarnessResult {
  status: "reproduced" | "inconclusive" | "skipped"
  detail: string
  elapsedMs: number
}

/** The extracted regex literal — its source `pattern` + `flags`. */
interface ExtractedRegex {
  pattern: string
  flags: string
}

/** Per-run sandbox caps for the harness. The deadline is the catastrophic-timeout
 *  signal: a short deadline means even a SMALL pump input that blows up superlinearly
 *  trips it, while a benign linear match finishes well under it. Memory/stack are
 *  generous (a regex match is not memory-bound) but still bounded by the runner. */
const HARNESS_DEADLINE_MS = 250
const HARNESS_CAPS: SandboxCaps = {
  memoryBytes: 32 * 1024 * 1024,
  maxStackBytes: 256 * 1024,
  deadlineMs: HARNESS_DEADLINE_MS,
}

/** HARD wall-clock cap on a SINGLE harness invocation (the TRUE aggregate bound).
 *  The per-call `deadlineMs` only bounds ONE sandbox run; without this, the worst
 *  case (a regex that's benign-fast for all 5 pump chars but never catastrophic) is
 *  5 × (1 benign + 2 adversarial) = 15 calls ≈ 3.75s. This cap makes the harness's
 *  ACTUAL cost bounded regardless of the pump-char/length matrix — checked before
 *  starting each pump-char attempt so the harness stops trying once it's spent its
 *  budget (→ inconclusive "harness-budget-exhausted"). It is the per-run figure the
 *  caller's per-PR budget reserves, so the aggregate ceiling is HONEST (not an
 *  under-estimate). DeepSeek-v4-pro + Codex both flagged the under-reserve; an
 *  internal cap is the simpler, correct fix (bounds actual cost, not an estimate). */
export const HARNESS_MAX_TOTAL_MS = 4_000

/** Candidate pump characters tried in order — the repeated atom of a vulnerable
 *  regex plausibly accepts one of these (`\w`/`\s`/`.`/letter/digit classes). The
 *  benign-fast gate per candidate ensures we only escalate a char the regex
 *  actually consumes. */
const PUMP_CHARS: readonly string[] = ["a", "0", " ", "x", "A"]
/** Escalating adversarial run lengths. Small on purpose: catastrophic backtracking
 *  is superlinear, so a TRUE ReDoS times out at N≈28-32 under a 250ms deadline,
 *  while a safe (linear) regex shrugs off these lengths in microseconds. Keeping N
 *  small is what makes a timeout MEAN "catastrophic" rather than "merely big input". */
const ADVERSARIAL_LENGTHS: readonly number[] = [28, 32]
/** Benign input length — a short accepted run that a non-pathological regex matches
 *  (or rejects) in linear time, well under the deadline. */
const BENIGN_LENGTH = 3
/** The mismatch suffix appended to the adversarial run. A high-codepoint char +
 *  `!` is very unlikely to be in the regex's accepted class, so it forces the
 *  engine to backtrack through every partition of the preceding run. */
const MISMATCH_SUFFIX = "\u{ffff}!"

/**
 * Build the sandbox guest source that constructs the regex and `.test()`s the
 * adversarial/benign string. The pattern + flags + input are embedded as JSON
 * string literals (no host reference; the guest only sees data), `lastIndex` is
 * reset (defensive against a sticky/global flag carrying state), and the boolean
 * result is returned so a clean run is `status:"ok"`. A catastrophic run instead
 * hits the deadline → `status:"timed-out"`.
 */
function buildHarnessSource(pattern: string, flags: string, input: string): string {
  return (
    `const re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)});` +
    `re.lastIndex = 0;` +
    `re.test(${JSON.stringify(input)})`
  )
}

/** The ORDERED candidate code snippets the regex is extracted from. CRITICAL: prefer
 *  the BUGGY code over the FIX. The harness must run the VULNERABLE regex, not the
 *  proposed safe replacement — running the fix would record a false `inconclusive`
 *  for a real ReDoS. Order: `failureExample` (the failing example) → `astEvidence`
 *  (the quoted buggy code) → the body's code fences → the raw body → and ONLY THEN
 *  the FIX fields (`suggestedReplacement` / `fixExample`) as a last resort, since a
 *  finding's fix usually CHANGES the regex. Each candidate is tried INDEPENDENTLY by
 *  `extractRegex` (the first one yielding a regex wins) — joining them into one blob
 *  would fail to parse (prose + fences around the code). Covers the same source fields
 *  the eligibility gate's `citedCode` scans, so an eligible finding is never `skipped`
 *  for a regex the gate already saw. */
function citedCodeCandidates(finding: RedosHarnessInput): string[] {
  const parts: string[] = []
  // Buggy-code sources first.
  for (const v of [finding.failureExample, finding.astEvidence]) {
    if (typeof v === "string" && v.trim().length > 0) parts.push(v)
  }
  const body = typeof finding.body === "string" ? finding.body : ""
  const fence = /```[a-z]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(body)) !== null) {
    if (m[1] && m[1].trim().length > 0) parts.push(m[1])
  }
  // The raw body so a regex quoted inline (no fence) is still reachable.
  if (body.trim().length > 0) parts.push(body)
  // FIX sources LAST — only used when no buggy source carried a regex (a fix often
  // changes the regex, so running it would falsely read inconclusive on a real ReDoS).
  for (const v of [finding.suggestedReplacement, finding.fixExample]) {
    if (typeof v === "string" && v.trim().length > 0) parts.push(v)
  }
  return parts
}

/**
 * Extract the FIRST RegExpLiteral from the candidate snippets via the AST. acorn
 * exposes a regex literal as a `Literal` node carrying `{ regex: { pattern, flags } }`
 * (the same shape the no-redos rule reads). Each candidate is parsed INDEPENDENTLY;
 * the first one that parses AND contains a regex literal wins. Returns null when no
 * candidate yields a regex — the harness then `skipped`s ("no-regex"). Never throws
 * (parseSource returns ok:false on a parse error).
 */
function extractRegex(candidates: readonly string[]): ExtractedRegex | null {
  for (const code of candidates) {
    const trimmed = code.trim()
    if (trimmed.length === 0) continue
    const parsed = parseSource(trimmed, ".ts" as SourceExt)
    if (!parsed.ok) continue
    let found: ExtractedRegex | null = null
    walkAst(parsed.ast, {
      Literal: (node: AstNode) => {
        if (found !== null) return
        const regex = node?.regex
        if (regex && typeof regex.pattern === "string") {
          found = { pattern: regex.pattern, flags: typeof regex.flags === "string" ? regex.flags : "" }
        }
      },
    })
    if (found !== null) return found
  }
  return null
}

/**
 * Run the ReDoS harness on ONE finding. NEVER throws; returns a structured
 * {@link RedosHarnessResult}. See the module header for the two-sided decision and
 * the never-reproduced-on-a-safe-regex guard.
 *
 * @param finding the submitted finding (its cited code is parsed for the regex).
 * @param caps optional sandbox-cap override (defaults to the harness caps); only
 *   the deadline materially affects the decision (it's the catastrophic signal).
 */
export async function runRedosHarness(
  finding: RedosHarnessInput,
  caps: SandboxCaps = HARNESS_CAPS,
): Promise<RedosHarnessResult> {
  const start = Date.now()
  const elapsed = (): number => Date.now() - start
  try {
    // (1) Extract the regex from the cited code.
    const regex = extractRegex(citedCodeCandidates(finding))
    if (regex === null) {
      return { status: "skipped", detail: "no-regex", elapsedMs: elapsed() }
    }

    // (2)+(3) Two-sided test per candidate pump char. We need a pump char the
    // regex's repeated atom accepts (so the benign run is fast and the adversarial
    // run can actually backtrack). Try each in order; the FIRST char that proves a
    // deterministic catastrophic timeout wins → reproduced.
    let sawBenignFast = false
    for (const pumpChar of PUMP_CHARS) {
      // HARD per-harness wall-clock cap (the TRUE aggregate bound — see
      // HARNESS_MAX_TOTAL_MS): stop trying more pump chars once the harness has spent
      // its budget, so its ACTUAL cost can never exceed the figure the caller reserves.
      if (elapsed() >= HARNESS_MAX_TOTAL_MS) {
        return { status: "inconclusive", detail: "harness-budget-exhausted", elapsedMs: elapsed() }
      }
      // BENIGN first: a short accepted run must return `ok` fast. If it does NOT
      // (times out / errors), this pump char is wrong (or the regex is weird) — try
      // the next candidate; if NO candidate is ever benign-fast, we never claim
      // reproduced (inconclusive "benign-not-fast").
      const benign = await runInSandbox(
        buildHarnessSource(regex.pattern, regex.flags, pumpChar.repeat(BENIGN_LENGTH)),
        null,
        caps,
      )
      if (benign.status !== "ok") continue
      sawBenignFast = true

      // ADVERSARIAL: a long run + a mismatch suffix, at escalating small N. A
      // `timed-out` is the catastrophic-backtracking signal — but only if it
      // REPRODUCES on a re-run (a one-off timeout could be CI noise / a GC pause),
      // so we re-run the SAME input and require BOTH to time out. A flaky single
      // timeout → inconclusive, never reproduced.
      for (const n of ADVERSARIAL_LENGTHS) {
        const adversarialInput = pumpChar.repeat(n) + MISMATCH_SUFFIX
        const first = await runInSandbox(buildHarnessSource(regex.pattern, regex.flags, adversarialInput), null, caps)
        if (first.status !== "timed-out") continue
        // Determinism re-run: confirm the timeout reproduces.
        const second = await runInSandbox(buildHarnessSource(regex.pattern, regex.flags, adversarialInput), null, caps)
        if (second.status === "timed-out") {
          return {
            status: "reproduced",
            detail: `catastrophic-backtracking:pump=${JSON.stringify(pumpChar)}:n=${n}`,
            elapsedMs: elapsed(),
          }
        }
        // First timed out but the re-run did not → flaky, not deterministic.
        return {
          status: "inconclusive",
          detail: `flaky-timeout:pump=${JSON.stringify(pumpChar)}:n=${n}`,
          elapsedMs: elapsed(),
        }
      }
    }

    // No candidate produced a deterministic catastrophic timeout. NEVER refute: a
    // safe regex (or one our pump chars don't fit) lands here as INCONCLUSIVE.
    return {
      status: "inconclusive",
      detail: sawBenignFast ? "no-catastrophic-input-found" : "benign-not-fast",
      elapsedMs: elapsed(),
    }
  } catch (err) {
    // Fail-safe: the harness must NEVER throw into the review path.
    return { status: "skipped", detail: `error:${err instanceof Error ? err.name : "unknown"}`, elapsedMs: elapsed() }
  }
}
