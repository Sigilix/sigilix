// SIG-292 — injection/XSS taint-grounding detector.

import { describe, expect, it } from "vitest"
import {
  extractSinkValueExpr,
  sinkValueIsProvablyConstant,
} from "@/shared/domain/validate-injection-taint"

const fileWith = (lines: string[]): Map<number, string> =>
  new Map(lines.map((t, i) => [i + 1, t]))

describe("extractSinkValueExpr", () => {
  it("extracts the value from each recognized sink", () => {
    expect(extractSinkValueExpr(`<span dangerouslySetInnerHTML={{ __html: BANNER_HTML }} />`)).toBe("BANNER_HTML")
    expect(extractSinkValueExpr(`  el.innerHTML = userHtml;`)).toBe("userHtml")
    expect(extractSinkValueExpr(`document.write(tpl)`)).toBe("tpl")
    expect(extractSinkValueExpr(`node.insertAdjacentHTML("beforeend", frag)`)).toBe("frag")
    expect(extractSinkValueExpr(`const r = eval(expr)`)).toBe("expr")
    expect(extractSinkValueExpr("const fn = new Function(\"count\", `return (${e})`)")).toBe("`return (${e})`")
  })
  it("returns null when there is no injection sink", () => {
    expect(extractSinkValueExpr(`const x = compute(items)`)).toBeNull()
    expect(extractSinkValueExpr(`<span>{row.label}</span>`)).toBeNull()
  })
})

describe("sinkValueIsProvablyConstant", () => {
  it("FIRES on a sink fed a direct non-interpolated literal", () => {
    expect(sinkValueIsProvablyConstant(`el.innerHTML = "<b>static</b>"`, undefined)).toBe(true)
    expect(sinkValueIsProvablyConstant("document.write(`<p>ok</p>`)", undefined)).toBe(true)
    expect(sinkValueIsProvablyConstant(`eval("1 + 1")`, undefined)).toBe(true)
  })

  it("FIRES on a sink fed an identifier resolving to a same-file const literal (the BANNER_HTML trap)", () => {
    const file = fileWith([
      `const BANNER_HTML = "<div class=\\"banner\\">Welcome</div>";`,
      `export function Panel() {`,
      `  return <div dangerouslySetInnerHTML={{ __html: BANNER_HTML }} />;`,
    ])
    expect(sinkValueIsProvablyConstant(`  return <div dangerouslySetInnerHTML={{ __html: BANNER_HTML }} />;`, file)).toBe(true)
  })

  it("KEEPS (false) when the sink value is a member access — potentially attacker-controlled", () => {
    expect(sinkValueIsProvablyConstant(`<div dangerouslySetInnerHTML={{ __html: props.bio }} />`, undefined)).toBe(false)
    expect(sinkValueIsProvablyConstant(`el.innerHTML = row.event.action_label`, undefined)).toBe(false)
  })

  it("KEEPS (false) on an interpolated template literal (real code injection)", () => {
    expect(sinkValueIsProvablyConstant("const fn = new Function(\"n\", `return (${userExpr})`)", undefined)).toBe(false)
    expect(sinkValueIsProvablyConstant("eval(`do(${x})`)", undefined)).toBe(false)
  })

  it("KEEPS (false) when the identifier can't be resolved to a literal in the file", () => {
    expect(sinkValueIsProvablyConstant(`el.innerHTML = userHtml`, fileWith([`function f(userHtml: string) {}`]))).toBe(false)
    // resolves to a CALL, not a literal
    const file = fileWith([`const html = render(input);`, `el.innerHTML = html;`])
    expect(sinkValueIsProvablyConstant(`el.innerHTML = html;`, file)).toBe(false)
  })

  it("KEEPS (false) when there is no recognized sink on the line", () => {
    expect(sinkValueIsProvablyConstant(`const total = compute(items)`, undefined)).toBe(false)
  })

  it("KEEPS (false) when the only matching const is inside a comment (decoy — CR P2)", () => {
    const file = fileWith([`// const X = "<p>ok</p>"`, `el.innerHTML = X;`])
    expect(sinkValueIsProvablyConstant(`el.innerHTML = X;`, file)).toBe(false)
  })

  it("still resolves a real export const literal (anchoring keeps the valid case)", () => {
    const file = fileWith([`export const X = "<p>ok</p>";`, `el.innerHTML = X;`])
    expect(sinkValueIsProvablyConstant(`el.innerHTML = X;`, file)).toBe(true)
  })

  it("KEEPS (false) on a reassignable let/var binding — its literal initializer doesn't prove constness (CR)", () => {
    // `let x = "ok"; x = req.body` — a literal init does NOT prove the value at
    // the sink is constant. const-only resolution → not provably constant → keep.
    const letFile = fileWith([`let X = "<b>ok</b>";`, `X = req.body;`, `el.innerHTML = X;`])
    expect(sinkValueIsProvablyConstant(`el.innerHTML = X;`, letFile)).toBe(false)
    const varFile = fileWith([`var X = "<b>ok</b>";`, `el.innerHTML = X;`])
    expect(sinkValueIsProvablyConstant(`el.innerHTML = X;`, varFile)).toBe(false)
  })
})
