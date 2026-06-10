// SIG-328 — logic-claim refutation gate: the string-comparison FP family
// (case-folding / .toLowerCase() / normalize claims).
//
// Sibling of validate-logic-claim-refutation.test.ts (split out under
// SIG-318/SIG-376 to keep each suite ≤1,000 lines). Shares the `finding`
// + `ctx` fixtures via validate-logic-claim-refutation.test-helpers.ts.

import { describe, expect, it } from "vitest"
import { evaluateLogicClaimRefutation } from "@/lib/ensemble/domain/gates/validate-logic-claim-refutation"
import {
  finding,
  ctx,
} from "@/lib/ensemble/domain/gates/validate-logic-claim-refutation.test-helpers"

describe("string FP refutations", () => {
  const FILTER = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  return rows.filter((r) => r.name.includes(needle))
}`

  it("refutes a regex/ReDoS claim when the cited statement only uses a string-only substring API", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` is compiled into a regular expression, but the cited filter uses includes.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER))).toEqual({
      keep: false,
      reason: "regex-substring-claim-refuted-by-literal-string-filter",
    })
  })

  it("refutes a regex/ReDoS claim when the cited line is the substring call inside a callback", () => {
    const SRC = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  return rows.filter((r) =>
    r.name.includes(needle)
  )
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 4,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` is compiled into a regular expression, but the cited filter uses includes.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC))).toEqual({
      keep: false,
      reason: "regex-substring-claim-refuted-by-literal-string-filter",
    })
  })

  it("KEEPS an unquoted regex/ReDoS claim because no exact expression is cited", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "User-controlled regex can cause ReDoS",
      body: "The search term is compiled into a regular expression.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER)).keep).toBe(true)
  })

  it("KEEPS a regex/ReDoS claim when any quoted identifier is absent from the cited substring statement", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` and `pattern` are compiled into a regular expression.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER)).keep).toBe(true)
  })

  it("KEEPS a regex/ReDoS claim when the function has a visible RegExp surface", () => {
    const SRC = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  const re = new RegExp(needle)
  return rows.filter((r) => re.test(r.name) || r.name.includes(needle))
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 4,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` is compiled into a regular expression.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a regex/ReDoS claim when a safe substring fast path shares a function with later RegExp compilation", () => {
    const SRC = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  if ("all".includes(needle)) return rows
  const re = new RegExp(needle)
  return rows.filter((r) => re.test(r.name))
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` is compiled into a regular expression after the fast path.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a regex/ReDoS claim when the same file has a regex surface outside the cited function", () => {
    const SRC = `${FILTER}

export function compileRows(rows, req) {
  return new RegExp(String(req.query.q ?? ""))
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` is compiled into a regular expression elsewhere in this file.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a regex/ReDoS claim when an imported builder could hide the regex surface", () => {
    const SRC = `import { compilePattern } from "regex-builder"

export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  if ("test".includes(needle)) return []
  return rows.filter((r) => compilePattern(needle, r.name))
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 5,
      headline: "User-controlled regex surface leads to ReDoS",
      body: "The input is passed to `compilePattern`, which constructs a regular expression.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a regex/ReDoS claim when the quoted value also flows to an unknown helper call", () => {
    const SRC = `import { compilePattern } from "regex-builder"

export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  if ("test".includes(needle)) return []
  return rows.filter((r) => compilePattern(needle, r.name) || r.name.includes(needle))
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 5,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` is compiled into a regular expression.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a regex/ReDoS claim when the quoted value flows to an aliased RegExp constructor", () => {
    const SRC = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  if ("test".includes(needle)) return []
  const R = RegExp
  const re = new R(needle)
  return rows.filter((r) => re.test(r.name))
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` is compiled into a regular expression.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS a regex/ReDoS claim when the quoted value flows to a tagged template helper", () => {
    const SRC = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "")
  const re = regex\`\${needle}\`
  return rows.filter((r) => re.test(r.name) || r.name.includes(needle))
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 4,
      headline: "User-controlled regex can cause ReDoS",
      body: "`needle` is compiled into a regular expression.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC)).keep).toBe(true)
  })

  it("KEEPS an ignored/undefined argument claim even when the cited string call directly passes the named argument", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "Filter ignores the extracted `needle` and uses a hardcoded empty string",
      body: "The filter callback never uses `needle`.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER)).keep).toBe(true)
  })

  it("KEEPS an ignored argument claim when the finding is anchored on the adjacent closing brace", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 4,
      headline: "Filter ignores the extracted `needle` and uses a hardcoded empty string",
      body: "The filter callback never uses `needle`.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER)).keep).toBe(true)
  })

  it("KEEPS an ignored-argument claim naming multiple identifiers", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "Filter ignores `locale` while using `needle`",
      body: "The callback passes `needle`, but never uses the requested `locale`.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER)).keep).toBe(true)
  })

  it("KEEPS a contrastive ignored-argument claim where the quoted identifier is the used value", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "Filter ignores the locale parameter but the cited `needle` is still passed to includes",
      body: "The bug is the missing locale handling, not use of the search needle.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER)).keep).toBe(true)
  })

  it("KEEPS a case-insensitive contract claim that is not AST-refutable", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "Case-sensitive filter breaks existing case-insensitive contract",
      body: "The product expects names to match regardless of case.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER)).keep).toBe(true)
  })

  it("KEEPS an ignores-case claim even when the named argument is used by includes", () => {
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "Case-insensitive search invariant broken: filter ignores case of `needle`",
      body: "The filter uses includes, which is case-sensitive.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", FILTER)).keep).toBe(true)
  })

  it("KEEPS a lowercased-query claim when a lowercase operation is actually present", () => {
    const SRC = `export function filterRows(rows, req) {
  const needle = String(req.query.q ?? "").toLowerCase()
  return rows.filter((r) => r.name.includes(needle))
}`
    const f = finding({
      path: "src/search/filter.ts",
      line: 3,
      headline: "Case-insensitive search invariant broken: `needle` is lowercased but `r.name` is not",
      body: "The query is lowercased before the includes call.",
    })
    expect(evaluateLogicClaimRefutation(f, ctx("src/search/filter.ts", SRC)).keep).toBe(true)
  })
})
