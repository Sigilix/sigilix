import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import {
  VERIFY_EMAIL_HTML_TEMPLATE,
  VERIFY_EMAIL_SUBJECT,
  VERIFY_EMAIL_TEXT_TEMPLATE,
  renderVerifyEmail,
} from "./render"

function readTemplate(file: string): string {
  return readFileSync(fileURLToPath(new URL(`./templates/${file}`, import.meta.url)), "utf8")
}

describe("template files stay in sync with the embedded runtime copies", () => {
  it("verify-email.html (minus the leading template-notes comment) matches VERIFY_EMAIL_HTML_TEMPLATE", () => {
    const file = readTemplate("verify-email.html")
    const marker = "-->\n"
    const runtime = file.slice(file.indexOf(marker) + marker.length)
    expect(runtime).toBe(VERIFY_EMAIL_HTML_TEMPLATE)
  })

  it("verify-email.txt matches VERIFY_EMAIL_TEXT_TEMPLATE", () => {
    expect(readTemplate("verify-email.txt")).toBe(VERIFY_EMAIL_TEXT_TEMPLATE)
  })
})

describe("renderVerifyEmail", () => {
  const base = { verifyUrl: "https://api.sigilix.ai/auth/verify?token=abc123", expiryHours: 24 }

  it("returns the subject and substitutes every placeholder", () => {
    const { subject, html, text } = renderVerifyEmail({ ...base, name: "Ada" })
    expect(subject).toBe(VERIFY_EMAIL_SUBJECT)
    expect(subject).toBe("Verify your email for Sigilix")
    for (const body of [html, text]) {
      expect(body).toContain("Hi Ada,")
      expect(body).toContain(base.verifyUrl)
      expect(body).toContain("expires in 24 hours")
      expect(body).not.toMatch(/\{\{\w+\}\}/)
    }
    expect(html).toContain(`href="${base.verifyUrl}"`)
    expect(html).toContain(String(new Date().getFullYear()))
  })

  it("falls back to a neutral greeting when name is absent or blank", () => {
    for (const name of [undefined, "", "   "]) {
      const { html, text } = renderVerifyEmail(name === undefined ? base : { ...base, name })
      expect(html).toContain("Hi,")
      expect(text).toContain("Hi,")
    }
  })

  it("HTML-escapes an attacker-controlled name", () => {
    // Use a tag that never appears in the template so the negative assertion is precise
    // (the template legitimately contains the logo <img>).
    const { html, text } = renderVerifyEmail({ ...base, name: '<svg onload="pwn()">' })
    expect(html).not.toContain("<svg")
    expect(html).toContain("&lt;svg onload=&quot;pwn()&quot;&gt;")
    // Plain text has no HTML context — raw is fine.
    expect(text).toContain('<svg onload="pwn()">')
  })

  it("HTML-escapes the verify URL so it cannot break out of the href attribute", () => {
    const evil = 'https://x.example/a?b="><script>alert(1)</script>'
    const { html } = renderVerifyEmail({ ...base, verifyUrl: evil })
    expect(html).not.toContain("<script")
    expect(html).toContain("&quot;&gt;&lt;script&gt;")
  })

  it("strips control characters (header-injection style input) from the name", () => {
    const { html } = renderVerifyEmail({ ...base, name: "Ada\r\nBcc: spam@example.com" })
    expect(html).toContain("Hi Ada Bcc: spam@example.com,")
    expect(html).not.toContain("\r\nBcc")
  })
})
