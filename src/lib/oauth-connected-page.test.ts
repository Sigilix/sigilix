// Tests for the shared branded OAuth "Connected" success page.
//
// Covers: the title renders, the default close-tab subtitle, a custom subtitle,
// the security headers (strict CSP, no-JS page), and — critically — that every
// dynamic value is HTML-escaped so a hostile title/subtitle can never inject
// markup into a page served from the Worker origin.

import { describe, expect, it } from "vitest"

import { renderConnectedPage } from "@/src/lib/oauth-connected-page"

describe("renderConnectedPage", () => {
  it("renders the app title and the default close-tab subtitle", async () => {
    const res = renderConnectedPage({ title: "Connected to Linear" })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("Connected to Linear")
    expect(body).toContain("You can safely close this tab.")
  })

  it("renders a custom subtitle instead of the default", async () => {
    const res = renderConnectedPage({ title: "Sigilix agent installed", subtitle: "Return to Linear to continue." })
    const body = await res.text()
    expect(body).toContain("Sigilix agent installed")
    expect(body).toContain("Return to Linear to continue.")
    expect(body).not.toContain("You can safely close this tab.")
  })

  it("HTML-escapes a hostile title and subtitle (no markup injection)", async () => {
    const res = renderConnectedPage({
      title: `<script>alert("x")</script>`,
      subtitle: `<img src=x onerror='alert(1)'> & friends`,
    })
    const body = await res.text()
    expect(body).not.toContain("<script>alert")
    expect(body).not.toContain("<img src=x")
    expect(body).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
    expect(body).toContain("&lt;img src=x onerror=&#39;alert(1)&#39;&gt; &amp; friends")
  })

  it("ships the strict no-JS security headers", () => {
    const res = renderConnectedPage({ title: "Connected to Linear" })
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin")
  })
})
