# ADR: SIG-184 — Private-runner shape for deterministic tools + verification-by-execution

Status: **Proposed** (awaiting founder review — SIG-184 is "done when Sigilix has a *reviewed* runner architecture").
Date: 2026-05-29.
Deciders: founder.
Related: SIG-107 (subprocess tools), SIG-171/SIG-144 (annotation posting), SIG-285 (verification-by-execution), ARC-188 (SARIF-evidence ingest, shipped).

## Context

The Sigilix worker is a Cloudflare Worker and **cannot shell out**, so deterministic tools (Semgrep/OpenGrep, ESLint, Ruff, actionlint, ShellCheck — SIG-107) and the next epic's verification-by-execution (SIG-285: run a repro/test, return a "receipt") have nowhere to run. We need a **runner**: an execution environment the worker orchestrates, which returns normalized SARIF + (later) execution receipts that flow into the existing review pipeline.

This ADR chooses the **first runner shape** and the **phasing**. It was produced from a grounded design pass (requirements lens over the repo + a judge panel scoring three shapes against the AC and the SIG-285 fit + an adversarial stress-test).

## Decision

**Ship the GitHub Action as the v1 runner shape, in three demand-gated phases:**

| Phase | Shape | Audience | Gate |
|---|---|---|---|
| **1 (now → July)** | **GitHub Action** (runs in the customer's CI) | the July design partners (DFV/UNLV) + everyone | build now |
| 2 (demand-gated) | Cloudflare Containers (Sigilix-managed, zero-setup) | SMB/self-serve who consent to code egress | when SMB self-serve demand is real |
| 3 (sell-then-build) | Self-hosted sidecar (outbound-only long-poll) | enterprise / code-can't-leave buyers | when a paying enterprise needs it |

This mirrors the proven Qodo Merge / PR-Agent two-tier pattern (Action as the common path; in-network deployment as the enterprise option) and **defers the two genuinely hard builds — multi-tenant untrusted execution, and a job-dispatch control plane — until a customer is paying for them.**

## Why GitHub Action first (the four decisive arguments)

1. **It unblocks SIG-285 soonest, because verification is inherently async + latency-tolerant.** A verification *receipt* ("I ran the repro/test, here's the exit code") lands fine as a follow-up comment minutes later; the SIG-285 requirement itself mandates async/best-effort receipts that never fail the review. CI queue latency only hurts the *sub-second inline-lint hot path* — which we keep server-side/async anyway (the webhook already acks in ~50ms and the review runs in the 15-min queue consumer). So the latency objection is misdirected when applied to verification.
2. **It is the only shape that serves the July audience.** The design partners are an enterprise referral. Cloudflare Containers clones the customer's private source into *Sigilix's* Cloudflare tenant — a security-questionnaire fail for that exact segment, regardless of microVM hardening. Building the managed runner first is building for a customer we don't have yet.
3. **It has the strongest receipt for the least new trust surface — with one load-bearing requirement.** The runner executes on the customer's per-job-reimaged CI VM with their secrets; **Sigilix never receives source code**, only normalized SARIF + the receipt. OIDC binds that evidence to `repo + head_sha + workflow + run_id`, keyless and auditable. The hole: OIDC proves *who produced it against what SHA*, not *that the tools ran unmodified*. **We close it by publishing a Sigilix *composite* Action and pinning the accepted OIDC subject to it (`job_workflow_ref`)** — then the receipt means "code at SHA X was run by *Sigilix's* pinned action in the customer's CI." This pinning is **load-bearing and must be in v1**, not deferred (it's cheap up front, expensive to retrofit, and the whole believability chain — SIG-114 FP-attribution → SIG-285 → SIG-286 — depends on a trustworthy receipt).
4. **It reuses what already exists.** SARIF ingest (ARC-188), the evidence-manifest + citation-gate (SIG-108), the prompt evidence-block rendering (`render.ts`/`renderHitsForPrompt`), and the check-run pattern (SIG-216) already consume + post deterministic findings. The Action is mostly a new *evidence feeder* into the best-effort ARC-188 channel, not a new posting mechanism.

The cross-tenant blast radius is **structurally zero** (each run is in the customer's own VM), versus the managed container where "Sigilix leaked Tenant A's code to Tenant B" is a fatal new failure mode in our own account.

## Trust boundary (Phase 1 / GitHub Action)

| Actor | Sees | Must NOT |
|---|---|---|
| Customer CI runner (GitHub-hosted, per-job VM) | the checkout + the customer's CI secrets, in **their** trust boundary | — |
| Sigilix-published composite Action | the checkout (read-only); runs the pinned tool suite + one verification command | persist secrets; phone home |
| OIDC token | mints a short-lived, keyless identity bound to `repo+sha+workflow+run_id` | — |
| Sigilix worker (SARIF-ingest endpoint) | **only** the normalized SARIF + receipt + OIDC claims | ever receive source code, build artifacts, or customer secrets |
| Sigilix GitHub App | posts the review/check-run via installation token | hold or see the runner's credentials |

**Net data-handling story:** customer source never leaves the customer's GitHub tenancy; Sigilix holds only findings + provenance. This is the cleanest possible posture for a security questionnaire and works for GHES + self-hosted runners (with the ephemeral-runner caveat below).

## Requirements coverage (the AC)

- **Tools:** Semgrep/OpenGrep, ESLint (`@microsoft/eslint-formatter-sarif`), Ruff, actionlint, ShellCheck — all emit or convert to SARIF; the Action produces one multi-`runs[]` SARIF 2.1.0 that ARC-188 already parses.
- **SARIF return → SIG-171/144 annotation:** via the existing ARC-188 ingest → evidence-manifest → review-thread posting. (Note SIG-216: findings live in the review thread, not check annotations.)
- **Degrade safely / never block webhook ack:** the webhook already acks in ~50ms and enqueues; the Action is an **async, possibly-absent** evidence source. The worker time-bounds the wait and proceeds with a degraded (LLM-only) review if SARIF doesn't arrive — exactly the existing best-effort SARIF channel (404/missing → silent skip, no gate).
- **Tenant isolation:** GitHub-hosted runners are per-job, hypervisor-isolated, reimaged after each run. (Caveat: self-hosted runners are *not* ephemeral by default — the install flow must steer self-hosted users to ephemeral runners or the isolation claim weakens for that segment.)
- **Version pinning:** native + idiomatic — `uses: sigilix/scan-action@<SHA>`; satisfies the AC without Sigilix shipping a server-side scanner-binary matrix.
- **Timeout/resource limits:** the Action's step timeouts + runner ceiling (customer's YAML, Sigilix-recommended defaults) + the **worker-side wait-for-SARIF timeout** (Sigilix-enforced). Two places; document both.
- **Artifact retention + audit logging:** raw artifacts live in the customer's account (their retention); Sigilix **persists the OIDC claims + run IDs server-side** to build the audit trail ("these findings came from this Action run at this SHA"). This is new but small work.
- **Install flow:** customer commits the workflow YAML (pinned to the composite Action) + grants `id-token: write` (OIDC). The flow **must verify the workflow exists** (see Biggest Risk).

## Biggest risk to de-risk first: the "Action-absent dark layer"

The highest-probability, highest-cost risk is **customers installing the GitHub App but never adding the workflow** — silently getting LLM-only reviews with the entire deterministic + verification layer dark in prod, with no loud failure. This is the **same failure class** as Sigilix's indexer incident ("flag on but never bootstrapped — the app was installed BEFORE the flag, so nothing ever indexed"). It directly poisons the believability roadmap: FP-attribution can't distinguish "verification said this was fine" from "verification never ran."

**Mitigation (build this first, before verification depth):**
- Per-repo, per-PR telemetry: `runner-evidence-present` / `runner-evidence-absent` (mirrors the `/metrics/validation` gate pattern).
- Surface "Action not detected — running LLM-only" in the check-run body.
- Install flow checks for / offers to commit the workflow.

This is cheap, is the exact instrumentation needed for the eventual managed-tier-vs-Action-tier split, and prevents the deterministic layer from going dark the way the indexer did.

## Cheapest July SIG-285 demo (does not require the full install flow)

1. A Sigilix-published **composite Action** that checks out PR head, runs the deterministic tool suite, runs **one** configured verification command (`npm test` / `./repro.sh`), and emits a multi-`runs[]` SARIF + a **receipt block** (exit code, stdout excerpt, timestamp, runner identity = the OIDC subject).
2. SARIF/receipt back via an **OIDC-authenticated POST** to a Sigilix ingest endpoint (reuses ARC-188).
3. Thread the receipt into specialist/synth prompts as an **AUTHORITATIVE evidence block** — `render.ts` + the evidence-manifest already do this for SARIF; the receipt is just another deterministic block tagged with `runner identity + exit code`.

That's the whole demo: a *real receipt proving a real test ran at a real SHA* feeding a real verdict — the believability proof SIG-114 → SIG-285 needs — with no sandbox provisioning, no cross-tenant isolation, no credential-minting-into-customer-compute, no control plane.

## Consequences

- **Accept:** a two-headed posture (GitHub App + Action publisher), CI-queue latency for the lint leg (mitigated by keeping it async/best-effort), per-customer setup friction (mitigated by the install flow + presence telemetry), and treating inbound SARIF as **evidence-with-provenance, not ground truth** (mitigated by the composite-Action OIDC pin + severity sanity-checks).
- **Gain:** zero code-egress, near-zero Sigilix compute cost, the cleanest enterprise data story, native version pinning, the soonest SIG-285 receipt, and a v1 that doubles as the self-host story.
- **Deferred (separate issues):** the composite Action implementation + tool wiring (SIG-107), the OIDC SARIF-ingest endpoint, the receipt evidence-block plumbing (SIG-285), the presence telemetry, Phase 2 (CF Containers) and Phase 3 (self-hosted sidecar, outbound long-poll + version-handshake).

## Open questions for the founder

1. Are the July design partners actually code-egress-averse (confirms Action-over-Containers for v1), or would a zero-setup managed container demo land better with them specifically?
2. Composite Action vs reusable workflow for the OIDC `job_workflow_ref` pin — confirm the pinning mechanism.
3. Worker-side wait-for-SARIF timeout budget (how long the review waits for async evidence before going LLM-only).
