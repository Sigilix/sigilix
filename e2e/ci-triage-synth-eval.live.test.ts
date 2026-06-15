// CI-failure-triage synth recall ruler (SIG-433, parent SIG-424) — replays a SET
// of CI-failure archetypes through the REAL CI-triage synth pipeline and measures
// the grounded-inline CATCH rate, the hallucination rate, and — the SIG-433
// question — the lift from the deterministic anchor REMAP (OFF vs ON), plus the
// withhold-correctness on bugs that live OFF the diff.
//
//   OPENROUTER_API_KEY=sk-or-... npm run ci-triage-synth-eval
//   CI_SYNTH_RECALL_REPEATS=12 OPENROUTER_API_KEY=... npm run ci-triage-synth-eval
//
// WHY a SET, not one fixture (SIG-433 Part 1): a catch/withhold number measured on
// a single fixture is meaningless. Each fixture below is a self-consistent
// {failure log, PR diff, ground-truth bug location} for a distinct CI archetype —
// an assertion mismatch, a type error, a lint failure, a runtime throw — and
// CRUCIALLY a mix of bugs that land ON the diff (catchable → must be caught AND
// anchored to the changed cause line) and OFF the diff (flaky/infra → must be
// WITHHELD). Only that mix makes the catch % real and the withhold behavior
// measurable.
//
// WHAT THE REMAP DOES (SIG-431 measured the problem): the grounded synth diagnoses
// ~100% correctly with 0% hallucination, but anchors the finding to the line that
// WITNESSES the bug — the enclosing function header, a blank context line, the
// interface-field declaration, or the off-diff test assertion — instead of the
// changed SOURCE statement that PRODUCES it. Off-diff → correctly withheld (catch
// lost); poor-but-reviewable changed line → posts on the WRONG line (still not a
// catch). The deterministic remap (`remapCiFindingAnchor`, default OFF behind
// `OPENCLAW_CI_TRIAGE_ANCHOR_REMAP`) re-homes such a finding to the changed cause
// line. This eval runs each fixture through the EXACT same per-finding decision
// the run layer uses (`ci-triage-synth-run.ts`), with the remap toggled OFF then
// ON, so the before/after is a real A/B of production code — not a re-derivation.
//
// It makes REAL model calls, so it's gated on the synth model's key and SKIPS in
// normal CI (`npm run build`). It does NOT vi.mock the model; it runs the prod
// CI-synth system prompt + the FIXED chatEnabled through the same gate stack prod
// uses. None of the fixture PRs correspond to a live PR head — each is committed,
// self-consistent test data for its archetype.

import { describe, it, expect } from "vitest"
import { runSynthesizer, SYNTHESIZER_CONFIG } from "@/src/lib/ensemble/adapters/model-provider"
import { selectConfigApiKey } from "@/src/lib/ensemble/adapters/model-provider-routing"
import { prepareReviewSubmissionFindings } from "@/src/lib/ensemble/render/submission"
import { SYNTHESIZER_PROMPT } from "@/src/prompts/specialists/synthesizer"
import { CI_SYNTH_PREAMBLE } from "@/src/prompts/specialists/ci-synth"
import { parseDiffToReviewablePositions, deriveSide } from "@/src/shared/util/diff-positions"
import { buildAddedLineTextByLine } from "@/src/features/ast-rules/domain/diff-filter"
import {
  buildCiSynthUserMessage,
  disposeCiFinding,
  isCiTestPath,
  isLogGrounded,
  remapCiFindingAnchor,
  type CiFileContext,
} from "@/src/lib/ci-triage-synth"

// A real unified diff from GitHub gives every IN-HUNK context line a leading
// space — including blank lines (an unchanged blank line is ` `, a single space).
// The fixtures below are written with human-readable truly-empty blank lines, so
// normalize them to real-diff bytes before parsing: inside a hunk, a completely
// empty line is an unchanged blank line → prefix one space. (Without this the
// two diff parsers — `parseDiffToReviewablePositions` advances on empty lines,
// `buildAddedLineTextByLine` does not — disagree on line numbers by the count of
// blank context lines, which never happens on a real diff.) Lines OUTSIDE a hunk
// are left as-is.
function toRealDiff(diff: string): string {
  const lines = diff.split("\n")
  let inHunk = false
  return lines
    .map((line) => {
      if (line.startsWith("@@")) {
        inHunk = true
        return line
      }
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
        inHunk = false
        return line
      }
      if (inHunk && line.length === 0) return " "
      return line
    })
    .join("\n")
}

const PER_RUN_TIMEOUT_MS = 180_000
// The synth is non-deterministic run-to-run; repeat K times (default 1) for a
// stable catch rate. Re-baseline a change at K>=12 (CLAUDE.md ruler).
const REPEATS = (() => {
  const n = Number(process.env.CI_SYNTH_RECALL_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
// Optional model swap (CI_SYNTH_RECALL_MODEL) — A/B a different synth model.
const MODEL_OVERRIDE = process.env.CI_SYNTH_RECALL_MODEL?.trim()
const SYNTH_CONFIG = MODEL_OVERRIDE
  ? { ...SYNTHESIZER_CONFIG, primary: MODEL_OVERRIDE, fallback: null }
  : SYNTHESIZER_CONFIG
// SIG-406: select the key by the EFFECTIVE synth model's shape.
const API_KEY = selectConfigApiKey(SYNTH_CONFIG, {
  ollama: process.env.OLLAMA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
})
// The eval must EXERCISE the fixed kill-switch, so chat must be on for the call to fire.
const CHAT_ENABLED: "on" | "off" = (process.env.OLLAMA_CHAT_ENABLE ?? "on") === "on" ? "on" : "off"
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

// ── fixture model ────────────────────────────────────────────────────────────

interface CiFixture {
  /** Short archetype id, used in the report. */
  id: string
  /** One-line description of the CI failure shape. */
  about: string
  /** The PR's unified diff. */
  diff: string
  /** The failed-job log handed to the synth. */
  ciLog: string
  /** Current contents of the files the log names (the run pulls these). */
  fileContexts: CiFileContext[]
  /**
   * The ground truth. For an ON-diff bug: the changed SOURCE path + line that
   * PRODUCES the failure (catch = a grounded finding posts there ±window). For an
   * OFF-diff bug: `expectCatchable:false` — the correct behavior is to WITHHOLD
   * (post nothing inline), because the cause is not a changed line.
   */
  expectCatchable: boolean
  /** Required when expectCatchable: the buggy changed SOURCE path. */
  buggyPath?: string
  /** Required when expectCatchable: the buggy changed SOURCE line (new-side). */
  buggyLine?: number
  /** Tolerate ±this many lines on the catch anchor (brace/comment drift). */
  anchorWindow?: number
  /** Lower-cased substrings that, if quoted, are a hallucination for this fixture. */
  hallucinationTokens: string[]
  /** A real verbatim log span the grounding gate must corroborate (integrity guard). */
  groundedProbe: string
}

// ── fixture 1: assertion mismatch — the canonical #24 dedupeKey (ON diff) ─────
// `dedupeKey` omits `attemptKind`; the buggy changed line is `const dedupeKey =`
// at new-side 118. The log names ONLY the test assertion (tests/parse.test.ts:50);
// the model must trace the wrong value back to the changed source line.
const FX_DEDUPE: CiFixture = {
  id: "dedupeKey-assertion",
  about: "assertion mismatch; cause = a changed source assignment (ON diff)",
  diff: `diff --git a/src/parse/event.ts b/src/parse/event.ts
--- a/src/parse/event.ts
+++ b/src/parse/event.ts
@@ -107,18 +107,21 @@ export interface ParsedEvent {
   readonly attemptIndex: number
   readonly attemptKind: AttemptKind
   readonly payload: Record<string, unknown>
+  readonly dedupeKey: string
 }

 export function parseEvent(line: string): ParsedEvent {
   const raw = JSON.parse(line) as RawEvent
   const attemptIndex = Number(raw.attempt ?? 0)
   const attemptKind = normalizeKind(raw.kind)
+  // Build a stable key so a re-delivered event is dropped as a duplicate.
+  const dedupeKey = \`\${raw.runId}:\${attemptIndex}\`
   return {
     runId: String(raw.runId),
     attemptIndex,
     attemptKind,
     payload: raw.payload ?? {},
+    dedupeKey,
   }
 }

 export function dedupeEvents(events: readonly ParsedEvent[]): ParsedEvent[] {
   const seen = new Set<string>()
   const out: ParsedEvent[] = []
   for (const e of events) {
     if (seen.has(e.dedupeKey)) continue
     seen.add(e.dedupeKey)
     out.push(e)
   }
   return out
 }
diff --git a/tests/parse.test.ts b/tests/parse.test.ts
--- a/tests/parse.test.ts
+++ b/tests/parse.test.ts
@@ -40,6 +40,15 @@ describe("dedupeEvents", () => {
     expect(dedupeEvents(events)).toHaveLength(1)
   })

+  it("keeps distinct-kind events for the same attempt", () => {
+    const events = [
+      parseEvent('{"runId":"r1","attempt":0,"kind":"start","payload":{}}'),
+      parseEvent('{"runId":"r1","attempt":0,"kind":"end","payload":{}}'),
+    ]
+    expect(dedupeEvents(events)).toHaveLength(2)
+  })
+
   it("normalizes unknown kinds", () => {
     expect(parseEvent('{"runId":"r1","attempt":0,"kind":"???"}').attemptKind).toBe("unknown")
   })
`,
  ciLog: `=== job: test ===
$ vitest run
 ❯ tests/parse.test.ts (3 tests | 1 failed)
   ✓ dedupeEvents > drops a re-delivered event
   × dedupeEvents > keeps distinct-kind events for the same attempt
   ✓ parseEvent > normalizes unknown kinds

 FAIL  tests/parse.test.ts > dedupeEvents > keeps distinct-kind events for the same attempt
AssertionError: expected [ { runId: 'r1', attemptIndex: 0, … } ] to have a length of 2 but got 1

- Expected
+ Received

- 2
+ 1

 ❯ tests/parse.test.ts:50:38
     48|       parseEvent('{"runId":"r1","attempt":0,"kind":"end","payload":{}}'),
     49|     ]
     50|     expect(dedupeEvents(events)).toHaveLength(2)
       |                                      ^
     51|   })

 Test Files  1 failed
      Tests  1 failed | 2 passed
`,
  fileContexts: [
    {
      path: "tests/parse.test.ts",
      content: `import { describe, it, expect } from "vitest"
import { parseEvent, dedupeEvents } from "../src/parse/event"

describe("dedupeEvents", () => {
  it("drops a re-delivered event", () => {
    const events = [
      parseEvent('{"runId":"r1","attempt":0,"kind":"start","payload":{}}'),
      parseEvent('{"runId":"r1","attempt":0,"kind":"start","payload":{}}'),
    ]
    expect(dedupeEvents(events)).toHaveLength(1)
  })

  it("keeps distinct-kind events for the same attempt", () => {
    const events = [
      parseEvent('{"runId":"r1","attempt":0,"kind":"start","payload":{}}'),
      parseEvent('{"runId":"r1","attempt":0,"kind":"end","payload":{}}'),
    ]
    expect(dedupeEvents(events)).toHaveLength(2)
  })

  it("normalizes unknown kinds", () => {
    expect(parseEvent('{"runId":"r1","attempt":0,"kind":"???"}').attemptKind).toBe("unknown")
  })
})
`,
    },
  ],
  expectCatchable: true,
  buggyPath: "src/parse/event.ts",
  buggyLine: 118,
  anchorWindow: 2,
  hallucinationTokens: ["syntax error", "ndjson", "json.parse", "malformed json"],
  groundedProbe: "expected [",
}

// ── fixture 2: TYPE ERROR (tsc TS2345) — cause = a changed source line (ON diff)
// A new helper passes a `string` where a `number` is required. tsc names the file
// + line of the OFFENDING source line directly. The model still tends to anchor
// the function header / the call target; the cause is the `const totalCents =`
// line that builds the wrong-typed value.
const FX_TYPE: CiFixture = {
  id: "type-error-ts2345",
  about: "tsc TS2345 type error; cause = a changed source assignment (ON diff)",
  diff: `diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -18,10 +18,14 @@ export interface LineItem {
   readonly quantity: number
 }

 export function invoiceTotal(items: readonly LineItem[]): number {
-  return items.reduce((sum, it) => sum + it.unitCents * it.quantity, 0)
+  const totalCents = items.reduce((sum, it) => sum + it.unitCents * it.quantity, 0)
+  return formatCents(totalCents)
 }
+
+export function formatCents(cents: number): string {
+  return \`\${(cents / 100).toFixed(2)}\`
+}
`,
  ciLog: `=== job: typecheck ===
$ tsc --noEmit
src/billing/invoice.ts:23:10 - error TS2322: Type 'string' is not assignable to type 'number'.

23   return formatCents(totalCents)
            ~~~~~~~~~~~~~~~~~~~~~~~~

Found 1 error in src/billing/invoice.ts:23
`,
  fileContexts: [
    {
      path: "src/billing/invoice.ts",
      content: `export interface LineItem {
  readonly unitCents: number
  readonly quantity: number
}

export function invoiceTotal(items: readonly LineItem[]): number {
  const totalCents = items.reduce((sum, it) => sum + it.unitCents * it.quantity, 0)
  return formatCents(totalCents)
}

export function formatCents(cents: number): string {
  return \`\${(cents / 100).toFixed(2)}\`
}
`,
    },
  ],
  expectCatchable: true,
  // The cause line is the changed `return formatCents(totalCents)` at new-side 23
  // (the return that yields a string from a number-typed function). The changed
  // `const totalCents =` (22) and `formatCents` body (27) are within the window.
  buggyPath: "src/billing/invoice.ts",
  buggyLine: 23,
  anchorWindow: 4,
  hallucinationTokens: ["null", "undefined is not", "cannot read prop"],
  groundedProbe: "is not assignable to type 'number'",
}

// ── fixture 3: LINT failure (no-floating-promises) — cause on a changed line (ON)
// A changed line introduces a floating promise. ESLint names the exact file:line.
// This fixture is the "clean" control: the cause line IS what the log names, so a
// correct anchor needs no remap — it asserts the remap does NOT break an
// already-correctly-anchored case (and stays caught both OFF and ON).
const FX_LINT: CiFixture = {
  id: "lint-floating-promise",
  about: "eslint no-floating-promises; cause = the exact changed line (ON diff)",
  diff: `diff --git a/src/queue/enqueue.ts b/src/queue/enqueue.ts
--- a/src/queue/enqueue.ts
+++ b/src/queue/enqueue.ts
@@ -30,7 +30,9 @@ export async function handleJob(job: Job, q: Queue): Promise<void> {
   const parsed = parseJob(job)
   if (!parsed.ok) return
-  await q.publish(parsed.value)
+  // fire-and-forget the retry; the publish itself is awaited above
+  q.publishRetry(parsed.value)
+  metrics.increment("job.handled")
 }
`,
  ciLog: `=== job: lint ===
$ eslint .

/repo/src/queue/enqueue.ts
  33:3  error  Promises must be awaited, end with a call to .catch, or be explicitly marked as ignored with the \`void\` operator  @typescript-eslint/no-floating-promises

✖ 1 problem (1 error, 0 warnings)
`,
  fileContexts: [
    {
      path: "src/queue/enqueue.ts",
      content: `import { metrics } from "../obs/metrics"

export async function handleJob(job: Job, q: Queue): Promise<void> {
  const parsed = parseJob(job)
  if (!parsed.ok) return
  // fire-and-forget the retry; the publish itself is awaited above
  q.publishRetry(parsed.value)
  metrics.increment("job.handled")
}
`,
    },
  ],
  expectCatchable: true,
  // The floating-promise line `q.publishRetry(parsed.value)` is new-side 33.
  buggyPath: "src/queue/enqueue.ts",
  buggyLine: 33,
  anchorWindow: 1,
  hallucinationTokens: ["unhandled rejection at", "syntaxerror"],
  groundedProbe: "no-floating-promises",
}

// ── fixture 4: RUNTIME throw in changed source (ON diff) ───────────────────────
// A changed line dereferences a possibly-undefined value at runtime; the stack
// frame names the changed source file:line directly. Cause = the changed
// `.toUpperCase()` deref line.
const FX_RUNTIME: CiFixture = {
  id: "runtime-throw",
  about: "runtime TypeError with a stack frame into changed source (ON diff)",
  diff: `diff --git a/src/format/name.ts b/src/format/name.ts
--- a/src/format/name.ts
+++ b/src/format/name.ts
@@ -4,6 +4,8 @@ export interface User {
   readonly middle?: string
 }

 export function initials(u: User): string {
-  return u.first[0] + u.last[0]
+  const mid = u.middle.toUpperCase()
+  return u.first[0] + mid[0] + u.last[0]
 }
`,
  ciLog: `=== job: test ===
$ vitest run
 FAIL  tests/name.test.ts > initials > handles a user with no middle name
TypeError: Cannot read properties of undefined (reading 'toUpperCase')
 ❯ src/format/name.ts:8:24
 ❯ tests/name.test.ts:11:18

 Test Files  1 failed
      Tests  1 failed
`,
  fileContexts: [
    {
      path: "src/format/name.ts",
      content: `export interface User {
  readonly first: string
  readonly last: string
  readonly middle?: string
}

export function initials(u: User): string {
  const mid = u.middle.toUpperCase()
  return u.first[0] + mid[0] + u.last[0]
}
`,
    },
  ],
  expectCatchable: true,
  // The deref `const mid = u.middle.toUpperCase()` is new-side 8.
  buggyPath: "src/format/name.ts",
  buggyLine: 8,
  anchorWindow: 1,
  hallucinationTokens: ["null pointer", "segfault", "stack overflow"],
  groundedProbe: "Cannot read properties of undefined",
}

// ── fixture 5: FLAKY / INFRA failure — OFF diff (must WITHHOLD) ────────────────
// The failed step is a network flake in a file this PR did NOT touch (the PR only
// changed README). There is NO changed source line that causes it, so the correct
// behavior is to WITHHOLD: post nothing inline. This measures withhold-correctness
// — a remap that fabricated an anchor here would post a wrong inline comment.
const FX_FLAKY: CiFixture = {
  id: "flaky-infra-offdiff",
  about: "network-flake in an untouched file; NO changed cause line (OFF diff → withhold)",
  diff: `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # widget-svc

+A service for widgets.
 Run \`npm test\` to test.
`,
  ciLog: `=== job: integration ===
$ vitest run tests/integration
 FAIL  tests/integration/payments.int.test.ts > charges a card
FetchError: request to https://api.payments.example/charge failed, reason: ETIMEDOUT
 ❯ src/payments/gateway.ts:142:18
 ❯ tests/integration/payments.int.test.ts:64:20

 Test Files  1 failed
      Tests  1 failed
`,
  fileContexts: [],
  expectCatchable: false,
  hallucinationTokens: ["readme", "documentation is wrong"],
  groundedProbe: "ETIMEDOUT",
}

// Normalize every fixture diff to real-diff bytes (leading space on blank context
// lines) so both diff parsers agree on line numbers, exactly as on a live diff.
const FIXTURES: CiFixture[] = [FX_DEDUPE, FX_TYPE, FX_LINT, FX_RUNTIME, FX_FLAKY].map((fx) => ({
  ...fx,
  diff: toRealDiff(fx.diff),
}))

// ── the per-finding decision, mirroring ci-triage-synth-run.ts EXACTLY ─────────
// This replays the production loop (prepareReviewSubmissionFindings → optional
// remap → grounding/anchor → disposeCiFinding) with the remap toggled, so OFF vs
// ON is a true A/B of the real code path, not a re-derivation.

interface FixtureOutcome {
  errored: boolean
  /** A grounded finding that WOULD post inline, anchored to the buggy cause line. */
  caught: boolean
  /** Any emitted finding inventing this fixture's red herring. */
  hallucinated: boolean
  /** For an OFF-diff fixture: did the pass correctly post NOTHING inline? */
  withheldCorrectly: boolean
  /** Number of findings that would post inline (the inline surface). */
  postedInline: number
}

async function runFixtureOnce(fx: CiFixture, apiKey: string, remapEnabled: boolean): Promise<FixtureOutcome> {
  const reviewable = parseDiffToReviewablePositions(fx.diff)
  const addedLineTextByPath = remapEnabled ? buildAddedLineTextByLine(fx.diff) : undefined
  const userMessage = buildCiSynthUserMessage({ ciLog: fx.ciLog, diff: fx.diff, fileContexts: fx.fileContexts })
  let output: Awaited<ReturnType<typeof runSynthesizer>>
  try {
    output = await runSynthesizer({
      apiKey,
      systemPrompt: CI_SYNTH_PREAMBLE + SYNTHESIZER_PROMPT,
      userMessage,
      chatEnabled: CHAT_ENABLED,
      signal: AbortSignal.timeout(PER_RUN_TIMEOUT_MS),
      perfCtx: { owner: "eval", repo: "eval", prNumber: 1, headSha: "0".repeat(40) },
      provenanceSources: [],
      ...(MODEL_OVERRIDE ? { configOverride: SYNTH_CONFIG } : {}),
    })
  } catch (e) {
    console.log(`  [${fx.id}] run ERROR: ${e instanceof Error ? e.message : String(e)}`)
    return { errored: true, caught: false, hallucinated: false, withheldCorrectly: false, postedInline: 0 }
  }

  const verdict = output.verdict
  if (verdict == null) {
    console.log(`  [${fx.id}] verdict=null failureReason=${output.failureReason ?? "n/a"}`)
    // An OFF-diff fixture that produces nothing is a correct withhold.
    return {
      errored: false,
      caught: false,
      hallucinated: false,
      withheldCorrectly: !fx.expectCatchable,
      postedInline: 0,
    }
  }

  const prepared = prepareReviewSubmissionFindings({
    rawVerdict: verdict,
    rawUnanchored: [],
    headSha: "0".repeat(40),
    reviewable,
  })

  // Hallucination = ANY emitted finding inventing this fixture's red herring.
  const hallucinated = verdict.findings.some((f) => {
    const hay = `${f.headline ?? ""} ${f.body ?? ""} ${f.logExcerpt ?? ""}`.toLowerCase()
    return fx.hallucinationTokens.some((tok) => hay.includes(tok))
  })

  let caught = false
  let postedInline = 0
  for (const original of prepared.inlineFindings) {
    let finding = original
    const logGrounded = isLogGrounded(finding.logExcerpt ?? "", fx.ciLog)
    // The EXACT remap call the run layer makes.
    if (remapEnabled && addedLineTextByPath && logGrounded) {
      const currentlyAnchored = deriveSide(reviewable, finding.path, finding.line) === "RIGHT"
      const remap = remapCiFindingAnchor({
        path: finding.path,
        line: finding.line,
        headline: finding.headline,
        body: finding.body,
        currentlyAnchored,
        addedLineTextByPath,
        isTestPath: isCiTestPath,
      })
      if (remap && deriveSide(reviewable, remap.path, remap.line) === "RIGHT") {
        finding = { ...finding, path: remap.path, line: remap.line }
      }
    }
    const anchored = deriveSide(reviewable, finding.path, finding.line) === "RIGHT"
    const logCorroborated = anchored && logGrounded
    const disposition = disposeCiFinding({ anchored, logCorroborated, hardWithholdUncorroborated: false })
    const wouldPost = disposition === "inline-clean" || disposition === "inline-hedged"
    if (wouldPost) postedInline += 1
    if (fx.expectCatchable && wouldPost && logCorroborated) {
      const onBuggy =
        finding.path === fx.buggyPath && Math.abs(finding.line - (fx.buggyLine ?? -999)) <= (fx.anchorWindow ?? 2)
      if (onBuggy) caught = true
    }
  }

  const withheldCorrectly = !fx.expectCatchable && postedInline === 0
  const tag = fx.expectCatchable ? (caught ? "✓ CAUGHT" : "✗ missed") : withheldCorrectly ? "✓ WITHHELD" : "✗ POSTED!"
  console.log(
    `  [${fx.id}] ${tag}${hallucinated ? " · ⚠ HALLUCINATED" : ""} · ${postedInline} inline · ${output.modelUsed} · ${output.elapsedMs}ms`,
  )
  if ((fx.expectCatchable && !caught) || (!fx.expectCatchable && !withheldCorrectly)) {
    for (const f of prepared.inlineFindings) {
      console.log(`      ↳ ${f.path}:${f.line} — ${f.headline ?? ""}`)
    }
  }
  return { errored: false, caught, hallucinated, withheldCorrectly, postedInline }
}

// ── fixture-integrity guards — run in normal CI (no key, no model) ─────────────
describe("CI-triage fixture integrity (no model)", () => {
  for (const fx of FIXTURES) {
    it(`[${fx.id}] is self-consistent (anchor reviewable iff catchable; probe grounded; no red herring)`, () => {
      const reviewable = parseDiffToReviewablePositions(fx.diff)
      // The grounding probe must corroborate against the fixture's own log.
      expect(isLogGrounded(fx.groundedProbe, fx.ciLog)).toBe(true)
      // The red-herring tokens must NOT be in the log (else a quote isn't a hallucination).
      for (const tok of fx.hallucinationTokens) expect(fx.ciLog.toLowerCase()).not.toContain(tok)
      if (fx.expectCatchable) {
        // The buggy line must be a real RIGHT-reviewable changed line (±window).
        const w = fx.anchorWindow ?? 2
        const anchorable = Array.from({ length: 2 * w + 1 }, (_, i) => (fx.buggyLine as number) - w + i).some(
          (l) => deriveSide(reviewable, fx.buggyPath as string, l) === "RIGHT",
        )
        expect(anchorable).toBe(true)
        // And the asserted buggy line is an ADDED (`+`) line (the cause a fix edits).
        const added = buildAddedLineTextByLine(fx.diff)
        expect(added.get(fx.buggyPath as string)?.has(fx.buggyLine as number)).toBe(true)
      } else {
        // An OFF-diff fixture must NOT have the failing source file in its diff.
        const failFile = /❯ (src\/[^\s:]+):/.exec(fx.ciLog)?.[1]
        expect(failFile).toBeTruthy()
        expect([...reviewable.keys()]).not.toContain(failFile as string)
      }
    })
  }

  it("the dedupeKey cause line (118) is the `const dedupeKey =` construction", () => {
    const fx = FIXTURES.find((f) => f.id === "dedupeKey-assertion")!
    const added = buildAddedLineTextByLine(fx.diff)
    expect(added.get("src/parse/event.ts")?.get(118)).toContain("const dedupeKey =")
  })
})

// ── the LIVE recall ruler — OFF vs ON across the fixture set ────────────────────
describe.skipIf(!API_KEY)(
  "CI-triage synth recall (LIVE — needs OPENROUTER_API_KEY or OLLAMA_API_KEY, K-repeated)",
  () => {
    it(
      "remap OFF vs ON: catch lift on ON-diff bugs, withhold-correctness on OFF-diff bugs, hallucination ~0",
      async () => {
        interface Agg {
          runs: number
          errors: number
          caught: number
          hallucinated: number
          withheldCorrectly: number
        }
        const mk = (): Agg => ({ runs: 0, errors: 0, caught: 0, hallucinated: 0, withheldCorrectly: 0 })
        // per fixture id → { off, on }
        const acc = new Map<string, { off: Agg; on: Agg }>()
        for (const fx of FIXTURES) acc.set(fx.id, { off: mk(), on: mk() })

        for (let k = 0; k < REPEATS; k++) {
          for (const fx of FIXTURES) {
            const bucket = acc.get(fx.id)!
            // Run OFF then ON back-to-back per fixture per repeat (sequential —
            // don't hammer the model). Both calls hit the SAME prompt; only the
            // post-hoc remap differs, so the model's diagnosis variance is shared.
            for (const [mode, agg] of [
              ["off", bucket.off],
              ["on", bucket.on],
            ] as const) {
              const r = await runFixtureOnce(fx, API_KEY as string, mode === "on")
              if (r.errored) {
                agg.errors += 1
                continue
              }
              agg.runs += 1
              if (r.caught) agg.caught += 1
              if (r.hallucinated) agg.hallucinated += 1
              if (r.withheldCorrectly) agg.withheldCorrectly += 1
            }
          }
        }

        // Report.
        const lines: string[] = [
          "",
          `┌─ CI-TRIAGE SYNTH RECALL · model=${SYNTH_CONFIG.primary} · ${REPEATS}× · remap OFF→ON ─┐`,
        ]
        let onDiff = 0
        let catchOffSum = 0
        let catchOnSum = 0
        for (const fx of FIXTURES) {
          const { off, on } = acc.get(fx.id)!
          if (fx.expectCatchable) {
            onDiff += 1
            const cOff = off.runs ? off.caught / off.runs : 0
            const cOn = on.runs ? on.caught / on.runs : 0
            catchOffSum += cOff
            catchOnSum += cOn
            lines.push(
              `[${fx.id}] (ON-diff) catch ${pct(cOff)}→${pct(cOn)} (${off.caught}/${off.runs}→${on.caught}/${on.runs}) · halluc ${on.hallucinated}/${on.runs}`,
            )
          } else {
            const wOff = off.runs ? off.withheldCorrectly / off.runs : 0
            const wOn = on.runs ? on.withheldCorrectly / on.runs : 0
            lines.push(
              `[${fx.id}] (OFF-diff) withhold-correct ${pct(wOff)}→${pct(wOn)} (${off.withheldCorrectly}/${off.runs}→${on.withheldCorrectly}/${on.runs}) · halluc ${on.hallucinated}/${on.runs}`,
            )
          }
        }
        const aggCatchOff = onDiff ? catchOffSum / onDiff : 0
        const aggCatchOn = onDiff ? catchOnSum / onDiff : 0
        const totalHallucOn = [...acc.values()].reduce((s, b) => s + b.on.hallucinated, 0)
        lines.push(
          `─ AGGREGATE (ON-diff fixtures): catch ${pct(aggCatchOff)} → ${pct(aggCatchOn)} · total hallucination (ON) ${totalHallucOn}`,
        )
        lines.push(`target: catch lift toward 70%, hallucination ~0, withhold-correct 100% on OFF-diff`)
        lines.push("└────────────────────────────────────────────────────────────────┘")
        console.log(lines.join("\n"))

        // Assertions the eval enforces (recall-safety, not a hard catch threshold —
        // the catch % is reported honestly, never widened to hit a number):
        //   1. the remap NEVER raises hallucination above the OFF baseline.
        const totalHallucOff = [...acc.values()].reduce((s, b) => s + b.off.hallucinated, 0)
        expect(totalHallucOn).toBeLessThanOrEqual(totalHallucOff)
        //   2. the remap NEVER lowers aggregate catch below OFF (it only re-homes).
        expect(aggCatchOn).toBeGreaterThanOrEqual(aggCatchOff - 1e-9)
        //   3. OFF-diff withhold-correctness is not harmed by the remap.
        for (const fx of FIXTURES) {
          if (fx.expectCatchable) continue
          const { off, on } = acc.get(fx.id)!
          expect(on.withheldCorrectly).toBeGreaterThanOrEqual(off.withheldCorrectly)
        }
      },
      // OFF+ON per fixture per repeat.
      REPEATS * FIXTURES.length * 2 * PER_RUN_TIMEOUT_MS + 120_000,
    )
  },
)
