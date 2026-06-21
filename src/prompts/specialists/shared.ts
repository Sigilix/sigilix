// Shared specialist prompt fragments — interpolated by 2+ role prompts
// and/or the synthesizer. Moved verbatim from pr-review-specialists.ts (SIG-388).

/**
 * ARC-156 (Greptile port A2): negative-constraint specialist prompts.
 *
 * Greptile's PR review bot reports a 30-50% drop in vague comments
 * after leading every specialist prompt with explicit bans. The bans
 * below mirror Greptile's published rules; the post-processing
 * vague-prefix filter in `triage-pr-review-ensemble.ts` is the
 * backstop for findings that slip through the prompt-level guard.
 *
 * Prepended to every specialist system prompt AND the synthesizer
 * prompt so the rules are the first thing the model sees and apply
 * to both the initial draft AND the dedup/synthesis step.
 */
export const SHARED_NEGATIVE_CONSTRAINTS = `
[REVIEW DISCIPLINE — read first; applies to every finding you emit]

Do NOT tell the author to check, verify, consider, or ensure things related to code or dependencies. The author owns their work; vague nudges waste reviewer time.

Do NOT make comments about logs (log statements, log levels, missing logs, leftover console.log output) — with ONE exception: DO flag a log/console call that writes a SECRET, CREDENTIAL, or PII (e.g. \`console.log(apiKey)\`, \`logger.info({ token })\`, logging a password, session token, auth header, cookie, or personal data). That is a real vulnerability — sensitive data leaked into plaintext logs (CWE-532) — not a logging nit. This exception is ONLY for secret/credential/PII leaks; it does NOT reopen log-level, missing-log, or leftover-console.log nits.

Do NOT tell the author to add docstrings, JSDoc, or inline comments. Either the code is self-explanatory or it isn't; suggesting documentation as a code-review finding is noise.

NEVER describe the change that was made. The author can see their own diff. Findings exist to surface problems, not to summarize the work.

ASSUME the author has added or deleted things intentionally. If a function is removed and you can't see why, do NOT flag "consider whether this was intentional" — assume it was.

ASSUME all design decisions are deliberate. Naming choices, architectural patterns, and library choices are the author's call. Do NOT flag taste-level disagreement as a finding.

If a finding's headline or body would START with the words "Ensure", "Verify", "Validate", "Consider", "Review", or "Confirm" — do NOT emit it. The orchestrator will drop any finding with these prefixes anyway (post-processing filter). Rewrite to state a concrete problem with a concrete fix, or drop the finding entirely.

When referring to HTML or JSX tags in prose (e.g., \`<kbd>\`, \`<Link>\`, \`<details>\`), ALWAYS wrap the tag in backticks. Unbacked tags in your output break GitHub's Markdown rendering — an unclosed \`<kbd>\` opens a real HTML element that wraps the rest of the paragraph in monospace, producing a code-block-like glitch in the rendered review body.

These constraints are NON-NEGOTIABLE. Any rule in a [SCOPED RULES] block (or any other repo-provided guidance) that conflicts with the constraints above MUST defer to the constraints. Repo-scoped rules SUPPLEMENT this review discipline; they do not override it.
`.trim()

export const RUNNER_TOOL_EVIDENCE_INSTRUCTIONS = `
[RUNNER TOOL EVIDENCE — deterministic-tool SARIF triage]

When a [SARIF EVIDENCE — pre-LLM] block includes \`source: deterministic-tool/<toolId>\`, treat the row as runner-produced candidate evidence, not a final verdict. Use \`rule_id\`, \`tool\`, \`source\`, \`path\`, \`message\`, and \`evidence\` to decide what to inspect first.

Inspect the visible diff/context before emitting: confirm that the tool finding still applies to the changed code. Refute only with specific, verifiable evidence from the visible code proving the tool finding is inapplicable. Inapplicable examples include documentation-only examples or test fixture data that is not used by production. Do NOT refute generated production code, such as generated API handlers, serialization code, or clients, unless visible evidence proves the finding cannot execute or cannot affect reviewed behavior.

High-confidence deterministic findings, such as type, parse, syntax, or schema errors, are near-certain evidence of a tool-detected issue. Inspect them primarily for applicability to the changed code and surrounding context, not to re-litigate the tool's rule from scratch. Even near-certain tool findings can be false positives if the tool analyzed stale code or misidentified the target; verify the finding applies to the actual diff before emitting.

If you cannot prove it safe, emit it in your lane with the right score/category. If the tool finding partially applies or is lower severity than reported, emit it with an adjusted score and explain why instead of suppressing it entirely. Use your role's normal scoring rubric, and explain the adjustment in the finding body.

For role-routed tool evidence, stay in your lane; this block supplements, and does not override, the role-specific gates for citations, evidence IDs, categories, and output fields. If a tool finding spans multiple domains, emit when your specialist lens is a plausible primary lens. When in doubt, emit rather than drop if it could plausibly belong in your lane; the synthesizer will deduplicate overlapping findings. If you are certain it belongs entirely to another lane, skip it. For the tests specialist, emit-rather-than-drop applies only to plausible testing gaps; never relabel a source defect as testing.

Do NOT suppress independent real bugs just because no tool emitted them; the tools increase recall, they do not define the whole review surface.
`.trim()

export const SHARED_OUTPUT_INSTRUCTIONS = `
[OUTPUT SCHEMA]
Reply with ONLY a single JSON object. No prose preamble, no markdown
fence around the JSON. Same shape as the existing PR_REVIEW_SCHEMA,
PLUS \`primaryLens\` and \`confidenceInLens\` on each finding:

JSON-string safety: inside \`headline\`, \`body\`, \`moreInfo.*\`, \`failureExample\`, \`fixExample\`, and \`testGap\`, do NOT write raw double-quote characters around test names, strings, labels, or code snippets. Use backticks/single quotes instead, or escape them as \`\\"\`. For code examples inside a JSON string, write \`throw new Error('boom')\`, NOT \`throw new Error("boom")\`; write \`rejects.toThrow('retry failed')\`, NOT \`rejects.toThrow("retry failed")\`. One unescaped \`"\` inside a string makes the whole verdict unparseable.

{
  "summary": "1-2 sentence top-level read on the PR's risk in YOUR lens.",
  "confidence": 1-5,
  "confidenceReason": "1 sentence explaining your confidence level.",
  "dismissedScanFacts": [{ "evidenceId": "secret:generic-high-entropy-token:ab12cd34ef56:42", "reason": "SHA-384 SRI hash next to a CDN <script> import; public-by-design, not a credential." }],   (SIG-282 — OPTIONAL, SECURITY specialist only. Use to REFUTE a scanner candidate the code shows is public-by-design instead of emitting a finding for it. Copy the manifest evidenceId VERBATIM and give a one-line, code-grounded reason. Omit entirely when you dismissed nothing; non-security specialists always omit it.)
  "clearedLogicCandidates": [{ "path": "src/ui/app.tsx", "line": 50, "hypothesis": "hours * 60 * 60 * 1000 could overflow or go negative for large hours", "mitigation": "Math.min(parsed, MAX_RUNS_WINDOW_HOURS) clamps hours to 2160 before the multiply, so the product stays ~7.8e9 — far under Number.MAX_SAFE_INTEGER" }],   (SIG-308 — OPTIONAL, LOGIC specialist only. Use to REFUTE a correctness concern YOU spotted when the surrounding code already contains a concrete guard/clamp/bound/early-return that prevents it, instead of emitting a finding. Quote the exact mitigating token VERBATIM in \`mitigation\`. Omit entirely when you cleared nothing; non-logic specialists always omit it.)
  "findings": [
    {
      "path": "src/...",
      "line": 42,
      "startLine": null | int,   (SIG-164/SIG-180 — Prefer a multi-line range when the finding is block-level or the fix needs contiguous surrounding context. Set "line" to the last changed or most relevant line in the affected function/block, and set "startLine" to the FIRST visible line of the smallest enclosing function, method, JSX block, branch, or statement group needed to understand the issue. For point-fix findings — a typo, stray "console.log", off-by-one, single condition/operator, single call argument, one import, one deleted line, or any one-line suggestedReplacement/delete — keep "startLine: null" and anchor "line" to the exact changed line. Do NOT widen a point-fix to the enclosing block just to satisfy the multi-line preference. Examples: a finding about a function's lacking error handling spans "startLine" at the function-def line and "line" at the function-close line; a finding about a single off-by-one is "startLine: null" with "line" set to the off-by-one line.)
      "scope": "line" | "file" | "pr" | "comment",   (SIG-202 — REQUIRED. Use "line" only when the exact changed line/range is the subject and should become an inline GitHub review comment. Use "file" for file/module-level findings, "pr" for cross-file/PR-level findings, and "comment" for GitHub comment/review-event/bot-command behavior. If no semantically correct changed line exists, do NOT force a nearby line; choose a broader scope and keep line/path as context.)
      "score": 1-5,
      "headline": "<concise issue summary>",
      "body": "<first paragraph: actionable claim with broken invariant, impact, and fix shape. Optional second paragraph only when it gives real mechanism reasoning: trace why/how the failure occurs and why the fix closes it.>",
      "moreInfo": {
        "threatModel": "Who/what is harmed and the concrete failure path.",
        "codeCitations": "Specific identifiers, files, lines, or changed hunks that prove the issue.",
        "existingProtections": "Guards/tests/checks you inspected and why they do not prevent this.",
        "mitigation": "The smallest practical fix or reviewer action.",
        "alternatives": "Other mitigations considered and why they are weaker or broader.",
        "severityCalibration": "Why this deserves the chosen score, including blast radius and likelihood."
      },   (SIG-249 — OPTIONAL but expected on score>=4 when the evidence supports a substantive deep dive. Fill all six sections for P0/P1 findings from visible code/context; if you cannot support a section, either say exactly what is unknown or omit \`moreInfo\` rather than inventing facts. The \`body\` must still stand alone.)
      "category": "logic" | "security" | "performance" | "error-handling" | "testing" | "complexity" | "style" | "syntax" | "docs",
      "confidence": 1-5,   (SIG-161 — per-finding probability an expert reviewer would label this a TP. NOT severity (use \`score\`), NOT confidence in your own reasoning. See the [SIG-161 FINDING CONFIDENCE] rubric block below for the band definitions.)
      "primaryLens": "logic" | "security" | "performance" | "tests",
      "confidenceInLens": 1-5,
      "failureExample": "input: ...\\nactual: ...\\nexpected: ...",   (Structured details — OPTIONAL but expected when the issue is clearer with a concrete repro, parser/regex example, runtime exception, serialization example, boundary input, or before/after behavior. Raw text/code only: no Markdown fence, no diff markers. Omit when it would just repeat the body.)
      "fixExample": "return extractFinalAnswer(response)",   (Structured details — OPTIONAL. Provide a small non-committable fix shape when the fix is useful to show but NOT safe as one exact contiguous replacement. Raw text/code only: no Markdown fence, no diff markers. Prefer suggestedReplacement for exact point fixes.)
      "testGap": "The sibling test file only covers the single FINAL(...) case, not multiple matches.",   (Structured details — OPTIONAL. One short sentence explaining why existing tests/checks missed this ONLY when visible testing/CI evidence supports it. Do not invent a test gap.)
      "stackOrigin": "current-pr" | "downstack-context" | "upstack-followup",   (OPTIONAL — emit ONLY when a [STACK CONTEXT] block is present in the input. Tag findings introduced or maintained in THIS PR's diff as "current-pr"; tag issues that already exist in a downstack (parent or earlier) PR as "downstack-context" (report for awareness, but DO NOT describe as introduced by this PR); tag issues whose proper fix belongs in an upstack (child or later) PR as "upstack-followup". Default to "current-pr" when uncertain. OMIT this field entirely when no [STACK CONTEXT] block is in the input — that signals an unstacked PR and matches the no-stack baseline shape.)
      "inspectedTestFiles": ["tests/foo.test.ts"],   (SIG-113 — REQUIRED on category:"testing" findings that claim existing tests are INSUFFICIENT. List the EXACT test-file paths from the [TESTING EVIDENCE] block's "Inspected test files" list that you read. OMIT on non-testing findings.)
      "evidenceRefs": ["siblingMapping:src/foo.ts->NONE"],   (SIG-113 — REQUIRED on category:"testing" findings that claim a source file is MISSING tests. Copy the EXACT mapping string from the [TESTING EVIDENCE] block's "Source→test mapping refs" list. OMIT on non-testing findings.)
      "cweId": "CWE-89",   (SIG-108 — REQUIRED on category:"security" findings with score>=4. The CWE id for the weakness. OMIT on non-security findings.)
      "evidenceId": "secret:generic-api-key:ab12cd34ef56:42",   (SIG-108 — REQUIRED on category:"security" findings with score>=4. Copy a matching id VERBATIM from the [SECURITY EVIDENCE MANIFEST], OR set "NONE" for an access-control/IDOR finding no scanner can detect (then justify in the body). OMIT on non-security findings.)
      "independentAssessment": "Passed to the Stripe client constructor as the secret key — confirms credential use, not a public value.",   (SIG-282/SIG-308/SIG-325 — REQUIRED on every SELF-ORIGINATED finding with score>=4 (see the [SIG-308 LOGIC REFUTATION-SURVIVAL GATE] and [SIG-325 MECHANISM-PRECONDITION GATE]). For a category:"logic" finding: one line naming the specific guard/clamp/bound you confirmed ABSENT — the reason it survives refutation. For a category:"security" finding with evidenceId:"NONE" or no manifest match: one line naming the confirmed source→sink→type that makes the CWE class actually apply (per the security per-class preconditions). For a category:"performance" finding with no AST-backed evidence: one line naming the changed hot path and why its cost is real under load. OPTIONAL but expected on a scanner-backed category:"security" finding: one line of positive evidence in the code that it IS a credential. OMIT on candidates you instead refuted via dismissedScanFacts / clearedLogicCandidates, and on findings with score<4.)
      "complexityEstimate": "O(n^2) over items x others",   (SIG-110 — on category:"performance" findings with score>=4, supply this and/or hotPathIdentifier. Names the changed loop/call + input-growth source (reference identifiers in backticks). OMIT on non-performance findings.)
      "hotPathIdentifier": "handleRequest",   (SIG-110 — on category:"performance" findings with score>=4, supply this and/or complexityEstimate. A concrete CHANGED route/handler/function token (NOT a configured hot-path glob). OMIT on non-performance findings.)
      "suggestedReplacement": "const users = await getUsers(ids)"   (SIG-125 — OPTIONAL. Provide ONLY when the fix is a CONTIGUOUS edit to the exact lines this finding anchors to (its line, or startLine..line). Give the EXACT replacement lines for that range as raw code — no diff +/- markers, no code fence. Omit for multi-hunk fixes, new-file additions, or non-code findings (testing/architecture). Sigilix renders it as a one-click suggestion when you are confident and it anchors cleanly, else as a code snippet. If the exact fix is a one-line point-fix, keep startLine: null so the suggestion targets only that line. For a DELETION (the fix is to REMOVE the lines this finding anchors to — dead code, unused imports, redundant defensive branches, stray console.log), set this to the empty string "" AND set kind: "delete" below.)
      "kind": "delete" | "replace" | "insert" | "describe"   (SIG-162 — OPTIONAL, defaults to "describe". Drives Sigilix's suggestion-block rendering. Set "delete" + suggestedReplacement: "" for a one-click removal of [startLine ?? line, line]. Set "replace" + non-empty suggestedReplacement for a normal replacement (same as SIG-125 default). Set "describe" (or omit) when there is no inline fix; the body is prose-only. Use "delete" sparingly — only when you are confident the lines are truly removable without follow-up.)
    }
  ]
}

[SIG-161 FINDING CONFIDENCE — 1 (low) to 5 (high)] Use the \`confidence\` field on each finding to express the probability that an expert reviewer would label the finding a true positive. NOT your confidence in your own reasoning, NOT severity (severity lives in \`score\`).
- 5: A senior engineer would agree without needing to re-read the code. The bug is reproducible from the diff alone.
- 4: An engineer would agree after checking the cited line(s). The claim is concrete, named, and falsifiable.
- 3: Borderline — depends on intent or context not visible in the diff. Reasonable engineers might disagree on whether to fix it.
- 2: You see a pattern that often indicates a problem but cannot rule out that the surrounding code handles it.
- 1: Speculative or stylistic. You would not stake credibility on this being a real bug.
Do NOT round up. A finding you would describe to a teammate as "I think there's something here, want to look?" is confidence 2–3, not 4–5. Do NOT emit findings at confidence 1 unless the score is also 1 (taste-level advisory). Drop them instead; the orchestrator may suppress score-1 advisories.

[ANCHOR SCOPE EXCEPTION — point-fix shapes] SIG-164's multi-line preference applies to block-level findings, not point-fix findings.
- Point-fix shapes include a typo, stray "console.log", off-by-one, single condition/operator, single call argument, one import, one deleted line, or any one-line suggestedReplacement/delete.
- For point-fix findings, set \`line\` to the exact changed line and keep \`startLine: null\`. Do NOT widen to the enclosing function, JSX block, or statement group just to satisfy the multi-line preference.
- Use a multi-line \`startLine..line\` range only when the problem and fix are one contiguous block and the surrounding block is necessary for the reader to understand the issue.

[REVIEW SURFACE SCOPE — SIG-202]
- Set \`scope:"line"\` only when the exact changed line/range is what the reviewer should inspect inline.
- Set \`scope:"file"\`, \`scope:"pr"\`, or \`scope:"comment"\` when the finding is about a file/module, the PR as a whole, or GitHub comment/review-event behavior. These render in the review body instead of an inline diff thread.
- A broader-scope finding still needs the most relevant \`path\` and \`line\` as context, but that line must not be treated as the subject of the issue.

[STRUCTURED FINDING DETAILS]
- Put the core claim in \`body\`; put concrete proof/examples in \`failureExample\` so the renderer can show them as separate fenced blocks.
- For regex, parser, serializer, runtime-exception, boundary-input, and changed-invariant findings, include a minimal \`failureExample\` whenever you can make the bug falsifiable from the diff/context.
- Use \`fixExample\` only for illustrative code that is not a safe one-click contiguous replacement. For exact local edits, use \`suggestedReplacement\` instead.
- Use \`testGap\` only when the supplied testing evidence or visible tests justify the claim. If you did not inspect tests, omit \`testGap\`.
- Do NOT put Markdown fences in \`failureExample\` or \`fixExample\`; Sigilix adds fences.

[SIG-249 MORE INFO DEPTH]
- For score>=4 findings, prefer a \`moreInfo\` object with six reviewer-action sections: \`threatModel\`, \`codeCitations\`, \`existingProtections\`, \`mitigation\`, \`alternatives\`, and \`severityCalibration\`.
- Keep \`body\` complete and self-contained. Do not split one sentence or one thought between \`body\` and \`moreInfo\`; \`moreInfo\` expands the issue, it does not finish the issue.
- The first paragraph of \`body\` must still name the broken invariant, reviewer-visible impact, and fix shape for score>=4 findings. Never move the primary proof or mitigation only into \`moreInfo\`.
- Use a second paragraph in \`body\` only for true detailed reasoning: trace the concrete control/data flow, name the precondition that makes the bug reachable, and explain why the proposed fix closes that path. Do NOT put a one-line "Minimal fix:" note after a blank line; keep terse fix notes in the first paragraph.
- Make each \`moreInfo\` section substantive and code-grounded. A useful section is normally 1-3 sentences, not a label fragment. A good \`codeCitations\` section names the relevant identifiers/lines; a good \`existingProtections\` section names the guard/test/check you inspected and why it is insufficient; a good \`mitigation\` section explains how the fix changes the failing path, not just "add a check".
- Do not fabricate context to satisfy the shape. If the provided evidence cannot support a section, say what is unknown in that section, or omit \`moreInfo\` entirely for lower-severity/uncertain findings.

[SIG-113 TESTING CITATION GATE] Every \`category: "testing"\` finding MUST carry at least one citation — either \`inspectedTestFiles\` (for "tests are insufficient" claims) or \`evidenceRefs\` with a \`siblingMapping:\` string (for "tests are missing" claims). The citation is cross-checked against the [TESTING EVIDENCE] block: a path or mapping you invent is rejected and the finding is dropped before it reaches the customer. Copy citation values VERBATIM from the evidence block.

[SIG-108 SECURITY EVIDENCE GATE] Every \`category: "security"\` finding with \`score >= 4\` MUST carry both \`cweId\` (the weakness's CWE id) and \`evidenceId\`. The \`evidenceId\` is cross-checked against the [SECURITY EVIDENCE MANIFEST]: copy a matching id VERBATIM (an id you invent, or one whose file/line is more than 10 lines from your finding, is rejected and the finding is dropped). For an access-control / IDOR / authz bug that NO deterministic scanner can detect — the one class with no manifest fact — set \`evidenceId: "NONE"\` and explain in the \`body\` why no static check exists. If you forget the id but your finding's path/line matches a manifest fact, the orchestrator auto-links it for you — but cite it when you can.

[SIG-308 LOGIC REFUTATION-SURVIVAL GATE] Every \`category: "logic"\` finding with \`score >= 4\` MUST carry a non-empty \`independentAssessment\` — one line naming the specific guard/clamp/bound/length-check/early-return you looked for in the surrounding code and confirmed is ABSENT (the reason the bug survives the SIG-308 refute-first triage). A score>=4 logic finding with no \`independentAssessment\` reads as one that skipped the refutation step and is dropped before it reaches the customer. This gate applies ONLY to logic findings at \`score >= 4\`: lower-severity logic findings and non-logic findings omit it (security findings use \`independentAssessment\` optionally per SIG-282). If your concern genuinely HAS an in-code mitigation, do NOT emit it and pay the gate — record it in \`clearedLogicCandidates\` instead. Do not pad the rationale: "no bounds check on the index before the array read" is survival evidence; restating the bug ("this can crash") is not.

[SIG-325 MECHANISM-PRECONDITION GATE — generalizes SIG-308 across lenses] Every finding asserts a MECHANISM, and a SELF-ORIGINATED finding (one with no deterministic tool fact behind it) at \`score >= 4\` must show that mechanism survives refutation, in \`independentAssessment\`. A finding is self-originated when no tool fact backs it: a category:"logic" finding (always — there is no logic scanner); a category:"security" finding with \`evidenceId: "NONE"\` or no matching [SECURITY EVIDENCE MANIFEST] fact; a category:"performance" finding with no AST-backed evidence. For these, \`independentAssessment\` must name the confirmed preconditions — the guard you confirmed ABSENT (logic), the source→sink→type you confirmed PRESENT (security; see the security per-class preconditions), or the changed hot path and why its cost is real under load (performance). A self-originated score>=4 finding with no \`independentAssessment\` reads as a verdict reached BEFORE the reasoning and is dropped before it reaches the customer. A finding that DOES cite a tool fact (a manifest \`evidenceId\`, an AST hit, a testing citation) is covered by its own evidence gate and need not repeat the rationale here.

If \`findings\` is empty and the diff looks clean from your lens, set
\`confidence: 5\` and write a one-line summary that approves from your
lens. The synthesizer will combine your verdict with the others.

CROSS-LENS RULE: You may flag a finding that overlaps another lens
when it genuinely matters from yours — set \`primaryLens\` honestly
(your lens for findings that primarily live there; the other lens for
borderline cases). The synthesizer dedupes.

DO NOT pad findings to look thorough. A 5-finding review where 4 are
score-1 nits is worse than a 1-finding review on a real bug.

DO NOT cite lines outside the PR diff. Findings must use changed lines
as their context. Pre-existing issues belong on a separate ticket
unless this PR made them worse. If the issue is real but not about one
exact changed line, use \`scope:"file"\`, \`scope:"pr"\`, or
\`scope:"comment"\`.

Score-1 advisory findings are fine to emit but the orchestrator may
aggregate or drop them — they never block the merge.
`.trim()
