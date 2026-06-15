// Inline-comment anchor-EXACTNESS ruler (SIG-436, parent SIG-245) — replays a SET
// of seeded-bug PR diffs through the REAL PR-review synthesizer + the PROD inline
// submission path (`prepareReviewSubmissionFindings`) and measures, per published
// inline comment, whether it lands on the EXACT intended bug line — with the
// deterministic anchor-precision pass toggled OFF then ON.
//
//   OPENROUTER_API_KEY=sk-or-... npm run anchor-exactness-eval
//   ANCHOR_EXACTNESS_REPEATS=12 OPENROUTER_API_KEY=... npm run anchor-exactness-eval
//
// THE BUG (founder-observed, run-to-run inconsistent): published inline comments
// don't consistently land on the exact intended line. The signature failure is a
// finding anchoring to the `// comment` line directly ABOVE the buggy statement
// (the comment describes the bug; the bug is the next line). Root cause: the
// submission substantive-anchor forward-walk (`pickSubstantiveAnchorLineForward`)
// treats a whole-line comment as "substantive" (`isSubstantiveAnchorLine` only
// rejects whitespace/structural punctuation), so it STOPS on the comment instead
// of walking to the code line below it. The deterministic anchor-precision pass
// (default OFF behind `OPENCLAW_ANCHOR_PRECISION`) makes a whole-line comment
// non-substantive, so the SAME walk lands on the bug.
//
// WHY a SET, not one fixture (CLAUDE.md ruler): an exactness number on a single
// fixture is meaningless. Each fixture below is a self-consistent {PR diff,
// seeded bug, KNOWN exact anchor line, specialist verdict that flags it} for a
// distinct anchoring archetype — comment-directly-above-bug (the repro), bug
// mid-function, bug after a blank line, a multi-line construct, a JSDoc block
// above the bug, and a comment-is-the-only-nearby-line recall-safety case.
//
// This runs the EXACT per-finding submission decision prod uses
// (`prepareReviewSubmissionFindings` with the same `reviewable` +
// `addedLineTextByLine` the orchestrator builds), with `anchorPrecision` toggled
// OFF then ON, so the before/after is a real A/B of production code — not a
// re-derivation. It makes REAL model calls (it does NOT vi.mock the model), so
// it's gated on the synth model's key and SKIPS in normal CI (`npm run build`).
// None of the fixture PRs correspond to a live PR head — each is committed,
// self-consistent test data for its archetype.
//
// The SUGGESTION (structured-fix) re-home path — a committable ```suggestion the
// model anchored to a comment, re-homed by `rehomeSuggestionAnchorForward` — is
// covered DETERMINISTICALLY in `triage-pr-review.anchor-render.test.ts` (it runs
// in `npm run build`), not here: whether the live synth emits a `suggestedReplacement`
// is model-dependent, so a live suggestion fixture would be flaky. This live ruler
// measures the dominant comment-above-bug signature end-to-end.

import { describe, it, expect } from "vitest"
import {
  runSynthesizer,
  SYNTHESIZER_CONFIG,
  SYNTHESIZER_TIMEOUT_MS,
  selectConfigApiKey,
} from "@/src/lib/triage-pr-review-ensemble"
import {
  SYNTHESIZER_PROMPT,
  buildSynthesizerInitialMessage,
  renderSpecialistVerdictsForSynth,
} from "@/src/prompts/pr-review-specialists"
import { prepareReviewSubmissionFindings } from "@/src/lib/ensemble/render/submission"
import { parseDiffToReviewablePositions, deriveSide } from "@/src/shared/util/diff-positions"
import { buildAddedLineTextByLine } from "@/src/features/ast-rules/domain/diff-filter"
import type { PrReviewFinding, PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import type { SpecialistRole } from "@/src/lib/ensemble-router"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"

// A real unified diff from GitHub gives every IN-HUNK context line a leading
// space — including blank lines (an unchanged blank line is ` `, a single space).
// The fixtures below are written with human-readable truly-empty blank lines, so
// normalize them to real-diff bytes before parsing: inside a hunk, a completely
// empty line is an unchanged blank line → prefix one space. Without this the two
// diff parsers disagree on line numbers by the count of blank context lines
// (`parseDiffToReviewablePositions` advances on empty lines, `buildAddedLineTextByLine`
// does not), which never happens on a real diff. (Mirrors the SIG-433 eval helper.)
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

const PER_RUN_TIMEOUT_MS = SYNTHESIZER_TIMEOUT_MS + 30_000
// The synth is non-deterministic run-to-run; repeat K times (default 1) for a
// stable exactness rate. Re-baseline a change at K>=12 (CLAUDE.md ruler).
const REPEATS = (() => {
  const n = Number(process.env.ANCHOR_EXACTNESS_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
// Optional model swap (ANCHOR_EXACTNESS_MODEL) — A/B a different synth model.
const MODEL_OVERRIDE = process.env.ANCHOR_EXACTNESS_MODEL?.trim()
const SYNTH_CONFIG = MODEL_OVERRIDE
  ? { ...SYNTHESIZER_CONFIG, primary: MODEL_OVERRIDE, fallback: null }
  : SYNTHESIZER_CONFIG
// SIG-406: select the key by the EFFECTIVE synth model's shape — an OpenRouter id
// (the prod default) → OPENROUTER_API_KEY; a `:cloud` override → OLLAMA_API_KEY.
const API_KEY = selectConfigApiKey(SYNTH_CONFIG, {
  ollama: process.env.OLLAMA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
})
const CHAT_ENABLED: "on" | "off" = (process.env.OLLAMA_CHAT_ENABLE ?? "on") === "on" ? "on" : "off"
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

const PERF_CTX: EnsembleRunCtx = { owner: "eval", repo: "eval", prNumber: 0, headSha: "0".repeat(40) }
const HEAD_SHA = "0".repeat(40)

// ── fixture model ────────────────────────────────────────────────────────────

interface SpecialistSourceVerdict {
  role: SpecialistRole
  verdict: Omit<PrReviewVerdict, "findings"> & { findings: Array<PrReviewFinding & { id: string }> }
}

interface AnchorFixture {
  /** Short archetype id, used in the report. */
  id: string
  /** One-line description of the anchoring archetype. */
  about: string
  /** The PR's unified diff. */
  diff: string
  /** The specialist verdict(s) that flag the seeded bug (drives the synth). */
  specialistVerdicts: SpecialistSourceVerdict[]
  /** The buggy changed SOURCE path the inline comment must anchor to. */
  buggyPath: string
  /** The EXACT buggy changed SOURCE line (new-side) — exactness = lands here. */
  buggyLine: number
  /**
   * The WRONG line the model tends to anchor to (the comment/header above the
   * bug). An inline comment here is an off-by-N miss the precision pass fixes.
   */
  decoyLine: number
}

const v = (
  role: SpecialistRole,
  findings: Array<PrReviewFinding & { id: string }>,
  summary: string,
): SpecialistSourceVerdict => ({
  role,
  verdict: { summary, confidence: 4, confidenceReason: "Source verdict for the anchor-exactness eval.", findings },
})

// ── fixture 1: comment DIRECTLY above the bug — THE REPRODUCTION ───────────────
const FX_COMMENT_ABOVE: AnchorFixture = {
  id: "comment-above-bug",
  about: "the model anchors to the `// comment` line directly above the buggy statement",
  diff: `diff --git a/src/parse/event.ts b/src/parse/event.ts
--- a/src/parse/event.ts
+++ b/src/parse/event.ts
@@ -107,12 +107,16 @@ export function parseEvent(line: string): ParsedEvent {
   const raw = JSON.parse(line) as RawEvent
   const attemptIndex = Number(raw.attempt ?? 0)
   const attemptKind = normalizeKind(raw.kind)
+  // Build a stable key so a re-delivered event is dropped as a duplicate.
+  const dedupeKey = \`\${raw.runId}:\${attemptIndex}\`
   return {
     runId: String(raw.runId),
     attemptIndex,
     attemptKind,
+    dedupeKey,
   }
 }
`,
  buggyPath: "src/parse/event.ts",
  buggyLine: 111, // the `const dedupeKey =` line
  decoyLine: 110, // the `// Build a stable key…` comment above it
  specialistVerdicts: [
    v(
      "logic",
      [
        {
          id: "logic-0",
          path: "src/parse/event.ts",
          line: 110, // the model anchors to the comment line above the bug
          score: 4,
          category: "logic",
          scope: "line",
          headline: "`dedupeKey` omits `attemptKind`, collapsing distinct events",
          body: "The dedupe key is `${raw.runId}:${attemptIndex}` — it leaves out `attemptKind`, so two distinct-kind events with the same runId+attempt are wrongly dropped as duplicates downstream.",
        },
      ],
      "Dedupe key omits attemptKind.",
    ),
  ],
}

// ── fixture 2: bug mid-function (no comment) ───────────────────────────────────
const FX_MID_FUNCTION: AnchorFixture = {
  id: "bug-mid-function",
  about: "bug is a plain statement in the middle of a changed block",
  diff: `diff --git a/src/checkout.ts b/src/checkout.ts
--- a/src/checkout.ts
+++ b/src/checkout.ts
@@ -20,9 +20,14 @@ export async function checkout(cart: Cart, token: string) {
   const order = await createOrder(cart)
   const total = computeTotal(cart)
   const discounted = applyDiscount(total, cart.coupon)
+  const tax = total * cart.region.taxRate
+  const grandTotal = discounted + tax
+  await charge(order, grandTotal)
+  await reserveInventory(cart)
   await markTokenSeen(token)
   return order
 }
`,
  buggyPath: "src/checkout.ts",
  buggyLine: 24, // `const grandTotal = discounted + tax` — tax added to the DISCOUNTED price
  decoyLine: 23, // `const tax = total * cart.region.taxRate`
  specialistVerdicts: [
    v(
      "logic",
      [
        {
          id: "logic-0",
          path: "src/checkout.ts",
          line: 24,
          score: 4,
          category: "logic",
          scope: "line",
          headline: "tax is added to the discounted subtotal, undercharging",
          body: "`grandTotal = discounted + tax` adds tax computed from the FULL `total` onto the discounted price; if tax should be on the discounted amount this double-counts the discount and undercharges. Confirm the intended tax base.",
        },
      ],
      "Tax base mismatch in grandTotal.",
    ),
  ],
}

// ── fixture 3: bug on the line after a BLANK line ──────────────────────────────
const FX_AFTER_BLANK: AnchorFixture = {
  id: "bug-after-blank",
  about: "a blank line separates the changed block from the buggy statement",
  diff: `diff --git a/src/auth/session.ts b/src/auth/session.ts
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -30,8 +30,13 @@ export function createSession(user: User): Session {
   const now = Date.now()
   const id = randomId()
+  const ttlMs = user.isAdmin ? ADMIN_TTL : USER_TTL
+
+  const expiresAt = now - ttlMs
   return {
     id,
     userId: user.id,
+    expiresAt,
   }
 }
`,
  buggyPath: "src/auth/session.ts",
  buggyLine: 34, // `const expiresAt = now - ttlMs` — SUBTRACTS ttl (already expired)
  decoyLine: 33, // the blank line between the block and the buggy statement
  specialistVerdicts: [
    v(
      "logic",
      [
        {
          id: "logic-0",
          path: "src/auth/session.ts",
          line: 33, // anchored to the blank line above the bug
          score: 5,
          category: "logic",
          scope: "line",
          headline: "`expiresAt` subtracts the TTL, so every session is already expired",
          body: "`expiresAt = now - ttlMs` subtracts the TTL from the current time; it should ADD it (`now + ttlMs`). As written every created session is immediately in the past and treated as expired.",
        },
      ],
      "Session expiry uses subtraction.",
    ),
  ],
}

// ── fixture 4: a MULTI-LINE construct (range) ──────────────────────────────────
const FX_MULTILINE: AnchorFixture = {
  id: "multiline-construct",
  about: "the buggy logic spans a multi-line object/call the model anchors loosely",
  diff: `diff --git a/src/api/retry.ts b/src/api/retry.ts
--- a/src/api/retry.ts
+++ b/src/api/retry.ts
@@ -12,8 +12,16 @@ export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
   let attempt = 0
   while (true) {
     try {
       return await fn()
     } catch (err) {
+      attempt++
+      if (attempt > MAX_RETRIES) throw err
+      const backoff = BASE_DELAY * attempt
+      await sleep(backoff)
       continue
     }
   }
 }
`,
  buggyPath: "src/api/retry.ts",
  buggyLine: 19, // `const backoff = BASE_DELAY * attempt` — linear, not exponential
  decoyLine: 17, // `attempt++` (the changed block's first line)
  specialistVerdicts: [
    v(
      "performance",
      [
        {
          id: "performance-0",
          path: "src/api/retry.ts",
          line: 17,
          score: 3,
          category: "performance",
          scope: "line",
          headline: "backoff is linear, not exponential",
          body: "`backoff = BASE_DELAY * attempt` grows linearly; an exponential backoff (`BASE_DELAY * 2 ** attempt`) is the usual intent to avoid hammering a struggling dependency under load.",
        },
      ],
      "Linear backoff under retry.",
    ),
  ],
}

// ── fixture 5: a JSDoc / block comment directly above the buggy statement ───────
const FX_JSDOC_ABOVE: AnchorFixture = {
  id: "jsdoc-above-bug",
  about: "a multi-line block comment sits directly above the buggy assignment",
  diff: `diff --git a/src/util/cache.ts b/src/util/cache.ts
--- a/src/util/cache.ts
+++ b/src/util/cache.ts
@@ -40,8 +40,15 @@ export function buildCache<V>(opts: CacheOpts): CacheState<V> {
   const store = new Map<string, V>()
   const order: string[] = []
+  /*
+   * The capacity guard: trim from the FRONT when we exceed the limit.
+   * (Off-by-one note: compare strictly so we keep exactly max items.)
+   */
+  const capacity = opts.max + 1
   return {
     store,
     order,
+    capacity,
   }
 }
`,
  buggyPath: "src/util/cache.ts",
  buggyLine: 46, // `const capacity = opts.max + 1` — off-by-one (should be opts.max)
  decoyLine: 42, // the block-comment `/*` opening line above the assignment
  specialistVerdicts: [
    v(
      "logic",
      [
        {
          id: "logic-0",
          path: "src/util/cache.ts",
          line: 42, // anchored to the block-comment above the bug
          score: 4,
          category: "logic",
          scope: "line",
          headline: "`capacity` is off by one (`opts.max + 1`)",
          body: "`capacity = opts.max + 1` lets the cache hold one more than the configured `max`; the comment even says to keep exactly `max` items, so this should be `opts.max`.",
        },
      ],
      "Capacity off-by-one.",
    ),
  ],
}

// ── fixture 6: comment is the ONLY nearby added line — RECALL-SAFETY ────────────
// The buggy logic the finding describes is on a CONTEXT line (not a `+`-line),
// and the only added line near the model's anchor is a comment. The precision
// pass must NOT anchor onto the comment (wrong) and must NOT drop the finding —
// it body-demotes (surfaced). `buggyLine`/`decoyLine` are set so an inline that
// lands on the comment counts as a wrong-line; an exact catch is not expected.
const FX_RECALL_SAFE: AnchorFixture = {
  id: "comment-only-recall-safe",
  about: "comment is the only added line near the anchor — must body-demote, never wrong-anchor",
  diff: `diff --git a/src/util/note.ts b/src/util/note.ts
--- a/src/util/note.ts
+++ b/src/util/note.ts
@@ -5,6 +5,8 @@ export function summarize(items: Item[]): string {
   const head = items[0]
   const rest = items.slice(1)
+  // NOTE: this assumes items is non-empty; callers must guard.
+
   return head.label + rest.map((r) => r.label).join(", ")
 }
`,
  buggyPath: "src/util/note.ts",
  buggyLine: 9, // the `return head.label …` is a CONTEXT line (not added) — not anchorable
  decoyLine: 7, // the added `// NOTE:` comment
  specialistVerdicts: [
    v(
      "logic",
      [
        {
          id: "logic-0",
          path: "src/util/note.ts",
          line: 7, // anchored at the comment
          score: 3,
          category: "logic",
          scope: "line",
          headline: "`summarize` throws on an empty list",
          body: "`head = items[0]` is undefined when `items` is empty and `head.label` then throws; the new comment acknowledges the assumption but the code still has no guard.",
        },
      ],
      "summarize lacks an empty-list guard.",
    ),
  ],
}

const FIXTURES: AnchorFixture[] = [
  FX_COMMENT_ABOVE,
  FX_MID_FUNCTION,
  FX_AFTER_BLANK,
  FX_MULTILINE,
  FX_JSDOC_ABOVE,
  FX_RECALL_SAFE,
]

// ── one run of one fixture through the synth + the prod submission path ─────────

interface RunResult {
  errored: boolean
  /** an inline comment landed on the EXACT buggy line. */
  exact: boolean
  /** an inline comment landed on a NON-bug code line for this fixture (a wrong anchor). */
  wrongLine: boolean
  /** the finding was surfaced at all (inline OR body) — recall. */
  surfaced: boolean
  /** the finding was body-demoted (surfaced, not inline). */
  bodyDemoted: boolean
  /** an inline comment landed on the decoy (comment/header) line. */
  onDecoy: boolean
}

async function runFixtureOnce(fx: AnchorFixture, apiKey: string, precision: boolean): Promise<RunResult> {
  const diff = toRealDiff(fx.diff)
  const userMessage = buildSynthesizerInitialMessage({
    prNumber: 0,
    diff,
    specialistVerdictsBlock: renderSpecialistVerdictsForSynth(
      fx.specialistVerdicts.map((s) => ({ role: s.role, verdict: s.verdict })),
    ),
  })
  let verdict: PrReviewVerdict | null
  try {
    const out = await runSynthesizer({
      apiKey,
      systemPrompt: SYNTHESIZER_PROMPT,
      userMessage,
      chatEnabled: CHAT_ENABLED,
      signal: AbortSignal.timeout(PER_RUN_TIMEOUT_MS),
      perfCtx: PERF_CTX,
      configOverride: SYNTH_CONFIG,
    })
    verdict = out.verdict
  } catch {
    return { errored: true, exact: false, wrongLine: false, surfaced: false, bodyDemoted: false, onDecoy: false }
  }
  if (verdict == null) {
    return { errored: true, exact: false, wrongLine: false, surfaced: false, bodyDemoted: false, onDecoy: false }
  }

  const reviewable = parseDiffToReviewablePositions(diff)
  const addedLineTextByLine = buildAddedLineTextByLine(diff)
  const prepared = prepareReviewSubmissionFindings({
    rawVerdict: verdict,
    rawUnanchored: [],
    headSha: HEAD_SHA,
    reviewable,
    addedLineTextByLine,
    anchorPrecision: precision,
  })

  // Restrict to inline findings on the buggy FILE (the synth may add unrelated
  // findings; the exactness question is about THIS bug's anchor).
  const inlineOnFile = prepared.inlineFindings.filter((f) => f.path === fx.buggyPath)
  const exact = inlineOnFile.some((f) => f.line === fx.buggyLine)
  const onDecoy = inlineOnFile.some((f) => f.line === fx.decoyLine)
  // A wrong-line = an inline comment on this file that is NOT the bug line AND is
  // a RIGHT-reviewable changed line (so it's a confidently-wrong inline anchor).
  const wrongLine = inlineOnFile.some(
    (f) => f.line !== fx.buggyLine && deriveSide(reviewable, f.path, f.line) === "RIGHT",
  )
  const bodyOnFile = prepared.unanchored.filter((f) => f.path === fx.buggyPath)
  const surfaced = inlineOnFile.length > 0 || bodyOnFile.length > 0
  const bodyDemoted = inlineOnFile.length === 0 && bodyOnFile.length > 0
  return { errored: false, exact, wrongLine, surfaced, bodyDemoted, onDecoy }
}

// ── fixture-integrity guards — run in normal CI (no model, no key) ─────────────
describe("anchor-exactness fixture integrity (no model)", () => {
  for (const fx of FIXTURES) {
    it(`[${fx.id}] is self-consistent (buggy line is an added RIGHT line; decoy is a real added line)`, () => {
      const diff = toRealDiff(fx.diff)
      const reviewable = parseDiffToReviewablePositions(diff)
      const added = buildAddedLineTextByLine(diff)
      // The decoy (comment/header) the model anchors to must be a real added line.
      expect(added.get(fx.buggyPath)?.has(fx.decoyLine)).toBe(true)
      if (fx.id === "comment-only-recall-safe") {
        // The bug here is on a CONTEXT line (not addable) — that's the point.
        expect(added.get(fx.buggyPath)?.has(fx.buggyLine)).toBe(false)
      } else {
        // The buggy line is a real added line AND RIGHT-reviewable (a fix edits it).
        expect(added.get(fx.buggyPath)?.has(fx.buggyLine)).toBe(true)
        expect(deriveSide(reviewable, fx.buggyPath, fx.buggyLine)).toBe("RIGHT")
      }
      // The decoy is genuinely NON-substantive-code (a comment/structural line),
      // so the precision pass is what moves the anchor off it.
      // (Asserted indirectly via the unit suite; here we just pin geometry.)
      expect(fx.decoyLine).not.toBe(fx.buggyLine)
    })
  }

  it("the comment-above fixture's decoy is a comment and its bug is the dedupeKey line", () => {
    const added = buildAddedLineTextByLine(toRealDiff(FX_COMMENT_ABOVE.diff))
    expect(added.get("src/parse/event.ts")?.get(110)?.trim().startsWith("//")).toBe(true)
    expect(added.get("src/parse/event.ts")?.get(111)).toContain("const dedupeKey =")
  })
})

// ── the LIVE exactness ruler — OFF vs ON across the fixture set ─────────────────
describe.skipIf(!API_KEY)(
  "inline anchor exactness (LIVE — needs OPENROUTER_API_KEY or OLLAMA_API_KEY, K-repeated)",
  () => {
    it(
      "precision OFF vs ON: exact-line hit-rate up, no rise in wrong-line anchors, no dropped findings",
      async () => {
        interface Agg {
          runs: number
          errors: number
          exact: number
          wrongLine: number
          surfaced: number
          bodyDemoted: number
          onDecoy: number
        }
        const mk = (): Agg => ({ runs: 0, errors: 0, exact: 0, wrongLine: 0, surfaced: 0, bodyDemoted: 0, onDecoy: 0 })
        const acc = new Map<string, { off: Agg; on: Agg }>()
        for (const fx of FIXTURES) acc.set(fx.id, { off: mk(), on: mk() })

        for (let k = 0; k < REPEATS; k++) {
          for (const fx of FIXTURES) {
            const bucket = acc.get(fx.id)!
            // OFF then ON back-to-back per fixture per repeat (sequential — don't
            // hammer the model). Both calls hit the SAME prompt; only the post-hoc
            // anchor-precision differs, so the model's variance is shared.
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
              if (r.exact) agg.exact += 1
              if (r.wrongLine) agg.wrongLine += 1
              if (r.surfaced) agg.surfaced += 1
              if (r.bodyDemoted) agg.bodyDemoted += 1
              if (r.onDecoy) agg.onDecoy += 1
            }
          }
        }

        // Report.
        const lines: string[] = [
          "",
          `┌─ INLINE ANCHOR EXACTNESS · model=${SYNTH_CONFIG.primary} · ${REPEATS}× · precision OFF→ON ─┐`,
        ]
        let exactOffSum = 0
        let exactOnSum = 0
        let measured = 0
        for (const fx of FIXTURES) {
          const { off, on } = acc.get(fx.id)!
          const eOff = off.runs ? off.exact / off.runs : 0
          const eOn = on.runs ? on.exact / on.runs : 0
          // The recall-safety fixture is not an exactness target — it's reported
          // separately (it should body-demote, never wrong-anchor).
          if (fx.id !== "comment-only-recall-safe") {
            measured += 1
            exactOffSum += eOff
            exactOnSum += eOn
          }
          lines.push(
            `[${fx.id}] exact ${pct(eOff)}→${pct(eOn)} (${off.exact}/${off.runs}→${on.exact}/${on.runs}) · onComment ${off.onDecoy}/${off.runs}→${on.onDecoy}/${on.runs} · wrong ${off.wrongLine}→${on.wrongLine} · body ${off.bodyDemoted}→${on.bodyDemoted} · surfaced ${on.surfaced}/${on.runs}`,
          )
        }
        const aggExactOff = measured ? exactOffSum / measured : 0
        const aggExactOn = measured ? exactOnSum / measured : 0
        const wrongOff = [...acc.values()].reduce((s, b) => s + b.off.wrongLine, 0)
        const wrongOn = [...acc.values()].reduce((s, b) => s + b.on.wrongLine, 0)
        const surfacedOff = [...acc.values()].reduce((s, b) => s + b.off.surfaced, 0)
        const surfacedOn = [...acc.values()].reduce((s, b) => s + b.on.surfaced, 0)
        lines.push(
          `─ AGGREGATE (exactness fixtures): exact ${pct(aggExactOff)} → ${pct(aggExactOn)} · wrong-line ${wrongOff}→${wrongOn} · surfaced ${surfacedOff}→${surfacedOn}`,
        )
        lines.push(`target: exact-line hit-rate up, wrong-line ON <= OFF, surfaced ON >= OFF (no dropped findings)`)
        lines.push("└──────────────────────────────────────────────────────────────────┘")
        console.log(lines.join("\n"))

        // Recall-safety assertions — RATE-based so a transient per-fixture model
        // error (which desyncs OFF vs ON run counts) can't fail the gate; the
        // model is non-deterministic, so these are the K-aggregated rates, with a
        // small epsilon for sampling noise. (Run K>=12 for a number you act on.)
        const rate = (num: number, den: number): number => (den > 0 ? num / den : 0)
        const EPS = 1e-9
        //   1. the precision pass NEVER raises the wrong-line (hallucination-equivalent) RATE.
        const wrongRateOff = rate(
          wrongOff,
          [...acc.values()].reduce((s, b) => s + b.off.runs, 0),
        )
        const wrongRateOn = rate(
          wrongOn,
          [...acc.values()].reduce((s, b) => s + b.on.runs, 0),
        )
        expect(wrongRateOn).toBeLessThanOrEqual(wrongRateOff + EPS)
        //   2. the precision pass NEVER drops a finding — the surfaced RATE per
        //      fixture (over the runs that actually completed) does not fall.
        for (const fx of FIXTURES) {
          const { off, on } = acc.get(fx.id)!
          expect(rate(on.surfaced, on.runs)).toBeGreaterThanOrEqual(rate(off.surfaced, off.runs) - EPS)
        }
        //   3. it NEVER lowers aggregate exactness below OFF (it only re-homes off comments).
        expect(aggExactOn).toBeGreaterThanOrEqual(aggExactOff - EPS)
      },
      REPEATS * FIXTURES.length * 2 * PER_RUN_TIMEOUT_MS + 120_000,
    )
  },
)
