// Branded OAuth-callback "Connected" success page — shared by every integration
// install/connect callback that ends in the browser (Linear agent install, Linear
// tenant connect, future connectors). One place for the look so every "connected"
// screen matches the /auth/welcome + Slack-install style: dark, card, red accent.
//
// Inline HTML/CSS/SVG only — served straight from the Worker, no JS, no external
// assets. Strict CSP via response headers (mirrors src/lib/auth-welcome.ts).
// Every dynamic value is HTML-escaped; never interpolate unescaped tenant data.

export type ConnectedPageInput = {
  /** Plain-text heading, e.g. `Connected to Linear`. Escaped before rendering. */
  title: string
  /** Plain-text sub-line under the heading. Defaults to the close-tab affordance. */
  subtitle?: string
}

const DEFAULT_SUBTITLE = "You can safely close this tab."

export function renderConnectedPage(input: ConnectedPageInput): Response {
  const safeTitle = escapeHtml(input.title)
  const safeSubtitle = escapeHtml(input.subtitle ?? DEFAULT_SUBTITLE)
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sigilix · Connected</title>
<meta name="referrer" content="strict-origin-when-cross-origin" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background: #0b0c10;
    color: #f0f0f2;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: 2rem;
  }
  .card {
    max-width: 28rem; width: 100%;
    background: #15161b;
    border: 1px solid #2a2b30;
    border-radius: 4px;
    padding: 2.5rem 2.25rem;
    box-shadow: 0 0 80px -30px rgba(198,35,74,0.25);
    text-align: center;
  }
  .mark { display: block; margin: 0 auto 1.5rem; }
  .kicker { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.625rem; letter-spacing: 0.3em; text-transform: uppercase; color: #c6234a; margin-bottom: 1rem; }
  h1 { font-size: 1.875rem; font-weight: 500; line-height: 1.05; letter-spacing: -0.02em; margin-bottom: 1rem; }
  p { color: #8a8b91; line-height: 1.65; font-size: 0.9375rem; }
</style>
</head>
<body>
  <div class="card">
    <svg class="mark" width="48" height="48" viewBox="0 0 48 48" fill="none" role="img" aria-label="Success">
      <circle cx="24" cy="24" r="22.5" stroke="#2a2b30" stroke-width="1.5" />
      <path d="M15 24.5l6.5 6.5L33 18" stroke="#c6234a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <p class="kicker">Sigilix</p>
    <h1>${safeTitle}</h1>
    <p>${safeSubtitle}</p>
  </div>
</body>
</html>`
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Strict CSP — page has no JS so nothing should ever execute.
      "content-security-policy":
        "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}
