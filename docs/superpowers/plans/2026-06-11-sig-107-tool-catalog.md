# SIG-107 Tool Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first SIG-107 deterministic tool-catalog slice: linter config and SARIF routing in the engine plus runner execution for Semgrep/OpenGrep, ESLint, Ruff, actionlint, and ShellCheck.

**Architecture:** The Cloudflare Worker stays subprocess-free. The runner executes tools, emits versioned Sigilix SARIF metadata, applies severity-aware per-tool caps, and posts one OIDC-backed SARIF envelope. The engine parses config, validates the metadata contract, owns role routing, and renders role-scoped facts.

**Tech Stack:** TypeScript, Vitest, Cloudflare Worker, GitHub Actions, Bash, Python stdlib, SARIF v2.1.0.

---

## Compliance Guard

- `COMPLIANCE.md` is binding for this work: every source, test, script, workflow, and docs file touched here must stay at or below 1,000 lines unless it already qualifies for the explicit allowlist. Do not add a new allowlist entry for SIG-107.
- Split before a file reaches 800 lines. Use narrow helpers instead of one catch-all converter or one oversized test.
- Before every commit, run `wc -l` on all touched files. Expected: no touched file over 1,000 lines.
- Keep off-limits files untouched unless the implementation is otherwise impossible: `src/lib/ensemble/app/specialists.ts` and `src/lib/ensemble/app/context/gather-graph.ts`.
- Cross-feature imports go through barrels, and cross-tree imports use `@/`, not `../`.
- Add tests beside their modules; only use `e2e/` for a true cross-module path.

## File Structure

Engine worktree:

- `/Users/danielmartinezjulio/Work/sigilix/sigilix-sig-107`
- Branch: `sig-107`

Engine files:

- Modify `src/shared/domain/config/types.ts`: `linters` config types and known linter ids.
- Modify `src/shared/domain/config/parse.ts`: parse `sigilix.json::linters`.
- Modify `src/shared/domain/config/resolve.ts`: resolve default linter enablement.
- Modify `src/lib/sigilix-config.rules.test.ts`: config parser/resolver tests.
- Create `src/features/sarif-evidence/domain/runner-metadata.ts`: versioned Sigilix SARIF property bag parsing and engine-owned tool routing metadata.
- Modify `src/features/sarif-evidence/domain/types.ts`: add optional deterministic source/tool metadata on `SarifFinding`.
- Modify `src/features/sarif-evidence/domain/taxonomy.ts`: use valid runner metadata before legacy taxonomy fallback.
- Modify `src/features/sarif-evidence/domain/sarif-evidence-taxonomy.test.ts`: metadata-routing tests.
- Modify `src/features/sarif-evidence/app/runner.ts`: propagate metadata and dropped-result summaries.
- Modify `src/features/sarif-evidence/app/sarif-evidence-runner.test.ts`: end-to-end SARIF parse tests for supported tools.
- Modify `src/features/sarif-evidence/render/render.ts`: render deterministic tool/source labels.
- Modify `src/features/sarif-evidence/render/sarif-evidence-render.test.ts`: rendering tests.
- Modify `src/lib/role-scoped-facts.ts`: route SARIF facts to role-scoped prompt facts.
- Modify `src/lib/role-scoped-facts.test.ts`: no cross-domain leak tests for SARIF facts.
- Modify `src/lib/ensemble/app/context/assemble-prompts.ts`: consume the role-scoped SARIF facts without touching gather-graph.

Runner worktree:

- Create when runner tasks start: `/Users/danielmartinezjulio/Work/sigilix/runner-sig-107`
- Branch: `sig-107`

Runner files:

- Create `.github/scripts/sigilix_sarif_contract.py`: constants, metadata normalization, severity ranking, cap accounting.
- Create `.github/scripts/sigilix_sarif_merge.py`: merge per-tool SARIF files into one envelope.
- Create `.github/scripts/eslint_to_sarif.py`: ESLint JSON to SARIF.
- Create `.github/scripts/actionlint_to_sarif.py`: actionlint JSON-line output to SARIF.
- Create `.github/scripts/shellcheck_to_sarif.py`: ShellCheck JSON to SARIF.
- Create `.github/scripts/sigilix_sarif_test.py`: Python stdlib tests for metadata, caps, and converters.
- Modify `.github/workflows/scan.yml`: add inputs, split scan/ingest jobs, call converters, upload/download the SARIF artifact, and keep OIDC only in ingest.
- Modify `.github/workflows/ci.yml`: run Python tests and workflow validation.
- Modify `README.md`: document inputs, safe ESLint mode, repo-config opt-in, and staged catalog.

## Task 1: Engine Config

**Files:**

- Modify `src/shared/domain/config/types.ts`
- Modify `src/shared/domain/config/parse.ts`
- Modify `src/shared/domain/config/resolve.ts`
- Test `src/lib/sigilix-config.rules.test.ts`

- [ ] Step 1: Add failing tests for `linters` object config, boolean shorthand, invalid values, unknown ids, and default enablement.
- [ ] Step 2: Run `npx vitest run src/lib/sigilix-config.rules.test.ts`.
  Expected: FAIL because `linters` parsing/resolution does not exist.
- [ ] Step 3: Add `LINTER_IDS`, `LinterId`, and `LinterConfig` to config types.
- [ ] Step 4: Parse only known linter ids; accept `{ enabled: boolean }` and boolean shorthand; drop invalid entries.
- [ ] Step 5: Add `resolveLintersConfig(config)` with known tools defaulting to enabled unless explicitly `enabled: false`.
- [ ] Step 6: Run `npx vitest run src/lib/sigilix-config.rules.test.ts`.
  Expected: PASS.
- [ ] Step 7: Run `wc -l` on the four touched files.
  Expected: all are `<= 1000`.
- [ ] Step 8: Commit `feat(SIG-107): parse linter enablement config`.

## Task 2: Engine SARIF Metadata Contract

**Files:**

- Create `src/features/sarif-evidence/domain/runner-metadata.ts`
- Modify `src/features/sarif-evidence/domain/types.ts`
- Modify `src/features/sarif-evidence/domain/taxonomy.ts`
- Test `src/features/sarif-evidence/domain/sarif-evidence-taxonomy.test.ts`

- [ ] Step 1: Add failing tests for valid metadata, unknown schema version fallback, unknown tool fallback, invalid source fallback, and role routing for each first-slice tool.
- [ ] Step 2: Run `npx vitest run src/features/sarif-evidence/domain/sarif-evidence-taxonomy.test.ts`.
  Expected: FAIL because metadata parsing and routing are absent.
- [ ] Step 3: Add `runner-metadata.ts` with schema version `1`, source `deterministic-tool`, known tool ids, dropped-result shape, and a parse function returning explicit ok/error variants.
- [ ] Step 4: Map tools in engine policy: Semgrep/OpenGrep to security, ESLint to logic, Ruff to logic plus performance, actionlint to logic plus security, ShellCheck to security plus logic.
- [ ] Step 5: Extend taxonomy/types with `toolId`, `source`, `roleHints`, and schema-warning flags while preserving legacy fallback behavior.
- [ ] Step 6: Run the taxonomy test command again.
  Expected: PASS.
- [ ] Step 7: Run `wc -l` on touched files.
  Expected: all are `<= 1000`; split `runner-metadata.ts` before committing if it approaches 800.
- [ ] Step 8: Commit `feat(SIG-107): route deterministic SARIF metadata`.

## Task 3: Engine SARIF Parse And Render Path

**Files:**

- Modify `src/features/sarif-evidence/app/runner.ts`
- Modify `src/features/sarif-evidence/app/sarif-evidence-runner.test.ts`
- Modify `src/features/sarif-evidence/render/render.ts`
- Modify `src/features/sarif-evidence/render/sarif-evidence-render.test.ts`

- [ ] Step 1: Add failing app-level SARIF tests proving valid tool metadata is copied from SARIF `tool.driver.properties` into findings and invalid metadata falls back without crashing.
- [ ] Step 2: Add a failing test for dropped-result summaries from `sigilixDroppedResults`.
- [ ] Step 3: Run `npx vitest run src/features/sarif-evidence/app/sarif-evidence-runner.test.ts`.
  Expected: FAIL for missing metadata propagation.
- [ ] Step 4: Propagate metadata and dropped summaries from the parsed SARIF run into `SarifFinding`.
- [ ] Step 5: Add rendering tests for deterministic tool labels and dropped-result summaries.
- [ ] Step 6: Run `npx vitest run src/features/sarif-evidence/render/sarif-evidence-render.test.ts`.
  Expected: FAIL until rendering is added.
- [ ] Step 7: Render concise labels like `deterministic-tool/eslint` and compact dropped-result summaries.
- [ ] Step 8: Run the app and render test invocations from Steps 3 and 6.
  Expected: PASS.
- [ ] Step 9: Run `wc -l` on touched files.
  Expected: all are `<= 1000`; split a test file by aspect before it exceeds 800 lines.
- [ ] Step 10: Commit `feat(SIG-107): preserve runner SARIF metadata`.

## Task 4: Engine Role-Scoped Prompt Routing

**Files:**

- Modify `src/lib/role-scoped-facts.ts`
- Modify `src/lib/role-scoped-facts.test.ts`
- Modify `src/lib/ensemble/app/context/assemble-prompts.ts`

- [ ] Step 1: Add failing tests proving each role sees only its relevant SARIF facts and security-only manifests do not absorb ESLint/Ruff logic facts.
- [ ] Step 2: Run `npx vitest run src/lib/role-scoped-facts.test.ts`.
  Expected: FAIL for current security-only SARIF handling.
- [ ] Step 3: Update role-scoped facts to accept multi-role SARIF hints from engine-owned taxonomy.
- [ ] Step 4: Update assemble-prompts to pass SARIF findings through the role-scoped path without modifying `gather-graph.ts`.
- [ ] Step 5: Run `npx vitest run src/lib/role-scoped-facts.test.ts src/features/sarif-evidence/app/sarif-evidence-runner.test.ts`.
  Expected: PASS.
- [ ] Step 6: Run `wc -l` on touched files.
  Expected: all are `<= 1000`.
- [ ] Step 7: Commit `feat(SIG-107): route SARIF facts by specialist role`.

## Task 5: Engine Validation Gate

- [ ] Step 1: Run `npm test`.
  Expected: PASS.
- [ ] Step 2: Run `npm run build`.
  Expected: PASS.
- [ ] Step 3: Run `git diff --check`.
  Expected: no output.
- [ ] Step 4: Run `git ls-files -m -o --exclude-standard | xargs wc -l`.
  Expected: no touched file over 1,000 lines.
- [ ] Step 5: Commit any validation-only docs fixes as `docs(SIG-107): document linter catalog plan`.

## Task 6: Runner Worktree And Contract Helpers

**Files:**

- Create `.github/scripts/sigilix_sarif_contract.py`
- Create `.github/scripts/sigilix_sarif_merge.py`
- Create `.github/scripts/sigilix_sarif_test.py`

- [ ] Step 1: Create `/Users/danielmartinezjulio/Work/sigilix/runner-sig-107` from `origin/main` on branch `sig-107`.
- [ ] Step 2: Add failing Python unit tests for metadata attachment, invalid metadata rejection, severity-aware caps, dropped counts, and merge output.
- [ ] Step 3: Run `python3 -m unittest .github/scripts/sigilix_sarif_test.py`.
  Expected: FAIL because helpers do not exist.
- [ ] Step 4: Implement contract constants, metadata builder, severity sort, cap function, and SARIF merge in focused files.
- [ ] Step 5: Run `python3 -m unittest .github/scripts/sigilix_sarif_test.py`.
  Expected: PASS.
- [ ] Step 6: Run `wc -l .github/scripts/sigilix_sarif_contract.py .github/scripts/sigilix_sarif_merge.py .github/scripts/sigilix_sarif_test.py`.
  Expected: all are `<= 1000`.
- [ ] Step 7: Commit `feat(SIG-107): add SARIF contract helpers`.

## Task 7: Runner Tool Converters And Workflow

**Files:**

- Create `.github/scripts/eslint_to_sarif.py`
- Create `.github/scripts/actionlint_to_sarif.py`
- Create `.github/scripts/shellcheck_to_sarif.py`
- Modify `.github/scripts/sigilix_sarif_test.py`
- Modify `.github/workflows/scan.yml`
- Modify `.github/workflows/ci.yml`
- Modify `README.md`

- [ ] Step 1: Add failing converter tests for ESLint JSON, actionlint JSON-line output, and ShellCheck JSON.
- [ ] Step 2: Run `python3 -m unittest .github/scripts/sigilix_sarif_test.py`.
  Expected: FAIL for missing converters.
- [ ] Step 3: Implement one converter per file, all using the shared contract helper and no third-party Python packages.
- [ ] Step 4: Run `python3 -m unittest .github/scripts/sigilix_sarif_test.py`.
  Expected: PASS.
- [ ] Step 5: Update `scan.yml` inputs for tool enablement and ESLint mode. Default ESLint mode is safe `--no-config-lookup`; repo-config mode is explicit opt-in.
- [ ] Step 6: Split the workflow into a no-OIDC scan job and an OIDC-only ingest job. The ingest job downloads the merged SARIF artifact and posts to Sigilix without checking out the caller repository.
- [ ] Step 7: Ensure every tool failure is captured in SARIF or metadata and does not fail the caller CI unless the workflow itself is malformed.
- [ ] Step 8: Update `ci.yml` to run Python tests and validate workflow syntax with actionlint when available.
- [ ] Step 9: Update `README.md` with inputs, security posture, caps, and staged catalog scope.
- [ ] Step 10: Run `python3 -m unittest .github/scripts/sigilix_sarif_test.py`.
  Expected: PASS.
- [ ] Step 11: Run `python3 -c 'import yaml'` only if PyYAML already exists locally; otherwise rely on actionlint and GitHub syntax review rather than adding a dependency.
- [ ] Step 12: Run `wc -l` on all runner files touched in this task.
  Expected: all are `<= 1000`.
- [ ] Step 13: Commit `feat(SIG-107): add deterministic linter catalog workflow`.

## Task 8: Cross-Repo Contract Check

- [ ] Step 1: Generate a tiny runner SARIF fixture for each supported tool with metadata version `1`.
- [ ] Step 2: Copy those fixtures into an engine test fixture directory only if existing SARIF tests already use fixture files; otherwise keep them inline in focused tests.
- [ ] Step 3: Run the engine SARIF app test against the generated fixture shape.
  Command: `npx vitest run src/features/sarif-evidence/app/sarif-evidence-runner.test.ts`
  Expected: PASS.
- [ ] Step 4: Run runner unit tests.
  Command: `python3 -m unittest .github/scripts/sigilix_sarif_test.py`
  Expected: PASS.
- [ ] Step 5: Run `wc -l` on every fixture and test touched by this task.
  Expected: all are `<= 1000`.

## Task 9: Review And Final Verification

- [ ] Step 1: In the engine worktree, run `npm run build`.
  Expected: PASS.
- [ ] Step 2: In the runner worktree, run the runner validation set from Tasks 6 and 7.
  Expected: PASS.
- [ ] Step 3: Run `git diff --check` in both worktrees.
  Expected: no output.
- [ ] Step 4: Run `git ls-files -m -o --exclude-standard | xargs wc -l` in both worktrees.
  Expected: no touched file over 1,000 lines.
- [ ] Step 5: Dispatch `agent code-reviewer` with both diffs and ask specifically: correctness, non-fatal CI contract, OIDC isolation, SARIF schema compatibility, and whether any real bug can be dropped silently.
- [ ] Step 6: Dispatch `agent security-auditor` for runner workflow/script changes and ask specifically about repo-controlled code execution and token exposure.
- [ ] Step 7: Fix valid findings and rerun the relevant tests.
- [ ] Step 8: Open focused PRs for engine and runner; do not merge.
- [ ] Step 9: Leave a Linear status comment summarizing commits, validation output, reviewers, and remaining bot follow-up.

## Self-Review

- Spec coverage: The plan covers original SIG-107 tools, engine config/routing, runner execution, SARIF metadata, dropped-result telemetry, OIDC split, ESLint safe mode, tests, and docs.
- Compliance coverage: The plan now includes a mandatory `COMPLIANCE.md` file-budget gate before every commit and final verification.
- Marker scan: No unresolved planning markers remain.
- Type consistency: The cross-repo contract names are stable: `sigilixSchemaVersion`, `sigilixToolId`, `sigilixSource`, and `sigilixDroppedResults`.
