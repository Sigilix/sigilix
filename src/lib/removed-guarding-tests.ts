// SIG-452: adversarial-framing hardening — "a guarding test for a CHANGED symbol
// was removed in THIS diff" signal.
//
// Why this exists:
//   Benchmark #29 showed adversarial framing defeats Sigilix on the hardest
//   planted bugs: a plausible-looking behavioral/contract change that ALSO
//   removes the regression test pinning the old behavior, in the SAME PR. The
//   model read the removed coverage as evidence the change was DELIBERATE and
//   waved it through ("intentional contract change with test coverage"). The fix
//   INVERTS that inference — a behavioral change whose guarding test was removed
//   in the same diff should RAISE suspicion, not lower it.
//
//   This module is the pure detector half. It correlates the EXISTING deleted-
//   test assertion detection (`classifyDeletedTestFocusHint` in
//   testing-evidence-pack.ts, reused via `isDeletedTestAssertionLine`) to the
//   CHANGED source symbols in the same diff, with a TIERED correlation strength:
//     - "stem"   — sibling/stem-level match only (a deleted assertion in a test
//                  that covers a changed source). Enough to COUNT (shadow), NOT
//                  to act on.
//     - "symbol" — the deleted assertion text references the CHANGED EXPORTED
//                  symbol by name (or its unambiguous source path/stem token).
//                  This is the enforce-grade evidence.
//
//   Precision is the entire risk (legit refactors remove tests too), so the
//   detector fails CLOSED on every ambiguity:
//     - a RENAMED / MOVED test (GitHub `status === "renamed"` or a non-null
//       `previousFilename`) → NO signal (the guard moved, it wasn't dropped).
//     - DEAD-CODE removal (the covered symbol is itself deleted / no longer
//       present in the diff's changed exports) → NO signal (the test went away
//       with its subject).
//     - a covered source with NO behavioral (changed-line) change → NO signal.
//     - more than `MAX_REMOVED_GUARDING_TESTS` candidates → capped.
//
// Pure module, never throws. No I/O — the caller supplies the deleted-line text,
// the changed/deleted exported-symbol sets (derived from head content + the
// diff), the sibling mappings, and the GitHub file metadata.

import type { TestingSiblingMapping } from "./testing-evidence-pack"
import { isDeletedTestAssertionLine } from "./testing-evidence-pack"
import { extractFileGraph } from "./graph-extract"
import { nodeOverlapsChanged, type ChangedLines, type AstCache } from "@/src/features/ast-rules"

/** off (default) | shadow (count only) | enforce (count + inject prompt blocks). */
export type AdversarialFramingMode = "off" | "shadow" | "enforce"

/**
 * Parse `OPENCLAW_ADVERSARIAL_FRAMING_MODE`. Default "off" (byte-identical to
 * today). Conservative: any value other than the literal "shadow"/"enforce"
 * (trim + lowercase) is "off".
 */
export function parseAdversarialFramingMode(raw: string | undefined): AdversarialFramingMode {
  const normalized = (raw ?? "off").trim().toLowerCase()
  return normalized === "shadow" || normalized === "enforce" ? normalized : "off"
}

/** How strongly a removed test is correlated to a changed source symbol. */
export type RemovedGuardingTestCorrelation = "stem" | "symbol"

export interface RemovedGuardingTest {
  /** Path of the test file whose guarding assertion(s) were removed. */
  testPath: string
  /** A short, grounded quote of one removed assertion line (so the prompt cites
   *  real evidence, not a fabricated claim). Capped length. */
  removedAssertionHint: string
  /** The changed source file the removed test covered (sibling-mapped). */
  coveredSource: string
  /** The changed EXPORTED symbol the removed assertion references — present only
   *  at "symbol" correlation; null at "stem". */
  coveredSymbol: string | null
  correlationStrength: RemovedGuardingTestCorrelation
}

/** Per-PR cap on emitted signals — fail closed past it (a PR that "removes" this
 *  many guarding tests is a refactor/cleanup, not a single sneaked regression). */
export const MAX_REMOVED_GUARDING_TESTS = 8

/** Max chars of a quoted removed-assertion line kept in `removedAssertionHint`. */
const REMOVED_ASSERTION_HINT_CHAR_CAP = 160

/** GitHub per-file change metadata needed for rename/move exclusion (Codex #4 —
 *  the diff text alone can't distinguish a rename from a deletion). */
export interface ChangedFileMeta {
  /** GitHub `status`: "added" | "modified" | "removed" | "renamed" | "copied" | … */
  status: string
  /** GitHub `previous_filename` (set for renames/copies), else null. */
  previousFilename: string | null
}

export interface BuildRemovedGuardingTestsArgs {
  /** Per old-side path → (old line number → deleted line TEXT). From
   *  `buildDeletedLineTextByLine(fullPrDiff)`. The key for a modified test file
   *  is the test path; for a renamed file it is the OLD name (excluded below). */
  deletedLineTextByPath: ReadonlyMap<string, ReadonlyMap<number, string>>
  /** Source ↔ test sibling pairs (test path → covered source path). Derived from
   *  the testing-evidence pack's `siblingMappings` (test side). */
  siblingMappings: readonly TestingSiblingMapping[]
  /** Source path → the set of EXPORTED symbol names that have a behavioral
   *  (changed-line) change in this diff. A source absent / with an empty set has
   *  NO behavioral change → fails closed (no signal). */
  changedExportedSymbolsBySource: ReadonlyMap<string, ReadonlySet<string>>
  /** Source path → the set of EXPORTED symbol names DELETED (no longer present)
   *  in this diff. Used for the dead-code exclusion: a removed test whose covered
   *  symbol is itself gone is a legitimate co-deletion, not a dropped guard. */
  deletedExportedSymbolsBySource?: ReadonlyMap<string, ReadonlySet<string>>
  /** GitHub file metadata keyed by the file's CURRENT path AND (for renames) its
   *  previous path, so a renamed test is excluded whether the deleted-line map
   *  keyed it by old or new name. Absent → fail closed to NO rename signal only
   *  when a path is genuinely unknown (we still require a sibling + symbol match,
   *  so an unknown-metadata test cannot produce a stale-positive on its own). */
  fileMetaByPath?: ReadonlyMap<string, ChangedFileMeta>
}

/**
 * Build the `removedGuardingTests` signal. Correlates removed test assertions to
 * changed source symbols, tiered by correlation strength, with the precision
 * guards above. Pure; deterministic; never throws.
 *
 * The result is ordered by test path then correlation strength ("symbol" before
 * "stem") and capped at {@link MAX_REMOVED_GUARDING_TESTS}.
 */
export function buildRemovedGuardingTests(args: BuildRemovedGuardingTestsArgs): RemovedGuardingTest[] {
  // test path → covered source (only the mapped, present pairs).
  const sourceByTest = new Map<string, string>()
  for (const m of args.siblingMappings) {
    // siblingMappings is the source→test view; invert to test→source for the
    // pairs that actually have a test sibling in this PR.
    if (m.test !== null && m.test.length > 0) sourceByTest.set(m.test, m.source)
  }

  const out: RemovedGuardingTest[] = []
  // Walk the deleted-line map deterministically (insertion order of the diff).
  // No early cap here: the cap is applied AFTER the symbol-grade-first sort below,
  // so a symbol-grade signal late in the diff is never starved by earlier
  // stem-grade ones (which the cap would otherwise truncate first).
  for (const [deletedPath, lineMap] of args.deletedLineTextByPath) {
    // The deleted-line map keys a modified test by its (stable) path. A renamed
    // test keys by the OLD name. Resolve which TEST PATH this is via the sibling
    // map (which is keyed by current paths) — try the deleted path directly, and
    // also treat it as a possible previous-name of a renamed current path.
    const testPath = resolveTestPathForDeletedFile(deletedPath, sourceByTest, args.fileMetaByPath)
    if (testPath === null) continue

    // Rename/move exclusion (Codex #4): use REAL GitHub metadata, never the diff
    // text. A test "removed" at one path but re-added at another (rename/copy) is
    // a MOVE of the guard, not a dropped guard → no signal.
    if (isRenamedOrMoved(testPath, deletedPath, args.fileMetaByPath)) continue

    const coveredSource = sourceByTest.get(testPath)
    if (coveredSource === undefined) continue

    // The covered source must have a BEHAVIORAL (changed-line) change; a removed
    // test whose covered source is untouched is a pure-cleanup removal (no bug to
    // sneak past). An empty / absent changed-symbol set fails closed here.
    const changedSymbols = args.changedExportedSymbolsBySource.get(coveredSource)
    if (changedSymbols === undefined || changedSymbols.size === 0) continue

    // Collect the deleted ASSERTION lines (reuse the existing classifier).
    const deletedAssertionTexts: string[] = []
    for (const [, text] of lineMap) {
      if (isDeletedTestAssertionLine(text)) deletedAssertionTexts.push(text)
    }
    if (deletedAssertionTexts.length === 0) continue

    // Tier the correlation. "symbol" requires a deleted assertion to reference a
    // LIVE changed exported symbol of the covered source by name (whole-token). A
    // symbol that was itself DELETED in this diff (dead code) excludes the signal
    // ENTIRELY — not just its symbol-grade tier — so a co-deleted symbol+test
    // never even produces a stem-grade count (Codex review: dead-code → NO signal).
    const deletedSymbols = args.deletedExportedSymbolsBySource?.get(coveredSource)
    const match = classifyAssertionSymbolMatch(deletedAssertionTexts, changedSymbols, deletedSymbols)
    if (match.kind === "dead-code") continue

    if (match.kind === "symbol") {
      out.push({
        testPath,
        removedAssertionHint: quoteAssertion(match.assertionText),
        coveredSource,
        coveredSymbol: match.symbol,
        correlationStrength: "symbol",
      })
    } else {
      out.push({
        testPath,
        removedAssertionHint: quoteAssertion(deletedAssertionTexts[0]!),
        coveredSource,
        coveredSymbol: null,
        correlationStrength: "stem",
      })
    }
  }

  // Deterministic order: symbol-grade first, then by test path. Stable + capped.
  out.sort((a, b) => {
    if (a.correlationStrength !== b.correlationStrength) {
      return a.correlationStrength === "symbol" ? -1 : 1
    }
    return a.testPath.localeCompare(b.testPath)
  })
  return out.slice(0, MAX_REMOVED_GUARDING_TESTS)
}

/**
 * The enforce-grade subset: only "symbol"-correlated signals act on the prompt.
 * Stem-grade signals are counted in shadow telemetry but never injected (Codex
 * #1 — stem/sibling alone is not enough to enforce).
 */
export function symbolGradeRemovedGuardingTests(signals: readonly RemovedGuardingTest[]): RemovedGuardingTest[] {
  return signals.filter((s) => s.correlationStrength === "symbol")
}

/** Resolve the current test path for a deleted-line-map key. The map keys a
 *  modified test by its stable path; a renamed file keys by its old name, so we
 *  also map an old name forward to the current path via `previousFilename`. */
function resolveTestPathForDeletedFile(
  deletedPath: string,
  sourceByTest: ReadonlyMap<string, string>,
  fileMetaByPath: ReadonlyMap<string, ChangedFileMeta> | undefined,
): string | null {
  // Common case: the deleted path IS a current test path with a sibling.
  if (sourceByTest.has(deletedPath)) return deletedPath
  // Renamed case: the deleted path is the OLD name; find a current path whose
  // metadata names this as its `previousFilename` AND that has a sibling.
  if (fileMetaByPath !== undefined) {
    for (const [current, meta] of fileMetaByPath) {
      if (meta.previousFilename === deletedPath && sourceByTest.has(current)) return current
    }
  }
  return null
}

/** True when the resolved test (by current OR deleted-old path) is a rename/copy
 *  per GitHub metadata — i.e. the guard MOVED, not dropped. Fails closed: any
 *  rename signal excludes. */
function isRenamedOrMoved(
  testPath: string,
  deletedPath: string,
  fileMetaByPath: ReadonlyMap<string, ChangedFileMeta> | undefined,
): boolean {
  if (fileMetaByPath === undefined) return false
  const meta = fileMetaByPath.get(testPath)
  if (meta !== undefined) {
    if (meta.status === "renamed" || meta.status === "copied") return true
    if (meta.previousFilename !== null && meta.previousFilename.length > 0) return true
  }
  // The deleted-line key differing from the resolved current path means the file
  // was renamed (old name ≠ new name) — exclude even if the metadata lookup above
  // missed (defensive, fail closed).
  if (deletedPath !== testPath) return true
  return false
}

type AssertionSymbolMatch =
  /** A deleted assertion references a LIVE changed exported symbol → symbol-grade. */
  | { kind: "symbol"; symbol: string; assertionText: string }
  /** A deleted assertion references ONLY changed symbols that were also DELETED in
   *  this diff (dead code) → suppress the whole signal (no stem fallback). */
  | { kind: "dead-code" }
  /** No deleted assertion references any changed symbol → stem-grade fallback. */
  | { kind: "none" }

/**
 * Classify how a test's deleted assertions correlate to the covered source's
 * changed symbols. Prefers a LIVE symbol match (symbol-grade); if the only
 * matches are dead-code (the changed symbol was itself deleted), suppress the
 * whole signal; otherwise "none" (→ stem-grade). Deterministic.
 */
function classifyAssertionSymbolMatch(
  deletedAssertionTexts: readonly string[],
  changedSymbols: ReadonlySet<string>,
  deletedSymbols: ReadonlySet<string> | undefined,
): AssertionSymbolMatch {
  // Sort candidate symbols for determinism + prefer the longest name first so a
  // specific symbol wins over a short ambiguous one.
  const candidates = [...changedSymbols]
    .filter((s) => s.length >= 3 && isIdentifier(s))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
  let sawDeadCodeMatch = false
  for (const text of deletedAssertionTexts) {
    for (const symbol of candidates) {
      if (!referencesSymbolToken(text, symbol)) continue
      if (deletedSymbols?.has(symbol) ?? false) {
        // Matched a symbol that was itself removed — the test legitimately went
        // away with its subject. Remember it but keep scanning for a LIVE match.
        sawDeadCodeMatch = true
        continue
      }
      return { kind: "symbol", symbol, assertionText: text }
    }
  }
  return sawDeadCodeMatch ? { kind: "dead-code" } : { kind: "none" }
}

/** Whole-token presence of `name` in `text` (not a substring of a larger
 *  identifier). `name` is pre-validated as an identifier by the caller. */
function referencesSymbolToken(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:[^A-Za-z0-9_$]|$)`).test(text)
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
}

/** Quote a removed assertion line compactly for the prompt (whitespace-collapsed,
 *  length-capped). */
function quoteAssertion(text: string): string {
  const collapsed = text.replace(/^[-]/, "").trim().replace(/\s+/g, " ")
  return collapsed.length > REMOVED_ASSERTION_HINT_CHAR_CAP
    ? collapsed.slice(0, REMOVED_ASSERTION_HINT_CHAR_CAP - 3) + "..."
    : collapsed
}

export interface ChangedExportedSymbols {
  /** source path → EXPORTED symbol names whose body overlaps a CHANGED line. */
  changedBySource: Map<string, Set<string>>
  /** source path → EXPORTED symbol names DELETED in this diff (a `-` line
   *  declares the export AND the symbol is no longer in the head content). */
  deletedBySource: Map<string, Set<string>>
}

/** Matches a deleted line that DECLARES an exported symbol, capturing the name —
 *  e.g. `export function foo`, `export const foo =`, `export class Foo`,
 *  `export async function foo`, `export default function foo`. Conservative:
 *  named declarations only (a bare `export { foo }` re-export is not a body). */
const EXPORTED_DECL_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/

/**
 * Derive, per CHANGED source file, the EXPORTED symbols that have a behavioral
 * (changed-line) change, and those that were DELETED — both keyed by source path.
 * Derived INDEPENDENTLY of the dynamic-evidence cards (Codex #1): it parses the
 * changed files' HEAD content via `extractFileGraph` (the same extractor the
 * evidence pack uses) and the diff's changed/deleted line maps, so the signal
 * works regardless of the unrelated `OPENCLAW_DYNAMIC_REVIEW_EVIDENCE` flag.
 *
 * Pure; never throws (the extractor is best-effort). A file missing head content
 * contributes nothing (fail closed — no changed-symbol set → no signal).
 *
 * @param sourcePaths        the CHANGED source paths to consider (non-test).
 * @param headContentByPath  head content for those paths (may be partial).
 * @param changedLines       new-side changed-line membership (`buildChangedLines`).
 * @param deletedLineTextByPath old-side deleted line text (`buildDeletedLineTextByLine`).
 * @param astCache           optional shared parse cache.
 */
export function deriveChangedExportedSymbols(args: {
  sourcePaths: readonly string[]
  headContentByPath: ReadonlyMap<string, string>
  changedLines: ChangedLines
  deletedLineTextByPath: ReadonlyMap<string, ReadonlyMap<number, string>>
  astCache?: AstCache
}): ChangedExportedSymbols {
  const changedBySource = new Map<string, Set<string>>()
  const deletedBySource = new Map<string, Set<string>>()

  for (const path of args.sourcePaths) {
    const content = args.headContentByPath.get(path)
    const headSymbolNames = new Set<string>()
    if (typeof content === "string" && content.length > 0) {
      const graph = extractFileGraph(path, content, args.astCache)
      const changed = new Set<string>()
      for (const sym of graph.symbols) {
        if (!sym.exported || sym.name.length === 0) continue
        headSymbolNames.add(sym.name)
        if (nodeOverlapsChanged(args.changedLines, path, sym.startLine, sym.endLine)) {
          changed.add(sym.name)
        }
      }
      if (changed.size > 0) changedBySource.set(path, changed)
    }

    // Dead-code: an exported declaration on a DELETED line whose name is NOT in
    // the head content's exported symbols was removed with the diff.
    const deletedLines = args.deletedLineTextByPath.get(path)
    if (deletedLines !== undefined) {
      const deleted = new Set<string>()
      for (const [, text] of deletedLines) {
        const m = EXPORTED_DECL_RE.exec(text)
        const name = m?.[1]
        if (name !== undefined && !headSymbolNames.has(name)) deleted.add(name)
      }
      if (deleted.size > 0) deletedBySource.set(path, deleted)
    }
  }

  return { changedBySource, deletedBySource }
}
