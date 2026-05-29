# ADR: SIG-184 — Private-runner shape for deterministic tools + verification-by-execution

Status: **Proposed** (awaiting founder review — SIG-184 is "done when Sigilix has a *reviewed* runner architecture").
Date: 2026-05-29.
Deciders: founder.
Reviewed-by: internal design pass (requirements lens + 3-shape judge panel + adversarial stress-test) + **Codex (architecture second voice)**. Codex agreed on Action-v1 + the phasing and drove three changes folded in here: (1) the receipt mechanism is a **reusable workflow**, not a composite Action (`job_workflow_ref` semantics); (2) **forked-PR / untrusted-code + `id-token` safety** must be explicit in the install template; (3) runner presence + provenance must be a **first-class review state** (the false-believability gap), not just telemetry. (Kimi, the usual second design voice, was unreachable off-LAN this session.)
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
3. **It has the strongest receipt for the least new trust surface — with one load-bearing requirement.** The runner executes on the customer's per-job-reimaged CI VM with their secrets; **Sigilix never receives source code**, only normalized SARIF + the receipt. OIDC binds that evidence to `repo + head_sha + workflow + run_id`, keyless and auditable. The hole: OIDC proves *who produced it against what SHA*, not *that the tools ran unmodified*. **We close it by shipping the Sigilix runner as a *pinned reusable workflow* (the customer's workflow `uses: sigilix/runner/.github/workflows/scan.yml@<SHA>`) and validating the OIDC `job_workflow_ref` claim against it.** This mechanism is precise: GitHub's `job_workflow_ref` claim identifies the **called reusable workflow** at a `path@ref` — **not** a composite Action step (an earlier draft said "composite Action"; that is NOT what `job_workflow_ref` binds, per GitHub's OIDC docs, so it would not be a defensible proof). With the reusable-workflow pin, the receipt means "code at SHA X was run by *Sigilix's* pinned reusable workflow in the customer's CI." This pinning is **load-bearing and must be in v1**, not deferred (cheap up front, expensive to retrofit; the whole believability chain — SIG-114 FP-attribution → SIG-285 → SIG-286 — depends on a trustworthy receipt). It still does NOT prove semantic tool correctness — acceptable for v1 *if* tool versions + the receipt schema are pinned.
4. **It reuses what already exists.** SARIF ingest (ARC-188), the evidence-manifest + citation-gate (SIG-108), the prompt evidence-block rendering (`render.ts`/`renderHitsForPrompt`), and the check-run pattern (SIG-216) already consume + post deterministic findings. The Action is mostly a new *evidence feeder* into the best-effort ARC-188 channel, not a new posting mechanism.

The cross-tenant blast radius is **structurally zero** (each run is in the customer's own VM), versus the managed container where "Sigilix leaked Tenant A's code to Tenant B" is a fatal new failure mode in our own account.

## Trust boundary (Phase 1 / GitHub Action)

| Actor | Sees | Must NOT |
|---|---|---|
| Customer CI runner (GitHub-hosted, per-job VM) | the checkout + the customer's CI secrets, in **their** trust boundary | — |
| Sigilix-published reusable workflow (the customer's workflow `uses:` it, SHA-pinned) | the checkout (read-only); runs the pinned tool suite + one verification command | persist secrets; phone home |
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
- **Install flow:** customer commits a workflow YAML that `uses:` Sigilix's reusable workflow SHA-pinned + grants `id-token: write` (OIDC). The flow **must verify the workflow exists** (see Biggest Risk). **Forked-PR safety (load-bearing, Codex):** the install template must be explicit about safe triggers + permissions — `id-token: write` + a repo checkout on *untrusted fork code* (`pull_request_target` semantics) is a known privilege-escalation/secret-exfil footgun. The template defaults to safe handling (run untrusted fork code without privileged tokens/secrets; gate OIDC + verification to trusted contexts) and documents it loudly.

## Biggest risk to de-risk first: the false-believability gap

The highest-probability, highest-cost risk is **Sigilix presenting a review as "verified" when the runner was actually absent, spoofable, or not pinned to the real Sigilix workflow** (Codex). Three faces of the same gap: (a) the customer installs the GitHub App but never adds the workflow → silent LLM-only reviews with the deterministic + verification layer dark in prod — the **same failure class** as Sigilix's indexer incident ("flag on but never bootstrapped — the app was installed BEFORE the flag, so nothing ever indexed"); (b) inbound SARIF/receipt that isn't bound to Sigilix's pinned reusable workflow → spoofable evidence; (c) an async receipt that's still pending rendered as if verification passed. Any of these poisons the believability roadmap: FP-attribution can't distinguish "verification said this was fine" from "verification never ran / was faked."

**Mitigation — make runner presence + provenance a FIRST-CLASS review/check-run state (build this first, before verification depth):**
- The check-run / review explicitly carries one of `verified` / `evidence-pending` / `runner-absent` — an LLM-only review must NEVER look "verified."
- Reject any inbound SARIF/receipt whose OIDC `job_workflow_ref` doesn't match Sigilix's pinned reusable workflow (provenance gate).
- Per-repo, per-PR telemetry: `runner-evidence-present` / `runner-evidence-absent` (mirrors the `/metrics/validation` gate pattern).
- Install flow checks for / offers to commit the workflow.

This is cheap, is the exact instrumentation needed for the managed-tier-vs-Action-tier split, and stops the deterministic layer from going dark — or looking grounded when it isn't — the way the indexer did.

## Cheapest July SIG-285 demo (does not require the full install flow)

1. A Sigilix-published **reusable workflow** (the demo repo `uses:` it, SHA-pinned) that checks out PR head, runs the deterministic tool suite, runs **one** configured verification command (`npm test` / `./repro.sh`), and emits a multi-`runs[]` SARIF + a **receipt block** (exit code, stdout excerpt, timestamp, runner identity = the OIDC `job_workflow_ref`).
2. SARIF/receipt back via an **OIDC-authenticated POST** to a Sigilix ingest endpoint (reuses ARC-188).
3. Thread the receipt into specialist/synth prompts as an **AUTHORITATIVE evidence block** — `render.ts` + the evidence-manifest already do this for SARIF; the receipt is just another deterministic block tagged with `runner identity + exit code`.

That's the whole demo: a *real receipt proving a real test ran at a real SHA* feeding a real verdict — the believability proof SIG-114 → SIG-285 needs — with no sandbox provisioning, no cross-tenant isolation, no credential-minting-into-customer-compute, no control plane.

## Consequences

- **Accept:** a two-headed posture (GitHub App + reusable-workflow publisher), CI-queue latency for the lint leg (mitigated by keeping it async/best-effort), per-customer setup friction (mitigated by the install flow + presence state), the forked-PR/untrusted-code handling burden in the install template, and treating inbound SARIF as **evidence-with-provenance, not ground truth** (mitigated by the reusable-workflow `job_workflow_ref` pin + severity sanity-checks).
- **Gain:** zero code-egress, near-zero Sigilix compute cost, the cleanest enterprise data story, native version pinning, the soonest SIG-285 receipt, and a v1 that doubles as the self-host story.
- **Deferred (separate issues):** the reusable-workflow + tool wiring (SIG-107), the OIDC SARIF-ingest endpoint (with the `job_workflow_ref` provenance gate), the receipt evidence-block plumbing + the first-class `verified/pending/absent` state (SIG-285), the presence telemetry, Phase 2 (CF Containers) and Phase 3 (self-hosted sidecar, outbound long-poll + version-handshake).

## Open questions for the founder

1. Are the July design partners actually code-egress-averse (confirms Action-over-Containers for v1), or would a zero-setup managed container demo land better with them specifically?
2. ~~Composite Action vs reusable workflow for the OIDC `job_workflow_ref` pin~~ — **RESOLVED (Codex + GitHub OIDC docs): reusable workflow.** `job_workflow_ref` binds the called reusable workflow, not a composite Action.
3. Worker-side wait-for-SARIF timeout budget (how long the review waits for async evidence before going LLM-only).
