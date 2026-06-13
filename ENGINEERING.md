# ENGINEERING.md — how Sigilix is built

This is the reference doc. Read it once to understand what the system does, how the code is
organized, and the conventions for writing in it. [`CONTRIBUTING.md`](./CONTRIBUTING.md) is the
workflow (how a change gets made); [`COMPLIANCE.md`](./COMPLIANCE.md) is the enforced structural
rules (what CI will block). This file is the *why* and the *how* behind both.

> **If you are an intern, worker, or AI model: read this file before you work in the repo, and
> tell your point of contact you have read it** (for an intern, that's your supervising engineer;
> for an AI model, the engineer running you). It is not optional background — it is how you learn
> where code goes and how it is written here, so your change fits the system instead of fighting
> it. Pair it with [`COMPLIANCE.md`](./COMPLIANCE.md) (the rules CI enforces).

> We build a multi-agent AI code-review product that runs as a single Cloudflare Worker. The
> codebase follows clean architecture: pure decision logic at the center, IO at the edges,
> dependencies pointing inward. The goal is **believability** — every finding we post should be
> one a senior engineer would stand behind.

---

## 1. What Sigilix is, in one screen

A GitHub pull request opens. Within ~50ms we acknowledge the webhook and enqueue a job. A queue
consumer picks it up, and for a PR review it runs an **ensemble**: four specialist models (logic,
security, performance, tests) review the diff in parallel, a synthesizer dedupes their verdicts
into one, a chain of ~13 **validation gates** drops anything not grounded in evidence, and the
survivors are rendered as inline-anchored comments and posted as a single GitHub review.

The same Worker also handles Linear issue triage, @-mention replies (GitHub and Linear), PR
overviews, CI-failure triage, and repository indexing. Everything is one Worker, one queue, a set
of Durable Objects for stateful work, and Cloudflare KV / Vectorize / D1 for storage.

The thing that makes Sigilix different from other AI review tools is the **believability stack**:
the specialists are deliberately run for recall, then the deterministic gates enforce precision.
We would rather a specialist over-produce and have a gate cut the ungrounded finding than have
the model quietly drop a real bug. That trade-off is the product.

---

## 2. The request lifecycle

```
GitHub / Linear webhook
   │  POST /github/webhook  or  /linear/webhook
   ▼
fetch(request, env, ctx)                         src/index.ts
   ├─ verify signature (HMAC; OIDC for /runner/ingest)
   ├─ parse payload → decide which jobs to emit   src/index-internals.ts
   ├─ enqueue typed JobMessage(s)                 → Cloudflare Queue
   └─ return 202  (~50ms — no model work on the request path)
   ▼
queue(batch, env)                                 src/index.ts → src/index-dispatch.ts
   └─ dispatchJob(job, env)  — switch on job.type
        ├─ "pr-review"      → PrReviewRunDO gate → ensemble pipeline   (the core path)
        ├─ "pr-overview"    → lightweight overview comment
        ├─ "pr-labels"      → auto-label suggestion
        ├─ "ci-triage"      → CI failure log analysis
        ├─ "linear-triage"  → issue rewrite (Context / Acceptance / Done-when)
        ├─ "linear-mention" → retrieval + reply
        ├─ "index-repo"     → chunk → embed → Vectorize
        └─ …                  (see src/shared/types/job.ts for the full union)
```

Why the split: the webhook path must return fast (GitHub/Linear time out webhooks), so it does no
model work — it only verifies, decides, and enqueues. All the expensive work happens in the queue
consumer, where we have the full Worker CPU budget and retry semantics.

**Key files:** `src/index.ts` (entry: fetch/queue/scheduled + Durable Object exports — these
*must* stay exported here for wrangler migrations to resolve), `src/index-dispatch.ts`
(`dispatchJob` — the job router), `src/index-github-webhook.ts` / `src/index-webhooks.ts` (the
webhook handlers), `src/index-internals.ts` (the pure `decidePullRequestJobs` decision logic).

---

## 3. The clean-architecture model — what is where, and why

The repo is organized so that **pure decision logic never depends on IO.** This is what lets us
unit-test the believability core in isolation and swap infrastructure (e.g. Ollama → OpenRouter)
behind a single port.

### Top-level map

| Path | What lives there |
|------|------------------|
| `src/index.ts`, `src/index-*.ts` | Worker entry: fetch/queue/scheduled handlers, the job dispatcher, webhook handlers |
| `src/shared/` | Foundations every feature builds on — see below |
| `src/lib/ensemble/` | The PR-review ensemble, fully clean-arch (`domain`/`app`/`ports`/`adapters`/`render`) |
| `src/lib/` | Feature handlers (triage, overview, mention, ci-triage) and supporting modules |
| `src/features/` | Composable deterministic lenses (AST rules, dep-vulns, SARIF evidence, precision profile) |
| `src/do/` | Durable Objects — stateful work and rolling metrics |
| `src/prompts/` | LLM prompt templates, per specialist |
| `src/test-shims/` | Vitest shims for Cloudflare Workers runtime (DO + SQLite mocks) |
| `e2e/` | Cross-cutting + live model-eval suites |
| `evals/` | Offline eval tooling (collect → label → score on benchmark PRs) |
| `scripts/` | Admin and analysis scripts |
| `docs/adr/` | Architecture decision records |

### `src/shared/` — the foundation

- `shared/types/` — pure types with no runtime: `env.ts` (the `Env` interface — every binding and
  secret), `job.ts` (the `JobMessage` discriminated union), `github.ts` (GitHub DTO shapes).
- `shared/domain/` — pure logic: `config/` (parse + resolve `sigilix.json`), `specialist-role.ts`,
  `finding-category.ts`, `pr-review-finding.ts` (the core finding/verdict types), `schemas.ts`
  (the JSON schema the models must satisfy), `index-keys.ts` (KV key conventions), policy helpers.
- `shared/ports/` — the cross-cutting seams: `ModelProviderPort`, `EmbeddingPort`.
- `shared/adapters/` — IO implementations: `github/` (the REST+GraphQL `GitHubClient`, app-JWT
  signing, webhook HMAC verify, behind a narrow barrel), `model/` (Ollama chat, Workers AI
  embeddings), `config/load.ts`.
- `shared/util/` — pure helpers: diff-position mapping, anchor-lines, path-glob, json-extract,
  bounded-concurrency, xml-escape.

### `src/lib/ensemble/` — the heart, in clean-arch layers

- `domain/` — **the believability core, all pure.** `validation.ts` + `validation-walk.ts` +
  `validation-phases.ts` (the post-synthesis adjudication), `gates/` (the ~13 validation gates),
  `verdict.ts`, `findings.ts`, `synth.ts`, `policy.ts` (quorum, early-exit, degraded-coverage
  predicates), `budget.ts` (timeout constants), `model-policy.ts` (retry/fallback knobs),
  `metric-events.ts` (the telemetry event vocabulary).
- `app/` — **the thin orchestrator.** `orchestrator.ts` (`handlePrReviewEnsemble`), `session.ts`
  (run state + finalize), `context/` (fetch-and-pack, gather-evidence, gather-graph,
  assemble-prompts), `specialists.ts` (fan-out + synth), `adjudicate.ts` (apply the gates),
  `render-prep.ts`, `verify-and-build.ts`, `publish.ts`.
- `ports/` — `model`, `github`, `review-sink`, `retrieval`, `graph`, `persistence`,
  `runner-receipt`, `clock`, plus the metric `sinks`. Type-only.
- `adapters/` — `model-provider.ts` (the Ollama→OpenRouter seam: chat + retry + the specialist
  runners), `retrieval.ts` (Vectorize + lexical), `persistence.ts` (KV + DO telemetry),
  `review-sink.ts` (GitHub review posting), `graph.ts` (RepoGraphDO queries).
- `render/` — `finding-comment.ts`, `finding-format.ts`, `review-body.ts`, `submission.ts`,
  `fallback.ts`.

**The dependency arrows inside the ensemble:** `domain` imports only `shared`. `app` imports
`domain` and `ports` (never an adapter directly). `adapters` implement `ports` and may import
`domain` types. `render` imports `domain` types. This is the rule §1 of COMPLIANCE.md enforces.

---

## 4. The ensemble pipeline in depth

`handlePrReviewEnsemble(args)` in `app/orchestrator.ts` runs these phases in strict order:

1. **Config resolve** — `parseEnsembleConfig(env)` + per-repo `sigilix.json` overrides.
2. **Fetch & pack** (`context/fetch-and-pack.ts`) — PR diff, file contents, commits, open checks;
   the router decision (which specialists run for this diff).
3. **Gather evidence** (`context/gather-evidence.ts`) — security fact manifest, CI SARIF (if
   present), prior dismissals (review-memory), Vectorize retrieval per specialist.
4. **Gather graph** (`context/gather-graph.ts`) — SIG-138 code/dependency graph: cross-file reach,
   import chains, symbol resolution (when graph retrieval is enabled).
5. **Assemble prompts** (`context/assemble-prompts.ts`) — format everything into the four
   specialist prompts, trimmed to per-role token budgets.
6. **Specialist fan-out + synth** (`app/specialists.ts`) — **the believability heart.** Four
   specialists run via `Promise.allSettled`, each with per-model retry and cross-provider
   fallback under a timeout; a quorum check; optional shadow runs; recall-floor enforcement; then
   the synthesizer dedupes the surviving verdicts into one with provenance.
7. **Adjudicate** (`app/adjudicate.ts` → `domain/validation.ts`) — `validateForSubmission` walks
   every finding through the ~13 gates and keeps or drops each.
8. **Render prep** (`app/render-prep.ts`) — sort by path+line, dedupe inline vs body.
9. **Verify & build** (`app/verify-and-build.ts`) — SIG-285: correlate findings against CI SARIF
   evidence, mark verified/pending/absent.
10. **Publish** (`app/publish.ts`) — submit the review to GitHub (body + inline comments),
    complete the check run, optionally post the inline overview.
11. **Finalize** (`app/session.ts`) — record telemetry to KV and the metrics DOs; update
    review-memory if the post succeeded.

### The validation gates — the believability core

Located in `domain/gates/validate-*.ts`. Each is a **pure decision function**: given a finding
and its evidence, return keep / drop / demote with a reason. Examples: `validate-logic-finding`
(SIG-109 — a high-severity logic claim must quote a concrete added-line token or have a
co-located AST hit), `validate-security-finding` (SIG-108 — reachable evidence), `validate-test-finding`
(SIG-113 — cite an inspected test file), `validate-inline-grounding` (SIG-281 — demote vague
low-severity findings to the body), `validate-refutation-survival` (SIG-325 — self-originated
findings need a mechanism rationale).

Two invariants make the gates safe:

- **Shadow-first.** Each gate reads an `OPENCLAW_*_VALIDATOR_MODE` flag: in `shadow` it only emits
  telemetry (measures what it *would* drop); in `enforce` it actually drops. New gates ship in
  shadow, get measured, then flip.
- **Fail closed to KEEP.** When a gate is uncertain, it keeps the finding. We never silently drop
  a real high-severity (P0/P1) finding to make precision numbers look better. Recall safety is
  non-negotiable — it is the difference between a tool engineers trust and one they mute.

This is why the golden matrix (`e2e/validation-golden-matrix.test.ts`) pins both the output and
the *ordered telemetry callbacks*: any change to gate behavior is visible, and any refactor that
preserves behavior passes untouched.

---

## 5. Durable Objects — stateful work

Cloudflare Durable Objects own state that must be single-threaded and consistent. Each is exported
from `src/index.ts` (wrangler migrations resolve class names against the entry module).

| DO | Role |
|----|------|
| `PrReviewRunDO` | PR review run state machine. Routes: `/enqueue` (webhook), `/pickup` (consumer), `/run-result` (consumer callback), `/status` (public). Alarm drives retry backoff (30s/90s/270s) and a watchdog for a missing result. |
| `RepoGraphDO` | SIG-138 per-repo code + dependency graph in SQLite; query-only at review time. |
| `RunnerReceiptDO` | SIG-184 single-use OIDC receipt guard — prevents duplicate SARIF ingest. |
| `ValidationMetricsDO` | Rolling per-gate drop-rate telemetry (`/metrics/validation`). |
| `VerificationMetricsDO` | SIG-285 verification verdict distribution. |
| `RunnerEvidenceMetricsDO` | SIG-184 runner-evidence adoption. |
| `GraphMetricsDO` / `GraphExpansionMetricsDO` | SIG-152 / SIG-286 graph-retrieval + context-expansion measurement. |

The metrics DOs exist because the believability work is **measure-then-flip**: a gate or feature
ships in shadow, accrues telemetry in a DO, and we read `/metrics/*` to decide whether to enforce.

---

## 6. Monitoring and operator reports

Sigilix has two monitoring surfaces: live authenticated `/metrics/*` reads for rolling Durable
Object counters, and offline CLI reports for log/KV exports. The live routes use the shared
`OPENCLAW_VALIDATION_METRICS_TOKEN` bearer token.

| Surface | Use it for |
|----|----|
| `GET /metrics/validation` | Validator would-drop / actual-drop rates by gate, reason, category, and mode. This is the main shadow-to-enforce safety check. |
| `GET /metrics/test-suppressions` | Focused tests-gate suppression rollup from the validation metrics. |
| `GET /metrics/dismissals` | Human dismissal reasons, used to spot repeated false-positive classes. |
| `GET /metrics/repeat-fps` | Rolling repeat-FP signal from review memory. |
| `GET /metrics/precision` | Per-repo precision profile / FP-reduction view. |
| `GET /metrics/fp-rate` | Live false-positive-rate read for one or more repos. |
| `GET /metrics/graph` | Graph-retrieval shadow/post adoption and quality metrics. |
| `GET /metrics/graph-expansion` / `/metrics/graph-expansion-ab` | Cross-file body expansion measurement and A/B comparison. |
| `GET /metrics/runner-evidence` | Runner evidence adoption and verification state. |
| `GET /metrics/runner-tools` | Per-tool runner evidence coverage. |
| `GET /metrics/verification` | Verification-by-execution verdict distribution and current mode. |

Offline CLIs live in `scripts/` and are exposed through `npm run`:

| Command | Input | Output / decision |
|----|----|----|
| `npm run dispatch-monitor -- --input <path> [--format md|json]` | `wrangler tail --format json` capture or Workers Logpush JSONL/NDJSON directory. | CLI dashboard for dynamic dispatcher coverage: actual vs shadow specialist calls avoided, roles intentionally not invoked, observed model tokens, and token-savings estimates from per-role averages. |
| `npm run bakeoff-report -- --input <path> [--since <iso>] [--until <iso>]` | Shadow bake-off Logpush export. | Model bake-off markdown/JSON decision report. |
| `npm run retrieval-ab-report -- --findings=<jsonl> --truth=<jsonl>` | Hand-labeled retrieval A/B findings + truth sets. | Precision/recall/F1 comparison and ship/no-ship decision. |
| `npm run fp-rate-report -- --repo=owner/repo` | Production KV telemetry plus review-memory records via Cloudflare API credentials. | Offline per-specialist false-positive report. |

The dispatch monitor is intentionally a CLI, not an HTTP route: dispatcher savings are emitted as
structured logs (`dispatcher-savings-summary`, `model-attempt-completed`, and
`specialist-fanout-summary`), and operators can replay tail/logpush exports without adding Worker
state, retention, or request-time cost. Use it when flipping or auditing
`OPENCLAW_DYNAMIC_DISPATCHER_MODE` (`shadow`, `enforce_rules`, `enforce`) to check that skipped
roles are genuinely not invoked in actual modes and only projected in shadow mode.

---

## 7. Cross-cutting systems

- **Trust ledger / proof tiers** (`domain/gates/trust-ledger-thread.ts`) — per-finding accounting
  of which gates a finding passed and which specialist sourced it; drives the VERIFIED/GROUNDED/
  MODEL pills in the rendered review.
- **Verification-by-execution** (`lib/verification/`, `lib/runner-evidence/`, `lib/runner-oidc/`)
  — CI posts SARIF + a GitHub OIDC token to `/runner/ingest`; we verify the token, store a
  single-use receipt, and correlate review findings against the CI evidence (SIG-285).
- **Review-memory** (`lib/review-memory/`) — dismissed findings are remembered per repo (KV
  `review-memory:repo:<id>:*`); the synthesizer softens future findings on the same category/path.
- **Code graph + retrieval** (`do/repo-graph.ts`, `ensemble/adapters/graph.ts`) — SIG-138 import
  graph and symbol table enrich specialist prompts with cross-file reachability.
- **Dynamic dispatcher** (`lib/ensemble-router.ts`) — decides which specialists run for a given
  diff (e.g. skip security when no crypto/secrets/deps are touched), to cut cost and latency.
- **Config** (`shared/domain/config`, `shared/adapters/config/load.ts`) — `sigilix.json` parsed
  into a typed `SigilixConfig` (gate modes, model overrides, labels, path instructions),
  fetched from the repo at the PR head SHA, with a per-team env fallback.

---

## 8. Coding standards

These are conventions, observed and expected. The subset that is *enforced* is in COMPLIANCE.md;
the rest is how we keep the code consistent.

### Imports

- **`@/` for everything cross-directory**, `./sibling` within a directory, never `../` across
  trees (enforced). `@/*` → repo root, so imports are root-anchored and show the exact file:
  `@/src/...` for code, `@/scripts/...` for tooling, `@/e2e/...` for cross-cutting tests.
- **`import type` for types** — `verbatimModuleSyntax` is on, so value and type imports are
  explicit. A port or a types-only module is imported with `import type`.
- **Order:** `shared/types` → `shared/domain` → `shared/ports` → `shared/adapters` → feature
  modules. Group by layer, inward to outward.
- **Barrels are narrow.** Re-export the public surface, not internal helpers.

### Naming

- **Files:** kebab-case — `validate-logic-finding.ts`, `pr-review-run.ts`.
- **Functions:** camelCase, verb-first — `handlePrReviewEnsemble`, `parseEnsembleConfig`,
  `runSpecialist`, `gatherGraphEvidence`.
- **Types:** PascalCase — `PrReviewFinding`, `EnsembleConfig`, `ValidateForSubmissionArgs`.
- **Constants:** UPPER_SNAKE — `SPECIALIST_TIMEOUT_MS`, `RELEASE_BASE_BRANCHES`.

### Functions

- **Pass `Env` explicitly**, never a global: `function handler(args: { env: Env; ... })`. Env
  carries every binding and secret; threading it keeps the pure layers pure.
- **Return discriminated unions for decisions**, don't throw for control flow:
  `{ keep: true } | { keep: false; reason: LogicDropReason }`. Early exits in a long pipeline map
  to a `{ kind: "continue" } | { kind: "proceed" }` union, not a bare `continue` buried in a
  branch.
- **Keep `domain` functions pure** — inputs in, decision out, no IO, no clock (`ClockPort` if you
  need time). If a helper needs the network or env, it belongs in `app` or an adapter.

### Error handling

- **Throw on startup/validation failures** (env missing, config unparseable) — fail fast and loud.
- **In the queue path, throw to retry**: the consumer catches, classifies transient vs terminal
  (`do/classify-error.ts`), and the DO schedules a backoff. Don't swallow a transient error into a
  silent success.
- **Structured logs**: `console.log(JSON.stringify({ event: "...", ... }))` for telemetry;
  `console.error` with structured context for failures. Logs are a product surface, not debug
  noise.

### Async

- `async function` declarations, no IIFEs.
- **Fan-out** with `Promise.allSettled` (one specialist failing must not sink the others);
  **batch** with `bounded-concurrency`; **time-box** with the composed-timeout helper that threads
  an `AbortSignal` through nested calls.

### Feature flags

- Read `OPENCLAW_*` env vars. The prefix is legacy — we'll rename it eventually — but it's wired
  into KV namespaces, the queue, and Vectorize, so for now it stays. Don't rename it ad hoc; that's
  a deliberate operational migration for later, not a drive-by cleanup.
- Parse through a typed helper (`parseLogicValidatorMode`, `isIndexerEnabled`), never inline string
  comparison. Default conservative: shadow / off unless explicitly set to `enforce` / `on`.

---

## 9. Build, test, deploy

```bash
npm run build      # tsc --noEmit && eslint . && vitest run  — run before every push, never push red
npm run dev        # wrangler dev
npm run deploy     # wrangler deploy
npm run typecheck  # tsc --noEmit  (covers tests too)
npm run lint       # eslint .
npm run test       # vitest run
npm run dispatch-monitor -- --input <logs.ndjson>  # dynamic-dispatcher CLI monitor
```

- **TypeScript:** strict, plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`. `@/*` → repo root (imports are root-anchored: `@/src/...`).
- **ESLint:** flat config, safety rules (`no-unused-vars`, `eqeqeq` smart, `prefer-const`,
  `no-var`), plus the structural gates from COMPLIANCE.md (`max-lines` two-tier,
  `no-restricted-imports` for `../`, `--max-warnings 0`).
- **Vitest:** Node environment; `@` alias; `cloudflare:workers` and `node:sqlite` shimmed for the
  Worker runtime. Tests are co-located; cross-cutting suites live in `e2e/`.
- **Wrangler:** Worker `sigilix`; bindings for KV, Vectorize (768-dim), D1 (lexical mirror),
  Workers AI, the queue, and the DO classes; DO SQLite migrations; secrets in the secret store.
- **Model-eval tests** (`e2e/*.live.test.ts`, e.g. `npm run logic-recall-eval`) run a real
  specialist through a live model and need a Turbo-entitled `OLLAMA_API_KEY` in `.dev.vars`; they
  **skip** without it so CI stays green. Treat their numbers as signal only at K≥12 repeats.

---

## 10. How to add things — recipes

- **A new validation gate:** add a pure `validate-*.ts` in `ensemble/domain/gates/`, returning a
  keep/drop/demote union with a reason; wire it into `validation-walk.ts`; give it an
  `OPENCLAW_*_VALIDATOR_MODE` flag and ship it in **shadow**; add golden fixtures pinning its
  behavior; measure via `/metrics/validation`; flip to `enforce` once the drop rate is safe.
- **A new specialist:** add its prompt under `prompts/specialists/`, its role to
  `shared/domain/specialist-role.ts`, and its runner wiring in `ensemble/app/specialists.ts`; gate
  it through the dynamic dispatcher; build a recall ruler in `e2e/` before trusting it.
- **A new job type:** add the variant to the `JobMessage` union in `shared/types/job.ts`, a case
  in `dispatchJob` (`src/index-dispatch.ts`), and the handler in `src/lib/`.
- **A new feature lens:** create `src/features/<name>/` with the layers it needs
  (`domain`/`app`/`adapters`/`render` — only those that have files), expose it through a barrel
  `index.ts`, and import it from the pipeline through that barrel only.
- **A new metric:** add a metrics DO in `src/do/`, record from the relevant adapter, surface it on
  a `/metrics/*` route; this is the measure half of measure-then-flip.

---

## 11. Key files to know

| File | Why |
|------|-----|
| `src/index.ts` | Worker entry; DO exports; fetch/queue/scheduled |
| `src/index-dispatch.ts` | `dispatchJob` — the job router |
| `src/do/pr-review-run.ts` | PR review run state machine (retry/watchdog) |
| `src/lib/ensemble/app/orchestrator.ts` | `handlePrReviewEnsemble` — the pipeline |
| `src/lib/ensemble/domain/validation.ts` | The adjudication core |
| `src/lib/ensemble/domain/gates/` | The ~13 validation gates |
| `src/lib/ensemble/adapters/model-provider.ts` | The Ollama→OpenRouter seam |
| `src/shared/types/env.ts` | The `Env` interface — every binding and secret |
| `src/shared/types/job.ts` | The `JobMessage` union — every job type |
| `src/shared/adapters/github/client.ts` | The GitHub REST/GraphQL client |

When in doubt about *where* something goes, ask which layer it belongs to (§3) and whether it is
pure (`domain`) or touches the world (`adapters`). When in doubt about *whether* a change is safe,
pin the behavior first (COMPLIANCE.md §6) and let the golden matrix prove it.
