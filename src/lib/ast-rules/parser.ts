// ARC-181: AST parser dispatch for the rule-pack scanner.
//
// Bundles `acorn` (JS) + `acorn-typescript` (TS-syntax extension) so
// the rule visitors can run against `.js`/`.mjs`/`.cjs`/`.jsx`/`.ts`/
// `.tsx`/`.mts`/`.cts` source files without pulling the full
// TypeScript compiler. acorn-typescript parses TS *syntax* (decorators,
// import attributes, satisfies, enums, namespaces) but does NOT
// type-check — v1 rules are AST-shape only.
//
// Workers compatibility: all three packages are pure-JS ESM with no
// Node-only APIs. Verified by reading their sources.
//
// Pin policy: `acorn@8.14.0`, `acorn-walk@8.3.4`, `acorn-typescript@1.4.13`
// — exact-pin in package.json (no caret/tilde). Parser correctness is
// rule-pack ground truth; silent npm-audit bumps must be explicit.

import { Parser as AcornParser } from "acorn"
import tsPlugin from "acorn-typescript"

export type SourceExt =
  | ".js" | ".mjs" | ".cjs" | ".jsx"
  | ".ts" | ".mts" | ".cts" | ".tsx"

export type ParseOk = { ok: true; ast: unknown }
export type ParseErr = { ok: false; reason: string }
export type ParseResult = ParseOk | ParseErr

// acorn-typescript exports a function that returns a Parser subclass;
// we instantiate two parsers — JS-only and TS-extended — once at module
// load. acorn parsers are stateless w.r.t. the configuration so this
// is cheap.
const TsAcorn = AcornParser.extend(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (tsPlugin as any)({ allowSatisfies: true }),
)

// Use the TS-extended parser for any extension that may contain TS
// syntax OR JSX. Plain acorn does not parse JSX; acorn-typescript's
// plugin handles both TS and JSX (via internal acorn-jsx fork). For
// `.jsx` files we want JSX support without TS-only syntax (decorators,
// satisfies, etc.) but the TS parser tolerates these as a permissive
// superset, so routing JSX through it is safe.
function needsTsParser(ext: SourceExt): boolean {
  return ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts"
    || ext === ".jsx"
}

function isJsxExt(ext: SourceExt): boolean {
  return ext === ".jsx" || ext === ".tsx"
}

/**
 * Parse a source file into an AST. Never throws — returns
 * `{ ok: false, reason }` on parse failure so the runner can record
 * `ast-rules-parse-failed` telemetry and skip the file without
 * blocking the rest of the scan.
 *
 * Parser options:
 *   - `ecmaVersion: "latest"` — accept all stage-4 syntax acorn knows
 *   - `sourceType: "module"` — every file is parsed as ESM (covers
 *     CommonJS in practice; CJS-only constructs like
 *     `module.exports = ...` are valid expression statements in
 *     module mode too)
 *   - `locations: true` — every node carries `{ loc: { start: {line,
 *     column}, end: {line, column} } }`. Required for diff-line
 *     filtering (§5.4) and reviewable-position resolution.
 *   - `allowHashBang: true` — accept `#!/usr/bin/env node` shebangs
 *     in `.mjs`/`.cjs` files
 */
export function parseSource(code: string, ext: SourceExt): ParseResult {
  if (typeof code !== "string") {
    return { ok: false, reason: "code must be a string" }
  }
  const Parser = needsTsParser(ext) ? TsAcorn : AcornParser
  const options = {
    ecmaVersion: "latest" as const,
    sourceType: "module" as const,
    locations: true,
    allowHashBang: true,
    ...(isJsxExt(ext) ? { jsx: true } : {}),
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ast = Parser.parse(code, options as any)
    return { ok: true, ast }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, reason }
  }
}
