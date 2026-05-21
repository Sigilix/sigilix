# SIG-125 — Actionable Code Suggestions in Proactive Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make proactive-review inline findings carry the actual proposed code change — always a non-committable snippet when a localized fix exists, upgraded to a one-click committable `` ```suggestion `` block when the finding is high-confidence and cleanly anchorable.

**Architecture:** Add an optional structured `suggestedReplacement` field to a finding (generated inline by the specialists, preserved by synth — no extra model call). `formatFindingComment` renders two tiers using the diff's `ReviewableMap` to decide committability. Anchoring primitives are consolidated in `diff-positions.ts`.

**Tech Stack:** TypeScript, Cloudflare Workers, vitest. Spec: `docs/superpowers/specs/2026-05-20-sig-125-review-inline-suggestions-design.md`.

---

## File Structure

- `src/lib/triage-pr-review.ts` — `PrReviewFinding` type + finding finalizer (parse) + `formatFindingComment` (rendering) + `buildReviewSubmission` (threads `reviewable`). New local helper `extensionToFenceLang`.
- `src/lib/schemas.ts` — `PR_REVIEW_SCHEMA` findings-item gains `suggestedReplacement`.
- `src/lib/diff-positions.ts` — gains `isContiguousRightRange` (moved from improve; its deps already live here).
- `src/lib/triage-pr-improve.ts` — import `isContiguousRightRange` from `diff-positions` instead of defining it (no behavior change).
- `src/prompts/pr-review-specialists.ts` — specialist emit instruction + `SHARED_OUTPUT_INSTRUCTIONS` schema doc + `SYNTHESIZER_PROMPT` preservation.
- `src/prompts/pr-review.ts` — `PROMPT_VERSION` bump.
- `src/lib/triage-pr-review-ensemble.ts` — pass `reviewable` into `buildReviewSubmission`.
- Tests: `tests/triage-pr-review.test.ts`, `tests/diff-positions.test.ts`, `tests/sig125-review-suggestions.test.ts` (new), `tests/perf-specialist-prompt.test.ts`-style prompt assertions in a new `tests/review-suggestion-prompt.test.ts`.

---

## Task 1: `suggestedReplacement` field — type, schema, parser

**Files:**
- Modify: `src/lib/triage-pr-review.ts` (interface `PrReviewFinding` ~line 240; finalizer block ~line 461)
- Modify: `src/lib/schemas.ts` (`PR_REVIEW_SCHEMA` findings-item properties ~line 157)
- Test: `tests/triage-pr-review.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/triage-pr-review.test.ts`:

```ts
import { parsePrReviewResponse } from "../src/lib/triage-pr-review"

describe("parsePrReviewResponse — suggestedReplacement (SIG-125)", () => {
  const base = {
    summary: "s", confidence: 4, confidenceReason: "r",
    findings: [{
      path: "src/a.ts", line: 10, score: 4, category: "performance",
      headline: "h", body: "b", suggestedReplacement: "  return getUsers(ids)\n",
    }],
  }
  it("reads a non-empty suggestedReplacement (trimmed of empty, raw kept)", () => {
    const v = parsePrReviewResponse(JSON.stringify(base))
    expect(v?.findings[0]?.suggestedReplacement).toBe("  return getUsers(ids)\n")
  })
  it("drops an empty / whitespace-only suggestedReplacement", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], suggestedReplacement: "   " }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.suggestedReplacement).toBeUndefined()
  })
  it("ignores a non-string suggestedReplacement", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], suggestedReplacement: 42 }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.suggestedReplacement).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/triage-pr-review.test.ts -t suggestedReplacement`
Expected: FAIL (`suggestedReplacement` is `undefined` — field not read yet).

- [ ] **Step 3: Add the field to the interface** — in `src/lib/triage-pr-review.ts`, after the `hotPathIdentifier` field in `PrReviewFinding` (~line 240):

```ts
  /**
   * SIG-125: exact replacement lines for the finding's anchored range
   * `[startLine ?? line, line]` when the fix is a contiguous edit. Raw
   * code (no diff markers, no fence). Rendered by `formatFindingComment`
   * as a committable ```suggestion block (high-confidence + anchorable)
   * or a non-committable code snippet. Absent when no localized fix
   * applies (testing / architecture / multi-hunk).
   */
  suggestedReplacement?: string
```

- [ ] **Step 4: Read it in the finalizer** — in the finalizer block (right after the `hotPathIdentifier` read ~line 468):

```ts
    // SIG-125: read suggestedReplacement (raw scalar string; trim only to
    // test emptiness — the body itself is kept verbatim incl. indentation).
    if (typeof finding.suggestedReplacement === "string" && finding.suggestedReplacement.trim().length > 0) {
      finalFinding.suggestedReplacement = finding.suggestedReplacement
    }
```

- [ ] **Step 5: Add to PR_REVIEW_SCHEMA** — in `src/lib/schemas.ts`, after `hotPathIdentifier: { type: "string" }` (~line 157):

```ts
          // SIG-125: optional contiguous-replacement code for the
          // finding's anchored range. Listed so constrained decode can
          // emit it; the parser + renderer validate/anchor it.
          suggestedReplacement: { type: "string" },
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `npx vitest run tests/triage-pr-review.test.ts -t suggestedReplacement`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/triage-pr-review.ts src/lib/schemas.ts tests/triage-pr-review.test.ts
git commit -m "feat(sig-125): add suggestedReplacement finding field + schema + parser"
```

---

## Task 2: Consolidate anchoring (`isContiguousRightRange` → `diff-positions`) + language helper

**Files:**
- Modify: `src/lib/diff-positions.ts` (add `isContiguousRightRange`)
- Modify: `src/lib/triage-pr-improve.ts` (import it instead of defining it)
- Modify: `src/lib/triage-pr-review.ts` (add `extensionToFenceLang`)
- Test: `tests/diff-positions.test.ts`, `tests/triage-pr-review.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `tests/diff-positions.test.ts`:

```ts
import { isContiguousRightRange } from "../src/lib/diff-positions"

describe("isContiguousRightRange (moved from improve, SIG-125)", () => {
  it("true when every line in the range is RIGHT-reviewable", () => {
    const m = parseDiffToReviewablePositions(
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +1,3 @@\n+a\n+b\n+c\n",
    )
    expect(isContiguousRightRange(m, "x.ts", 1, 3)).toBe(true)
  })
  it("false when a line in the range is not reviewable", () => {
    const m = parseDiffToReviewablePositions(
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +1,1 @@\n+a\n",
    )
    expect(isContiguousRightRange(m, "x.ts", 1, 3)).toBe(false)
  })
})
```

And append to `tests/triage-pr-review.test.ts`:

```ts
import { extensionToFenceLang } from "../src/lib/triage-pr-review"

describe("extensionToFenceLang (SIG-125)", () => {
  it("maps known extensions", () => {
    expect(extensionToFenceLang("src/a.ts")).toBe("ts")
    expect(extensionToFenceLang("src/a.tsx")).toBe("tsx")
    expect(extensionToFenceLang("x.py")).toBe("python")
    expect(extensionToFenceLang("x.json")).toBe("json")
  })
  it("returns empty string for unknown/extensionless paths", () => {
    expect(extensionToFenceLang("Makefile")).toBe("")
    expect(extensionToFenceLang("x.weird")).toBe("")
  })
})
```

- [ ] **Step 2: Run them, verify they fail**

Run: `npx vitest run tests/diff-positions.test.ts -t isContiguousRightRange tests/triage-pr-review.test.ts -t extensionToFenceLang`
Expected: FAIL (`isContiguousRightRange` not exported from diff-positions; `extensionToFenceLang` undefined).

- [ ] **Step 3: Move `isContiguousRightRange` into `diff-positions.ts`** — append (it depends only on `isPositionReviewable`, already in this file):

```ts
/**
 * Return true iff every line in `[startLine..line]` is RIGHT-reviewable
 * for `path`. A missing intermediate line means the range crosses a hunk
 * boundary. Pure. (Moved here from triage-pr-improve.ts, SIG-125, so both
 * the /improve and proactive-review paths share one anchoring primitive.)
 */
export function isContiguousRightRange(
  reviewable: ReviewableMap,
  path: string,
  startLine: number,
  line: number,
): boolean {
  if (startLine > line) return false
  for (let l = startLine; l <= line; l++) {
    if (!isPositionReviewable(reviewable, path, l, "RIGHT")) return false
  }
  return true
}
```

- [ ] **Step 4: Re-wire improve to import it** — in `src/lib/triage-pr-improve.ts`, delete the local `isContiguousRightRange` definition (the `export function isContiguousRightRange(...) { ... }` block ~line 495) and add it to the existing `./diff-positions` import (~line 31-35):

```ts
import {
  deriveSide,
  isPositionReviewable,
  isContiguousRightRange,
  type ReviewableMap,
} from "./diff-positions"
```

Note: improve re-exports `isContiguousRightRange` today (other tests may import it from improve). Keep a re-export so those imports don't break — add to improve:

```ts
export { isContiguousRightRange } from "./diff-positions"
```

- [ ] **Step 5: Add `extensionToFenceLang`** — in `src/lib/triage-pr-review.ts`, just above `formatFindingComment`:

```ts
/**
 * SIG-125: map a file path's extension to a Markdown fence language for
 * the non-committable "Proposed change" snippet. Empty string when
 * unknown (renders a plain fence). Pure — exported for tests.
 */
const FENCE_LANG_BY_EXT: Readonly<Record<string, string>> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  mts: "ts", cts: "ts", json: "json", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", sh: "bash", yml: "yaml",
  yaml: "yaml", toml: "toml", css: "css", html: "html", sql: "sql",
  md: "markdown",
}
export function extensionToFenceLang(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot < 0 || dot === path.length - 1) return ""
  const ext = path.slice(dot + 1).toLowerCase()
  return FENCE_LANG_BY_EXT[ext] ?? ""
}
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `npx vitest run tests/diff-positions.test.ts tests/triage-pr-review.test.ts`
Expected: PASS (incl. the existing improve tests still green via the re-export).

- [ ] **Step 7: Verify improve still typechecks/tests**

Run: `npx vitest run tests/pr-improve.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/diff-positions.ts src/lib/triage-pr-improve.ts src/lib/triage-pr-review.ts tests/diff-positions.test.ts tests/triage-pr-review.test.ts
git commit -m "refactor(sig-125): consolidate isContiguousRightRange in diff-positions; add extensionToFenceLang"
```

---

## Task 3: Two-tier rendering in `formatFindingComment` + thread `reviewable`

**Files:**
- Modify: `src/lib/triage-pr-review.ts` (`formatFindingComment` ~line 1216; `BuildReviewArgs` + `buildReviewSubmission` ~line 571-650)
- Modify: `src/lib/triage-pr-review-ensemble.ts` (pass `reviewable` to `buildReviewSubmission`)
- Test: `tests/sig125-review-suggestions.test.ts` (new)

- [ ] **Step 1: Write the failing test** — create `tests/sig125-review-suggestions.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { formatFindingComment } from "../src/lib/triage-pr-review"
import { parseDiffToReviewablePositions } from "../src/lib/diff-positions"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

const reviewable = parseDiffToReviewablePositions(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,2 @@\n+const x = 1\n+const y = 2\n",
)
function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/a.ts", line: 1, score: 4, category: "performance",
    headline: "h", body: "b", confidence: 5,
    suggestedReplacement: "const x = batch(1)", ...over,
  } as PrReviewFinding
}

describe("formatFindingComment two-tier suggestions (SIG-125)", () => {
  it("committable ```suggestion when confidence>=4 AND anchorable", () => {
    const out = formatFindingComment(finding(), 5, reviewable)
    expect(out).toContain("```suggestion")
    expect(out).toContain("const x = batch(1)")
  })
  it("non-committable snippet when confidence<4 (still shows the change)", () => {
    const out = formatFindingComment(finding(), 3, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("```ts")
    expect(out).toContain("const x = batch(1)")
  })
  it("non-committable snippet when not anchorable (line absent from diff)", () => {
    const out = formatFindingComment(finding({ path: "src/other.ts" }), 5, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("```ts")
  })
  it("prose only when no suggestedReplacement", () => {
    const out = formatFindingComment(finding({ suggestedReplacement: undefined }), 5, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).not.toContain("```ts")
  })
  it("falls back to snippet when no reviewable map is supplied", () => {
    const out = formatFindingComment(finding(), 5)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("```ts")
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/sig125-review-suggestions.test.ts`
Expected: FAIL (`formatFindingComment` takes 2 args / doesn't render suggestions).

- [ ] **Step 3: Extend `formatFindingComment`** — replace the function body in `src/lib/triage-pr-review.ts` (~1216-1241). Add the import at the top of the file: `import { isContiguousRightRange, deriveSide, type ReviewableMap } from "./diff-positions"` (merge with any existing diff-positions import):

```ts
const HIGH_CONFIDENCE_FLOOR = 4

export function formatFindingComment(
  finding: PrReviewFinding,
  confidence: number,
  reviewable?: ReviewableMap,
): string {
  const lines: string[] = ["<!-- sigilix:pr-review-finding -->"]
  const badge = severityBadgeForScore(finding.score)
  const heading = badge !== null
    ? `${badge} · **${finding.category}:** ${finding.headline} · _confidence: ${confidence}/5_`
    : `**${finding.category}:** ${finding.headline} · _confidence: ${confidence}/5_`
  lines.push(heading, "")
  if (confidence <= 2) {
    lines.push("<details>", "<summary>Low-confidence finding — expand to read</summary>", "", finding.body, "", "</details>")
  } else {
    lines.push(finding.body)
  }
  // SIG-125: render the proposed change when present.
  const repl = finding.suggestedReplacement
  if (typeof repl === "string" && repl.length > 0) {
    const committable =
      confidence >= HIGH_CONFIDENCE_FLOOR &&
      reviewable !== undefined &&
      isFindingAnchorable(finding, reviewable)
    lines.push("")
    if (committable) {
      lines.push("```suggestion", repl.replace(/\n$/, ""), "```")
    } else {
      const lang = extensionToFenceLang(finding.path)
      lines.push("**Proposed change:**", "```" + lang, repl.replace(/\n$/, ""), "```")
    }
  }
  return lines.join("\n")
}

/**
 * SIG-125: a finding's anchored range `[startLine ?? line, line]` is
 * committable iff every line is RIGHT-reviewable (matches GitHub's
 * ```suggestion applyability requirement).
 */
function isFindingAnchorable(finding: PrReviewFinding, reviewable: ReviewableMap): boolean {
  if (deriveSide(reviewable, finding.path, finding.line) !== "RIGHT") return false
  const start = finding.startLine != null && finding.startLine < finding.line ? finding.startLine : finding.line
  return isContiguousRightRange(reviewable, finding.path, start, finding.line)
}
```

- [ ] **Step 4: Run the rendering test, verify it passes**

Run: `npx vitest run tests/sig125-review-suggestions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Thread `reviewable` through `buildReviewSubmission`** — in `src/lib/triage-pr-review.ts`: add `reviewable?: ReviewableMap` to the `BuildReviewArgs` interface, destructure it in `buildReviewSubmission` (~line 571), and pass it at the `formatFindingComment` call (~line 624):

```ts
    const baseBody = formatFindingComment(f, confidence, reviewable)
```

- [ ] **Step 6: Pass `reviewable` at the ensemble call site** — in `src/lib/triage-pr-review-ensemble.ts`, find the `buildReviewSubmission({ ... })` call and add `reviewable,` to its args object (`reviewable` is already in scope from `parseDiffToReviewablePositions(diff)` ~line 1148).

- [ ] **Step 7: Full typecheck + targeted tests**

Run: `npx tsc --noEmit && npx vitest run tests/sig125-review-suggestions.test.ts tests/triage-pr-review.test.ts`
Expected: tsc clean; PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/triage-pr-review.ts src/lib/triage-pr-review-ensemble.ts tests/sig125-review-suggestions.test.ts
git commit -m "feat(sig-125): two-tier suggestion rendering in formatFindingComment + thread reviewable"
```

---

## Task 4: Prompt — emit instruction, schema doc, synth preservation, PROMPT_VERSION

**Files:**
- Modify: `src/prompts/pr-review-specialists.ts` (`SHARED_OUTPUT_INSTRUCTIONS`, `SYNTHESIZER_PROMPT`)
- Modify: `src/prompts/pr-review.ts` (`PROMPT_VERSION`)
- Test: `tests/review-suggestion-prompt.test.ts` (new)

- [ ] **Step 1: Write the failing test** — create `tests/review-suggestion-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS, SYNTHESIZER_PROMPT } from "../src/prompts/pr-review-specialists"
import { PROMPT_VERSION } from "../src/prompts/pr-review"

describe("SIG-125 suggestion prompt wiring", () => {
  it("output schema documents suggestedReplacement", () => {
    expect(SPECIALIST_PROMPTS.performance).toContain("suggestedReplacement")
    expect(SPECIALIST_PROMPTS.logic).toContain("suggestedReplacement")
  })
  it("instructs contiguous-only emission", () => {
    expect(SPECIALIST_PROMPTS.logic).toMatch(/contiguous/i)
  })
  it("synth preserves suggestedReplacement verbatim", () => {
    expect(SYNTHESIZER_PROMPT).toContain("suggestedReplacement")
    expect(SYNTHESIZER_PROMPT).toMatch(/PRESERVE VERBATIM/i)
  })
  it("PROMPT_VERSION bumped to 5", () => {
    expect(PROMPT_VERSION).toBe("5")
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run tests/review-suggestion-prompt.test.ts`
Expected: FAIL.

- [ ] **Step 3: Document the field in `SHARED_OUTPUT_INSTRUCTIONS`** — in `src/prompts/pr-review-specialists.ts`, add to the findings-object schema (after the `hotPathIdentifier` line):

```text
      "suggestedReplacement": "const users = await getUsers(ids)"   (SIG-125 — OPTIONAL. Provide ONLY when the fix is a CONTIGUOUS edit to the exact lines this finding anchors to (its line, or startLine..line). Give the EXACT replacement lines for that range — raw code, no diff +/- markers, no fence. Omit for multi-hunk fixes, new-file additions, or non-code findings (testing/architecture). Sigilix renders it as a one-click suggestion when you're confident and it anchors cleanly, else as a code snippet.)
```

- [ ] **Step 4: Add synth preservation** — in `SYNTHESIZER_PROMPT`'s output-schema findings object (after the `hotPathIdentifier` preservation line):

```text
        "suggestedReplacement": "const users = await getUsers(ids)"   (SIG-125 — REQUIRED: PRESERVE VERBATIM from any kept source finding that set it. The review renderer anchors it to the finding's line range; altering or dropping it loses the one-click fix. Keep the finding's line/startLine consistent with the replacement's range. OMIT only when no kept source finding had it.)
```

- [ ] **Step 5: Bump PROMPT_VERSION** — in `src/prompts/pr-review.ts`, add a `v4 → v5` doc comment and change `export const PROMPT_VERSION = "4"` to `"5"`.

- [ ] **Step 6: Run the test, verify it passes**

Run: `npx vitest run tests/review-suggestion-prompt.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/prompts/pr-review-specialists.ts src/prompts/pr-review.ts tests/review-suggestion-prompt.test.ts
git commit -m "feat(sig-125): prompt emits suggestedReplacement + synth preserves it + PROMPT_VERSION 4->5"
```

---

## Task 5: 422-safety on review submit (defensive)

**Context:** GitHub rejects an ENTIRE review (HTTP 422) if any one inline comment carries a `` ```suggestion `` whose range isn't applicable. Our committable gate (`isFindingAnchorable`) matches GitHub's applicability rule, so this should be near-impossible — but `/improve` has hit it (a line listed reviewable yet not applicable, e.g. binary hunk). Mirror improve's safety so a bad suggestion can never fail a review.

**Files:**
- Modify: `src/lib/triage-pr-review-ensemble.ts` (the `submitReview` call for the main review path)
- Test: `tests/sig125-review-suggestions.test.ts`

- [ ] **Step 1: Locate the review submit** — find where the ensemble calls `client.submitReview(...)` with the `buildReviewSubmission` result on the success path. Confirm whether a 422 try/catch already exists there.

- [ ] **Step 2: Write the failing test** — add a pure helper `stripSuggestionBlocks(body: string): string` and test it (the retry re-renders without committable blocks):

```ts
import { stripSuggestionBlocks } from "../src/lib/triage-pr-review"
describe("stripSuggestionBlocks (SIG-125 422 fallback)", () => {
  it("converts a ```suggestion block to a plain code fence", () => {
    const body = "finding\n\n```suggestion\nconst x = 1\n```"
    const out = stripSuggestionBlocks(body)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("const x = 1")
  })
  it("leaves non-suggestion bodies unchanged", () => {
    expect(stripSuggestionBlocks("plain body")).toBe("plain body")
  })
})
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npx vitest run tests/sig125-review-suggestions.test.ts -t stripSuggestionBlocks`
Expected: FAIL (not exported).

- [ ] **Step 4: Implement `stripSuggestionBlocks`** — in `src/lib/triage-pr-review.ts`:

```ts
/**
 * SIG-125: downgrade any committable ```suggestion block in a comment
 * body to a plain code fence (keeps the visible change, removes the
 * one-click apply). Used on the 422 retry when GitHub rejects the review
 * for an inapplicable suggestion. Pure — exported for tests.
 */
export function stripSuggestionBlocks(body: string): string {
  return body.replace(/```suggestion\n/g, "```\n")
}
```

- [ ] **Step 5: Wire the 422 retry** — at the ensemble's review submit, wrap in try/catch mirroring improve (`readHttpStatus(err) === 422`): on 422, rebuild the submission with each comment body run through `stripSuggestionBlocks`, and re-submit once. On any other error, rethrow. (Reuse `readHttpStatus` from the improve module or its shared home.)

```ts
try {
  await client.submitReview(owner, repo, prNumber, submission)
} catch (err) {
  if (readHttpStatus(err) === 422 && submission.comments?.some((c) => c.body.includes("```suggestion"))) {
    const downgraded = {
      ...submission,
      comments: submission.comments.map((c) => ({ ...c, body: stripSuggestionBlocks(c.body) })),
    }
    console.log(JSON.stringify({ event: "pr-review-422-suggestion-downgrade", owner, repo, prNumber }))
    await client.submitReview(owner, repo, prNumber, downgraded)
  } else {
    throw err
  }
}
```

- [ ] **Step 6: Run tests + full build**

Run: `npx vitest run tests/sig125-review-suggestions.test.ts && npm run build`
Expected: PASS; full build green (tsc + eslint + all vitest).

- [ ] **Step 7: Commit**

```bash
git add src/lib/triage-pr-review.ts src/lib/triage-pr-review-ensemble.ts tests/sig125-review-suggestions.test.ts
git commit -m "feat(sig-125): 422-safe review submit — downgrade inapplicable suggestions to snippets"
```

---

## Final verification

- [ ] `npm run build` green (tsc + eslint + full vitest suite).
- [ ] Manual schema sanity: a finding JSON with `suggestedReplacement` decodes and renders a committable block at confidence 5 on a changed line; a snippet at confidence 3.
- [ ] code-reviewer agent + Codex second pass (retry — Codex was down during design); CodeRabbit at phase-end before `gh pr create`.
- [ ] PR against `main`, `Closes SIG-125`.

## Spec coverage check

- Schema/type/parser → Task 1. Generation prompt → Task 4. Synth preservation → Task 4. Two-tier render + confidence gate + anchoring → Task 3. Reuse improve anchoring → Task 2. 422 fallback → Task 5. PROMPT_VERSION bump → Task 4. Tests → every task. All spec sections covered.
