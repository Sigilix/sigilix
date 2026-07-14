# entitlements — the paid-only feature gate

The single source of truth for **"is this paid-only feature available on this plan?"**
Free-tier installations (and `individual`, and any unknown/unset plan) get core PR
reviews but NOT the four paid-only surfaces.

## Policy (founder-confirmed 2026-07-02)

| Feature (`EntitledFeature`) | Surface | Entitled tiers |
| --- | --- | --- |
| `ci_triage` | CI-failure triage sticky comment | `pro`, `teams`, `max`, `ultra`, `enterprise` |
| `slack` | Slack app-mention assistant | `pro`, `teams`, `max`, `ultra`, `enterprise` |
| `linear` | Linear triage + assign→PR agent | `pro`, `teams`, `max`, `ultra`, `enterprise` |
| `cli_byok` | BYO model-key in the CLI/portal — **display/config gate + Terms** (no server touchpoint) | `pro`, `teams`, `max`, `ultra`, `enterprise` |

`ENTITLED_TIERS = {pro, teams, max, ultra, enterprise}` (teams is feature-complete;
`enterprise` is the CONTRACT tier — set manually on `tenant.tier` when a team signs, never
self-serve Stripe — and is the TOP tier: every feature plus the highest usage cap).
**Fail-closed**: anything not positively one of those five — `free`, `individual`, `team`,
`"default"`, unknown, unset, a typo — is NOT entitled.

### How each feature is enforced

`ci_triage`, `slack`, and `linear` have a **server call site** that resolves the
installation's plan and branches on `resolveEntitlement(...).blocked` — the
authoritative gate. `cli_byok` is different: "bring your own model key" never
routes through the Worker (the CLI talks to the user's own model provider
directly; the portal has no server BYOK endpoint), so there is no server request
to reject. `cli_byok` is enforced at the **display/config layer** — the CLI/portal
read this same `isFeatureEntitled` policy to disable the BYOK control and show
`upsellFor("cli_byok")` — backed by the **Terms**. The policy is defined here so
both the server gates and the client display gate read one source of truth (and a
future server touchpoint is a one-line `resolveEntitlement` call).

## The boundary is one edit

- `domain/entitlements.ts` — `ENTITLED_TIERS`, `EntitledFeature`, `isFeatureEntitled`.
  Change the tiers or open a feature to free HERE; surfaces never re-decide policy.
- `domain/mode.ts` — `resolveEntitlementsMode` reads `OPENCLAW_ENTITLEMENTS_MODE`.
- `domain/upsell.ts` — the human-facing upgrade copy (Slack/Linear + the CLI BYOK notice).
- `adapters/d1-plan-read.ts` — `readInstallationPlan`, fail-closed read of `tenant.tier`.
- `adapters/gate.ts` — `resolveEntitlement(env, {installationId, feature})`, the ONE call
  every surface makes; returns `{ mode, plan, entitled, blocked, wouldBlock }`.

## Rollout flag — `OPENCLAW_ENTITLEMENTS_MODE`

Pinned in `wrangler.toml [vars]`, default `off`.

- `off` (default) — **no gating**, no plan lookup; byte-identical to pre-entitlements.
- `shadow` — resolve the plan and LOG what would be gated, but ALLOW it. Validate the
  plan→installation resolution on live traffic before enforcing.
- `enforce` — actually gate: an un-entitled installation is blocked from the surface.

Surfaces only ever branch on `decision.blocked` (true only in `enforce` + not entitled).

## Where each surface maps its installation → plan

- CI-triage — the PR's `installationId` (`handleCiTriage`, `src/lib/triage-ci.ts`).
- Slack — the mentioned team's exact authorized installation
  (`scope.installationId`, `src/index-slack-webhook.ts`).
- Linear agent — the issue's team → repo → installation (`runLinearAgentRun`,
  `src/lib/linear-agent-run.ts`).
- Linear triage — the PR's installation (`handleLinearTriageCommand`,
  `src/lib/github-mention-linear-triage.ts`).

Every lookup is keyed strictly by that surface's own installation id, so tenant
isolation is structural — a lookup can only read the row for the installation it was
handed.

## Follow-ups (out of scope here)

- **CLI BYOK gating** — `sigilix-cli` repo + portal UI (`cli_byok` is enum-ready).
- **Portal upgrade prompts** + BYOK gating UI.
- **Student-Pro entitlement grant** mechanism (ASU/UNLV) — a way to write `pro` to a
  tenant row for verified students.
