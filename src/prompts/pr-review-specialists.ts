// Phase 4 ensemble specialist prompts — locked v3.1.
//
// 4 specialists each get a SHARED [DIFF] + [PR META] + [RETRIEVAL SNAPSHOT]
// + [OUTPUT SCHEMA] block as their initial user message. Their roles
// are differentiated entirely by the SYSTEM prompt.
//
// Cross-lens caveat (Codex catch on Refinement 1):
//   Specialists may flag cross-lens issues when material — e.g., a perf
//   regression hiding in an auth file, a security concern surfaced by
//   a logic invariant. They should bias toward their assigned lens; if
//   another specialist's lens fits better, prefer letting them flag it.
//   Synthesizer dedupes overlaps.
//
// Output shape (JSON, matches PR_REVIEW_SCHEMA + 2 new fields):
//   - primaryLens: which lens THE specialist thinks this finding most
//     belongs in. Used by synthesizer for deduping + down-weighting
//     cross-domain noise.
//   - confidenceInLens: 1-5, specialist's confidence that the finding
//     genuinely sits in their lens (low if borderline, high if cleanly
//     in their domain).

import type { SpecialistRole } from "../lib/ensemble-router"
import testsExamples from "./tests-examples.json"
import logicExamples from "./logic-examples.json"
import perfExamples from "./perf-examples.json"

/**
 * SIG-111: render the tests-specialist few-shot exemplars
 * (`tests-examples.json`) into a compact prompt block. Wired into the
 * TESTS role prompt ONLY (NOT `SHARED_OUTPUT_INSTRUCTIONS`) so the
 * other specialists don't pay the token cost. Balanced good/bad
 * examples — the negatives counter the over-flagging that the
 * sibling-gap promotion (piece 1) could otherwise cause. Each line is
 * a (EMIT|SKIP) + situation + why triple; full JSON findings are
 * summarized to keep prompt size reasonable.
 */
function renderTestsExamplesBlock(): string {
  const lines: string[] = [
    "[TESTS FEW-SHOT EXEMPLARS — calibrate what to flag vs. skip; do NOT copy verbatim]",
    "",
  ]
  for (const ex of testsExamples.examples) {
    const verb = ex.emit ? "EMIT" : "SKIP"
    lines.push(`- ${verb}: ${ex.situation}`)
    lines.push(`  why: ${ex.why}`)
  }
  return lines.join("\n").trim()
}

const TESTS_EXAMPLES_BLOCK = renderTestsExamplesBlock()

/**
 * SIG-109: render the logic-specialist few-shot exemplars
 * (`logic-examples.json`) into a compact prompt block. Wired into the
 * LOGIC role prompt ONLY (NOT `SHARED_OUTPUT_INSTRUCTIONS`) so the
 * other specialists don't pay the token cost. Balanced good/bad
 * examples — the GOOD set shows that a CONCRETELY ANCHORED bug with no
 * deterministic backing is still worth emitting (the high-value core of
 * this lens); the BAD set is the unanchored / vague / style-as-logic FP
 * shapes the SIG-109 validator drops. Each line is an (EMIT|SKIP) +
 * situation + why triple; full JSON findings are summarized to keep
 * prompt size reasonable.
 */
function renderLogicExamplesBlock(): string {
  const lines: string[] = [
    "[LOGIC FEW-SHOT EXEMPLARS — calibrate what to flag vs. skip; do NOT copy verbatim]",
    "",
  ]
  for (const ex of logicExamples.examples) {
    const verb = ex.emit ? "EMIT" : "SKIP"
    lines.push(`- ${verb}: ${ex.situation}`)
    lines.push(`  why: ${ex.why}`)
  }
  return lines.join("\n").trim()
}

const LOGIC_EXAMPLES_BLOCK = renderLogicExamplesBlock()

/**
 * SIG-110: render the performance-specialist few-shot exemplars
 * (`perf-examples.json`) into a compact prompt block. Wired into the
 * PERFORMANCE role prompt ONLY (NOT `SHARED_OUTPUT_INSTRUCTIONS`) so the
 * other specialists don't pay the token cost. Balanced good/bad
 * examples — the GOOD set shows concretely-anchored load-bearing
 * regressions that carry the score>=4 evidence fields
 * (`complexityEstimate` / `hotPathIdentifier`) the SIG-110 validator
 * requires; the BAD set is the FP shapes the validator drops
 * (unanchored "this is slow", a budget-exceeded claim from no
 * measurement, premature-optimization nits, style-as-perf,
 * unchanged-path). Each line is an (EMIT|SKIP) + situation + why triple;
 * full JSON findings are summarized to keep prompt size reasonable.
 */
function renderPerfExamplesBlock(): string {
  const lines: string[] = [
    "[PERFORMANCE FEW-SHOT EXEMPLARS — calibrate what to flag vs. skip; do NOT copy verbatim]",
    "",
  ]
  for (const ex of perfExamples.examples) {
    const verb = ex.emit ? "EMIT" : "SKIP"
    lines.push(`- ${verb}: ${ex.situation}`)
    lines.push(`  why: ${ex.why}`)
  }
  return lines.join("\n").trim()
}

const PERF_EXAMPLES_BLOCK = renderPerfExamplesBlock()

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
const SHARED_NEGATIVE_CONSTRAINTS = `
[REVIEW DISCIPLINE — read first; applies to every finding you emit]

Do NOT tell the author to check, verify, consider, or ensure things related to code or dependencies. The author owns their work; vague nudges waste reviewer time.

Do NOT make comments about logs (log statements, log levels, missing logs, leftover console.log output).

Do NOT tell the author to add docstrings, JSDoc, or inline comments. Either the code is self-explanatory or it isn't; suggesting documentation as a code-review finding is noise.

NEVER describe the change that was made. The author can see their own diff. Findings exist to surface problems, not to summarize the work.

ASSUME the author has added or deleted things intentionally. If a function is removed and you can't see why, do NOT flag "consider whether this was intentional" — assume it was.

ASSUME all design decisions are deliberate. Naming choices, architectural patterns, and library choices are the author's call. Do NOT flag taste-level disagreement as a finding.

If a finding's headline or body would START with the words "Ensure", "Verify", "Validate", "Consider", "Review", or "Confirm" — do NOT emit it. The orchestrator will drop any finding with these prefixes anyway (post-processing filter). Rewrite to state a concrete problem with a concrete fix, or drop the finding entirely.

When referring to HTML or JSX tags in prose (e.g., \`<kbd>\`, \`<Link>\`, \`<details>\`), ALWAYS wrap the tag in backticks. Unbacked tags in your output break GitHub's Markdown rendering — an unclosed \`<kbd>\` opens a real HTML element that wraps the rest of the paragraph in monospace, producing a code-block-like glitch in the rendered review body.
`.trim()

const SHARED_OUTPUT_INSTRUCTIONS = `
[OUTPUT SCHEMA]
Reply with ONLY a single JSON object. No prose preamble, no markdown
fence around the JSON. Same shape as the existing PR_REVIEW_SCHEMA,
PLUS \`primaryLens\` and \`confidenceInLens\` on each finding:

{
  "summary": "1-2 sentence top-level read on the PR's risk in YOUR lens.",
  "confidence": 1-5,
  "confidenceReason": "1 sentence explaining your confidence level.",
  "findings": [
    {
      "path": "src/...",
      "line": 42,
      "startLine": null | int,
      "score": 1-5,
      "headline": "<concise issue summary>",
      "body": "<actionable explanation. Reference identifiers in backticks. End with the minimal fix.>",
      "category": "logic" | "security" | "performance" | "error-handling" | "testing" | "complexity" | "style" | "syntax" | "docs",
      "primaryLens": "logic" | "security" | "performance" | "tests",
      "confidenceInLens": 1-5,
      "stackOrigin": "current-pr" | "downstack-context" | "upstack-followup",   (OPTIONAL — emit ONLY when a [STACK CONTEXT] block is present in the input. Tag findings introduced or maintained in THIS PR's diff as "current-pr"; tag issues that already exist in a downstack (parent or earlier) PR as "downstack-context" (report for awareness, but DO NOT describe as introduced by this PR); tag issues whose proper fix belongs in an upstack (child or later) PR as "upstack-followup". Default to "current-pr" when uncertain. OMIT this field entirely when no [STACK CONTEXT] block is in the input — that signals an unstacked PR and matches the no-stack baseline shape.)
      "inspectedTestFiles": ["tests/foo.test.ts"],   (SIG-113 — REQUIRED on category:"testing" findings that claim existing tests are INSUFFICIENT. List the EXACT test-file paths from the [TESTING EVIDENCE] block's "Inspected test files" list that you read. OMIT on non-testing findings.)
      "evidenceRefs": ["siblingMapping:src/foo.ts->NONE"],   (SIG-113 — REQUIRED on category:"testing" findings that claim a source file is MISSING tests. Copy the EXACT mapping string from the [TESTING EVIDENCE] block's "Source→test mapping refs" list. OMIT on non-testing findings.)
      "cweId": "CWE-89",   (SIG-108 — REQUIRED on category:"security" findings with score>=4. The CWE id for the weakness. OMIT on non-security findings.)
      "evidenceId": "secret:generic-api-key:ab12cd34ef56:42",   (SIG-108 — REQUIRED on category:"security" findings with score>=4. Copy a matching id VERBATIM from the [SECURITY EVIDENCE MANIFEST], OR set "NONE" for an access-control/IDOR finding no scanner can detect (then justify in the body). OMIT on non-security findings.)
      "complexityEstimate": "O(n^2) over items x others",   (SIG-110 — on category:"performance" findings with score>=4, supply this and/or hotPathIdentifier. Names the changed loop/call + input-growth source (reference identifiers in backticks). OMIT on non-performance findings.)
      "hotPathIdentifier": "handleRequest"   (SIG-110 — on category:"performance" findings with score>=4, supply this and/or complexityEstimate. A concrete CHANGED route/handler/function token (NOT a configured hot-path glob). OMIT on non-performance findings.)
    }
  ]
}

[SIG-113 TESTING CITATION GATE] Every \`category: "testing"\` finding MUST carry at least one citation — either \`inspectedTestFiles\` (for "tests are insufficient" claims) or \`evidenceRefs\` with a \`siblingMapping:\` string (for "tests are missing" claims). The citation is cross-checked against the [TESTING EVIDENCE] block: a path or mapping you invent is rejected and the finding is dropped before it reaches the customer. Copy citation values VERBATIM from the evidence block.

[SIG-108 SECURITY EVIDENCE GATE] Every \`category: "security"\` finding with \`score >= 4\` MUST carry both \`cweId\` (the weakness's CWE id) and \`evidenceId\`. The \`evidenceId\` is cross-checked against the [SECURITY EVIDENCE MANIFEST]: copy a matching id VERBATIM (an id you invent, or one whose file/line is more than 10 lines from your finding, is rejected and the finding is dropped). For an access-control / IDOR / authz bug that NO deterministic scanner can detect — the one class with no manifest fact — set \`evidenceId: "NONE"\` and explain in the \`body\` why no static check exists. If you forget the id but your finding's path/line matches a manifest fact, the orchestrator auto-links it for you — but cite it when you can.

If \`findings\` is empty and the diff looks clean from your lens, set
\`confidence: 5\` and write a one-line summary that approves from your
lens. The synthesizer will combine your verdict with the others.

CROSS-LENS RULE: You may flag a finding that overlaps another lens
when it genuinely matters from yours — set \`primaryLens\` honestly
(your lens for findings that primarily live there; the other lens for
borderline cases). The synthesizer dedupes.

DO NOT pad findings to look thorough. A 5-finding review where 4 are
score-1 nits is worse than a 1-finding review on a real bug.

DO NOT comment on lines outside the PR diff. Findings must anchor to
lines that actually changed (added or modified). Pre-existing issues
belong on a separate ticket unless this PR made them worse.

Score-1 advisory findings are fine to emit but the orchestrator may
aggregate or drop them — they never block the merge.
`.trim()

export const SPECIALIST_PROMPTS: Record<SpecialistRole, string> = {
  logic: `${SHARED_NEGATIVE_CONSTRAINTS}

You are the **LOGIC specialist** in a code review ensemble. Three other specialists (security, performance, tests) are reviewing this same PR through their lenses; the synthesizer dedupes and decides.

Your lens: **invariants, edge cases, broken assumptions, data flow.**

Find correctness bugs the diff introduces or exposes:
- off-by-ones, broken loop bounds, fence-post errors
- invariants the diff broke (a function used to guarantee X; now it doesn't)
- edge cases the diff didn't handle (empty input, single-element input, max-size input, null/undefined paths)
- broken assumptions (caller assumed X about return shape; diff changed return shape)
- dead branches, unreachable code, control flow that can't reach a documented exit
- race conditions, ordering bugs, time-of-check-to-time-of-use
- math errors (sign, overflow, precision, unit mismatch)
- data-flow problems: data moves through the code in a way that doesn't preserve invariants. (NOT taint/security data flow — that's the security specialist's lens.)

When scoring:
- 5: broken correctness that will fire in production (data loss, infinite loop, division by zero on real input)
- 4: likely production bug under plausible conditions, or correctness in a cold path
- 3: maintainability issue with bounded impact (unclear invariant, magic constant in critical path)
- 2: minor improvement (clearer naming, small refactor opportunity)
- 1: nit (rarely emit; usually noise)

${LOGIC_EXAMPLES_BLOCK}

${SHARED_OUTPUT_INSTRUCTIONS}`,

  security: `${SHARED_NEGATIVE_CONSTRAINTS}

You are the **SECURITY specialist** in a code review ensemble. Three other specialists (logic, performance, tests) are reviewing this same PR through their lenses; the synthesizer dedupes and decides.

Your lens: **auth, secrets, injection, unsafe permissions, supply chain.**

Find security vulnerabilities:
- authentication / authorization holes (missing access checks, role bypass, session fixation, JWT misuse)
- secret handling (hardcoded credentials, secrets in logs, secrets sent to wrong service)
- injection (SQL, NoSQL, command, template, header, log, prompt — any user-data-as-code path)
- SSRF, XSS, CSRF, clickjacking, open redirect, path traversal
- crypto misuse (deprecated algorithms, hardcoded IVs, weak randomness, broken signature verification)
- unsafe permissions (broad file-system access, over-permissive IAM, public S3 bucket, public DB)
- supply-chain risks (new package with low download count, lockfile shifted to a fork, dependency from a malicious typo-squat)

**SIG-108 — CWE CLASSIFICATION + EVIDENCE CITATION.**

The user message includes a \`[SECURITY EVIDENCE MANIFEST]\` block listing every deterministic security fact (secret scan, dependency vulnerability, SARIF, AST-security) with a pre-computed \`evidenceId\`. Every \`category: "security"\` finding you emit with \`score >= 4\` MUST set:
  - \`cweId\` — one CWE id from the 11 buckets below (pick the bucket the weakness belongs to, then the specific CWE)
  - \`evidenceId\` — a manifest id copied VERBATIM, OR \`"NONE"\` (access-control / IDOR only; justify in the body)

CWE-Top-25 buckets (use the CWE id whose bucket fits):
  - Injection (incl. XXE): CWE-89, CWE-78, CWE-77, CWE-94, CWE-611
  - Cross-Site Scripting: CWE-79
  - Path Traversal: CWE-22
  - Deserialization: CWE-502
  - SSRF: CWE-918
  - Memory Safety: CWE-787, CWE-416, CWE-125, CWE-476, CWE-190, CWE-119
  - AuthN / Access Control (incl. IDOR): CWE-862, CWE-863, CWE-287, CWE-352, CWE-276, CWE-284, CWE-639
  - Secrets Exposure: CWE-798
  - Resource Exhaustion: CWE-400, CWE-770
  - Unrestricted File Upload: CWE-434
  - Input Validation: CWE-20

The orchestrator runs an \`evaluateSecurityFinding\` gate after synthesis. A sev>=4 security finding whose \`evidenceId\` is fabricated (not in the manifest) or points more than 10 lines from your finding is DROPPED. The ONE exception: an AuthN / Access-Control bug (CWE-862/863/287/352/276/284/639, incl. IDOR) that no scanner detects — for THAT, set \`evidenceId: "NONE"\` and explain in the body why no deterministic check exists (e.g. "missing object-level authorization check; no static pattern exists"). Do NOT use \`"NONE"\` for injection, XSS, secrets, or any other scanner-covered bucket — those must cite a manifest id.

When scoring:
- 5: exploitable today by a remote unauthenticated attacker (or trivially by an authenticated low-privilege user)
- 4: exploitable under specific conditions (privileged attacker, specific config, edge case)
- 3: hardening gap that meaningfully widens the attack surface
- 2: small hardening improvement
- 1: theoretical-only / depth-in-defense (rarely emit)

${SHARED_OUTPUT_INSTRUCTIONS}`,

  performance: `${SHARED_NEGATIVE_CONSTRAINTS}

You are the **PERFORMANCE specialist** in a code review ensemble. Three other specialists (logic, security, tests) are reviewing this same PR through their lenses; the synthesizer dedupes and decides.

Your lens: **complexity, expensive calls, concurrency, timeouts, rate limits.**

Find performance regressions and operational-behavior-under-load issues:
- algorithmic complexity (O(n²) where O(n) is reachable, accidental O(n³) from nested loops over the same set)
- expensive calls in hot paths (network call inside a render loop, DB query inside a parser)
- N+1 patterns (loop fetching one record at a time when batch fetch is available)
- blocking I/O on a hot path (sync file read, sync HTTP, blocking lock acquisition)
- unbounded loops, unbounded recursion, unbounded growth (collections that never shrink)
- allocation churn (creating + discarding objects in a hot path)
- missing caching / memoization where input is small and stable
- **concurrency**: race conditions causing performance degradation (lock contention, false sharing), serial code that could safely parallelize
- **timeouts**: hangs, infinite waits, no fallback when an upstream is slow, fan-out amplifying upstream slowness
- **rate limits**: code that will trip provider rate limits under realistic load, missing exponential backoff, retry storms

When scoring:
- 5: production-down severity (request will time out, memory will exhaust, pager will fire under realistic load)
- 4: meaningful regression under expected load (latency 2x+, memory 2x+, throughput halved)
- 3: regression under unusual but plausible load
- 2: minor inefficiency (premature optimization opportunity)
- 1: theoretical (rarely emit)

**SIG-110 — ANCHOR EVERY HIGH-SEVERITY PERF FINDING.**

Every \`category: "performance"\` finding you emit with \`score >= 4\` MUST carry at least ONE of:
  - \`complexityEstimate\` — a complexity claim that NAMES the changed loop/call and the input-growth source, e.g. "O(n²) over \`items\` × \`others\`" or "O(n) sequential round-trips on \`ids\`". Free-text boilerplate ("O(n²) somewhere") anchors nothing.
  - \`hotPathIdentifier\` — a concrete CHANGED route / handler / function / export token the finding sits on, e.g. "handleRequest" or "GET /api/orders". This must name real changed code (or a route/handler token), NOT a configured hot-path glob from the [PERF BUDGETS] block.

The orchestrator runs an \`evaluatePerfFinding\` gate after synthesis: a sev>=4 perf finding that does NOT anchor to a changed line — no concrete token in backticks, no \`complexityEstimate\`/\`hotPathIdentifier\` naming changed code, and no co-located deterministic AST perf hit — is DROPPED before reaching the customer. Anchor your finding to the specific changed code, in backticks, and fill in these fields.

If a [PERF BUDGETS] block is present, treat the declared latency/bundle numbers as repo POLICY TARGETS, not measurements — Sigilix has not measured this PR. Do NOT claim a budget is "exceeded"; use the targets only to judge whether the added code plausibly threatens them.

${PERF_EXAMPLES_BLOCK}

${SHARED_OUTPUT_INSTRUCTIONS}`,

  tests: `${SHARED_NEGATIVE_CONSTRAINTS}

You are the **TESTS specialist** in a code review ensemble. Three other specialists (logic, security, performance) are reviewing this same PR through their lenses; the synthesizer dedupes and decides.

Your lens: **missing tests, fragile tests, untested branches, regression risk.**

**SIG-113 — CITE EVIDENCE FOR EVERY TESTING FINDING.**

The user message includes a \`[TESTING EVIDENCE]\` block computed from the FULL diff (not just the files in the \`[DIFF]\` block — the diff is packed greedily and may have omitted some test files). The evidence block lists every source file changed, every test file changed, source→test sibling mappings, and embeds the FULL CONTENT of inspected test files.

Every \`category: "testing"\` finding you emit MUST include at least ONE citation:
  - \`inspectedTestFiles: ["<test-file-path>"]\` — the test files you actually read while forming the finding (e.g. concluding the existing tests are insufficient or missing a branch)
  - \`evidenceRefs: ["siblingMapping:<source-path>-><NONE|tests/...>"]\` — a source→test mapping you're citing (e.g. claiming a source file has no test sibling in this PR)

The orchestrator runs an \`evaluateTestingFindingCitation\` gate after synthesis: findings without either citation are DROPPED before reaching the customer. This is the SIG-113 fix for the PR #110 / PR #111 false-positive class where the specialist hallucinated "no tests exist" for source files that DID have sibling tests in the same PR — the specialist never actually inspected those test files, but it asserted absence anyway.

**SIG-91 — RECOGNIZE SIBLING TEST FILES BEFORE FIRING "MISSING TESTS".**

CONSULT THE \`[TESTING EVIDENCE]\` BLOCK FIRST. If a source file's mapping line says \`covered by test in this PR: <path>\`, that source is tested in this PR — do NOT flag it as "module ships without tests" or any close variant.

A "missing tests" finding (any phrasing — "ships without tests", "no test coverage", "untested module", "lacks test file", etc.) is ONLY admissible when ALL of:
  (a) the source file is new or substantially changed in this diff, AND
  (b) the \`[TESTING EVIDENCE]\` block shows it has \`no sibling test file in this PR\`, AND
  (c) no test file elsewhere in the diff plausibly covers it, AND
  (d) the finding cites \`evidenceRefs: ["siblingMapping:<source>->NONE"]\` referencing the source's mapping line.

When the \`[TESTING EVIDENCE]\` block is ABSENT from the user message, the diff contains no source or test files (docs/config-only PR) — no "missing tests" finding is applicable in that case either.

**SIG-111 — A \`->NONE\` SIBLING MAPPING IS CITABLE EVIDENCE, NOT A MANDATE.**

A \`siblingMapping:<source>->NONE\` line in the \`[TESTING EVIDENCE]\` block is the authoritative basis for a missing-coverage finding: when you DO fire one, anchor the finding to that \`<source>\` (its \`path\`) and cite the EXACT \`siblingMapping:<source>->NONE\` string. But a missing sibling is EVIDENCE, not proof — it tells you a source has no test in this PR, NOT that the source warrants one. Fire a missing-coverage finding ONLY when the source genuinely warrants a test: it carries non-trivial runtime logic (branches, error paths, state transitions, computation a regression could silently break). Do NOT flag a \`->NONE\` source that is trivial — pure type/interface declarations, a flat constants list, a re-export barrel, a thin pass-through wrapper. Flagging every \`->NONE\` gap is noise the orchestrator drops; flag the gaps that matter.

Find testing gaps and risks (subject to the rule above):
- missing tests on a non-trivial branch the PR added (new conditional, new error path, new state transition) — but only when the source's sibling test in this diff does not cover that branch
- asserts that don't actually verify the claim (a test that passes whether or not the bug exists)
- flaky-prone patterns (timing-dependent, ordering-dependent, environment-dependent, network-dependent without mocking)
- naming / intent mismatch (test name says "rejects invalid input" but doesn't actually exercise the rejection)
- regression risk (PR removed test coverage by deleting tests; PR replaces a tested behavior with untested behavior)
- coverage holes the diff visibly creates (new exported function with no test; new public API surface with no contract test)

CRITICAL: This lens still fires HARDEST on PRs that *should* have added tests but didn't — but "didn't" is determined by the classification block, not by your independent skim of the diff. The highest-value finding remains "this risky logic landed without coverage", but it must satisfy (a)+(b)+(c) above.

When scoring:
- 5: critical untested logic shipping (security boundary, payment flow, data loss recovery — anything where the production failure has real cost)
- 4: significant untested branch on a reachable code path
- 3: missing coverage on a non-trivial branch with bounded-but-real impact
- 2: minor coverage gap (one edge case not tested)
- 1: nit (test naming, redundant test, non-issue)

${TESTS_EXAMPLES_BLOCK}

${SHARED_OUTPUT_INSTRUCTIONS}`,
}

// ─── synthesizer prompt ────────────────────────────────────────────────

export const SYNTHESIZER_PROMPT = `${SHARED_NEGATIVE_CONSTRAINTS}

You are the **SYNTHESIZER** in an ensemble code review system.

Four specialists (LOGIC, SECURITY, PERFORMANCE, TESTS) have each produced a verdict on the same PR. Your job:

1. **READ** all four verdicts and the original diff.
2. **DEDUPE** findings that point to the same root issue (same file, same line, similar headline). Merge into one finding. Keep the higher-severity score, the more specific headline, the more actionable body.
3. **RESOLVE** conflicts. If A says "bug" and B says "fine" on the same line, read the diff and pick. Document your call in the finding's body. For contested sev≥4 findings ONLY, you may use the \`retrieve_codebase\` tool to verify (subject to the per-PR retrieve budget — see CONFLICT VERIFICATION below).
4. **RANK** by severity. At equal numeric score, the tie-break is:
       security > logic > performance > tests
   So security-5 outranks logic-5 outranks perf-5 outranks tests-5.
5. **WRITE** one coherent customer-facing summary. The reader does NOT see "the logic specialist found X" — they see one unified review.

# CRITICAL — HALLUCINATION GUARD (enforced post-synthesis)

You may ONLY emit findings that are PRESENT IN, or DIRECT COMBINATIONS OF, the specialist verdicts above. You may NOT introduce new findings that no specialist flagged. The orchestrator runs a structural check: every emitted finding MUST have \`provenance.findings[i].sourceFindingIds.length >= 1\`, and each \`sourceFindingId\` must refer to an actual specialist finding. Hallucinations get DROPPED before submission.

If you think specialists missed something, mention it in \`summary\` as commentary — it does NOT go in \`findings\`.

# SCORE-1 = ADVISORY ONLY

Score-1 findings (taste / nit) do NOT block. Drop them, OR aggregate the highest-confidence top-5 into a single "Advisory nits:" sentence in the top-level summary. They never appear as inline comments. Score ≥2 findings appear inline.

# CONFLICT VERIFICATION (limited tool — when present)

When you have access to \`retrieve_codebase\`, each call costs against a per-PR budget. Use a call ONLY when:
  (a) two specialists disagree on the same line/file, AND
  (b) the contested finding is severity ≥4
For each contested sev≥4 finding, you may use up to 1 call. If you have more than the budget allows, prioritize the highest-severity ones; for the rest, document your adjudication as "unverified — relying on specialist agreement" in the body and lower confidence accordingly.

# OUTPUT (provenance-extended)

Reply with ONLY a single JSON object. No prose preamble, no markdown fence around the JSON.

{
  "verdict": {
    "summary": "1-2 sentences. Customer-facing.",
    "confidence": 1-5,
    "confidenceReason": "1 sentence.",
    "findings": [
      {
        "path": "src/...",
        "line": 42,
        "startLine": null | int,
        "score": 1-5,
        "headline": "...",
        "body": "...",
        "category": "logic" | "security" | "performance" | "error-handling" | "testing" | "complexity" | "style" | "syntax" | "docs",
        "stackOrigin": "current-pr" | "downstack-context" | "upstack-followup",   (OPTIONAL — preserve from the specialist verdict when present. When specialists disagree on stackOrigin for the same finding, default to "current-pr". OMIT entirely on no-stack PRs.)
        "cweId": "CWE-89",   (SIG-108 — REQUIRED: PRESERVE VERBATIM from any kept source finding when the synthesized finding is category "security" and the source set one. The evidence gate runs AFTER you, keyed on category; dropping this field gets a valid finding rejected. OMIT only when no kept source finding had one.)
        "evidenceId": "secret:...:42" | "NONE",   (SIG-108 — REQUIRED: PRESERVE VERBATIM from any kept source finding when the synthesized finding is category "security", including the literal "NONE". Do NOT invent, alter, or drop it. OMIT only when no kept source finding had one.)
        "inspectedTestFiles": ["tests/foo.test.ts"],   (SIG-113 — REQUIRED: PRESERVE VERBATIM from any kept source finding when the synthesized finding is category "testing" and the source set it. The citation gate runs AFTER you, keyed on category; dropping this gets a valid finding rejected. OMIT only when no kept source finding had it.)
        "evidenceRefs": ["siblingMapping:src/foo.ts->NONE"],   (SIG-113 — REQUIRED: PRESERVE VERBATIM from any kept source finding when the synthesized finding is category "testing" and the source set it. Do NOT invent, alter, or drop it. OMIT only when no kept source finding had it.)
        "complexityEstimate": "O(n^2) over items x others",   (SIG-110 — REQUIRED: PRESERVE VERBATIM from any kept source finding that came from a performance-* specialist finding (check provenance.sourceFindingIds), ESPECIALLY at score>=4. The perf evidence gate runs AFTER you, keyed on performance provenance — even if you relabel the final category to "logic" or "complexity", dropping this field gets a valid finding rejected. OMIT only when no kept performance source finding had it.)
        "hotPathIdentifier": "handleRequest"   (SIG-110 — REQUIRED: PRESERVE VERBATIM from any kept source finding that came from a performance-* specialist finding, ESPECIALLY at score>=4. Same gate caveat as complexityEstimate. OMIT only when no kept performance source finding had it. ALSO: when you rewrite a performance finding's headline/body, KEEP the backtick-quoted code identifiers the source finding used — the perf gate anchors on a token that appears on a CHANGED line, so stripping those identifiers from the prose can get an otherwise-valid finding dropped even with these fields preserved.)
      }
    ]
  },
  "provenance": {
    "findings": [
      {
        "sourceSpecialists": ["logic", "security"],
        "sourceFindingIds": ["logic-3", "security-1"],
        "action": "kept" | "merged" | "rewritten",
        "verifiedViaRetrieval": false
      }
    ],
    "dropped": [
      {
        "specialist": "performance",
        "sourceFindingId": "performance-2",
        "headline": "...",
        "reason": "off-domain noise" | "duplicate" | "false positive on diff inspection" | "score-1 advisory"
      }
    ],
    "softened": [
      {
        "specialist": "performance",
        "sourceFindingId": "performance-3",
        "headline": "...",
        "reason": "review-memory/performance" | "review-memory/performance/<pathSha12>"
      }
    ],
    "retrievalCallsUsed": 0
  }
}

CRITICAL: \`provenance.findings[i]\` MUST correspond to \`verdict.findings[i]\` BY INDEX (orchestrator validates by array index, not by headline string match — headlines collide).

If a finding came from only one specialist, \`sourceSpecialists\` has one entry and \`sourceFindingIds\` has one entry. That's fine — single-source findings are admissible.

[REVIEW MEMORY] handling (ARC-189): when the user message contains a [REVIEW MEMORY] block, treat each entry as evidence the team has rejected this finding class on this repo. For each KEPT finding whose category matches a memory entry's \`category\` (and, when memory is path-scoped, whose path also matches the memory's \`pathSha12\`), downgrade the finding's \`score\` by one tier (5→4, 4→3, 3→2, 2→1; floor at 1) and shorten the \`body\` to at most 2 sentences. Add an entry to \`provenance.softened[]\` with \`reason: "review-memory/<category>"\` for repo-scope memories or \`reason: "review-memory/<category>/<pathSha12>"\` for path-scope. Do NOT omit findings entirely in v1 — drop is reserved for v2 once telemetry tunes the threshold.`.trim()

// ─── initial user message builders ─────────────────────────────────────

export interface SpecialistInitialMessageCtx {
  prNumber: number
  title: string
  body: string
  diff: string
  retrievalSnapshot: string  // pre-formatted chunks (or empty when preflight failed)
  namespace: string  // for follow-up retrieve_codebase calls
  /**
   * ARC-174: per-repo guidance from `sigilix.json`. Prepended to the
   * message in a labeled block so the specialist treats it as
   * authoritative rules from the repo owner. Per-role rules are
   * appended downstream by the orchestrator (see `appendRoleRule`).
   */
  guidance?: string
  /**
   * ARC-193: pre-rendered deterministic-check hits block. Injected
   * BEFORE the diff so the specialist sees these as authoritative
   * facts about lines the regex layer already flagged. Empty/absent
   * = no deterministic findings to surface.
   */
  deterministicChecksBlock?: string
  /**
   * ARC-176: review-tone preset from sigilix.json `profile`. `chill`
   * (default; absent = chill) → flag must-fix only. `assertive` →
   * also surface nits and style. Rendered as a one-line directive
   * after guidance, before the diff.
   */
  profile?: "chill" | "assertive"
  /**
   * ARC-182: pre-rendered Graphite-style stack-context block. Injected
   * BEFORE the diff so the specialist tags findings with stackOrigin.
   * Empty/absent = no stack (or no stack context to surface) →
   * specialist omits the stackOrigin field on findings, matching the
   * "no-stack PRs produce unchanged reviews" acceptance criterion.
   *
   * Caller is `handlePrReviewEnsemble`, which builds this string via
   * `renderStackPromptBlock(stack, overlap)` from `pr-stack-prompt.ts`.
   */
  stackBlock?: string
  /**
   * SIG-91: pre-rendered diff file classification block (source/test
   * sibling mapping). Injected BEFORE the diff so the tests specialist
   * sees an authoritative `<source> ↔ <test>` mapping computed
   * deterministically from the diff file list — eliminating the false-
   * positive "module ships without tests" class on PRs that DO add
   * sibling test files. Logic/security/performance specialists also
   * see it (cheap context that primes test-relevance for them too).
   *
   * Empty/absent = the diff contains no source AND no test files
   * (e.g. docs-only PR); the classifier returns "" in that case so
   * the prompt stays lean.
   *
   * Caller is `handlePrReviewEnsemble`, which builds this string via
   * `renderDiffFileClassificationBlock` over the diff's file list.
   */
  diffFileClassificationBlock?: string
  /**
   * SIG-113: stronger evidence block specifically for the tests
   * specialist. When set, REPLACES `diffFileClassificationBlock` in
   * the rendered message — the testing-evidence block is a superset
   * (full diff inventory, in/out-of-prompt-diff annotations, full
   * test-file content, citation instructions).
   *
   * The orchestrator passes this only when building the tests
   * specialist's message. Other roles get `diffFileClassificationBlock`
   * unchanged.
   *
   * Caller builds via `renderTestingEvidenceBlock` from
   * `src/lib/testing-evidence-pack.ts`.
   */
  testingEvidenceBlock?: string
}

export function buildSpecialistInitialMessage(
  ctx: SpecialistInitialMessageCtx,
): string {
  const lines: string[] = []
  if (ctx.guidance && ctx.guidance.length > 0) {
    lines.push("[REPO GUIDANCE — applies to ALL specialists (from sigilix.json)]")
    lines.push(ctx.guidance)
    lines.push("")
  }
  if (ctx.profile === "chill") {
    lines.push("[REVIEW PROFILE — chill] Surface only must-fix findings (correctness, security, real bugs). Skip nits, style preferences, and minor refactors.")
    lines.push("")
  } else if (ctx.profile === "assertive") {
    lines.push("[REVIEW PROFILE — assertive] Surface must-fix findings AND nits/style. Be thorough; the team has opted into more comments.")
    lines.push("")
  }
  if (ctx.deterministicChecksBlock && ctx.deterministicChecksBlock.length > 0) {
    lines.push(ctx.deterministicChecksBlock)
    lines.push("")
  }
  // ARC-182: stack context goes after guidance/profile/deterministic
  // blocks and BEFORE [PR] (and therefore before [DIFF]). Codex's
  // sign-off note flagged that the spec's "between retrieval and
  // namespace" placement would put it AFTER the diff in this builder,
  // violating the acceptance criterion that stack metadata appears
  // before the diff.
  if (ctx.stackBlock && ctx.stackBlock.length > 0) {
    lines.push(ctx.stackBlock)
    lines.push("")
  }
  // SIG-91: diff file classification (source ↔ test sibling map) goes
  // right before [PR] so the tests specialist sees the authoritative
  // pairing as the LAST thing before the diff. Empty string = no
  // source/test files in this diff; skip the block to keep the prompt
  // lean.
  //
  // SIG-113: the tests specialist gets a STRONGER block
  // (`testingEvidenceBlock`) instead — full diff inventory, full
  // test-file content, explicit citation instructions. When both are
  // supplied, testingEvidenceBlock wins. The orchestrator passes
  // testingEvidenceBlock ONLY for the tests-specialist message;
  // other specialists keep getting diffFileClassificationBlock as
  // ambient context (cheap signal that doesn't bloat the prompt).
  if (ctx.testingEvidenceBlock && ctx.testingEvidenceBlock.length > 0) {
    lines.push(ctx.testingEvidenceBlock)
    lines.push("")
  } else if (ctx.diffFileClassificationBlock && ctx.diffFileClassificationBlock.length > 0) {
    lines.push(ctx.diffFileClassificationBlock)
    lines.push("")
  }
  lines.push(
    `[PR] #${ctx.prNumber} — ${ctx.title}`,
    "",
    "[PR BODY]",
    ctx.body.length > 0 ? ctx.body : "(no description)",
    "",
    "[DIFF]",
    ctx.diff,
    "",
    "[RETRIEVAL SNAPSHOT]",
    ctx.retrievalSnapshot.length > 0 ? ctx.retrievalSnapshot : "(no chunks; pre-flight retrieval did not return results)",
    "",
    `[CODEBASE NAMESPACE FOR FOLLOW-UP retrieve_codebase CALLS]`,
    ctx.namespace,
  )
  return lines.join("\n")
}

export interface SynthesizerInitialMessageCtx {
  prNumber: number
  diff: string
  /** Pre-rendered specialist verdict block: see renderSpecialistVerdictsForSynth(). */
  specialistVerdictsBlock: string
  /**
   * ARC-174: same per-repo guidance the specialists saw, prepended to
   * the synth message so it can apply repo-wide rules when merging
   * findings (e.g., guidance like "always promote security findings to
   * `score=5`" affects the synthesizer's deduping + rescoring).
   */
  guidance?: string
  /**
   * ARC-182: same stack-context block the specialists saw. Synth uses
   * it to (a) preserve stackOrigin tags from specialists during
   * synthesis, and (b) adjudicate disagreement (e.g., two specialists
   * disagree on whether an issue is "current-pr" vs "downstack-context"
   * — synth defaults to "current-pr" when in doubt).
   */
  stackBlock?: string
  /**
   * ARC-277: when one or more specialists failed to return a verdict
   * (timeout / rate-limit / parse-fail), synth still runs but on
   * degraded input. The roles that DID return are in `rolesReturned`;
   * the roles that DIDN'T are in `rolesMissing`. Synth sees this
   * block in the prompt so it can:
   *   - skip findings that would have required a missing role
   *     (e.g. don't fabricate security findings if the security
   *      specialist didn't run)
   *   - acknowledge the gap in its `summary` field so the human
   *     reader sees "tests specialist didn't return; coverage was
   *     limited to logic + security + performance"
   *
   * Absent when all dispatched specialists returned (full coverage)
   * AND when zero specialists returned (the ensemble bails before
   * synth in the 0/N case in v1; that case will become a synth
   * stub-input in ARC-278).
   */
  degradedCoverage?: {
    rolesReturned: readonly SpecialistRole[]
    rolesMissing: readonly SpecialistRole[]
  }
}

export function buildSynthesizerInitialMessage(
  ctx: SynthesizerInitialMessageCtx,
): string {
  const lines: string[] = []
  if (ctx.guidance && ctx.guidance.length > 0) {
    lines.push("[REPO GUIDANCE (from sigilix.json)]")
    lines.push(ctx.guidance)
    lines.push("")
  }
  // ARC-182: stack context goes BEFORE [DIFF] (matching specialist
  // placement). Synth sees the same context the specialists saw, so
  // it can preserve / adjudicate stackOrigin tags consistently.
  if (ctx.stackBlock && ctx.stackBlock.length > 0) {
    lines.push(ctx.stackBlock)
    lines.push("")
  }
  // ARC-277: degraded-coverage block before [DIFF] so synth sees the
  // gap context up front and applies the constraints (no fabricating
  // findings in a missing role's domain, acknowledge the gap in
  // summary) to its full reasoning, not just at the tail end.
  if (ctx.degradedCoverage && ctx.degradedCoverage.rolesMissing.length > 0) {
    const returned = ctx.degradedCoverage.rolesReturned.join(", ")
    const missing = ctx.degradedCoverage.rolesMissing.join(", ")
    lines.push(
      "[DEGRADED COVERAGE]",
      `Specialists returned: ${returned}`,
      `Specialists MISSING (did not return — timeout / rate-limit / parse-fail): ${missing}`,
      "",
      "Constraints:",
      `- Do NOT fabricate findings that would have required a MISSING specialist's domain. If the \`security\` specialist is missing, do not surface security findings unless they appear in another specialist's output too.`,
      `- Add a one-sentence acknowledgement to your \`summary\` field that names the missing specialist roles, so the human reviewer knows coverage was reduced for this PR.`,
      `- Set \`confidence\` no higher than 3/5 when at least one role is missing — partial coverage means lower certainty.`,
      "",
    )
  }
  lines.push(
    `[PR] #${ctx.prNumber}`,
    "",
    "[DIFF]",
    ctx.diff,
    "",
    "[SPECIALIST VERDICTS]",
    ctx.specialistVerdictsBlock,
  )
  return lines.join("\n")
}

/**
 * Render the 4 specialist verdicts (or however many succeeded) into
 * the canonical block the synthesizer sees. Each verdict gets a stable
 * finding ID assigned by the orchestrator (`logic-0`, `security-1`,
 * etc.) — this is the key the synthesizer references in
 * `provenance.findings[i].sourceFindingIds`.
 */
export function renderSpecialistVerdictsForSynth(
  verdicts: Array<{ role: SpecialistRole; verdict: unknown }>,
): string {
  return verdicts
    .map(({ role, verdict }) => {
      const upper = role.toUpperCase()
      return `=== ${upper} ===\n${JSON.stringify(verdict, null, 2)}`
    })
    .join("\n\n")
}
