// SIG-477 PR-1 — the execution-sandbox ELIGIBILITY GATE (the measurement
// instrument). DARK: this PR runs the gate in shadow and records the eligible
// fraction over real prod findings; NOTHING executes, renders, or mutates a tier.
// The gate decides whether the whole engine (the QuickJS runner, PR-2+) is worth
// building: don't build it until we know what share of real findings are even
// eligible to be reproduced (standalone + I/O-free + admit a non-fabricated
// two-sided test).
//
// "Eligible" = the finding's cited code is SAFE + STANDALONE enough that a future
// sandbox could lift it verbatim, run it, and observe the predicted failure
// without (a) reaching out to the network / disk / db / env, or (b) fabricating a
// request payload. The gate is the SECURITY boundary that defines the executable
// set even though nothing executes in this PR.
//
// UNDER-STRICT-SAFE: every gate fails OPEN to ineligible. Any uncertainty — an
// unparseable snippet, a missing class, a borderline sink — returns
// `{ eligible: false, reason }`. The helper NEVER throws, so it can never crash a
// review (the recall-safety bar: a measurement instrument that breaks a review is
// worse than one that under-counts the eligible set).
//
// Pure + side-effect-free + dependency-light (only the AST parser/walker leaves,
// already used across the lib layer). Heavily unit-tested.

import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import { parseSource, walkAst, type SourceExt, type AstNode } from "@/src/features/ast-rules"

/** The eligibility decision for ONE finding. `eligible` gates the future sandbox;
 *  `reason` is a stable machine-readable tag (telemetry + the shadow corpus);
 *  `klass` is the matched executable class (only set when eligible). */
export interface ReproduceEligibility {
  eligible: boolean
  reason: string
  klass?: string
}

/**
 * SIG-477 PR-1 — the reproduce gate mode (`OPENCLAW_REPRODUCE_MODE`). `off`
 * (default): the gate doesn't run. `shadow`: compute + telemeter the eligible
 * fraction (the `reproduce_eligibility` corpus on VerificationMetricsDO), NO
 * behavior change. `on`: PR-1 still ONLY measures — the engine (execute → tier
 * annotate) is PR-5; even `on` mutates nothing here. Three-state with `off`
 * default, mirroring `parseSelfConfirmMode` / `parseReceiptJoinMode`. */
export type ReproduceMode = "off" | "shadow" | "on"

export function parseReproduceMode(raw: string | undefined): ReproduceMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "on") return "on"
  return "off"
}

/**
 * SIG-477 v1 executable allowlist. Three classes whose failure is reproducible by
 * re-running a PURE closure (no request taint, no I/O) and observing a two-sided
 * test — the design's measure-first set:
 *   - "redos"              — catastrophic-backtracking / ReDoS: re-run the regex on
 *                            an adversarial input string, observe the time blow-up.
 *   - "pure-function-logic"— off-by-one / fence-post / parser-coercion: re-run the
 *                            function on a boundary input, observe the wrong result.
 *   - "hmac-byte-divergence"— a digest/compare divergence: re-run the byte
 *                            computation, observe the mismatch.
 * Deliberately EXCLUDES the taint-flow vuln classes (sql/ssrf/path/cmd/ssti/xxe/
 * proto-pollution/idor): their sink is REQUEST-TAINTED, so any two-sided test would
 * force the harness to FABRICATE the attacker payload — exactly the non-fabrication
 * bar Gate 3 refuses on. Those stay receipt-/scanner-grounded, not reproduced. */
export type ExecutableClass = "redos" | "pure-function-logic" | "hmac-byte-divergence"

export const EXECUTABLE_CLASSES: ReadonlySet<ExecutableClass> = new Set<ExecutableClass>([
  "redos",
  "pure-function-logic",
  "hmac-byte-divergence",
])

// --- Gate 1 helpers ---------------------------------------------------------

/** Does the finding carry a real manifest evidenceId (the SIG-108 security-evidence
 *  path)? Mirrors verify-and-build's `hasManifestEvidence` so the GROUNDED-or-
 *  stronger gate reads the SAME predicate. */
function hasManifestEvidence(finding: Pick<PrReviewFinding, "evidenceId">): boolean {
  const ev = typeof finding.evidenceId === "string" ? finding.evidenceId.trim() : ""
  return ev.length > 0 && ev !== "NONE"
}

/** Is the finding already GROUNDED-or-stronger? Either a real manifest evidenceId
 *  OR a real trust tier (anything the trust ledger lifted above MODEL). The gate's
 *  population is findings that already passed grounding — we never propose
 *  reproducing an ungrounded model guess. */
function isGroundedOrStronger(finding: Pick<PrReviewFinding, "evidenceId" | "trust">): boolean {
  if (hasManifestEvidence(finding)) return true
  const tier = finding.trust?.tier
  return (
    tier === "runner-confirmed" ||
    tier === "reproduced-by-execution" ||
    tier === "deterministic-confirmed" ||
    tier === "deterministic-grounded" ||
    tier === "worker-token-confirmed" ||
    tier === "grounded-model"
  )
}

/** Lowercased free-text the class matcher reads — headline + body. Cited code
 *  fields are NOT included here (they describe the FIX, not the bug-class). */
function classifyText(finding: Pick<PrReviewFinding, "headline" | "body">): string {
  return `${finding.headline ?? ""}\n${finding.body ?? ""}`.toLowerCase()
}

/**
 * Derive the finding's EXECUTABLE class from FINDING-OWN free-text signals, or
 * null when it doesn't name one of the allowlisted classes. Keyword-based (the
 * model names these classes in plain language; there is no deterministic AST
 * rule-id for ReDoS / off-by-one / hmac-byte divergence the way there is for the
 * taint-flow classes). Conservative: an ambiguous text → null → ineligible.
 *
 * SIG-477: the keyword list can't enumerate every way the model DESCRIBES a
 * boundary/off-by-one bug — it often names the SYMPTOM ("can return len", "is out
 * of bounds", "reads one past the end") rather than the class. So `category ===
 * "logic"` is a FALLBACK class signal: a logic-specialist finding that survived
 * grounding is a pure-function-logic CANDIDATE. This only widens the CANDIDATE
 * set — Gate 2 (purity) + Gate 3 (liftable, non-request-tainted) + the
 * reconstruction's unique-near-twin requirement + the harness's diverge-AND-stable
 * test are the real filters, so an over-broad class never inflates the REPRODUCED
 * set for a BEHAVIOR-PRESERVING change (it yields `inconclusive`). The residual
 * risk is a behavior-CHANGING WRONG fix on already-correct code (a model FP): the
 * harness proves buggy≠fix, NOT buggy-is-wrong, so it CAN reproduce — the GROUNDING
 * gate (Gate 1a) is the SOLE filter for that class, and this fallback widens the
 * grounded-logic population reaching it. Acceptable while grounding holds; revisit
 * if logic findings start grounding cheaply.
 */
export function executableClassForFinding(
  finding: Pick<PrReviewFinding, "headline" | "body"> & Partial<Pick<PrReviewFinding, "category">>,
): ExecutableClass | null {
  const t = classifyText(finding)
  // ReDoS / catastrophic backtracking.
  if (/\bredos\b/.test(t) || /catastrophic backtrack/.test(t) || /regex(?:p|ular expression)?\s+dos/.test(t)) {
    return "redos"
  }
  // HMAC / digest byte divergence (a crypto compare/serialize mismatch).
  if (/hmac/.test(t) && (/byte/.test(t) || /diverg/.test(t) || /mismatch/.test(t) || /reserializ/.test(t))) {
    return "hmac-byte-divergence"
  }
  // Pure-function logic: off-by-one / fence-post / boundary / coercion bugs whose
  // failure is a WRONG RETURN VALUE at a boundary input (re-runnable as a two-sided
  // test: buggy output ≠ corrected output). Broadened beyond the literal "off-by-one"
  // phrasing to the way the model actually names these. A generous class match only
  // widens the CANDIDATE set — every match still has to clear Gate 2 (purity) + Gate 3
  // (liftable, non-request-tainted), so an over-broad keyword never inflates the
  // EXECUTED set, and the pure-logic harness's agree+diverge requirement is the real
  // filter (a misclassified finding just yields `inconclusive`).
  if (
    /off[-\s]?by[-\s]?one/.test(t) ||
    /fence[-\s]?post|fencepost/.test(t) ||
    /\bboundary (?:condition|error|bug|case|check|issue|off)/.test(t) ||
    /\bone (?:too many|too few|extra|fewer|short) (?:iteration|element|item|index|character|char|loop|byte|row)/.test(
      t,
    ) ||
    /(?:<=|>=)[\s`'"]*should be[\s`'"]*(?:<|>)|(?:<|>)[\s`'"]*should be[\s`'"]*(?:<=|>=)/.test(t) ||
    /\bloop (?:bound|boundary|condition|range)\b[^.]*\b(?:off|wrong|incorrect|error|one|exclusive|inclusive)\b/.test(
      t,
    ) ||
    /\b(?:inclusive|exclusive)\b[^.]*\b(?:bound|range|index|end|boundary|slice|loop)\b/.test(t) ||
    /\b(?:parser|type|string|number|boolean) coercion\b/.test(t)
  ) {
    return "pure-function-logic"
  }
  // SIG-477 category fallback (see the doc-comment): a `logic`-category finding the
  // keyword list didn't name is still a pure-function-logic CANDIDATE — the downstream
  // purity/liftability gates, the near-twin reconstruction, and the harness's
  // diverge-AND-stable test remain the real filters. ReDoS / HMAC are matched above, so
  // this never mis-routes those (a logic finding worded as one already returned early).
  if (finding.category === "logic") {
    return "pure-function-logic"
  }
  return null
}

// --- Gate 2 helpers (dependency-closure purity) -----------------------------

/**
 * Impurity sinks the cited code's reachable closure must NOT touch for the future
 * sandbox to run it safely + standalone. A hit on ANY of these refuses (fail-
 * closed to ineligible). Two complementary detectors below read this set: a
 * STRUCTURAL one (callee/member names on the parsed AST) and a CONSERVATIVE
 * STRING one (raw substring, the backstop when the snippet can't be parsed as a
 * standalone closure). The string detector is intentionally over-broad — a false
 * INELIGIBLE only under-counts the measurement; a false ELIGIBLE would let an
 * impure closure into the executable set, which is the security failure we refuse.
 */
const IMPURITY_CALL_NAMES: ReadonlySet<string> = new Set([
  // network
  "fetch",
  "xmlhttprequest",
  "websocket",
  "eventsource",
  // child process
  "exec",
  "execsync",
  "spawn",
  "spawnsync",
  "fork",
  "execfile",
  // arbitrary-code-exec (would defeat the no-3rd-party / no-exec intent of the gate)
  "eval",
  "function", // Function(...) / new Function(...)
  // timers / async impurity (also non-deterministic → no stable two-sided test)
  "settimeout",
  "setinterval",
  "setimmediate",
  "queuemicrotask",
])

/** Member/object roots whose access implies I/O, globals, a 3rd-party client, OR
 *  non-determinism (which breaks the ≥5-run stable two-sided test the engine needs). */
const IMPURITY_MEMBER_ROOTS: ReadonlySet<string> = new Set([
  "fs",
  "process",
  "child_process",
  "document",
  "window",
  "globalthis",
  "localstorage",
  "sessionstorage",
  "navigator",
  "fetch",
  "crypto", // randomBytes/subtle etc. — impure + non-deterministic, never the pure slice
  "performance", // performance.now() — clock, non-deterministic
])

/** Bare-identifier references that are impure even WITHOUT a call (e.g. the aliased
 *  `const m = require; m("fs")` bypass): referencing any of these names at all in a
 *  "pure" closure is disqualifying. Fail-closed. */
const IMPURITY_IDENTIFIER_REFS: ReadonlySet<string> = new Set(["require", "eval", "globalthis", "process"])

/** `object.property` pairs that are impure even though the ROOT is otherwise pure
 *  (Math.floor/Math.max are pure; Math.random is not). Keyed root → impure props. */
const IMPURE_MEMBER_PAIRS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["math", new Set(["random"])],
  ["date", new Set(["now"])],
])

/** Conservative raw-substring sinks for the un-parseable backstop scan. Lowercased.
 *  Broad on purpose (fail-closed): any hit refuses. */
const IMPURITY_SUBSTRINGS: readonly string[] = [
  "fetch(",
  "xmlhttprequest",
  "websocket",
  "eventsource",
  "require(",
  "import(",
  "from 'node:",
  'from "node:',
  "node:fs",
  "node:child_process",
  "child_process",
  "fs.",
  "readfile",
  "writefile",
  "createreadstream",
  "createwritestream",
  "process.env",
  "globalthis",
  "localstorage",
  "sessionstorage",
  "document.",
  "window.",
  ".query(",
  ".execute(",
  ".connect(",
  ".collection(",
  ".findone(",
  "prisma.",
  "knex(",
  "mongoose",
  "createclient(",
  "new pool(",
  "exec(",
  "execsync(",
  "spawn(",
  // non-determinism / timers / clocks (break the ≥5-run stable two-sided test) +
  // arbitrary-exec. Specific tokens only — NOT bare `eval`/`function(`/`require`
  // (they over-match `retrieval`, function expressions, `required`, shrinking the
  // measurement); the structural AST walk catches those precisely when parseable.
  "settimeout",
  "setinterval",
  "setimmediate",
  "queuemicrotask",
  "math.random",
  "date.now",
  "new date",
  "performance.now",
  "crypto.",
]

/** AST-structural impurity check over a parsed standalone closure. Returns the
 *  matched sink (the reason fragment) or null. Walks Call/Member/Import nodes;
 *  ANY 3rd-party `import`/`require` is also impure (we can't bundle it). */
function structuralImpuritySink(ast: AstNode): string | null {
  let hit: string | null = null
  const note = (s: string) => {
    if (hit === null) hit = s
  }
  walkAst(ast, {
    ImportDeclaration: () => note("import"),
    ImportExpression: () => note("dynamic-import"),
    CallExpression: (node: AstNode) => {
      const callee = node?.callee
      if (callee?.type === "Identifier") {
        const name = String(callee.name ?? "").toLowerCase()
        if (name === "require") note("require")
        if (IMPURITY_CALL_NAMES.has(name)) note(name)
      }
    },
    NewExpression: (node: AstNode) => {
      const callee = node?.callee
      if (callee?.type === "Identifier") {
        const name = String(callee.name ?? "").toLowerCase()
        // `new Date()` is a clock read (non-deterministic); Function/exec covered by IMPURITY_CALL_NAMES.
        if (name === "date" || IMPURITY_CALL_NAMES.has(name)) note(name)
      }
    },
    MemberExpression: (node: AstNode) => {
      const obj = node?.object
      if (obj?.type === "Identifier") {
        const root = String(obj.name ?? "").toLowerCase()
        if (IMPURITY_MEMBER_ROOTS.has(root)) note(root)
        // root-pure-but-member-impure pairs (Math.random, Date.now) — not all of Math/Date.
        const prop = node?.property
        if (prop?.type === "Identifier") {
          const impureProps = IMPURE_MEMBER_PAIRS.get(root)
          if (impureProps?.has(String(prop.name ?? "").toLowerCase()))
            note(`${root}.${String(prop.name).toLowerCase()}`)
        }
      }
    },
    // Bare-identifier impurity refs (catches the aliased `const m = require` bypass
    // + any reference to eval/process/globalThis even without an immediate call).
    Identifier: (node: AstNode) => {
      if (IMPURITY_IDENTIFIER_REFS.has(String(node?.name ?? "").toLowerCase()))
        note(`ref:${String(node.name).toLowerCase()}`)
    },
  })
  return hit
}

/** Conservative raw-substring impurity scan (the un-parseable backstop). Returns
 *  the matched substring or null. Fail-closed: over-broad by design. */
function substringImpuritySink(code: string): string | null {
  const lc = code.toLowerCase()
  for (const s of IMPURITY_SUBSTRINGS) {
    if (lc.includes(s)) return s
  }
  return null
}

/** OUR deterministic AST detectors whose rule-id, when co-located on the finding's
 *  file, proves an I/O-adjacent / taint-flow sink lives in (or beside) the cited
 *  code — so the reachable closure is NOT pure. A conservative use of the available
 *  AST facts: the rule-id is the `ast/<ruleId>/<hash>/<line>` segment[1]. */
const IMPURE_AST_RULE_IDS: ReadonlySet<string> = new Set([
  "no-ssrf",
  "no-sql-injection",
  "no-nosql-injection",
  "no-path-traversal",
  "no-exec-shell-interpolation",
  "spawn-shell-true",
  "no-ssti",
  "no-xxe",
  "no-open-redirect",
  "no-sync-io-in-request-path",
  "no-process-env-mutation",
  "no-document-write-call",
])

/** Does an `ast/<ruleId>/<hash>/<line>` fact name an impure detector? */
function astFactRuleId(astFindingId: string): string | null {
  if (typeof astFindingId !== "string" || !astFindingId.startsWith("ast/")) return null
  const ruleId = astFindingId.split("/")[1]?.trim()
  return ruleId && ruleId.length > 0 ? ruleId : null
}

/**
 * Gate-2 closure-purity signal from the AVAILABLE AST facts: scan OUR co-located
 * security-roled detectors on the finding's file and refuse if any names an
 * I/O-adjacent / taint-flow sink (the impure rule-id set). Returns the matched
 * rule-id, or null when the finding's closure has no co-located impure fact. This
 * is the AST half of Gate 2's dependency-closure walk — see the LIMITATION in
 * `isReproducibleEligible`. */
function impureCoLocatedAstFact(
  finding: Pick<PrReviewFinding, "path">,
  astSecurityFindings: ReadonlyArray<{ path: string; line: number; astFindingId: string }>,
): string | null {
  for (const f of astSecurityFindings) {
    if (f.path !== finding.path) continue
    const ruleId = astFactRuleId(f.astFindingId)
    if (ruleId !== null && IMPURE_AST_RULE_IDS.has(ruleId)) return ruleId
  }
  return null
}

// --- Gate 3 helpers (non-fabricated two-sided test) -------------------------

/** Does the cited code read like a REQUEST-tainted fragment — i.e. running it
 *  would force the harness to fabricate `req`/`request`/`ctx`/`params`/`body` etc.?
 *  Such a fragment cannot admit a non-fabricated two-sided test, so it's
 *  ineligible (this is WHY the taint-flow classes are excluded — their sink is
 *  request-tainted). Conservative substring check on the cited code. */
const REQUEST_TAINT_TOKENS: readonly string[] = [
  "req.",
  "request.",
  "req[",
  "request[",
  "ctx.request",
  "event.request",
  ".params",
  ".query",
  ".body",
  "req,",
  "request,",
  "searchparams",
]

function looksRequestTainted(code: string): boolean {
  const lc = code.toLowerCase()
  return REQUEST_TAINT_TOKENS.some((tok) => lc.includes(tok))
}

/** Is a SINGLE cited fragment a LIFTABLE pure closure — a function/arrow/expression
 *  or a regex literal — rather than an empty or non-closure fragment? Parses as a
 *  standalone module; a clean parse with ≥1 function/regex/return is liftable. Never
 *  throws (parseSource returns ok:false on failure). */
function isLiftablePart(code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length === 0) return false
  // A bare regex literal admits a one-line two-sided test (ReDoS timing), so it's
  // liftable even though it isn't a function.
  if (/\/.+\/[a-z]*/.test(trimmed) && (trimmed.startsWith("/") || /=\s*\/.+\//.test(trimmed))) return true
  const parsed = parseSource(trimmed, ".ts" as SourceExt)
  if (!parsed.ok) return false
  let liftable = false
  walkAst(parsed.ast, {
    FunctionDeclaration: () => {
      liftable = true
    },
    FunctionExpression: () => {
      liftable = true
    },
    ArrowFunctionExpression: () => {
      liftable = true
    },
    ReturnStatement: () => {
      liftable = true
    },
    Literal: (node: AstNode) => {
      if (node?.regex) liftable = true
    },
  })
  return liftable
}

/** Does ANY cited fragment hold a liftable closure? Checked PER-FRAGMENT (not on the
 *  joined blob) to match how the harnesses lift code — each parses its candidates
 *  INDEPENDENTLY. The joined blob frequently fails to parse for a genuinely-liftable
 *  finding (e.g. the buggy `export function f` in `failureExample` AND the corrected
 *  `export function f` in `suggestedReplacement` → a duplicate-export SyntaxError, or
 *  prose mixed with a code fence) — gating those out would refuse exactly the findings
 *  the pure-logic harness CAN run. Per-fragment is strictly wider and never throws. */
function hasLiftableClosure(parts: readonly string[]): boolean {
  return parts.some(isLiftablePart)
}

// --- The gate ---------------------------------------------------------------

/** The cited-code FRAGMENTS the gates scan. Prefers the fields that carry VERBATIM
 *  code the harness would lift: the structured examples + the committable fix, then
 *  code-fenced regions of the body. Returned as parts so liftability is checked
 *  per-fragment (matching the harness) while impurity is checked on the join (a sink
 *  in ANY of them refuses). */
function citedCodeParts(
  finding: Pick<PrReviewFinding, "failureExample" | "fixExample" | "suggestedReplacement" | "astEvidence" | "body">,
): string[] {
  const parts: string[] = []
  for (const v of [finding.failureExample, finding.fixExample, finding.suggestedReplacement, finding.astEvidence]) {
    if (typeof v === "string" && v.trim().length > 0) parts.push(v)
  }
  // Pull fenced code blocks out of the body (```...```), which usually hold the
  // quoted buggy snippet for findings without the structured fields.
  const body = typeof finding.body === "string" ? finding.body : ""
  const fence = /```[a-z]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(body)) !== null) {
    if (m[1] && m[1].trim().length > 0) parts.push(m[1])
  }
  return parts
}

/**
 * Is this finding's cited code SAFE + STANDALONE enough to (eventually) execute?
 * Pure, side-effect-free, NEVER throws. The three gates, each fail-open to
 * ineligible:
 *
 *   Gate 1 — the finding is already GROUNDED-or-stronger AND names an executable
 *            allowlist class (ReDoS / pure-function-logic / hmac-byte-divergence;
 *            NOT the request-tainted taint-flow classes).
 *   Gate 2 — DEPENDENCY-CLOSURE PURITY: the cited code's closure must NOT touch
 *            network / fs / db / env / globals / child_process / DOM / 3rd-party
 *            imports. THREE detectors, ANY refuses: (a) co-located OUR AST facts
 *            naming an I/O-adjacent / taint-flow sink on the finding's file
 *            (`astSecurityFindings`), (b) the parsed-closure structural walk, and
 *            (c) a conservative raw-string backstop.
 *   Gate 3 — the cited code admits a NON-FABRICATED two-sided test: a liftable
 *            pure closure (function / regex / expression), NOT a request-tainted
 *            fragment that would force fabricating the attacker payload.
 *
 * LIMITATION (documented): a true reachable-closure graph would need the full file
 * AST + a call-graph resolver. From a quoted snippet we can't build that, so Gate 2
 * is CONSERVATIVE — it treats ANY co-located impure AST fact OR ANY sink token in
 * the cited code as in the closure (fail-closed to ineligible). A false INELIGIBLE
 * only under-counts the measurement; a false ELIGIBLE would admit an impure closure
 * into the executable set, the security failure we refuse. PR-5 replaces this with
 * the real closure walk over the sandbox-bundled module graph.
 *
 * @param finding the submitted finding.
 * @param astSecurityFindings OUR in-worker AST detector's security-roled hits
 *   ({path, line, astFindingId}) — Gate 2 consults the co-located impure rule-ids
 *   on the finding's file (its AST half).
 */
export function isReproducibleEligible(
  finding: Pick<
    PrReviewFinding,
    | "path"
    | "score"
    | "category"
    | "headline"
    | "body"
    | "evidenceId"
    | "trust"
    | "failureExample"
    | "fixExample"
    | "suggestedReplacement"
    | "astEvidence"
  >,
  astSecurityFindings: ReadonlyArray<{ path: string; line: number; astFindingId: string }>,
): ReproduceEligibility {
  try {
    // Gate 1a — already grounded? An ungrounded model guess is never a reproduce
    // candidate (we'd be executing a hallucination).
    if (!isGroundedOrStronger(finding)) {
      return { eligible: false, reason: "not-grounded" }
    }
    // Gate 1b — names an executable allowlist class? (excludes taint-flow classes).
    const klass = executableClassForFinding(finding)
    if (klass === null) {
      return { eligible: false, reason: "class-not-in-allowlist" }
    }

    const parts = citedCodeParts(finding)
    // Impurity is checked on the JOIN (a sink in ANY fragment refuses); liftability is
    // checked PER-FRAGMENT below (matching the harness's independent lifting).
    const code = parts.join("\n")
    if (code.trim().length === 0) {
      // No verbatim cited code to lift → can't reproduce → ineligible (fail-open).
      return { eligible: false, reason: "no-cited-code" }
    }

    // Gate 2 — dependency-closure purity. THREE detectors (any refuses): the
    // co-located AST facts (OUR detectors naming an I/O / taint-flow sink on the
    // finding's file), the parsed-closure STRUCTURAL walk, and the CONSERVATIVE
    // substring backstop (catches sinks the structural walk can't reach when the
    // snippet doesn't parse as a clean module). See the LIMITATION above.
    const astSink = impureCoLocatedAstFact(finding, astSecurityFindings)
    if (astSink !== null) {
      return { eligible: false, reason: `impure-closure:ast:${astSink}` }
    }
    const substringSink = substringImpuritySink(code)
    if (substringSink !== null) {
      return { eligible: false, reason: `impure-closure:${substringSink}` }
    }
    const parsed = parseSource(code.trim(), ".ts" as SourceExt)
    if (parsed.ok) {
      const structuralSink = structuralImpuritySink(parsed.ast)
      if (structuralSink !== null) {
        return { eligible: false, reason: `impure-closure:${structuralSink}` }
      }
    }
    // (an un-parseable snippet is NOT auto-eligible — Gate 3's liftability check
    // below still has to pass, and parse failure makes a function un-liftable.)

    // Gate 3 — non-fabricated two-sided test. Refuse request-tainted fragments
    // (would force fabricating the payload) and non-liftable fragments.
    if (looksRequestTainted(code)) {
      return { eligible: false, reason: "request-tainted-fragment" }
    }
    if (!hasLiftableClosure(parts)) {
      return { eligible: false, reason: "not-liftable-closure" }
    }

    return { eligible: true, reason: "eligible", klass }
  } catch (err) {
    // UNDER-STRICT-SAFE: any unexpected failure fails OPEN to ineligible. The gate
    // is a measurement instrument; it must never crash a review.
    return { eligible: false, reason: `error:${err instanceof Error ? err.name : "unknown"}` }
  }
}
