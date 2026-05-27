// SIG-172: directory-scoped + glob-scoped rule discovery, matching, and
// rendering for the per-specialist prompt.
//
// Two file shapes the indexer enumerates (separate from sigilix.json):
//
//   1. `SIGILIX.md` at any directory depth — the AGENTS.md-style
//      "rules that apply here" file. At review time, for each changed
//      file we walk closest-ancestor first and concatenate every
//      SIGILIX.md whose dir is an ancestor of the changed file's path.
//      Cap the walk at MAX_ANCESTORS (8) so a hostile or accidentally-
//      deep repo can't blow the prompt budget — see research §Recom-
//      mendation ("Cap the walk at ~5 ancestors") + ESLint cascading
//      cautionary tale (§4).
//
//   2. `.sigilix/rules/*.md` at any directory depth — glob-keyed
//      opt-in rules. Optional `glob:` frontmatter scopes a rule to
//      changed files matching the glob (picomatch/posix semantics).
//      No frontmatter → the rule fires for every changed file in this
//      PR (i.e. it behaves like a directory-anchored SIGILIX.md but
//      with explicit per-rule files). Bodies are concatenated across
//      all matching rules in lexicographic-path order.
//
// Concatenation order in the rendered [SCOPED RULES] block:
//   - SIGILIX.md from each ancestor, in [deepest, ..., shallowest]
//     order so the deepest (most specific) is positioned LAST. LLMs
//     give higher weight to later text in a flat list (research §Q7);
//     this matches AGENTS.md's "more specific takes precedence" model.
//   - Then matching .sigilix/rules/*.md bodies, in lexicographic path
//     order of the rule file's own path (stable, debuggable).
//
// The whole [SCOPED RULES] block is emitted BELOW the
// [SHARED_NEGATIVE_CONSTRAINTS] system-prompt block (which carries
// explicit override language SIG-172 added — see
// `src/prompts/pr-review-specialists.ts`). Scoped rules SUPPLEMENT
// the constraints; they do NOT override them.

import picomatch from "picomatch/posix"
import type { Matcher } from "picomatch/posix"

/**
 * Hard cap on the closest-ancestor walk depth for SIGILIX.md
 * discovery. Defends the prompt budget against pathologically nested
 * repos. Research §Recommendation suggested 5–8; 8 chosen for a
 * little headroom on tools/<area>/<feature>/... layouts.
 */
export const MAX_ANCESTORS = 8

/**
 * Closest-ancestor rule file. Indexed by the directory it lives in
 * (`""` for the repo root). Multiple SIGILIX.md at the same depth
 * is structurally impossible (one file per dir).
 */
export interface PerDirectoryRule {
  /** Directory path the rule applies to (e.g. `""` for root,
   *  `"src/payments"` for src/payments/SIGILIX.md). Lowercased
   *  comparison is NOT used — paths from the GitHub tree preserve
   *  case and we match by exact string equality on the path
   *  segments. */
  dirPath: string
  /** Frontmatter-stripped body (SIGILIX.md may use frontmatter for
   *  future fields; v1 emits the body verbatim). */
  body: string
}

/**
 * Glob-keyed rule file (`.sigilix/rules/*.md`).
 *
 * - `rulePath` is the rule file's own path (used for the lexicographic
 *   tie-break ordering at render time and for telemetry).
 * - `glob` is the optional `glob:` frontmatter value. Null when the
 *   rule applies to every changed file (no frontmatter or empty glob).
 * - `body` is the frontmatter-stripped Markdown.
 */
export interface GlobRule {
  rulePath: string
  glob: string | null
  body: string
}

/**
 * Serialized shape persisted in KV (`repo-index-rules:<owner>/<repo>`).
 * Matchers are pre-compiled at runtime from `globRules[].glob` to
 * avoid stashing a function in KV. Keeping the JSON pure-data also
 * lets a SIG-x follow-up swap the matcher library without rewriting
 * stored manifests.
 */
export interface ScopedRulesManifest {
  perDirectoryRules: PerDirectoryRule[]
  globRules: GlobRule[]
}

/**
 * In-memory compiled manifest — same shape as `ScopedRulesManifest`
 * but with each globRule paired with its compiled picomatch matcher.
 * The orchestrator builds this once per review and reuses it for every
 * changed file (research §Recommendation: "Pre-compile globs at
 * index-time, not per-PR-file at review-time" — at minimum, compile
 * once per PR rather than once per file).
 */
export interface CompiledScopedRulesManifest {
  perDirectoryRules: PerDirectoryRule[]
  globRules: Array<GlobRule & { matcher: Matcher | null }>
}

/**
 * SIG-172 frontmatter parser. Hand-rolled per research §6: schema is
 * one field today (`glob:`), maybe two tomorrow, so a 20-LOC parser is
 * cheaper than the ~50KB `gray-matter` + `js-yaml` dependency. The
 * constraint we document and enforce by parser shape: frontmatter MUST
 * be flat key:value scalars — no nested mappings, no lists, no
 * multi-line values. Anything that doesn't match `^\w+:\s*(.+)$` is
 * silently dropped (fail-open).
 *
 * Returns the body verbatim when frontmatter is absent or malformed —
 * a corrupted header must not strip the rule's body.
 *
 * Line-ending normalisation (SIG-172 H1, fix-up): Windows-authored
 * `.sigilix/rules/*.md` files arrive over the GitHub API with `\r\n`
 * line endings preserved. The closing-delim regex previously hardcoded
 * `\n`, so a CRLF frontmatter fell through to body-only mode AND the
 * raw YAML header leaked into the LLM prompt as rule body. Normalise
 * to LF before matching.
 *
 * Frontmatter-only files (no body after the closing `---`) also parse
 * correctly: the closing delim's trailing newline + body is treated as
 * optional so a manifest of pure frontmatter doesn't fail the match.
 */
export function parseRuleFrontmatter(text: string): { glob?: string; body: string } {
  // Normalise line endings BEFORE matching so the closing-delim regex
  // (which hardcodes `\n`) handles CRLF + lone-CR inputs uniformly.
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  // Trailing `\n([\s\S]*)` made optional so a file whose entire contents
  // are the frontmatter (no body, possibly no trailing newline after the
  // closing `---`) still parses — previously fell through to body-only.
  const match = normalised.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/)
  if (!match) return { body: normalised }
  const headerText = match[1] ?? ""
  const body = match[2] ?? ""
  const fields: Record<string, string> = {}
  for (const line of headerText.split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)$/)
    if (m && m[1] && m[2] !== undefined) fields[m[1]] = m[2].trim()
  }
  const glob = fields.glob
  return glob && glob.length > 0 ? { glob, body } : { body }
}

/**
 * Classify a file path against the SIG-172 discovery rules. Returns
 * `"sigilix-md"` for `SIGILIX.md` at any depth, `"glob-rule"` for
 * `.sigilix/rules/*.md` at any depth, or `null` for anything else.
 *
 * Case-sensitive match per POSIX path conventions — both filenames
 * are intentional uppercase / dotted-dir conventions and a casing
 * mistake should silently miss rather than be tolerated.
 */
export function classifyRuleFilePath(
  path: string,
): "sigilix-md" | "glob-rule" | null {
  if (path.length === 0) return null
  const lastSlash = path.lastIndexOf("/")
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path
  if (basename === "SIGILIX.md") return "sigilix-md"
  // `.sigilix/rules/<anything>.md` — the rules dir may live at any depth.
  if (basename.endsWith(".md")) {
    // Walk backwards: require an ancestor segment chain `.sigilix/rules/`
    // immediately above the file. We avoid a single-regex check because
    // it's harder to reason about Windows-style paths or empty segments.
    const segs = path.split("/")
    // Need at least `.sigilix`, `rules`, and the file itself.
    if (segs.length < 3) return null
    const file = segs[segs.length - 1]!
    const parent = segs[segs.length - 2]
    const grand = segs[segs.length - 3]
    if (parent === "rules" && grand === ".sigilix" && file.endsWith(".md")) {
      return "glob-rule"
    }
  }
  return null
}

/**
 * Directory portion of a path. Returns `""` for a file at the repo
 * root (e.g. `SIGILIX.md` → `""`).
 */
export function dirnamePosix(path: string): string {
  const lastSlash = path.lastIndexOf("/")
  return lastSlash < 0 ? "" : path.slice(0, lastSlash)
}

/**
 * Depth of a directory path in path-segment counts. The repo root
 * (`""` or `"."`) is depth 0; `"src"` is depth 1; `"src/payments"` is
 * depth 2. Used by the per-directory-rule comparator to enforce
 * AGENTS.md-style segment-based ordering (deepest wins on conflict),
 * NOT byte-length ordering — siblings with different name lengths but
 * the same depth must tie + fall through to lexicographic tie-break.
 * `Boolean` filters out empty segments produced by leading / trailing /
 * doubled slashes so a stray "src//payments" still scores depth 2.
 */
export function dirDepth(dirPath: string): number {
  if (dirPath === "" || dirPath === ".") return 0
  return dirPath.split("/").filter(Boolean).length
}

/**
 * Compile the persisted manifest into matcher-ready form. Bad globs
 * (picomatch throws) drop to `matcher: null` — the rule then never
 * fires; we don't break the review on a typo in one rule.
 *
 * SIG-172 H2 (fix-up): the compile-failure branch previously swallowed
 * picomatch's error silently. An operator with a typo'd glob (e.g. a
 * doublestar-then-bracket pattern with an unbalanced bracket) then had
 * ZERO signal that the rule wasn't firing. Emit structured telemetry
 * on the catch so dashboards can surface "your rule isn't compiling"
 * without waiting for a human to notice it never fires.
 */
export function compileScopedRulesManifest(
  manifest: ScopedRulesManifest,
): CompiledScopedRulesManifest {
  const compiledGlobRules = manifest.globRules.map((g) => {
    if (g.glob === null) {
      return { ...g, matcher: null as Matcher | null }
    }
    try {
      const matcher = picomatch(g.glob, { dot: true })
      return { ...g, matcher: matcher as Matcher | null }
    } catch (err) {
      console.warn(JSON.stringify({
        event: "scoped-rules-glob-compile-failed",
        rulePath: g.rulePath,
        glob: g.glob,
        err: err instanceof Error ? err.message : String(err),
      }))
      return { ...g, matcher: null as Matcher | null }
    }
  })
  return {
    perDirectoryRules: manifest.perDirectoryRules,
    globRules: compiledGlobRules,
  }
}

/**
 * Resolve which rules apply to a set of changed file paths.
 *
 * Returns the rule bodies in render order:
 *   1. SIGILIX.md ancestors, in [deepest, ..., shallowest] order so the
 *      most specific instruction is positioned LAST. Dedup by dirPath
 *      across all changed files so a SIGILIX.md isn't repeated when
 *      multiple changed files share an ancestor.
 *   2. Then glob rules whose matcher fires against AT LEAST ONE
 *      changed path. `glob: null` (no-frontmatter) rules always fire
 *      (treated as "no per-file scoping"). Glob rules are emitted in
 *      lexicographic order of `rulePath` for stable, debuggable output.
 *
 * Walk depth cap: at most MAX_ANCESTORS dirs per changed file. When
 * the path has more than that many directory levels, we keep the
 * MAX_ANCESTORS deepest (closest to the file) and drop the shallowest.
 */
export function resolveScopedRulesForChangedPaths(
  manifest: CompiledScopedRulesManifest,
  changedPaths: ReadonlyArray<string>,
): ScopedRuleSelection {
  const ancestorsByDir = new Map<string, PerDirectoryRule>(
    manifest.perDirectoryRules.map((r) => [r.dirPath, r]),
  )
  // Walk each changed file's ancestors closest-first, collect any
  // matching SIGILIX.md. Dedup by dirPath across all changed files.
  const matchedPerDir = new Map<string, PerDirectoryRule>()
  for (const path of changedPaths) {
    const ancestors = ancestorDirs(path, MAX_ANCESTORS)
    for (const dir of ancestors) {
      const rule = ancestorsByDir.get(dir)
      if (rule && !matchedPerDir.has(dir)) {
        matchedPerDir.set(dir, rule)
      }
    }
  }
  // Order by directory DEPTH (segment count) DESC so the deepest is
  // rendered LAST (we reverse below). Tie-break on dirPath DESC too
  // (post-reverse → ASC lexicographic for same-depth siblings) so the
  // final render order is deterministic AND alphabetical within depth.
  //
  // SIG-172 fix-up: previously sorted by `dirPath.length` (STRING
  // length). That misorders siblings with different name lengths but
  // the SAME depth ("src/a" 5 chars vs "src/abc" 7 chars are both
  // depth 2, but length sort puts "src/a" before "src/abc" by chance)
  // AND can flip cross-depth ordering ("src/a" depth 2 vs "foo"
  // depth 1: length sorts "foo" deeper than "src/a"). The AGENTS.md
  // model is segment-based, not byte-based.
  const orderedPerDir = [...matchedPerDir.values()].sort((a, b) => {
    const depthDelta = dirDepth(b.dirPath) - dirDepth(a.dirPath)
    if (depthDelta !== 0) return depthDelta
    // Tie-break DESC so the post-reverse render is ASC (e.g. "src/a"
    // appears before "src/abc" in the rendered block).
    return a.dirPath < b.dirPath ? 1 : a.dirPath > b.dirPath ? -1 : 0
  })
  // Reverse to [shallowest, ..., deepest] so deepest appears LAST in
  // the rendered block (the AGENTS.md model: deepest wins on conflict;
  // the LLM gives more weight to later text in a flat list).
  const perDirOrdered = orderedPerDir.reverse()

  // Glob rules: a rule fires if its matcher returns true for at least
  // one changed path, OR if `glob: null` (always-on). Lexicographic
  // sort by rulePath for stable rendering.
  const matchedGlobRules = manifest.globRules.filter((g) => {
    if (g.matcher === null) {
      // Two ways a matcher ends up null:
      //   - `glob: null` (no frontmatter) → rule has NO per-file
      //     scoping; fire repo-wide for any changed file.
      //   - non-null glob string that picomatch refused to compile
      //     (typo / malformed pattern) → DON'T fire. Over-firing on
      //     every PR because of one typo would be hard to debug
      //     after the fact; silently suppressing it surfaces the
      //     bug the first time the operator notices the rule isn't
      //     applying.
      return g.glob === null
    }
    return changedPaths.some((p) => g.matcher!(p))
  }).sort((a, b) => {
    if (a.rulePath < b.rulePath) return -1
    if (a.rulePath > b.rulePath) return 1
    return 0
  })

  return { perDirectoryRules: perDirOrdered, globRules: matchedGlobRules }
}

export interface ScopedRuleSelection {
  /** Closest-ancestor rules ordered [shallowest, ..., deepest] so the
   *  deepest (most specific) appears LAST in the rendered prompt. */
  perDirectoryRules: PerDirectoryRule[]
  /** Glob-keyed rules whose matcher fired (or `glob: null`),
   *  lexicographically ordered by `rulePath`. */
  globRules: GlobRule[]
}

/**
 * Aggregate byte cap on the rendered [SCOPED RULES] block. Belt-and-
 * suspenders defense alongside MAX_RULE_FILE_BYTES (the per-file cap):
 * a handful of in-range rule files can still combine to push specialist
 * requests over context limits. 16KB comfortably leaves headroom for
 * the diff + the rest of the prompt under every model we run today.
 *
 * SIG-172 M1 (fix-up).
 */
export const MAX_RENDERED_SCOPED_RULES_BYTES = 16 * 1024

/**
 * Render the selection into a single labeled prompt block. Returns
 * `""` when the selection is empty so callers can early-skip the
 * `lines.push(...)` step without producing extra blank lines.
 *
 * The header explicitly restates that these rules are SECONDARY to
 * the SHARED_NEGATIVE_CONSTRAINTS in the system prompt — positional
 * defense isn't enough on its own; we belt-and-suspender with an
 * explicit "MUST defer" sentence inside the block.
 *
 * SIG-172 M1 (fix-up): capped at MAX_RENDERED_SCOPED_RULES_BYTES total.
 * When the rule bodies exceed the cap, the lower-priority entries
 * (later in the selection order — i.e. shallower per-directory rules
 * + lexicographically-later glob rules) are dropped and a truncation
 * marker is appended so the model knows it didn't see everything.
 * Telemetry surfaces dropped count + rendered bytes for dashboards.
 */
export function renderScopedRulesForPrompt(
  selection: ScopedRuleSelection,
): string {
  const dirBodies = selection.perDirectoryRules.map((r) => {
    const label = r.dirPath.length === 0 ? "<repo root>" : r.dirPath
    return `[SIGILIX.md — ${label}]\n${r.body.trim()}`
  })
  const globBodies = selection.globRules.map((g) => {
    const scope = g.glob === null ? "<all files>" : g.glob
    return `[.sigilix/rules — ${g.rulePath} (scope: ${scope})]\n${g.body.trim()}`
  })
  const blocks = [...dirBodies, ...globBodies].filter((b) => b.length > 0)
  if (blocks.length === 0) return ""

  // Aggregate-budget pass.
  //
  // SIG-172 fix-up: iterate END -> START so the HIGHEST-priority bodies
  // (deepest SIGILIX.md, lexicographically-later glob rules) are kept
  // first when the cap bites. Previous implementation walked
  // front-to-back, which kept SHALLOWEST first and dropped the deepest
  // (most-specific) rules — directly inverting the AGENTS.md priority
  // model.
  //
  // Each chosen block is `unshift`ed into `kept` so the final array
  // preserves the original shallow -> deep render order; only the
  // truncation marker is appended at the tail.
  //
  // The header lines are accounted for up-front in `totalBytes`: a
  // small (~330B) but non-zero contribution that previously slipped
  // past the cap calculation, producing a rendered block a few hundred
  // bytes over budget when the rule bodies summed to exactly the cap.
  const HEADER_LINES = [
    "[SCOPED RULES — directory-scoped + glob-scoped guidance from SIGILIX.md / .sigilix/rules/*.md]",
    "These rules SUPPLEMENT [SHARED_NEGATIVE_CONSTRAINTS] (system prompt). They do NOT override them. Any rule here that conflicts with a SHARED_NEGATIVE_CONSTRAINT MUST defer to the constraint.",
    "",
  ]
  const encoder = new TextEncoder()
  // Header bytes + the two `\n\n` separators joining the three header
  // lines together. Inter-block separators between header-tail and
  // first kept block are added per-block below.
  const headerBytes =
    encoder.encode(HEADER_LINES.join("\n\n")).length
  const kept: string[] = []
  let totalBytes = headerBytes
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!
    const blockBytes = encoder.encode(block).length
    // Every kept entry contributes a leading `\n\n` separator added by
    // the final join — for the FIRST kept block that joins onto the
    // header's trailing entry, for subsequent kept blocks it joins onto
    // the previous kept entry. Either way: +2 bytes per kept entry.
    const sepBytes = 2
    if (totalBytes + sepBytes + blockBytes > MAX_RENDERED_SCOPED_RULES_BYTES) {
      break
    }
    kept.unshift(block)
    totalBytes += sepBytes + blockBytes
  }
  const droppedCount = blocks.length - kept.length
  if (droppedCount > 0) {
    console.warn(JSON.stringify({
      event: "scoped-rules-block-truncated",
      droppedCount,
      renderedBytes: totalBytes,
      capBytes: MAX_RENDERED_SCOPED_RULES_BYTES,
    }))
    kept.push(
      `_[scoped rules truncated at ${MAX_RENDERED_SCOPED_RULES_BYTES} bytes; ${droppedCount} rule ${droppedCount === 1 ? "body" : "bodies"} omitted]_`,
    )
  }

  return [
    ...HEADER_LINES,
    ...kept,
  ].join("\n\n")
}

/**
 * Return up to `cap` ancestor directories of `path`, ordered
 * closest-first. Empty path → empty result. The repo-root (`""`) is
 * always included as the shallowest entry when within cap so a
 * root-level SIGILIX.md is reachable.
 */
export function ancestorDirs(path: string, cap: number): string[] {
  const all: string[] = []
  const dir = dirnamePosix(path)
  if (dir.length === 0) {
    // File is at the root — only the root is an ancestor.
    return [""]
  }
  const segs = dir.split("/")
  // Build [a/b/c, a/b, a, ""] (closest-first).
  for (let i = segs.length; i > 0; i--) {
    all.push(segs.slice(0, i).join("/"))
  }
  all.push("") // root
  if (all.length <= cap) return all
  // Keep the `cap` deepest. We drop the shallowest entries (research:
  // attention budget defense; shallow rules tend to be repo-wide
  // boilerplate, deep rules tend to be specific instructions for THIS
  // area; specific is more valuable).
  return all.slice(0, cap)
}

/**
 * Identify scoped-rule files in a flat tree-entry list. Returns the
 * subset of entries whose `path` looks like a SIGILIX.md or a
 * `.sigilix/rules/*.md` file. Size-capped at MAX_RULE_FILE_BYTES to
 * defend against a hostile repo that ships a huge "SIGILIX.md".
 *
 * Mirrors `walkIndexableFiles` (in indexer.ts) but with a separate
 * filter — rule files live under `.sigilix/` which `walkIndexableFiles`
 * intentionally drops via the dotfile-dir skip.
 */
export function walkScopedRuleFiles(
  entries: ReadonlyArray<{ path?: string | undefined; type?: string | undefined; size?: number | undefined }>,
): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = []
  for (const entry of entries) {
    if (entry.type !== "blob") continue
    if (typeof entry.path !== "string" || entry.path.length === 0) continue
    if (classifyRuleFilePath(entry.path) === null) continue
    const size = typeof entry.size === "number" ? entry.size : 0
    if (size > MAX_RULE_FILE_BYTES) continue
    out.push({ path: entry.path, size })
  }
  return out
}

/**
 * Size cap per rule file. 64KB easily covers reasonable Markdown rule
 * files (the whole [SCOPED RULES] block aims to stay under ~10K
 * tokens combined). Lower than `MAX_FILE_BYTES` (200KB) because
 * runaway rule files specifically attack the prompt budget.
 */
export const MAX_RULE_FILE_BYTES = 64 * 1024

/**
 * Build a `ScopedRulesManifest` from a flat list of `(path, content)`
 * tuples — typically the indexer's `getFileContent` results for every
 * file `classifyRuleFilePath` flagged.
 *
 * Files whose classification disagrees with the path shape are
 * skipped (defensive — caller shouldn't pass them in the first place,
 * but a single bad entry shouldn't corrupt the manifest).
 */
export function buildScopedRulesManifest(
  entries: ReadonlyArray<{ path: string; content: string }>,
): ScopedRulesManifest {
  const perDirectoryRules: PerDirectoryRule[] = []
  const globRules: GlobRule[] = []
  for (const e of entries) {
    const cls = classifyRuleFilePath(e.path)
    if (cls === "sigilix-md") {
      const parsed = parseRuleFrontmatter(e.content)
      // SIGILIX.md ignores `glob:` — it's a directory-anchored rule
      // file by construction. We still strip the frontmatter so a
      // future `glob:` typo doesn't leak into the body text.
      perDirectoryRules.push({
        dirPath: dirnamePosix(e.path),
        body: parsed.body,
      })
    } else if (cls === "glob-rule") {
      const parsed = parseRuleFrontmatter(e.content)
      globRules.push({
        rulePath: e.path,
        glob: parsed.glob ?? null,
        body: parsed.body,
      })
    }
  }
  // Sort for deterministic JSON serialization. The KV layer's
  // change-detection (and any test snapshot) benefits from a stable
  // shape regardless of file-walk order.
  perDirectoryRules.sort((a, b) => (a.dirPath < b.dirPath ? -1 : a.dirPath > b.dirPath ? 1 : 0))
  globRules.sort((a, b) => (a.rulePath < b.rulePath ? -1 : a.rulePath > b.rulePath ? 1 : 0))
  return { perDirectoryRules, globRules }
}
