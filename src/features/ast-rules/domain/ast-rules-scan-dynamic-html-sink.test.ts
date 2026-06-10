// SIG-312: deterministic dynamic-HTML-sink XSS detector — the inverse of
// SIG-292. Flags an untrusted dynamic value flowing into dangerouslySetInnerHTML
// / innerHTML / insertAdjacentHTML; FP-safe by construction (skips constants,
// bare identifiers, safe-marked values, and ALL calls).

import { describe, it, expect } from "vitest"
import {
  classifyHtmlSinkValue,
  scanDynamicHtmlSinks,
  DYNAMIC_HTML_SINK_RULE_ID,
} from "@/src/features/ast-rules/domain/scan-dynamic-html-sink"

describe("classifyHtmlSinkValue — FLAG (untrusted dynamic)", () => {
  it("flags a member access with an HTML-ish terminal property (the recurring miss)", () => {
    expect(classifyHtmlSinkValue("c.bodyHtml")).toEqual({ flag: true, reason: "member" })
    expect(classifyHtmlSinkValue("props.rawHtml")).toEqual({ flag: true, reason: "member" })
    expect(classifyHtmlSinkValue("row.event.bodyHtml")).toEqual({ flag: true, reason: "member" })
    expect(classifyHtmlSinkValue("item.contentHtml")).toEqual({ flag: true, reason: "member" })
    expect(classifyHtmlSinkValue("c.html")).toEqual({ flag: true, reason: "member" })
    expect(classifyHtmlSinkValue("data.markup")).toEqual({ flag: true, reason: "member" })
  })
  it("flags an optional-chained HTML-ish member", () => {
    expect(classifyHtmlSinkValue("c?.bodyHtml")).toEqual({ flag: true, reason: "member" })
  })
  it("flags a raw interpolated template", () => {
    expect(classifyHtmlSinkValue("`<b>${userInput}</b>`")).toEqual({ flag: true, reason: "interpolation" })
    expect(classifyHtmlSinkValue("`<div>${row.bio}</div>`")).toEqual({ flag: true, reason: "interpolation" })
  })
  it("still flags `unsafeHtml` / `uncleanHtml` — the safe-marker is token-anchored (CodeRabbit #296)", () => {
    expect(classifyHtmlSinkValue("c.unsafeHtml")).toEqual({ flag: true, reason: "member" })
    expect(classifyHtmlSinkValue("data.uncleanHtml")).toEqual({ flag: true, reason: "member" })
  })
})

describe("classifyHtmlSinkValue — SKIP (FP-safe: provably benign / ambiguous)", () => {
  it("skips a constant string / template literal", () => {
    expect(classifyHtmlSinkValue('"<b>ok</b>"').flag).toBe(false)
    expect(classifyHtmlSinkValue("'<b>ok</b>'").flag).toBe(false)
    expect(classifyHtmlSinkValue("`<b>ok</b>`").flag).toBe(false) // no ${}
  })
  it("skips a bare identifier (could be pre-sanitized upstream)", () => {
    expect(classifyHtmlSinkValue("html").flag).toBe(false)
    expect(classifyHtmlSinkValue("bodyHtml").flag).toBe(false) // html-ish NAME but bare id
  })
  it("skips a sanitizer call (safe-marked)", () => {
    expect(classifyHtmlSinkValue("DOMPurify.sanitize(x)").flag).toBe(false)
    expect(classifyHtmlSinkValue("sanitizeHtml(raw)").flag).toBe(false)
    expect(classifyHtmlSinkValue("escapeHtml(x)").flag).toBe(false)
  })
  it("skips a safe-marked member access even when html-ish", () => {
    expect(classifyHtmlSinkValue("c.safeHtml").flag).toBe(false)
    expect(classifyHtmlSinkValue("data.sanitizedHtml").flag).toBe(false)
    expect(classifyHtmlSinkValue("v.trustedHtml").flag).toBe(false)
  })
  it("skips ANY call (any call could be an unrecognized sanitizer — FN over FP)", () => {
    expect(classifyHtmlSinkValue("render(x)").flag).toBe(false)
    expect(classifyHtmlSinkValue("marked(md)").flag).toBe(false)
  })
  it("skips an interpolation containing a call (might sanitize)", () => {
    expect(classifyHtmlSinkValue("`<b>${escapeHtml(x)}</b>`").flag).toBe(false)
    expect(classifyHtmlSinkValue("`<b>${sanitize(x)}</b>`").flag).toBe(false)
  })
  it("skips a non-HTML-named member (FN-safe — we only flag html-ish names)", () => {
    expect(classifyHtmlSinkValue("c.id").flag).toBe(false)
    expect(classifyHtmlSinkValue("user.name").flag).toBe(false)
  })
  it("skips empty / whitespace", () => {
    expect(classifyHtmlSinkValue("").flag).toBe(false)
    expect(classifyHtmlSinkValue("   ").flag).toBe(false)
  })
})

describe("scanDynamicHtmlSinks — line-scan across the sink syntaxes", () => {
  it("flags dangerouslySetInnerHTML of a member access", () => {
    const hits = scanDynamicHtmlSinks(`return <div dangerouslySetInnerHTML={{ __html: c.bodyHtml }} />`)
    expect(hits.length).toBe(1)
    expect(hits[0].line).toBe(1)
    expect(hits[0].message).toMatch(/XSS/)
  })
  it("flags innerHTML / outerHTML assignment of a member access", () => {
    expect(scanDynamicHtmlSinks(`el.innerHTML = data.userHtml`).length).toBe(1)
    expect(scanDynamicHtmlSinks(`node.outerHTML = item.contentHtml;`).length).toBe(1)
  })
  it("flags insertAdjacentHTML of a member access", () => {
    expect(scanDynamicHtmlSinks(`el.insertAdjacentHTML("beforeend", row.bodyHtml)`).length).toBe(1)
  })
  it("flags a raw interpolated template through the innerHTML / insertAdjacentHTML sinks", () => {
    // innerHTML / insertAdjacentHTML capture to `;` / `)`, so a template with
    // `${…}` extracts cleanly and the interpolation classifier fires.
    expect(scanDynamicHtmlSinks("el.innerHTML = `<b>${u.bio}</b>`").length).toBe(1)
    expect(scanDynamicHtmlSinks('el.insertAdjacentHTML("beforeend", `<b>${u.bio}</b>`)').length).toBe(1)
  })
  it("known FN: an INLINE template literal inside dangerouslySetInnerHTML is not extracted", () => {
    // The SIG-292 `dangerouslySetInnerHTML` extractor captures `[^}]+?`, which
    // the `}` inside `${…}` terminates — so an inline template in the JSX
    // `{{__html: …}}` container can't be sliced. Deliberately a MISS (FN over
    // FP; we never modify the shared SIG-292 regex). The real recurring miss is
    // a MEMBER ACCESS (`c.bodyHtml`, no braces), which extracts and flags.
    expect(scanDynamicHtmlSinks("<div dangerouslySetInnerHTML={{ __html: `<b>${u.bio}</b>` }} />").length).toBe(0)
  })
  it("does NOT flag a constant, sanitized, or bare-identifier sink", () => {
    expect(scanDynamicHtmlSinks(`<div dangerouslySetInnerHTML={{ __html: "<b>ok</b>" }} />`).length).toBe(0)
    expect(scanDynamicHtmlSinks(`<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(x) }} />`).length).toBe(0)
    expect(scanDynamicHtmlSinks(`<div dangerouslySetInnerHTML={{ __html: c.safeHtml }} />`).length).toBe(0)
    expect(scanDynamicHtmlSinks(`<div dangerouslySetInnerHTML={{ __html: html }} />`).length).toBe(0)
  })
  it("does NOT flag a line with no HTML sink", () => {
    expect(scanDynamicHtmlSinks(`const x = c.bodyHtml`).length).toBe(0)
    expect(scanDynamicHtmlSinks(`eval(userInput)`).length).toBe(0) // eval is NOT an HTML-write sink
    expect(scanDynamicHtmlSinks(`document.write(c.bodyHtml)`).length).toBe(0) // own rule covers it
  })
  it("flags a pretty-printed MULTI-LINE dangerouslySetInnerHTML (CodeRabbit #296)", () => {
    const src = [
      "const x = (",
      "  <div",
      "    dangerouslySetInnerHTML={{",
      "      __html: c.bodyHtml",
      "    }}",
      "  />",
      ")",
    ].join("\n")
    const hits = scanDynamicHtmlSinks(src)
    expect(hits.length).toBe(1)
    expect(hits[0].line).toBe(3) // the `dangerouslySetInnerHTML` line
    expect(hits[0].endLine).toBeGreaterThan(hits[0].line) // spans to the `}}`
  })
  it("does NOT flag a line-commented-out sink, but does NOT false-skip a real sink after a URL (CodeRabbit #296)", () => {
    expect(scanDynamicHtmlSinks(`  // el.innerHTML = c.bodyHtml`).length).toBe(0)
    expect(scanDynamicHtmlSinks(`foo(); // el.innerHTML = c.bodyHtml`).length).toBe(0)
    expect(scanDynamicHtmlSinks(`/* el.innerHTML = c.bodyHtml */`).length).toBe(0)
    // a `://` URL earlier on the line must NOT be treated as a line comment
    expect(scanDynamicHtmlSinks(`setSrc("https://x"); el.innerHTML = c.bodyHtml`).length).toBe(1)
  })
  it("dedupes by match span — two sinks on one line both count (CodeRabbit #296)", () => {
    // dangerouslySetInnerHTML has no `$` anchor, so two on one line both match;
    // the span dedup (vs the old start-line dedup) keeps both.
    const src = `<div dangerouslySetInnerHTML={{ __html: a.bodyHtml }} /><div dangerouslySetInnerHTML={{ __html: b.rawHtml }} />`
    expect(scanDynamicHtmlSinks(src).length).toBe(2)
  })
  it("does NOT flag `unsafeHtml` being safe, but the line scan still catches it", () => {
    expect(scanDynamicHtmlSinks(`el.innerHTML = c.unsafeHtml`).length).toBe(1)
  })
  it("#64: flags setHTMLUnsafe of an html-ish member or interpolated template", () => {
    expect(scanDynamicHtmlSinks(`el.setHTMLUnsafe(data.html)`).length).toBe(1)
    expect(scanDynamicHtmlSinks("root.setHTMLUnsafe(`<b>${u.bio}</b>`)").length).toBe(1)
  })
  it("#64: flags an iframe srcDoc/srcdoc bound to an html-ish member (React camelCases it, CodeRabbit #321)", () => {
    expect(scanDynamicHtmlSinks(`<iframe srcDoc={frame.bodyHtml} />`).length).toBe(1) // React canonical
    expect(scanDynamicHtmlSinks(`<iframe srcdoc={frame.bodyHtml} />`).length).toBe(1) // raw lowercase
  })
  it("#64: flags jQuery / DOM `.html()` of an html-ish member or template", () => {
    expect(scanDynamicHtmlSinks(`$(sel).html(data.markup)`).length).toBe(1)
    expect(scanDynamicHtmlSinks("el.html(`<p>${row.bio}</p>`)").length).toBe(1)
  })
  it("#64: stays FP-safe on the new sinks — constants, bare ids, calls, the getter", () => {
    expect(scanDynamicHtmlSinks(`el.setHTMLUnsafe(userInput)`).length).toBe(0) // bare identifier
    expect(scanDynamicHtmlSinks(`<iframe srcdoc={"<b>ok</b>"} />`).length).toBe(0) // constant
    expect(scanDynamicHtmlSinks(`el.html(escapeHtml(x))`).length).toBe(0) // call → possible sanitizer
    expect(scanDynamicHtmlSinks(`const s = el.html()`).length).toBe(0) // getter, no value
  })
  it("reports a stable rule id", () => {
    expect(DYNAMIC_HTML_SINK_RULE_ID).toBe("no-dangerous-html-dynamic")
  })
})
