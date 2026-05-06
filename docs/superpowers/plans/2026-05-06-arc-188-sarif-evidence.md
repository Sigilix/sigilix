# ARC-188 — Implementation plan

**Status:** DRAFT v1 — pending dual sign-off (Kimi + Codex)
**Spec:** `docs/superpowers/specs/2026-05-06-arc-188-sarif-evidence-design.md` (v2, fully signed off)
**Branch:** `arc-188-trivy-evidence` (module name `sarif-evidence`)

11 micro-commits. Each ends in tsc-clean + green-test commit. TDD where it pays.

**Reordering vs ARC-181 plan precedent:** config field (Task 2) ships before runner (Task 6) so type references work. SBOM metadata + sarif-evidence telemetry events deferred to a post-runner Task to keep early commits small.

---

## Task 1: SARIF v2.1.0 defensive parser — TDD

**Files:** `src/lib/sarif-evidence/sarif-parser.ts`, `src/lib/sarif-evidence/types.ts`, `tests/sarif-evidence-parser.test.ts`

- [ ] `types.ts`: export `SarifFinding`, `SarifFindingCategory`, `SarifReport`, `SarifRun`, `SarifResult` per spec §4.2.
- [ ] `sarif-parser.ts`: `parseSarif(raw: string): { ok: true; report: SarifReport } | { ok: false; reason: string }`.
  - JSON.parse defensively
  - Validate top-level `version: "2.1.0"` — `unsupported-sarif-version` reason on mismatch
  - Validate `runs` is an array
  - Coerce `runs[].results[]` to a known shape; missing `result.message.text` → drop result
- [ ] **Tests**: minimal happy-path, missing version, version "2.0.0", non-object root, malformed JSON, empty runs, no results array, multi-runs single file (Trivy + Kubescape in one).
- [ ] Commit: `feat(arc-188): SARIF v2.1.0 defensive parser`

---

## Task 2: `sigilix.json` `sarifEvidence` config field — TDD

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
- [ ] Parser: strict-bool on `enabled`, strict-enum on `severityThreshold`, array-of-strings on `disabledRules` + `disabledCategories` (drop entries that aren't valid category strings).
- [ ] **Default lock** (matches ARC-181 pattern): when `sarifEvidence` is missing OR any field is missing, runner falls back to `{ enabled: true, path: ".sigilix/trivy.sarif.json", severityThreshold: "warning", disabledRules: [], disabledCategories: [] }`.
- [ ] Add `resolveSarifEvidenceConfig(config)` returning the locked shape.
- [ ] **Tests**: 3+ positive + 3+ negative for each subfield, plus absent-config + empty `{}` cases.
- [ ] Commit: `feat(arc-188): sigilix.json sarifEvidence config + locked defaults`

---

## Task 3: path normalizer (Codex MAJOR #4) — TDD

**Files:** `src/lib/sarif-evidence/path-normalize.ts`, `tests/sarif-evidence-path-normalize.test.ts`

- [ ] `normalizeSarifPath(rawUri: string | undefined, opts: { uriBaseId?: string; artifacts?: Array<{ uri?: string }>; index?: number }): { ok: true; path: string } | { ok: false; reason: string }`.
- [ ] Handles per spec §4.4: index resolution, uriBaseId resolution, URI decoding, file:// strip, leading ./ strip, absolute-path rejection, Windows separator normalization, traversal rejection.
- [ ] **Tests** (16+):
  - Plain relative path passes through
  - URI-encoded path decoded (`src%2Ffoo.js` → `src/foo.js`)
  - `file:///path/to/foo.js` → strip scheme; `/path/to/foo.js` rejected as absolute
  - `./src/foo.js` → `src/foo.js`
  - Windows `src\\foo.js` → `src/foo.js`
  - `../etc/passwd` → traversal rejected
  - `index: 3` resolution against `artifacts[3].location.uri`
  - `uriBaseId === "%SRCROOT%"` accepted; other base IDs rejected with telemetry-eligible reason
  - empty/undefined path → `ok: false, reason: "no-path"`
- [ ] Commit: `feat(arc-188): path normalizer (URI decode, uriBaseId, index resolution, traversal rejection)`

---

## Task 4: taxonomy resolver (Codex MAJOR #3) — TDD

**Files:** `src/lib/sarif-evidence/taxonomy.ts`, `tests/sarif-evidence-taxonomy.test.ts`

- [ ] `resolveTaxonomy(rule: SarifRule, toolName: string): { roleHint, category }`.
- [ ] Match-priority order per spec §3.6: `taxa` references → `properties.tags[]` → `rule.id` substring → `rule.name` substring → `shortDescription.text` substring → `tool.driver.name`.
- [ ] **Tests** (~12):
  - K8s misconfig (`AVD-KSV-0001`, tag `Kubernetes`) → `iac` / `security`
  - CVE in tags → `vulnerability` / `security`
  - License keyword → `license` / `security` (spec §3.6 — license routes to security)
  - Secret keyword → `secret` / `security`
  - SBOM-flagged rule → returns marker that runner uses to filter (NOT emitted as a finding)
  - Empty rule → falls through to `tool.driver.name`
  - Trivy / Kubescape / unknown tool name handling
- [ ] Commit: `feat(arc-188): multi-source taxonomy resolver (taxa + tags + ruleId + name + tool name)`

---

## Task 5: SBOM-summary block builder — TDD

**Files:** `src/lib/sarif-evidence/sbom-summary.ts`, `tests/sarif-evidence-sbom-summary.test.ts`

- [ ] `buildSbomSummary(report: SarifReport): string` — renders the compact metadata block per spec §3.6a.
- [ ] Detects SBOM runs by `tool.driver.name === "Trivy"` AND `properties.kind === "sbom"` OR `result.kind === "informational"` carrying SBOM taxonomy.
- [ ] Returns empty string when no SBOM runs found (omit-empty contract).
- [ ] **Tests** (~6): empty input, single SBOM run, multi-run with one SBOM + one regular, top-N package ordering deterministic, license counts aggregated, ≤20 lines output.
- [ ] Commit: `feat(arc-188): SBOM compact metadata block builder (≤20 lines, synth-only)`

---

## Task 6: scan runner — TDD

**Files:** `src/lib/sarif-evidence/runner.ts`, `tests/sarif-evidence-runner.test.ts`

- [ ] `runSarifEvidence(args)` orchestrates fetch → parse → enumerate runs/results → normalize path → resolve taxonomy → diff-line filter → cap-and-emit findings.
- [ ] Caps applied: report-size 2 MB (pre-parse), 200 findings total, 10 per file path in render only, stale-report > 7d telemetry.
- [ ] Per-finding telemetry + `sarif-evidence-scan-skipped` / `sarif-evidence-scan-ran`.
- [ ] **Tests** (~12): all skip paths (disabled, no-report, report-too-large, parse-failed, unsupported-version), happy path, 200-finding cap truncation, finding-no-path drop, finding with absolute path drop, multi-runs single file, stale-report telemetry, diff-line filter passes, finding without line number kept on path-only match.
- [ ] Commit: `feat(arc-188): runSarifEvidence orchestrator with caps + stale-report telemetry`

---

## Task 7: prompt + synth-JSON rendering — TDD

**Files:** `src/lib/sarif-evidence/render.ts`, `tests/sarif-evidence-render.test.ts`

- [ ] `renderSarifFindingsForPrompt(findings)` and `renderSarifFindingsAsJsonForSynth(findings)` mirror ARC-181 omit-empty + JSON-block contract.
- [ ] Per-file 10-render cap on the human-readable block; full set in JSON synth block.
- [ ] **Tests** (~8): empty findings, single finding, multi-finding sort (severity desc, then path), per-file render cap kicks in at 11+ findings on the same path, JSON parses cleanly, includes `toolName` / `category` / `roleHint`.
- [ ] Commit: `feat(arc-188): renderSarifFindingsForPrompt + JSON-for-synth (per-file render cap)`

---

## Task 8: ensemble pipeline integration — TDD

**Files:** `src/lib/triage-pr-review-ensemble.ts`, `tests/triage-pr-review-ensemble.test.ts`

- [ ] Wire `runSarifEvidence` after `runAstRules` (ARC-181), before specialist fanout.
- [ ] Append `sarifBlock` to `combinedFactsBlock`.
- [ ] Append SBOM summary to synth prompt (separate from specialist prompts; spec §3.6a).
- [ ] Append `renderSarifFindingsAsJsonForSynth(findings)` to synth prompt for supersession (parallels ARC-181 v1 prompt-only synth dedup).
- [ ] Telemetry shape on `EnsembleTelemetry` gains `sarifEvidence` field: `{ scanned, findingsCount, durationMs }` or `{ scanned: false, skipReason }`.
- [ ] **Tests** (~6): scan runs after ARC-181 + before fanout; findings appear in combinedFactsBlock; SBOM appears in synth only; disabled config short-circuits.
- [ ] Commit: `feat(arc-188): wire sarif-evidence into ensemble pre-LLM facts block + SBOM-to-synth`

---

## Task 9: README + telemetry doc updates

**Files:** `README.md`

- [ ] Add an "SARIF evidence channel (ARC-188)" section under existing pre-LLM-scanner docs. Cover: scope, ingest path, single-file model, severity mapping, taxonomy resolver, path normalization, caps + stale-report telemetry, license-as-security routing, SBOM metadata block.
- [ ] Document `sarifEvidence` config under the `sigilix.json` reference.
- [ ] Commit: `docs(arc-188): README — SARIF evidence channel reference`

---

## Task 10: dogfood — annotate sigilix's own `sigilix.json` with `sarifEvidence`

**Files:** `sigilix.json`

- [ ] Add `sarifEvidence: { enabled: true, severityThreshold: "warning", disabledRules: [], disabledCategories: [] }`. Sigilix doesn't currently commit a SARIF report; the config slot is opt-in for future CI integration.
- [ ] Commit: `chore(arc-188): dogfood sarifEvidence config in sigilix.json`

---

## Task 11: final integration pass — typecheck, tests, CodeRabbit, bundle-size, push PR

- [ ] `npx tsc --noEmit` clean.
- [ ] `npm test` clean. Target test count delta: ~+70 (parser + path normalize + taxonomy + SBOM summary + runner + render + config + ensemble integration).
- [ ] Bundle-size verification: `wrangler deploy --dry-run` size delta < 10 KB raw vs pre-ARC-188 baseline (target ≤ 5 KB gzipped per spec §9).
- [ ] `coderabbit review --plain --type committed --base main` — triage findings.
- [ ] `gh pr create` with `Closes ARC-188`, the per-task summary, sample SARIF report fixture, sigilix.json snippet, measured bundle-size delta.

---

## Self-review checklist (before sign-off)

- [ ] **Spec coverage:** every numbered section in v2 spec maps to ≥1 task.
- [ ] **Type names** consistent: `SarifFinding`, `SarifFindingCategory`, `SarifReport`, `SarifRun`, `SarifResult`, `SarifRule`, `runSarifEvidence`, `parseSarif`, `normalizeSarifPath`, `resolveTaxonomy`, `buildSbomSummary`, `renderSarifFindingsForPrompt`, `renderSarifFindingsAsJsonForSynth`, `resolveSarifEvidenceConfig`.
- [ ] **No new dependencies.**
- [ ] **License → `security`** (Codex MAJOR #2 + Kimi MAJOR #2).
- [ ] **Module renamed `sarif-evidence`** (Codex NIT + Kimi MINOR).
- [ ] **Caps in place**: 2 MB report, 200 findings, 10-per-file render.
- [ ] **Path normalization**: URI decode, file://, ./, Windows, uriBaseId, index resolution, absolute reject, traversal reject.
- [ ] **TDD**: Tasks 1-7 lead with failing tests. Tasks 8-11 are integration glue.
