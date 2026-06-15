// CI-failure-triage synth recall ruler (SIG-431, parent SIG-424) — replays the
// canonical #24 failure through the REAL CI-triage synth pipeline and measures
// the dedupeKey CATCH rate + hallucination rate.
//
//   OPENROUTER_API_KEY=sk-or-... npm run ci-triage-synth-eval
//   CI_SYNTH_RECALL_REPEATS=12 OPENROUTER_API_KEY=... npm run ci-triage-synth-eval
//
// This is the LIVE e2e that should have caught the P0 the merged stub-only e2e
// (ci-triage-synth-run.e2e.test.ts, which vi.mocks runSynthesizer) hid: the
// CI synth hardcoded chatEnabled:"off", a HARD model kill-switch — the chat
// adapter throws on "off", runSynthesizer catches that as a non-permanent
// failure and returns verdict:null, so enforce would post nothing (the run's
// `synth-no-verdict` skip). With a mocked synth that signature is invisible.
// It makes REAL model calls, so it's gated on the synth model's key and SKIPS in
// normal CI (`npm run build`). The import chain still resolves via vitest's
// `cloudflare:workers` shim, but no model is called without the key. It does NOT
// vi.mock the model (that is the stub anti-pattern); it runs the prod CI-synth
// system prompt + the FIXED chatEnabled through the same gate stack prod uses.
//
// The fixture is the canonical "#24" CI failure (the documented archetype the
// SIG-426 code comments + spec call "the #24 'syntax error'"): a real
// dedupeKey/attemptIndex/attemptKind bug whose changed SOURCE line lives at
// src/parse/event.ts:118, surfaced by a failed assertion in tests/parse.test.ts.
// The model's diagnosis is ~always correct; the catch hinges on whether it
// anchors the CHANGED SOURCE line (counts) or the test-assertion line (off-diff
// → correctly withheld). It must NOT invent the #24 "ndjson syntax error" red
// herring (the hallucination measure). Real PR #24's head no longer carries
// these paths (it merged green and was a different change), so this self-
// consistent fixture IS the committed test data for the archetype.

import { describe, it, expect } from "vitest"
import { runSynthesizer, SYNTHESIZER_CONFIG } from "@/src/lib/ensemble/adapters/model-provider"
import { selectConfigApiKey } from "@/src/lib/ensemble/adapters/model-provider-routing"
import { prepareReviewSubmissionFindings } from "@/src/lib/ensemble/render/submission"
import { SYNTHESIZER_PROMPT } from "@/src/prompts/specialists/synthesizer"
import { CI_SYNTH_PREAMBLE } from "@/src/prompts/specialists/ci-synth"
import { parseDiffToReviewablePositions, deriveSide } from "@/src/shared/util/diff-positions"
import { buildCiSynthUserMessage, isLogGrounded, disposeCiFinding } from "@/src/lib/ci-triage-synth"

const PER_RUN_TIMEOUT_MS = 180_000
// The synth is non-deterministic run-to-run; repeat K times (default 1) for a
// stable catch rate. Re-baseline a prompt change at K>=12 (CLAUDE.md ruler).
const REPEATS = (() => {
  const n = Number(process.env.CI_SYNTH_RECALL_REPEATS ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
})()
// Optional model swap (CI_SYNTH_RECALL_MODEL) — A/B a different synth model
// against the same fixture. Default = the prod synth primary; when overriding we
// null the fallback so every scored run is the requested model.
const MODEL_OVERRIDE = process.env.CI_SYNTH_RECALL_MODEL?.trim()
const SYNTH_CONFIG = MODEL_OVERRIDE
  ? { ...SYNTHESIZER_CONFIG, primary: MODEL_OVERRIDE, fallback: null }
  : SYNTHESIZER_CONFIG
// SIG-406: select the key by the EFFECTIVE synth model's shape — a `:cloud`
// override → Ollama Turbo (no OpenRouter spend); the prod default (an OpenRouter
// id) → OPENROUTER_API_KEY. The suite SKIPS unless the SELECTED provider's key
// is set, and reads the SAME chatEnabled the run derives so the FIX is exercised.
const API_KEY = selectConfigApiKey(SYNTH_CONFIG, {
  ollama: process.env.OLLAMA_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
})
// The eval must EXERCISE the fixed kill-switch, so chat must be on for the call
// to fire — same derivation the run uses (ci-triage-synth-run.ts). The eval pins
// it on (the live run is the whole point); if a runner sets it off, we honor that
// and the call will fail closed (proving the switch is real, not bypassed).
const CHAT_ENABLED: "on" | "off" = (process.env.OLLAMA_CHAT_ENABLE ?? "on") === "on" ? "on" : "off"
const pct = (x: number): string => `${(x * 100).toFixed(0)}%`

// ── the canonical #24 fixture ────────────────────────────────────────────────

// The PR diff. `src/parse/event.ts` is rewritten so each parsed CLI event gets a
// `dedupeKey`; the BUG is on new-file line 118 — the key omits `attemptKind`, so
// a "start" and an "end" event for the same attemptIndex collide and the second
// is dropped as a duplicate. The fix is to fold `attemptKind` into the key. The
// test file is also touched (a new assertion), but the CAUSE is the event.ts
// line, not the assertion. Hunk header `@@ -107,18 +107,21 @@` makes the first
// new-side line 107; the buggy `dedupeKey` line lands at 118 (asserted by the
// fixture-integrity guard below so the catch detection can't silently rot).
const PR_DIFF = `diff --git a/src/parse/event.ts b/src/parse/event.ts
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
+    // start + end for the same attempt are DISTINCT events, not duplicates.
+    expect(dedupeEvents(events)).toHaveLength(2)
+  })
+
   it("normalizes unknown kinds", () => {
     expect(parseEvent('{"runId":"r1","attempt":0,"kind":"???"}').attemptKind).toBe("unknown")
   })
`

// The CHANGED SOURCE line that PRODUCES the bug (new-file line). The catch must
// anchor here (or its immediate neighbours), NOT the test-assertion line.
const BUGGY_SOURCE_PATH = "src/parse/event.ts"
const BUGGY_SOURCE_LINE = 118
const ANCHOR_WINDOW = 2 // tolerate ±2 lines (brace/comment drift)
// The test-assertion line the LOG names — anchoring HERE is the 18%-catch failure
// mode (it observes the bug; it is off the source diff for the cause).
const TEST_ASSERT_PATH = "tests/parse.test.ts"

// The failed-job log: vitest reports the assertion failure in tests/parse.test.ts.
// It names the TEST line, never src/parse/event.ts — the model must trace the
// wrong value back to the changed source line itself. It contains NO "syntax
// error" / "ndjson" text: a finding that quotes those is a hallucination.
const CI_LOG = `=== job: test ===
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
`

// The current contents of the named file (the test file the log points at), as
// the run hands the synth (it pulls context for files the log names). The source
// file is in the diff above; the synth still has to reason about it.
const FILE_CONTEXTS = [
  {
    path: TEST_ASSERT_PATH,
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
]

// The "ndjson" / "syntax error" red herring the model must NEVER invent — the #24
// hallucination. (Lower-cased so any casing variant is caught.)
const HALLUCINATION_TOKENS = ["syntax error", "ndjson", "json.parse", "malformed json"]

interface RunOutcome {
  errored: boolean
  candidates: number
  // a grounded (logExcerpt corroborated) + anchored finding on the buggy SOURCE line
  caught: boolean
  // any finding whose headline/body invents the ndjson "syntax error" red herring
  hallucinated: boolean
  anchored: number // findings RIGHT-anchored to a changed line
  corroborated: number // anchored findings whose logExcerpt is in the log
  dispositions: Record<string, number>
}

async function runOnce(apiKey: string): Promise<RunOutcome> {
  const reviewable = parseDiffToReviewablePositions(PR_DIFF)
  const userMessage = buildCiSynthUserMessage({ ciLog: CI_LOG, diff: PR_DIFF, fileContexts: FILE_CONTEXTS })
  const dispositions: Record<string, number> = {}
  let output: Awaited<ReturnType<typeof runSynthesizer>>
  try {
    output = await runSynthesizer({
      apiKey,
      // The PROD CI-synth system prompt + order (preamble FIRST), the FIXED
      // chatEnabled, and the prod config — exactly what ci-triage-synth-run.ts sends.
      systemPrompt: CI_SYNTH_PREAMBLE + SYNTHESIZER_PROMPT,
      userMessage,
      chatEnabled: CHAT_ENABLED,
      signal: AbortSignal.timeout(PER_RUN_TIMEOUT_MS),
      perfCtx: { owner: "eval", repo: "eval", prNumber: 24, headSha: "0".repeat(40) },
      provenanceSources: [],
      ...(MODEL_OVERRIDE ? { configOverride: SYNTH_CONFIG } : {}),
    })
  } catch (e) {
    console.log(`  run ERROR: ${e instanceof Error ? e.message : String(e)}`)
    return {
      errored: true,
      candidates: 0,
      caught: false,
      hallucinated: false,
      anchored: 0,
      corroborated: 0,
      dispositions,
    }
  }

  const verdict = output.verdict
  // A null/empty verdict is the P0 signature (the kill-switch). It is NOT a model
  // error — surface it loudly as a non-caught run so the catch rate reflects it.
  if (verdict == null) {
    console.log(`  run: verdict=null (P0 kill-switch signature?) failureReason=${output.failureReason ?? "n/a"}`)
    return {
      errored: false,
      candidates: 0,
      caught: false,
      hallucinated: false,
      anchored: 0,
      corroborated: 0,
      dispositions,
    }
  }

  const prepared = prepareReviewSubmissionFindings({
    rawVerdict: verdict,
    rawUnanchored: [],
    headSha: "0".repeat(40),
    reviewable,
  })

  // Hallucination = ANY emitted finding (inline or body) that invents the red
  // herring. Checked across the whole verdict, not just survivors — a fabricated
  // root cause is a hallucination even if it gets withheld for being off-diff.
  const hallucinated = verdict.findings.some((f) => {
    const hay = `${f.headline ?? ""} ${f.body ?? ""} ${f.logExcerpt ?? ""}`.toLowerCase()
    return HALLUCINATION_TOKENS.some((tok) => hay.includes(tok))
  })

  let anchored = 0
  let corroborated = 0
  let caught = false
  for (const finding of prepared.inlineFindings) {
    const isAnchored = deriveSide(reviewable, finding.path, finding.line) === "RIGHT"
    const logCorroborated = isAnchored && isLogGrounded(finding.logExcerpt ?? "", CI_LOG)
    const disposition = disposeCiFinding({ anchored: isAnchored, logCorroborated, hardWithholdUncorroborated: false })
    dispositions[disposition] = (dispositions[disposition] ?? 0) + 1
    if (isAnchored) anchored += 1
    if (logCorroborated) corroborated += 1
    // CATCH = a finding that WOULD post inline (clean or hedged), corroborated
    // against the log, AND anchored to the buggy SOURCE line (±window) — the real
    // cause, not the test-assertion line. Recall-safe: corroboration is required,
    // so this can never be inflated by weakening the grounding gate.
    const onBuggySource =
      finding.path === BUGGY_SOURCE_PATH && Math.abs(finding.line - BUGGY_SOURCE_LINE) <= ANCHOR_WINDOW
    const wouldPost = disposition === "inline-clean" || disposition === "inline-hedged"
    if (wouldPost && logCorroborated && onBuggySource) caught = true
  }

  const anchoredToTest = prepared.inlineFindings.some(
    (f) => f.path === TEST_ASSERT_PATH && deriveSide(reviewable, f.path, f.line) === "RIGHT",
  )
  console.log(
    `  run: ${prepared.inlineFindings.length} inline / ${prepared.unanchored.length} body · ${caught ? "✓ CAUGHT" : "✗ missed"}${hallucinated ? " · ⚠ HALLUCINATED" : ""}${anchoredToTest ? " · (anchored a TEST line)" : ""} · ${output.modelUsed} · ${output.elapsedMs}ms`,
  )
  // Diagnose a miss: dump what it anchored where.
  if (!caught) {
    for (const f of prepared.inlineFindings) {
      console.log(`      ↳ ${f.path}:${f.line} score=${f.score} — ${f.headline ?? ""}`)
    }
  }
  return {
    errored: false,
    candidates: prepared.inlineFindings.length + prepared.unanchored.length,
    caught,
    hallucinated,
    anchored,
    corroborated,
    dispositions,
  }
}

// Fixture-integrity guard — runs in normal CI (no key, no model). The live
// catch detection above is meaningless if BUGGY_SOURCE_LINE drifts off the diff
// or stops being the dedupeKey line, so pin both here.
describe("#24 fixture integrity (no model)", () => {
  it("the buggy dedupeKey SOURCE line is RIGHT-reviewable at the asserted line", () => {
    const reviewable = parseDiffToReviewablePositions(PR_DIFF)
    expect([...reviewable.keys()].sort()).toEqual([BUGGY_SOURCE_PATH, TEST_ASSERT_PATH].sort())
    // The catch anchors within ±ANCHOR_WINDOW of BUGGY_SOURCE_LINE; at least one
    // of those lines must be a real RIGHT-side changed position.
    const anchorable = Array.from(
      { length: 2 * ANCHOR_WINDOW + 1 },
      (_, i) => BUGGY_SOURCE_LINE - ANCHOR_WINDOW + i,
    ).some((l) => deriveSide(reviewable, BUGGY_SOURCE_PATH, l) === "RIGHT")
    expect(anchorable).toBe(true)
    // And the exact asserted line must be the `dedupeKey` construction (the cause).
    const addedByLine = new Map<number, string>()
    let newLine = 0
    let inEventHunk = false
    for (const line of PR_DIFF.split("\n")) {
      if (line.startsWith("+++ ")) {
        inEventHunk = line.includes(BUGGY_SOURCE_PATH)
        continue
      }
      if (line.startsWith("diff --git") || line.startsWith("--- ")) {
        inEventHunk = false
        continue
      }
      if (line.startsWith("@@")) {
        newLine = Number(line.match(/\+(\d+)/)?.[1] ?? 0)
        continue
      }
      if (!inEventHunk || newLine === 0) continue
      if (line.startsWith("+")) {
        addedByLine.set(newLine, line.slice(1))
        newLine++
      } else if (line.startsWith("-")) {
        // old-side only
      } else {
        addedByLine.set(newLine, line.replace(/^ /, ""))
        newLine++
      }
    }
    expect(addedByLine.get(BUGGY_SOURCE_LINE)).toContain("const dedupeKey =")
  })

  it("the failed log names the test-assert line, never the source (so anchoring is non-trivial)", () => {
    expect(CI_LOG).toContain(`${TEST_ASSERT_PATH}:50`)
    expect(CI_LOG).not.toContain(BUGGY_SOURCE_PATH)
    // The grounding gate must be able to corroborate a real log span.
    expect(isLogGrounded("expected [", CI_LOG)).toBe(true)
    // And the red herring must NOT be present (so a finding quoting it is a hallucination).
    for (const tok of HALLUCINATION_TOKENS) expect(CI_LOG.toLowerCase()).not.toContain(tok)
  })
})

describe.skipIf(!API_KEY)(
  "CI-triage synth recall (LIVE — needs OPENROUTER_API_KEY or OLLAMA_API_KEY, K-repeated)",
  () => {
    it(
      "catches the #24 dedupeKey bug on the changed SOURCE line, grounded, with no hallucination",
      async () => {
        let runs = 0
        let errors = 0
        let caught = 0
        let hallucinated = 0
        const dispositions: Record<string, number> = {}
        for (let k = 0; k < REPEATS; k++) {
          const r = await runOnce(API_KEY as string) // sequential — don't hammer the model
          if (r.errored) {
            errors += 1
            continue
          }
          runs += 1
          if (r.caught) caught += 1
          if (r.hallucinated) hallucinated += 1
          for (const [d, n] of Object.entries(r.dispositions)) dispositions[d] = (dispositions[d] ?? 0) + n
        }
        const catchRate = runs ? caught / runs : 0
        const hallRate = runs ? hallucinated / runs : 0
        const dispoStr = Object.entries(dispositions)
          .map(([d, n]) => `${d}=${n}`)
          .join(" · ")
        const lines = [
          "",
          `┌─ CI-TRIAGE SYNTH RECALL · model=${SYNTH_CONFIG.primary} · ${REPEATS}×, fixture=#24/dedupeKey ─┐`,
          `dedupeKey CATCH rate ${pct(catchRate)} (${caught}/${runs})  ·  HALLUCINATION rate ${pct(hallRate)} (${hallucinated}/${runs})${errors ? `  · ${errors} errored run(s) excluded` : ""}`,
          `target: catch >= 70%, hallucination ~0`,
          `dispositions (inline findings): ${dispoStr || "(none)"}`,
          "└────────────────────────────────────────────────────────────────┘",
        ]
        console.log(lines.join("\n"))
      },
      REPEATS * PER_RUN_TIMEOUT_MS + 60_000,
    )
  },
)
