// Email-verification transactional email (sent via Resend on email/password signup).
//
// The canonical, previewable templates live in ./templates/verify-email.html and
// ./templates/verify-email.txt. Cloudflare Workers cannot read files at runtime,
// so the runtime copies are embedded below as template constants — the HTML one
// with the leading template-notes comment stripped, the text one verbatim.
// render.test.ts asserts the files and the constants stay in sync.
//
// Placeholder convention: {{name}} is replaced with "" (no name) or " FirstName"
// WITH a leading space, so "Hi{{name}}," renders as "Hi," or "Hi Ada,". All
// interpolated values are HTML-escaped before substitution into the HTML body.

export const VERIFY_EMAIL_SUBJECT = "Verify your email for Sigilix"

export interface VerifyEmailInput {
  verifyUrl: string
  name?: string
  expiryHours: number
}

export interface RenderedVerifyEmail {
  subject: string
  html: string
  text: string
}

export function renderVerifyEmail(input: VerifyEmailInput): RenderedVerifyEmail {
  const name = normalizeName(input.name)
  const expiryHours = String(input.expiryHours)
  const year = String(new Date().getFullYear())

  const html = fill(VERIFY_EMAIL_HTML_TEMPLATE, {
    name: name === "" ? "" : ` ${escapeHtml(name)}`,
    verifyUrl: escapeHtml(input.verifyUrl),
    expiryHours: escapeHtml(expiryHours),
    year: escapeHtml(year),
  })

  const text = fill(VERIFY_EMAIL_TEXT_TEMPLATE, {
    name: name === "" ? "" : ` ${name}`,
    verifyUrl: input.verifyUrl,
    expiryHours,
    year,
  })

  return { subject: VERIFY_EMAIL_SUBJECT, html, text }
}

/** Trim and strip control characters; returns "" when no usable name remains. */
function normalizeName(name: string | undefined): string {
  if (name === undefined) return ""
  return name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Embedded runtime copies — keep in sync with ./templates/ (render.test.ts enforces).

export const VERIFY_EMAIL_HTML_TEMPLATE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1.0" />\n<meta http-equiv="X-UA-Compatible" content="IE=edge" />\n<meta name="x-apple-disable-message-reformatting" />\n<meta name="color-scheme" content="dark" />\n<meta name="supported-color-schemes" content="dark" />\n<title>Verify your email for Sigilix</title>\n<!--[if mso]>\n<noscript>\n<xml>\n<o:OfficeDocumentSettings>\n<o:PixelsPerInch>96</o:PixelsPerInch>\n</o:OfficeDocumentSettings>\n</xml>\n</noscript>\n<![endif]-->\n<style type="text/css">\n  :root { color-scheme: dark; supported-color-schemes: dark; }\n  body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }\n  table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }\n  img { border: 0; line-height: 100%; outline: none; text-decoration: none; }\n  @media only screen and (max-width: 480px) {\n    .sx-shell { padding-left: 12px !important; padding-right: 12px !important; }\n    .sx-card { padding-left: 24px !important; padding-right: 24px !important; }\n  }\n</style>\n</head>\n<body style="margin:0;padding:0;word-spacing:normal;background-color:#0b0c10;" bgcolor="#0b0c10">\n  <!-- Preheader: hidden preview line -->\n  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">Confirm your email to finish setting up your Sigilix account.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>\n  <table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0" bgcolor="#0b0c10" style="background-color:#0b0c10;">\n    <tr>\n      <td align="center" class="sx-shell" style="padding:40px 16px 48px;">\n        <!--[if mso]><table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" align="center"><tr><td><![endif]-->\n        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px;width:100%;">\n          <!-- Logo -->\n          <tr>\n            <td align="center" style="padding:0 0 28px;">\n              <img src="https://sigilix.ai/Sigilix.png" width="44" height="44" alt="Sigilix" style="display:block; border:0;" />\n            </td>\n          </tr>\n          <!-- Card -->\n          <tr>\n            <td bgcolor="#15161b" class="sx-card" style="background-color:#15161b;border:1px solid #2a2b30;border-radius:6px;padding:40px 48px 36px;">\n              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">\n                <tr>\n                  <td style="font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;font-weight:600;color:#f0f0f2;padding:0 0 12px;">Hi{{name}},</td>\n                </tr>\n                <tr>\n                  <td style="font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:26px;color:#c7c8cd;padding:0 0 28px;">Confirm your email to finish setting up your Sigilix account.</td>\n                </tr>\n                <tr>\n                  <td align="center" style="padding:0 0 28px;">\n                    <!--[if mso]>\n                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{verifyUrl}}" style="height:48px;v-text-anchor:middle;width:220px;" arcsize="13%" fillcolor="#f1140d" stroke="f">\n                      <w:anchorlock/>\n                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Verify email</center>\n                    </v:roundrect>\n                    <![endif]-->\n                    <!--[if !mso]><!-->\n                    <a href="{{verifyUrl}}" target="_blank" style="display:inline-block;background-color:#f1140d;color:#ffffff;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;line-height:48px;text-align:center;text-decoration:none;width:220px;border-radius:6px;">Verify email</a>\n                    <!--<![endif]-->\n                  </td>\n                </tr>\n                <tr>\n                  <td style="font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#8a8b91;padding:0 0 28px;word-break:break-all;">or paste this link: <a href="{{verifyUrl}}" target="_blank" style="color:#ff5a54;text-decoration:underline;">{{verifyUrl}}</a></td>\n                </tr>\n                <tr>\n                  <td height="1" bgcolor="#2a2b30" style="background-color:#2a2b30;font-size:0;line-height:0;">&nbsp;</td>\n                </tr>\n                <tr>\n                  <td style="font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#8a8b91;padding:24px 0 8px;">This link expires in {{expiryHours}} hours.</td>\n                </tr>\n                <tr>\n                  <td style="font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#8a8b91;padding:0;">If you didn\'t create a Sigilix account, you can safely ignore this email.</td>\n                </tr>\n              </table>\n            </td>\n          </tr>\n          <!-- Footer -->\n          <tr>\n            <td align="center" style="padding:28px 8px 0;font-family:-apple-system,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:20px;color:#5a5b61;">\n              Sigilix &middot; &copy; {{year}} Sigilix, Inc.<br />\n              Questions? Contact <a href="mailto:support@sigilix.ai" style="color:#8a8b91;text-decoration:underline;">support@sigilix.ai</a>\n            </td>\n          </tr>\n        </table>\n        <!--[if mso]></td></tr></table><![endif]-->\n      </td>\n    </tr>\n  </table>\n</body>\n</html>\n'

export const VERIFY_EMAIL_TEXT_TEMPLATE =
  "SIGILIX\n------------------------------------------------------------\n\nHi{{name}},\n\nConfirm your email to finish setting up your Sigilix account.\n\nVerify your email by opening this link:\n\n{{verifyUrl}}\n\nThis link expires in {{expiryHours}} hours.\n\nIf you didn't create a Sigilix account, you can safely ignore\nthis email.\n\n------------------------------------------------------------\nSigilix - (c) {{year}} Sigilix, Inc.\nQuestions? Contact support@sigilix.ai\n"
