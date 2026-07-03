# entitlements — the paid-only feature gate

The single source of truth for **"is this paid-only feature available on this plan?"**
Free-tier installations (and `individual`, and any unknown/unset plan) get core PR
reviews but NOT the three paid-only surfaces.

## Policy (founder-confirmed 2026-07-02)

| Feature (`EntitledFeature`) | Surface | Entitled tiers |
| --- | --- | --- |
| `ci_triage` | CI-failure triage sticky comment | `pro`, `max`, `ultra` |
| `slack` | Slack app-mention assistant | `pro`, `max`, `ultra` |
| `linear` | Linear triage + assign→PR agent | `pro`, `max`, `ultra` |
| `cli_byok` | BYOK key entry (CLI/portal) — **gating is a follow-up** | `pro`, `max`, `ultra` |

`ENTITLED_TIERS = {pro, max, ultra}`. **Fail-closed**: anything not positively one of
those three — `free`, `individual`, `team`, `enterprise`, `"default"`, unknown, unset,
a typo — is NOT entitled.

## The boundary is one edit

- `domain/entitlements.ts` — `ENTITLED_TIERS`, `EntitledFeature`, `isFeatureEntitled`.
  Change the tiers or open a feature to free HERE; surfaces never re-decide policy.
- `domain/mode.ts` — `resolveEntitlementsMode` reads `OPENCLAW_ENTITLEMENTS_MODE`.
- `domain/upsell.ts` — the human-facing upgrade copy (Slack/Linear).
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
- Slack — the mentioned team's mapped repo installation
  (`scope.repos[0].installationId`, `src/index-slack-webhook.ts`).
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
