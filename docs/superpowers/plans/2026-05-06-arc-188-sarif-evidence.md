# ARC-188 — Implementation plan

**Status:** v2 — fully dual-signed-off (Codex + Kimi APPROVE-WITH-CHANGES; both BLOCKING + all MAJOR + MINOR addressed)
**Spec:** `docs/superpowers/specs/2026-05-06-arc-188-sarif-evidence-design.md` (v2, fully signed off)
**Branch:** `arc-188-trivy-evidence` (module name `sarif-evidence`)

11 micro-commits. Each ends in tsc-clean + green-test commit. TDD where it pays.

Module rename is locked in v2 spec: code lives under `src/lib/sarif-evidence/`, config key is `sarifEvidence`, telemetry events prefixed `sarif-evidence-*`. Branch name keeps the legacy `arc-188-trivy-evidence` since rename'ing branches mid-PR is friction.

---

## Task 1: SARIF v2.1.0 defensive parser + types — TDD

**Files:** `src/lib/sarif-evidence/types.ts`, `src/lib/sarif-evidence/sarif-parser.ts`, `tests/sarif-evidence-parser.test.ts`

- [ ] `types.ts`: export `SarifFinding`, `SarifFindingCategory`, `SarifReport`, `SarifRun`, `SarifResult`, `SarifRule`, `SarifTaxa`, `SbomSummary` per spec §4.2 + §3.6a. **Codex MAJOR #5**: SBOM-related types must explicitly preserve `result.kind` (`"informational"` etc.), `runs[].tool.driver.properties.kind`, `result.taxa[]` references, and per-package `properties` (name, version, license, direct/transitive flag) so the SBOM builder doesn't have to re-derive them. Define `SarifTaxa` for the run-level taxonomy table the resolver de-references.
- [ ] `sarif-parser.ts`: `parseSarif(raw: string): { ok: true; report: SarifReport } | { ok: false; reason: string }`.
  - JSON.parse defensively
  - Validate top-level `version: "2.1.0"` — `unsupported-sarif-version` reason on mismatch
  - Validate `runs` is an array
  - Coerce `runs[].results[]`; missing `result.message.text` → drop result
- [ ] **Tests** (~10): minimal happy-path, missing version, version "2.0.0", non-object root, malformed JSON, empty runs, no results array, multi-runs single file (Trivy + Kubescape in one report), invocations with endTimeUtc, results with both `taxa` + `properties.tags`.
- [ ] Commit: `feat(arc-188): SARIF v2.1.0 defensive parser + types`

---

## Task 2: `sigilix.json` `sarifEvidence` config field — TDD (PROMOTED before runner — Codex BLOCKING from ARC-181 plan precedent)

**Files:** `src/lib/sigilix-config.ts`, `tests/sigilix-config.test.ts`

- [ ] Add `sarifEvidence` to `SigilixConfig`:
  ```ts
  sarifEvidence?: {
    enabled?: boolean
    path?: string
    severityThreshold?: "info" | "warning" | "error"
    disabledRules?: string[]
    disabledCategories?: SarifFindingCategory[]
  }
  ```
- [ ] Parser: strict-bool on `enabled`, strict-string on `path` (default `.sigilix/trivy.sarif.json`), strict-enum on `severityThreshold`, array-of-strings on `disabledRules` (trim + dedupe), array-of-known-categories on `disabledCategories` (drop unknowns).
- [ ] **Default lock**: when `sarifEvidence` is missing OR any field is missing, runner falls back to `{ enabled: true, path: ".sigilix/trivy.sarif.json", severityThreshold: "warning", disabledRules: [], disabledCategories: [] }`.
- [ ] Add `resolveSarifEvidenceConfig(config)` returning the locked shape.
- [ ] **Tests**: per-subfield 3+ positive + 3+ negative, plus absent-config + empty `{}` cases.
- [ ] Commit: `feat(arc-188): sigilix.json sarifEvidence config + locked defaults`

---

## Task 3: path normalizer (Codex MAJOR #4) — TDD

**Files:** `src/lib/sarif-evidence/path-normalize.ts`, `tests/sarif-evidence-path-normalize.test.ts`

- [ ] `normalizeSarifPath(rawUri: string | undefined, opts: { uriBaseId?: string; artifacts?: Array<{ location?: { uri?: string } }>; index?: number }): { ok: true; path: string } | { ok: false; reason: string }`. **Codex BLOCKING #2 on plan v1**: SARIF artifacts use `artifacts[i].location.uri`, not `artifacts[i].uri`. Type signature corrected.
- [ ] Handles per spec §4.4: index resolution, uriBaseId (`%SRCROOT%` only), URI decoding, file:// strip, leading ./ strip, absolute-path rejection, Windows separator normalization, traversal rejection.
- [ ] **Tests** (~22 — Codex MAJOR #4 + Kimi MAJOR #2 expansions):
  - Plain relative path passes through
  - URI-encoded path decoded (`src%2Ffoo.js` → `src/foo.js`)
  - `file:///path/to/foo.js` → strip scheme; `/path/to/foo.js` rejected as absolute
  - `./src/foo.js` → `src/foo.js`
  - Windows `src\\foo.js` → `src/foo.js`
  - `../etc/passwd` → traversal rejected
  - **Encoded traversal: `%2e%2e/etc/passwd`, `src/%2e%2e/foo`, `%2Fetc/passwd`** → all rejected (decode FIRST, then traversal-check)
  - **Malformed percent encoding** (`%2`, `%2G`) → reject with reason
  - **Windows absolute `C:\path\foo.js`** → rejected
  - **UNC path `\\server\share\foo.js`** → rejected
  - `index: 3` resolution against `artifacts[3].location.uri`
  - **`index` out of bounds** (artifacts.length === 2, index === 5) → reject with reason
  - **`index` set but `artifacts` is missing entirely** → reject
  - **`index` set, artifact exists, but `location.uri` is undefined** → reject
  - `uriBaseId === "%SRCROOT%"` accepted; other base IDs rejected
  - empty/undefined path → `ok: false`
  - mixed path forms (decoded + Windows + traversal) cascading correctly
- [ ] Commit: `feat(arc-188): SARIF path normalizer (URI decode, uriBaseId, index, traversal reject + encoded/UNC/Windows-abs hardening)`

---

## Task 4: taxonomy resolver (Codex MAJOR #3 + plan-v2 BLOCKING #1) — TDD

**Files:** `src/lib/sarif-evidence/taxonomy.ts`, `tests/sarif-evidence-taxonomy.test.ts`

Codex BLOCKING #1 on plan v1: `taxa` lives on `result.taxa[]`, not `SarifRule`. The resolver needs the result-level taxa references AND the run-level `tool.driver.taxa[]` definitions. Updated signature:

- [ ] `resolveTaxonomy(args: { result: SarifResult, rule: SarifRule | null, runTaxa?: SarifTaxa[], toolName: string }): { roleHint, category }`.
- [ ] Match-priority order per spec §3.6: `result.taxa[].toolComponent.guid` references → `runs[].tool.driver.rules[].properties.tags[]` → `rule.id` substring → `rule.name` substring → `shortDescription.text` substring → `tool.driver.name`. Resolver de-references `result.taxa[].toolComponent.guid` against `runTaxa[]` to extract the canonical taxonomy name.
- [ ] **Tests** (~12):
  - K8s misconfig (`AVD-KSV-0001`, tag `Kubernetes`) → `iac` / `security`
  - CVE in tags → `vulnerability` / `security`
  - License keyword → `license` / **`security`** (spec §3.6 — license routes to security, not logic)
  - Secret keyword → `secret` / `security`
  - SBOM-flagged rule → returns marker for runner to filter (NOT a finding)
  - Empty rule → falls through to `tool.driver.name`
  - Trivy / Kubescape / unknown tool name handling
  - First-match-wins ordering (e.g. tag `Kubernetes` beats `tool.driver.name === "Snyk"`)
- [ ] Commit: `feat(arc-188): multi-source taxonomy resolver (taxa + tags + ruleId + name + tool name)`

---

## Task 5: SBOM-summary builder — TDD

**Files:** `src/lib/sarif-evidence/sbom-summary.ts`, `tests/sarif-evidence-sbom-summary.test.ts`

- [ ] `buildSbomSummary(report: SarifReport): string` — renders compact metadata block per spec §3.6a (≤20 lines: package count + top-N direct deps + license counts).
- [ ] Detects SBOM runs by `tool.driver.name === "Trivy"` AND `properties.kind === "sbom"` OR `result.kind === "informational"` carrying SBOM taxonomy.
- [ ] Returns empty string when no SBOM runs found (omit-empty contract).
- [ ] **Tests** (~7): empty input, single SBOM run, multi-run with one SBOM + one regular, deterministic top-N ordering, license counts aggregated, ≤20 lines output, license-counts threshold (groups long-tail under "Other").
- [ ] Commit: `feat(arc-188): SBOM compact metadata block builder (≤20 lines, synth-only)`

---

## Task 6: scan runner — TDD

**Files:** `src/lib/sarif-evidence/runner.ts`, `tests/sarif-evidence-runner.test.ts`

- [ ] `runSarifEvidence(args)` orchestrates: fetch SARIF at PR head → parse → enumerate runs/results → normalize path → resolve taxonomy → diff-line filter → cap-and-emit findings → build SBOM summary.
- [ ] Caps applied (spec §3.1a): report-size 2 MB (pre-parse), 200 findings total, 10 per file path in render only, stale-report > 7d telemetry.
- [ ] Path-only fallback for findings with no line number (spec §4.5 — IaC findings often file-level).
- [ ] Per-finding telemetry + `sarif-evidence-scan-skipped` / `sarif-evidence-scan-ran`.
- [ ] **Tests** (~22 — config enforcement + caps + telemetry boundaries from Codex MAJOR #3, MINOR #7 + Kimi MAJOR #1, MAJOR #3, MINOR #4):
  - All skip paths: disabled, no-report, report-too-large, parse-failed, unsupported-version
  - Happy path: 1 IaC finding emitted with correct category/role
  - **200-finding cap truncates excess** + emits `sarif-evidence-truncated` telemetry; under-cap (e.g. 199) does NOT truncate (boundary)
  - **Report size at 2 MB exact** passes; **at 2 MB + 1 byte** rejected with `report-too-large`
  - Finding with no path → drops with telemetry
  - Finding with absolute path → drops with telemetry
  - Multi-runs single file: both Trivy + Kubescape findings emit
  - **Stale-report telemetry fires when `invocations[].endTimeUtc > 7d`**
  - **Stale-report telemetry does NOT fire when** (a) endTimeUtc is absent, (b) endTimeUtc is fresh (< 7 days), (c) `invocations` array is missing entirely
  - **7-day boundary**: exactly 7 days → no fire; 7d + 1ms → fires
  - Diff-line filter keeps findings on changed lines, drops findings on unchanged lines
  - Path-only fallback: IaC finding with no line number kept when path is in changed-file set
  - SBOM run produces metadata block but no findings
  - License finding routes to `security` roleHint (NOT logic)
  - **SARIF `level` mapping** (Kimi MINOR #4): `error` → `error`, `warning` → `warning`, `note` → `info`, `none` → skipped (filtered before render)
  - **`severityThreshold` enforcement**: when threshold is `warning`, `note`-level findings are dropped
  - **`disabledRules` enforcement**: a rule_id in the disabled list filters out all findings carrying that rule_id
  - **`disabledCategories` enforcement**: e.g. `disabledCategories: ["license"]` → all license findings dropped while vulnerability findings still emit
- [ ] Commit: `feat(arc-188): runSarifEvidence orchestrator with caps + stale-report telemetry + config-driven filtering`

---

## Task 7: prompt + synth-JSON rendering — TDD

**Files:** `src/lib/sarif-evidence/render.ts`, `tests/sarif-evidence-render.test.ts`

- [ ] `renderSarifFindingsForPrompt(findings, sbomSummary?)` and `renderSarifFindingsAsJsonForSynth(findings)`.
- [ ] Per-file 10-render cap on the human-readable block (spec §3.1a). Full set in JSON synth block. SBOM summary appears in synth-only path.
- [ ] **Tests** (~10): empty findings, single finding, multi-finding sort (severity desc, then path), per-file render cap kicks in at 11+, JSON parses cleanly, includes `toolName` / `category` / `roleHint`, SBOM appended to synth-only, evidence whitespace normalized (regression from ARC-181 PR #67 CR feedback). **Kimi MINOR #5**: explicit assertion that the SBOM summary block does NOT appear in the human-readable specialist prompt block — synth-only contract enforcement.
- [ ] Commit: `feat(arc-188): renderSarifFindingsForPrompt + JSON-for-synth + SBOM injection (per-file render cap)`

---

## Task 8: ensemble pipeline integration — TDD

**Files:** `src/lib/triage-pr-review-ensemble.ts`, `tests/triage-pr-review-ensemble.test.ts`

- [ ] Wire `runSarifEvidence` after `runAstRules` (ARC-181), before specialist fanout.
- [ ] Append `sarifBlock` to `combinedFactsBlock`.
- [ ] Append SBOM summary + structured findings JSON to synth prompt (separate from specialist prompts; spec §3.6a + §5.5).
- [ ] Telemetry shape on `EnsembleTelemetry` gains `sarifEvidence` field: `{ scanned, findingsCount, durationMs }` or `{ scanned: false, skipReason }`.
- [ ] **Tests** (~7): scan runs after ARC-181 + before fanout; findings appear in combinedFactsBlock; SBOM appears in synth only; disabled config short-circuits; no-report short-circuits. **Kimi NIT #6**: when 200-finding cap fires, telemetry's `findingsCount` reflects the post-cap emitted count, not the pre-cap total. **Codex MINOR #8**: when `sarifEvidence.path` is set to a glob pattern (e.g. `.sigilix/trivy/*.sarif.json`), the runner treats it as a single literal path and falls through to no-report skip — v1 explicitly does not glob.
- [ ] Commit: `feat(arc-188): wire sarif-evidence into ensemble pre-LLM facts block + SBOM-to-synth`

---

## Task 9: README + telemetry doc updates

**Files:** `README.md`

- [ ] Add an "SARIF evidence channel (ARC-188)" section under existing pre-LLM-scanner docs. Cover: scope, ingest path, single-file model, severity mapping, taxonomy resolver, path normalization, caps + stale-report telemetry, license-as-security routing, SBOM metadata block.
- [ ] Document `sarifEvidence` config under the `sigilix.json` reference.
- [ ] Commit: `docs(arc-188): README — SARIF evidence channel reference`

---

## Task 10: dogfood — sigilix.json `sarifEvidence` block

**Files:** `sigilix.json`

- [ ] Add `sarifEvidence: { enabled: true, severityThreshold: "warning", disabledRules: [], disabledCategories: [] }`. No SARIF report committed yet — slot is opt-in for future CI integration.
- [ ] Commit: `chore(arc-188): dogfood sarifEvidence config in sigilix.json`

---

## Task 11: acceptance fixtures — TDD (Codex MAJOR #6)

**Files:** `tests/fixtures/sarif/trivy-iac.sarif.json`, `tests/fixtures/sarif/dep-and-license.sarif.json`, `tests/fixtures/sarif/kubescape-rego-meta.sarif.json`, `tests/sarif-evidence-acceptance.test.ts`

Per Linear AC: 1 IaC + 1 dep/license + 1 Rego metadata fixture. v2 plan locks fixture-level end-to-end tests so the full parse → normalize → taxonomy → diff-filter → render pipeline is verified against real SARIF shapes.

- [ ] **Trivy IaC fixture**: K8s manifest finding (`AVD-KSV-0017` privileged container), `level: "error"`, `tool.driver.name: "Trivy"`. Assert: `category: "iac"`, `roleHint: "security"`, `severity: "error"`, `toolName: "Trivy"`, finding renders into the prompt block.
- [ ] **Dep + license fixture**: Two findings — one CVE (`CVE-2024-1234`, lodash, `level: "error"`) AND one license (`GPL-3.0`, some-pkg, `level: "warning"`). Assert: CVE → `category: "vulnerability"` / `roleHint: "security"`; license → `category: "license"` / `roleHint: "security"` (NOT logic — locked here per the v2 spec rename).
- [ ] **Kubescape Rego metadata fixture**: `tool.driver.name: "Kubescape"` with a `taxa` reference to a Rego-policy taxonomy. Assert: `toolName: "Kubescape"`, taxonomy resolved via the run-level taxa table (Codex BLOCKING #1 wiring), category routed to `iac`.
- [ ] Commit: `test(arc-188): acceptance fixtures (Trivy IaC + dep/license + Kubescape Rego metadata)`

---

## Task 12: final integration pass — typecheck, tests, CodeRabbit, bundle-size, push PR

- [ ] `npx tsc --noEmit` clean.
- [ ] `npm test` clean. Target test count delta: ~+70 (parser + path normalize + taxonomy + SBOM summary + runner + render + config + ensemble integration).
- [ ] Bundle-size verification: `wrangler deploy --dry-run` size delta < 10 KB raw vs pre-ARC-188 baseline (target ≤ 5 KB gzipped per spec §9; zero new dependencies).
- [ ] `coderabbit review --plain --type committed --base main` — triage findings.
- [ ] `gh pr create` with `Closes ARC-188`, per-task summary, sample SARIF report fixture, sigilix.json snippet, measured bundle-size delta.

---

## Sign-off summary

### Codex (v1 → v2)

| Codex finding | v2 change |
|---|---|
| **[BLOCKING]** Task 4 taxonomy API wrong — `taxa` on `result`, not `SarifRule` | Task 4 signature now takes `{ result, rule, runTaxa, toolName }`; resolver de-references `result.taxa[].toolComponent.guid` against `runTaxa[]`. |
| **[BLOCKING]** Task 3 `artifacts` shape mismatch | Task 3 type signature corrected: `Array<{ location?: { uri?: string } }>`. |
| **[MAJOR]** Runner config-driven filter tests missing | Task 6 tests now cover `severityThreshold`, `disabledRules`, `disabledCategories` enforcement. |
| **[MAJOR]** Path normalization missing encoded-traversal + Windows-abs + UNC | Task 3 expanded to ~22 tests covering `%2e%2e/`, `src/%2e%2e/foo`, malformed `%2`/`%2G`, `C:\...`, `\\server\share`. |
| **[MAJOR]** SBOM builder needs explicit field declarations | Task 1 types preserve `result.kind`, `properties.kind`, `result.taxa[]`, per-package metadata, direct/transitive flag. |
| **[MAJOR]** Acceptance fixtures not locked + spec §7 stale "logic" | New Task 11 with three fixture-locked acceptance tests; spec §7 stale "logic" line corrected to "security". |
| **[MINOR]** Caps/stale boundary tests | Task 6 tests boundary cases: 199/200 truncation, 2 MB exact/+1, 7-day boundary, missing endTimeUtc. |
| **[MINOR]** Single-file path test | Task 8 tests glob-pattern path falls through to no-report (v1 explicitly does not glob). |
| **[NIT]** Telemetry naming consistency | All telemetry events confirmed `sarif-evidence-*` prefixed in spec §6 + plan tasks. |

### Kimi (v1 → v2)

| Kimi finding | v2 change |
|---|---|
| **[MAJOR]** Task 6 missing config-filter tests | Already addressed via Codex MAJOR #3. |
| **[MAJOR]** Task 3 `artifactLocation.index` negative paths | Task 3 tests now include out-of-bounds, missing artifacts, and undefined uri. |
| **[MAJOR]** Stale-report telemetry positive-only | Task 6 adds explicit no-fire cases for missing endTimeUtc + fresh < 7d + 7-day boundary. |
| **[MINOR]** SARIF `level`→severity mapping unassigned | Task 6 adds explicit `level` mapping assertions (`error/warning/note/none`). |
| **[MINOR]** SBOM-not-in-prompt assertion | Task 7 adds explicit assertion that SBOM block stays out of the human-readable prompt. |
| **[NIT]** Ensemble telemetry `findingsCount` post-cap | Task 8 asserts `findingsCount` reflects post-200-cap emitted count. |

## Self-review checklist

- [ ] **Spec coverage:** every numbered section in v2 spec maps to ≥1 task.
- [ ] **Type names** consistent: `SarifFinding`, `SarifFindingCategory`, `SarifReport`, `SarifRun`, `SarifResult`, `SarifRule`, `SbomSummary`, `runSarifEvidence`, `parseSarif`, `normalizeSarifPath`, `resolveTaxonomy`, `buildSbomSummary`, `renderSarifFindingsForPrompt`, `renderSarifFindingsAsJsonForSynth`, `resolveSarifEvidenceConfig`.
- [ ] **No new dependencies.**
- [ ] **License → `security`** (Codex MAJOR #2 + Kimi MAJOR #2).
- [ ] **Module renamed `sarif-evidence`** (Codex NIT + Kimi MINOR).
- [ ] **Caps in place**: 2 MB report, 200 findings, 10-per-file render.
- [ ] **Path normalization**: URI decode, file://, ./, Windows, uriBaseId, index resolution, absolute reject, traversal reject.
- [ ] **TDD**: Tasks 1-7 lead with failing tests. Tasks 8-11 are integration glue.
