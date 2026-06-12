# SIG-392 — security→logic reclassification at the evidence gate (enforce)

## Problem (e2e-frontend#20, batch PR #494's F4)

The SIG-108 security-evidence gate (enforce in prod) demoted a TRUE P1 —
the planted T4 cache-key collision, concrete failureExample attached, clean
anchor at :9-10 — to the review body, where external evaluators score it
"silent". Root cause is a category gap, not a gate bug: security-shaped
LOGIC bugs (key collisions, authz-by-construction) can never carry scanner
evidence, and the NONE+justification authz path didn't admit it either.

## Change

In the gate's demote branch (validation-walk.ts SIG-108 else): when the
failing finding carries a CONCRETE MECHANISM — non-empty trimmed
`failureExample` — RECATEGORIZE to `category:"logic"` and keep it inline
(it then faces the logic-class machinery: the grounding gate stays enforce,
hallucination guard already passed). Findings WITHOUT a concrete mechanism
demote exactly as today — the anti-hallucination wall (the confabulated
SSRF/path-traversal class) is untouched.

Telemetry: `pr-review-security-reclassified-logic` (path, line, score,
headline[0:100], gateReason) per reclassification.

Flag: `OPENCLAW_SECURITY_RECLASS` "on"/"off" (off = byte-identical to
today; prod ships "on"). No shadow stage — founder call, rationale:
demote≠drop, these findings ALREADY POST in the body, so enforce changes
PLACEMENT not FP count; the believability bar counts posted P0/P1 FPs on
any surface; rollback is one line; the next probes measure it directly.

## Safety argument

- Reclassified findings still carry their original trust pill and grounding
  requirements; score unchanged (no inflation path).
- The gate's keep/enrich path is untouched; only the demote branch forks.
- A fabricated failureExample on a confabulated finding is the residual
  risk — bounded: the finding was already customer-visible in the body, and
  the grounding gate + dismissal corpus remain the backstops.

## Tests

The frontend#20 collision shape (security sev4, no manifest evidence,
concrete failureExample) → category flips to logic, stays inline, telemetry
fires. No failureExample → demotes exactly as today (byte-identical).
Flag off → byte-identical. Keep/enrich path unaffected.
