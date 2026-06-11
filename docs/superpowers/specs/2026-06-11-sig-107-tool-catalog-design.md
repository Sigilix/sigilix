# SIG-107 Tool Catalog Design

## Context

SIG-107 started as five subprocess-backed linters: Semgrep/OpenGrep, ESLint, Ruff, actionlint,
and ShellCheck. The broader product goal is now CodeRabbit-style tool parity: a catalog of
open-source linters and analyzers selected by repository contents, recent changes, and repo
configuration.

Sigilix cannot execute subprocesses inside the Cloudflare Worker. The existing Sigilix runner
reusable workflow already executes deterministic tools in GitHub Actions, normalizes output to one
SARIF envelope with multiple `runs[]`, mints an OIDC receipt, and posts that SARIF to
`/runner/ingest`. The engine already verifies runner provenance, looks up verified receipt SARIF at
review time, parses SARIF through `features/sarif-evidence`, and injects deterministic facts into
specialist and synth prompts.

Reference:
- Linear: SIG-107
- CodeRabbit catalog: https://docs.coderabbit.ai/tools/list
- Existing runner ADR: `docs/specs/2026-05-29-sig-184-runner-shape-adr.md`
- Existing dogfood caller: `.github/workflows/sigilix-runner.yml`
- Existing runner workflow: `/Users/danielmartinezjulio/Work/sigilix/runner/.github/workflows/scan.yml`

## Goals

1. Make the CodeRabbit-style tool catalog the product target, not a one-off five-tool script.
2. Keep subprocess execution in the runner repository. The Worker remains subprocess-free.
3. Reuse the existing SARIF receipt channel for ingestion, provenance, prompt injection, and check
   annotations.
4. Add enough engine-side schema/routing so SARIF from language linters does not all default to the
   security specialist, without making the runner the source of truth for role policy.
5. Keep delivery staged: first PR establishes the catalog foundation and lands the original five
   high-leverage tools; follow-up PRs add the rest of the catalog in batches.

## Non-Goals

- Do not add 35-plus tools as one giant PR.
- Do not run untrusted code in Sigilix-managed infrastructure for v1.
- Do not add custom rule packs for any linter in v1.
- Do not make deterministic tool failures fail the caller's CI.
- Do not create or keep any SIG-107 source, test, workflow, script, or docs file over the
  `COMPLIANCE.md` 1,000-line budget. Split helpers/tests before they approach the cap.
- Do not touch `src/lib/ensemble/app/specialists.ts` or
  `src/lib/ensemble/app/context/gather-graph.ts` for this work. Linear explicitly marked them
  off-limits for SIG-107 because SIG-393 is active there and both files are close to the line
  budget.

## Architecture

SIG-107 is split across two repositories:

- `Sigilix/runner`: owns tool detection, installation, execution, SARIF normalization, per-tool
  caps, graceful missing-tool skips, and the OIDC POST envelope.
- `Sigilix/sigilix`: owns `sigilix.json` parsing, per-tool enablement config, SARIF tool taxonomy,
  prompt routing, and rendering deterministic source/provenance to specialists and synth.

The runner emits one SARIF document with one or more `runs[]`. Each run must preserve:

- `tool.driver.name`: canonical tool display name.
- `tool.driver.properties.sigilixSchemaVersion`: integer contract version, starting at `1`.
- `tool.driver.properties.sigilixToolId`: stable internal id such as `eslint` or `shellcheck`.
- `tool.driver.properties.sigilixSource`: `"deterministic-tool"`.
- `tool.driver.properties.sigilixDroppedResults`: optional structured drop counters when a tool
  produced more results than v1 can ingest.
- `tool.driver.rules[]`: rule metadata when the tool provides it.
- `results[]`: capped to at most 50 results per tool before merge.

The engine treats `sigilixToolId` and `sigilixSchemaVersion` as runner-contract metadata when
present. Role routing remains engine-owned: the engine maps `sigilixToolId` plus rule/category
metadata to specialist roles. If Sigilix properties are absent, the existing SARIF taxonomy
fallback remains for legacy SARIF producers.

The runner and engine must share a JSON Schema for the Sigilix SARIF property bag. The engine
owns the schema; the runner imports or vendors it and validates fixture SARIF in CI. Unknown schema
versions are not silently trusted: engine keeps the finding as generic SARIF but logs
`sarif-evidence-schema-version-unknown` and does not apply tool-specific routing.

## Config Model

Add `sigilix.json::linters` as a per-tool enablement map:

```json
{
  "linters": {
    "semgrep": { "enabled": true },
    "eslint": { "enabled": true },
    "ruff": { "enabled": true },
    "actionlint": { "enabled": true },
    "shellcheck": { "enabled": true }
  }
}
```

For compatibility with the original issue text, the parser also accepts strict boolean shorthand:

```json
{
  "linters": {
    "semgrep": false
  }
}
```

Resolution defaults:

- Known linters default to enabled.
- `enabled: false` disables that tool.
- Invalid values are dropped fail-open and resolve to defaults.
- Unknown tool ids are logged as ignored config; they do not fail review.

The runner workflow receives tool enablement through workflow inputs. The engine does not dispatch
the reusable workflow today, so for caller-installed workflows the generated install template and
README document the inputs. A later install-flow ticket can generate these inputs from
`sigilix.json`.

Tool applicability is explicit before it is automatic:

- A disabled tool never runs, even if matching files exist.
- An enabled tool may still skip when no relevant files/config are present.
- Auto-detection is a cost optimization, not the source of truth for whether a repo asked for a
  tool.

## Initial Tool Batch

The first implementation PR should include the original SIG-107 five because they cover the
highest-value missing surfaces and prove each category:

| Tool | Runner behavior | Engine role routing |
| --- | --- | --- |
| Semgrep/OpenGrep | Run configured rulesets, default `p/security-audit` and `p/owasp-top-ten` | engine maps security rules to security, correctness-tagged rules to logic |
| ESLint | Default-safe mode avoids repo plugin execution; repo-config mode is explicit opt-in | logic |
| Ruff | Default rules, SARIF output when available | logic and performance |
| actionlint | GitHub Actions workflow lint | security |
| ShellCheck | Shell script lint | logic and security |

The runner catalog should make adding follow-up tools mechanical. Follow-up batches can mirror the
CodeRabbit catalog:

- Multipurpose/security: ast-grep, OpenGrep, Semgrep, Betterleaks, Presidio, OSV-Scanner,
  Checkov, Trivy, TruffleHog, Brakeman, zizmor.
- Language quality: Biome, Oxlint, Pylint, Flake8, golangci-lint, Clippy, RuboCop, SwiftLint,
  PHPStan, PHPMD, PHPCS, PMD, detekt, Clang-Tidy, Cppcheck, Infer, Luacheck, Blinter, Fortitude,
  Regal, PSScriptAnalyzer, smarty-lint, SQLFluff, Prisma Lint, Stylelint, HTMLHint,
  ember-template-lint, YAMLlint, Dotenv Linter, Buf, checkmake, Shopify CLI.
- IaC: Checkov, Trivy, TFLint, Hadolint.
- CI/CD: actionlint, zizmor, CircleCI config validation, GitHub Checks analysis.
- Docs/prose: markdownlint and LanguageTool.

## Runner Design

Add a small runner-side tool catalog, not five copied workflow blocks. Each descriptor contains:

- `id`
- `display_name`
- `enabled_input_name`
- `detect_paths` or `detect_command`
- `install` steps
- `run` steps
- output file path
- SARIF conversion strategy
- default engine routing category
- max findings per run, fixed at 50 visible results for SIG-107

The reusable workflow continues to be best-effort:

- Tool install failure: emit `::warning::`, write an empty SARIF run or skip merge, continue.
- Tool missing from PATH: emit `::notice::`, continue.
- Tool finding exit code: never fail the caller's CI.
- Tool internal crash: continue with existing SARIF from earlier tools.
- Combined SARIF over ingest cap: keep prior tools, append structured drop metadata to the SARIF
  property bag when possible, and log the dropped tool.

For tools that do not emit SARIF natively, the runner converts their machine-readable output into
minimal SARIF. Converters must include a stable `ruleId`, message, path, optional line, severity,
tool id, and schema version.

The flat 50-result cap is severity-aware. For each tool, keep the highest-severity results first
(`error` before `warning` before `note`) and then stable-sort by path/line/rule id. If results are
dropped, record:

- `tool_id`
- `dropped_count`
- `max_severity_dropped`
- counts by severity

This metadata travels in the SARIF run properties so the engine can emit telemetry and, later,
surface degraded deterministic coverage honestly.

The runner workflow should separate code execution from OIDC minting:

- `scan` job: checks out the repository and runs linters with `contents: read` and no `id-token`
  permission.
- `ingest` job: downloads the SARIF artifact, mints the OIDC token, and posts the envelope. It
  does not check out or execute repository code.

This split is load-bearing for linters that can execute repo-provided plugins or configuration.
ESLint v1 defaults to a safe mode that does not load repo plugins. Full repo-config ESLint is
allowed only behind an explicit workflow input such as `eslint-mode: repo-config`, and the README
must label it as executing repository-controlled lint code inside the caller's CI boundary.

## Engine Design

Engine changes stay in pure/shared and existing SARIF feature modules:

- Extend `SigilixConfig` with `linters`.
- Add parser/resolver tests next to existing `sigilix-config` tests.
- Extend SARIF domain types to read optional `tool.driver.properties.sigilixSchemaVersion`,
  `sigilixToolId`, `sigilixSource`, and `sigilixDroppedResults`.
- Add engine-owned tool routing so Sigilix runner metadata selects the routing policy, but the
  runner does not dictate specialist roles.
- Render `source: deterministic` and tool labels such as `source_tool: eslint` in specialist and synth SARIF
  blocks.
- Route SARIF facts by role instead of treating the whole SARIF block as security-only.
- Emit telemetry for unknown schema versions and dropped deterministic results.

The last bullet is the only prompt-plumbing change. It belongs in `assemble-prompts.ts` and
`role-scoped-facts.ts`, not `specialists.ts`. If implementing it would require touching
`gather-graph.ts`, stop and split the change.

## Evidence Flow

1. Caller workflow invokes the pinned Sigilix runner reusable workflow.
2. Runner detects enabled tools, runs applicable tools in the scan job,
   caps each tool to 50 results, and merges SARIF runs.
3. Runner uploads the merged SARIF artifact.
4. Ingest job downloads the artifact, mints OIDC, and posts the SARIF envelope to `/runner/ingest`.
5. Worker verifies OIDC provenance and stores the scrubbed SARIF.
6. During review, `lookupRunnerEvidence` returns verified receipt SARIF in `post` mode.
7. `runSarifEvidence` parses the verified SARIF, filters to changed lines, and emits
   `SarifFinding[]`.
8. Role-scoped facts inject each finding into the intended specialist prompt.
9. Synth receives structured SARIF JSON with deterministic source metadata.

## Testing Strategy

Engine tests:

- `src/lib/sigilix-config.rules.test.ts`: parse and resolve `linters` config, including boolean
  shorthand and invalid values.
- `src/features/sarif-evidence/domain/sarif-evidence-taxonomy.test.ts`: Sigilix runner metadata
  overrides default security routing.
- `src/features/sarif-evidence/app/sarif-evidence-runner.test.ts`: multi-run SARIF with ESLint,
  Ruff, actionlint, and ShellCheck emits expected `roleHint`, `toolId`, and deterministic source.
- `src/features/sarif-evidence/app/sarif-evidence-runner.test.ts`: dropped-results metadata
  emits telemetry without dropping the whole SARIF run.
- `src/features/sarif-evidence/render/sarif-evidence-render.test.ts`: prompt and synth render
  source metadata.
- `src/lib/role-scoped-facts.test.ts`: SARIF findings route to logic/performance/security roles
  without cross-domain leaks.
- Existing e2e runner evidence contract remains green.

Runner tests:

- Shell-level workflow tests or small converter fixtures for each tool descriptor.
- Missing binary path produces empty output and warning/notice.
- Per-tool cap keeps highest-severity findings first and records structured dropped-result
  metadata.
- Disabled input skips the tool without install/run.
- Merged SARIF remains valid with multiple tool runs.
- OIDC ingest happens in a separate no-checkout job from code-scanning tool execution.

Validation:

- Engine: targeted tests first, then `npm run build`.
- Runner: workflow YAML validation/actionlint plus converter tests, then a manual workflow dry run
  where feasible.
- Final review: `design-critic` before implementation if the implementation plan changes this
  design, and `code-reviewer` on the final diff before PR.

## Rollout

Phase 1: Catalog foundation plus original five tools.

Phase 2: Add high-signal security/IaC parity tools: Checkov, Trivy, TruffleHog, zizmor, Hadolint,
TFLint.

Phase 3: Add language-family batches by ecosystem and customer demand: Go/Rust/Ruby/PHP/Java/C++.

Phase 4: Add docs/prose and specialized format tools.

Each phase is independently shippable because all tools enter through the same SARIF and
provenance path.

## Open Decisions

1. Whether engine should expose linter config to runner dispatch automatically, or whether v1
   relies on caller workflow inputs documented in the install template.
2. Whether ESLint repo-config mode should be included in Phase 1 or deferred. Safe fallback mode is
   acceptable for Phase 1; repo-config mode must stay explicit opt-in because ESLint plugins can
   execute repository-controlled code.
3. Whether Semgrep and OpenGrep should be separate tool ids or one `semgrep` slot with an
   implementation choice. The first PR can keep the public id `semgrep`.
