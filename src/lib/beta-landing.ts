// app.sigilix.ai landing — private-beta email capture.
//
// Inline HTML, no JS, no framework. The form is a native POST to /beta/signup
// (no script needed), behind a strict CSP. Renders three states: the form, a
// success confirmation, and the form with an inline error.

export interface BetaLandingOptions {
  sent?: boolean
  error?: string
  status?: number
}

export function renderBetaLandingPage(opts: BetaLandingOptions = {}): Response {
  const status = opts.status ?? (opts.error ? 400 : 200)
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sigilix · Join the private beta</title>
<meta name="referrer" content="strict-origin-when-cross-origin" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background:
      radial-gradient(1000px 560px at 50% -10%, rgba(241,20,13,.16), transparent 60%),
      #09090b;
    color: #f5f4f2;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    min-height: 100%; padding: 2rem;
  }
  .card { width: 100%; max-width: 30rem; text-align: center; }
  .mark {
    width: 56px; height: 56px; border-radius: 14px; margin: 0 auto 22px;
    background: #f1140d; box-shadow: 0 18px 50px -12px rgba(241,20,13,.75);
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 30px; color: #fff;
  }
  h1 {
    font-size: clamp(28px, 6vw, 40px); line-height: 1.05; letter-spacing: -.03em;
    margin-bottom: 14px; font-weight: 700;
  }
  p.lead { color: #b4b3b9; font-size: 16px; line-height: 1.6; margin-bottom: 28px; }
  form { display: flex; gap: 10px; flex-wrap: wrap; }
  input[type=email] {
    flex: 1; min-width: 0; padding: 13px 15px; font-size: 15px;
    color: #f5f4f2; background: rgba(255,255,255,.04);
    border: 1px solid rgba(255,255,255,.14); border-radius: 11px; outline: none;
  }
  input[type=email]:focus { border-color: rgba(241,20,13,.55); }
  button {
    padding: 13px 22px; font-size: 15px; font-weight: 600; color: #fff;
    background: #f1140d; border: 0; border-radius: 11px; cursor: pointer;
    box-shadow: 0 12px 36px -10px rgba(241,20,13,.7);
  }
  .note { margin-top: 16px; font-size: 12.5px; color: #76757c; }
  .error { margin-top: 14px; font-size: 13.5px; color: #ff8079; }
  .ok h1 { margin-bottom: 10px; }
  a { color: #ff8079; }
  .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
</style>
</head>
<body>
  <main class="card${opts.sent ? " ok" : ""}">
    <div class="mark">S</div>
    ${
      opts.sent
        ? `<h1>You're on the list.</h1>
    <p class="lead">Thanks — we've got your request and we'll reach out with an invite. Questions? <a href="mailto:support@sigilix.ai">support@sigilix.ai</a></p>`
        : `<h1>Join the private beta.</h1>
    <p class="lead">Sigilix is the mark of merge-ready code — a believability-first AI reviewer. Drop your email and we'll send an invite.</p>
    <form method="POST" action="/beta/signup">
      <div class="hp" aria-hidden="true"><label>Company<input type="text" name="company" tabindex="-1" autocomplete="off" /></label></div>
      <input type="email" name="email" placeholder="you@company.com" required autocomplete="email" aria-label="Email address" />
      <button type="submit">Request access</button>
    </form>
    ${opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>` : ""}
    <p class="note">By requesting access you agree to our <a href="https://sigilix.ai/terms">Terms</a> and <a href="https://sigilix.ai/privacy">Privacy Policy</a>.</p>`
    }
  </main>
</body>
</html>`
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
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
