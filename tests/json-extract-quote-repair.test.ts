import { describe, expect, it } from "vitest"
import { parseFirstJsonObject } from "../src/lib/json-extract"

describe("parseFirstJsonObject quote repair", () => {
  it("repairs unescaped object-key text inside a value string", () => {
    const out = parseFirstJsonObject('{ "body": "The parser should cover "kind": "bug" payloads." }')

    expect(out?.body).toBe('The parser should cover "kind": "bug" payloads.')
  })

  it("repairs nested object-like snippets inside a value string", () => {
    const out = parseFirstJsonObject('{ "body": "Nested {"kind": "bug"} payload", "ok": true }')

    expect(out?.body).toBe('Nested {"kind": "bug"} payload')
    expect(out?.ok).toBe(true)
  })

  it("repairs nested array/object snippets before prose inside a value string", () => {
    const out = parseFirstJsonObject('{ "body": "Array [{"name": "Alice"}] payload", "ok": true }')

    expect(out?.body).toBe('Array [{"name": "Alice"}] payload')
    expect(out?.ok).toBe(true)
  })

  it("does not terminate before an object-snippet comma followed by prose", () => {
    const out = parseFirstJsonObject('{ "body": "Nested {"name": "Alice"}, payload", "ok": true }')

    expect(out?.body).toBe('Nested {"name": "Alice"}, payload')
    expect(out?.ok).toBe(true)
  })

  it.each([
    [
      "number-like prose",
      '{ "body": "Nested {"name": "Alice"}, 3.14 is pi", "ok": true }',
      'Nested {"name": "Alice"}, 3.14 is pi',
    ],
    [
      "boolean-like prose",
      '{ "body": "Nested {"name": "Alice"}, true story", "ok": true }',
      'Nested {"name": "Alice"}, true story',
    ],
    [
      "null-like prose",
      '{ "body": "Nested {"name": "Alice"}, null void", "ok": true }',
      'Nested {"name": "Alice"}, null void',
    ],
  ])("does not terminate before object-snippet comma followed by %s", (_name, text, expected) => {
    const out = parseFirstJsonObject(text)

    expect(out?.body).toBe(expected)
    expect(out?.ok).toBe(true)
  })

  it("does not repair a dangling object-snippet comma at EOF into a finding", () => {
    const out = parseFirstJsonObject('{ "body": "Nested {"name": "Alice"},')

    expect(out).toBeNull()
  })

  it("repairs unescaped quotes inside array element strings", () => {
    const out = parseFirstJsonObject('{ "items": ["Cover "kind" parsing", "ok"] }')

    expect(out?.items).toEqual(['Cover "kind" parsing', "ok"])
  })

  it("still terminates valid nested object strings before container closings", () => {
    const out = parseFirstJsonObject(
      '{ "items": [{ "name": "Alice" }], "body": "Cover "kind" parsing" }',
    )

    expect(out?.items).toEqual([{ name: "Alice" }])
    expect(out?.body).toBe('Cover "kind" parsing')
  })

  it("does not treat a comma plus prose number as the end of the string", () => {
    const out = parseFirstJsonObject('{ "body": "The value mentions "-1", -2 as invalid", "ok": true }')

    expect(out?.body).toBe('The value mentions "-1", -2 as invalid')
    expect(out?.ok).toBe(true)
  })

  it("repairs a comma followed by non-json prose inside the same string", () => {
    const out = parseFirstJsonObject('{ "body": "The value mentions "kind", bare words after comma", "ok": true }')

    expect(out?.body).toBe('The value mentions "kind", bare words after comma')
    expect(out?.ok).toBe(true)
  })
})
