// Minimal /auth/welcome page renderer.
//
// Inline HTML, no JS, no framework. Strict CSP via response header.
// Renders only after requireSession() resolves — unauthenticated users
// 302 to / before reaching this handler.

import type { SessionRecord } from "./auth-session"

export function renderWelcomePage(record: SessionRecord): Response {
  const safeLogin = escapeHtml(record.login)
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sigilix · Welcome</title>
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
    padding: 2rem 2.25rem 2.5rem;
    box-shadow: 0 0 80px -30px rgba(198,35,74,0.25);
    text-align: center;
  }
  .kicker { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.625rem; letter-spacing: 0.3em; text-transform: uppercase; color: #c6234a; margin-bottom: 1rem; }
  h1 { font-size: 1.875rem; font-weight: 500; line-height: 1.05; letter-spacing: -0.02em; margin-bottom: 1rem; }
  .accent { color: #c6234a; }
  p { color: #8a8b91; line-height: 1.65; margin-bottom: 1.5rem; font-size: 0.9375rem; }
  .actions { display: flex; flex-direction: column; gap: 0.625rem; margin-top: 1.75rem; }
  .btn {
    display: flex; align-items: center; justify-content: center; gap: 0.625rem;
    height: 44px; padding: 0 1rem; border-radius: 4px;
    font-size: 0.875rem; font-weight: 500;
    text-decoration: none;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .btn-primary { background: #c6234a; color: #fff; }
  .btn-primary:hover { background: #d13d62; }
  .btn-secondary { background: #1c1d23; color: #f0f0f2; border: 1px solid #2a2b30; }
  .btn-secondary:hover { border-color: #8a8b91; }
  form { margin: 0; }
  button[type=submit] { width: 100%; cursor: pointer; border: none; }
  .legal { margin-top: 1.5rem; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.6875rem; color: #5a5b61; }
</style>
</head>
<body>
  <div class="card">
    <p class="kicker">Sigilix</p>
    <h1>Welcome, <span class="accent">${safeLogin}</span>.</h1>
    <p>Your Sigilix account is active. Install the GitHub App on the repos you want reviewed and Sigilix will start posting on your next PR.</p>
    <div class="actions">
      <a class="btn btn-primary" href="https://github.com/apps/sigilix/installations/new">Install on GitHub</a>
      <a class="btn btn-secondary" href="https://github.com/settings/installations">Manage installations</a>
      <form method="post" action="/auth/logout">
        <button type="submit" class="btn btn-secondary">Sign out</button>
      </form>
    </div>
    <p class="legal">Logged in as ${safeLogin} · session held server-side, only an opaque ID is stored in your cookie.</p>
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
