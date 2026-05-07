# ARC-188 — SARIF evidence channel (Trivy + generic) — design spec

**Status:** v2 — fully dual-signed-off (Codex + Kimi APPROVE-WITH-CHANGES; both BLOCKING + all MAJOR + MINOR addressed; module renamed `trivy-evidence` → `sarif-evidence` per both signers)
**Linear:** [ARC-188](https://linear.app/arc-and-anchor/issue/ARC-188/trivysast-evidence-channel-iac-dep-license-findings)
**Branch:** `arc-188-trivy-evidence` (branch name kept; module name `sarif-evidence`)
**Sibling pre-LLM scanners (already shipped):** ARC-187 secret-scan, ARC-193 deterministic-checks, ARC-186 dep-vuln-scan, ARC-181 AST rule-pack scanner

---

## 1. Problem

Sigilix has zero IaC awareness today. Kubernetes manifests, Dockerfiles, Terraform/HCL, CloudFormation, Helm — the LLM specialist sees these as opaque YAML/HCL and can flag obvious anti-patterns but misses everything that a real IaC scanner like Trivy + Kubescape would catch deterministically. ARC-188 adds a **generic deterministic SARIF evidence channel** that lets a CI pipeline upload SARIF reports (Trivy is the prototype consumer; the channel works for any tool emitting SARIF v2.1.0) and pipes the findings into the specialist prompts as authoritative facts.

## 2. Acceptance criteria (v1, refined)

- [ ] Sigilix ingests SARIF v2.1.0 reports for changed files in a PR.
- [ ] IaC, misconfiguration, dependency, secret, SBOM, and license finding categories are all supported (each maps to a `roleHint` for prompt injection).
- [ ] Specialist + synth prompts clearly separate deterministic scanner findings from LLM-authored observations (mirrors ARC-181/186/187/193 omit-empty contract).
- [ ] Test coverage: 1 Trivy IaC finding fixture (K8s manifest misconfig), 1 dep/license finding fixture (npm CVE + GPL-3.0 license violation), 1 Rego metadata fixture (Kubescape-style rule metadata).
- [ ] **SBOM AC clarification** (Codex BLOCKING #1 + Kimi BLOCKING #1): SBOM is recognized by the parser and **emitted as a compact metadata block** (≤20 lines: package count + top-N packages by direct-dep ranking + license-counts summary), NOT as per-package findings. The metadata block is rendered into the synth prompt only (specialists don't need it for review correctness; the synth uses it for Fix Plan ordering context).

## 3. Scope decisions (lock before plan)

### 3.1 Ingest path — **Single repo-committed `.sigilix/trivy.sarif.json` at PR head** (Codex MINOR #7 + Kimi MAJOR #3: drop multi-file glob)

Three options considered:

| Option | Pros | Cons |
|---|---|---|
| **Repo-committed file at known path** | Zero infra; user runs Trivy in CI + commits artifact OR pre-commit hook | Stale-after-push if user forgets to refresh; LFS-y for big reports |
| GitHub Actions workflow-run artifact fetch | Always fresh from CI | Requires `actions: read` scope expansion; GHA artifact API is annoying |
| Webhook receiver (Trivy posts to Sigilix) | Real-time | New endpoint + auth surface; ops complexity |

**v1 lock: single repo-committed file at `.sigilix/trivy.sarif.json` (path configurable via `sigilix.json`).** Mirrors how `sigilix.json` itself is fetched — single Contents API call per PR, no new auth surface, and the user is in control of when the report refreshes. v2 candidate: workflow-run artifact fetch + multi-file glob, behind an opt-in flag.

The ingestor accepts ONE SARIF file. Multi-tool scans should be aggregated by the user's CI before commit — SARIF supports multiple `runs[]` in a single file, so a `trivy ... && trivy-aggregate ...` step or a CI plugin like `microsoft/sarif-multitool` does the merge upstream. v1 supports multi-`runs` parsing inside the single file (Kimi MAJOR #3 + Codex MINOR #7 reconciled).

`sigilix.json` `sarif.path` overrides the default file path; v1 accepts ONLY single-file paths (no glob).

### 3.1a Caps + stale-report telemetry (Codex MINOR #5)

Defensive caps prevent prompt-flooding + Worker-bundle-load issues:

- **Report-size cap**: 2 MB raw bytes. Larger reports → `sarif-evidence-skipped { reason: "report-too-large" }` telemetry, scan skipped with no findings.
- **Max-findings cap**: 200 findings per scan. Excess findings dropped with `sarif-evidence-truncated` telemetry recording the dropped count.
- **Per-file render cap**: 10 findings rendered into the prompt block per file path (Codex MINOR #6 prompt-flooding guard). Excess findings recorded in the structured JSON synth block but NOT in the human-readable prompt block.
- **Stale-report telemetry**: if SARIF top-level `runs[].invocations[].endTimeUtc` exists, emit `sarif-evidence-stale-report { ageHours }` when the timestamp is older than 7 days. Reviewers can act on the stale signal in PR review.

### 3.2 Format — **SARIF v2.1.0 only**

Trivy supports JSON, SARIF, CycloneDX, Cosign, etc. v1 supports SARIF v2.1.0 (OASIS standard) because:
- It's the lingua franca for security tools (Trivy, Snyk, CodeQL, Bandit, Semgrep, etc. all emit SARIF).
- Adopting SARIF makes the channel generic — any SARIF-emitting tool benefits, not just Trivy.
- Trivy's native JSON format is a parallel surface; defer to v2.

The parser validates the top-level `version: "2.1.0"` field and rejects everything else (`unsupported-sarif-version` telemetry).

### 3.3 Bundle size — **No new dependencies**

SARIF parsing is straightforward (JSON with a known schema). v1 hand-rolls a defensive parser in ~150 LOC. Strict schema validation (via `ajv`) is deferred to v2 since it adds ~100 KB and v1's defensive checks are sufficient for the curated finding shapes we render.

### 3.4 Findings filtered by changed files

Like ARC-181, only findings whose `physicalLocation.artifactLocation.uri` intersects the PR's changed-file set are emitted. Pre-existing IaC misconfigurations in untouched files don't get re-flagged.

### 3.5 Confidence + severity bands (mapped from SARIF `level`)

| SARIF `level` | Sigilix severity | Behavior |
|---|---|---|
| `error` | error | Specialist prompt block; counts toward Fix Plan |
| `warning` | warning | Specialist prompt block |
| `note` | info | Below default threshold — drops unless threshold set to `info` |
| `none` | (skipped) | Not emitted |

Auto-inline posting is **NOT** wired in v1 — Trivy findings can be high-FP in raw form (especially license-misclassification on dual-license repos). v2 candidate after FP-rate telemetry.

### 3.6 Finding categorization — multi-source taxonomy resolver (Codex MAJOR #3 + Kimi NIT #6)

SARIF rules carry taxonomy info inconsistently across producers. v1 inspects (in order) ALL of:
1. SARIF `result.taxa[].toolComponent.guid` references
2. `runs[].tool.driver.rules[].properties.tags[]` (Trivy, Snyk use these)
3. `runs[].tool.driver.rules[].id` substring matches (e.g. `AVD-KSV-` → Kubescape K8s)
4. `runs[].tool.driver.rules[].name` substring matches
5. `runs[].tool.driver.rules[].shortDescription.text` substring matches
6. `runs[].tool.driver.name` (e.g. `Trivy`, `Kubescape`)

Match-priority: first match wins. Mapping table:

| Match (any source above) | `roleHint` | `category` |
|---|---|---|
| `Kubernetes` / `Helm` / `Dockerfile` / `Terraform` / `CloudFormation` / `IaC` / `Misconfiguration` / `AVD-KSV-` / `kubernetes-` | `security` | `iac` |
| `License` / `licensing` | `security` (Codex MAJOR #2 + Kimi MAJOR #2 — license is governance/compliance, closest to security in our roleHint set) | `license` |
| `Vulnerability` / `CVE-` / `GHSA-` / `cve` | `security` | `vulnerability` |
| `Secret` / `secret` / `credential` | `security` | `secret` |
| `SBOM` | (not emitted as a finding — see §3.6a) | (filtered) |
| Anything else | `security` (conservative default) | `other` |

The `source` field on `SarifFinding` is the **raw `tool.driver.name`** string (Kimi NIT #6 — preserves generality; the runner does NOT enum it to `"trivy" | "kubescape" | "other"`).

### 3.6a SBOM emission — compact metadata block (Codex BLOCKING #1 + Kimi BLOCKING #1)

When SARIF results carry SBOM-flavored entries (typically a parallel run with `tool.driver.name: "Trivy"` and `properties.kind: "sbom"` or `result.kind: "informational"` carrying a `taxonomies[]` reference to the SBOM taxonomy), v1 builds a compact metadata block:

```
[SBOM SUMMARY — pre-LLM]
Total packages: <N>
Direct deps: <D> | Transitive: <N - D>
License counts: MIT=<x>, Apache-2.0=<y>, BSD-3-Clause=<z>, GPL-3.0=<g>, ...
Top-10 packages by direct-dep ranking: <comma-separated>
```

≤ 20 lines. Rendered into the **synth prompt only** (specialists don't need SBOM context for review correctness). Used by the synth for Fix Plan ordering when a vulnerability finding's package is a direct dep vs deep transitive — direct-dep findings are higher Fix Plan priority.

## 4. Architecture

### 4.1 Module layout

```
src/lib/sarif-evidence/                      ← Renamed (Kimi MINOR #5 + Codex NIT #8)
├── sarif-parser.ts       — defensive SARIF v2.1.0 parser
├── runner.ts             — runSarifEvidence orchestrator
├── render.ts             — renderSarifFindingsForPrompt + JSON for synth + SBOM-summary block
├── path-normalize.ts     — Codex MAJOR #4: URI / file:// / ./ / Windows / uriBaseId / traversal
├── taxonomy.ts           — multi-source taxonomy resolver (§3.6)
└── types.ts              — SarifFinding shape
```

### 4.2 Finding shape

```ts
export type SarifFindingCategory =
  | "iac" | "misconfiguration" | "vulnerability"
  | "license" | "secret" | "other"

export interface SarifFinding {
  ruleId: string                 // e.g. "AVD-KSV-0001" (Kubescape) or "CVE-2024-1234"
  severity: "info" | "warning" | "error"
  roleHint: "security" | "logic" | "performance" | "tests"
  category: SarifFindingCategory
  path: string                   // post-normalization (§4.4)
  line?: number                  // 1-based startLine if present in region
  message: string                // SARIF result.message.text
  ruleName?: string              // resolved rule name from runs[].tool.driver.rules[]
  ruleHelpText?: string          // resolved rule help text (truncated to 500 chars)
  toolName: string               // raw runs[].tool.driver.name (Kimi NIT #6)
  evidence?: string              // SARIF result.snippet.text (≤200 chars, redacted)
}
```

### 4.3 Pipeline integration

In `triage-pr-review-ensemble.ts`, slot in after dep-vuln + AST-rules, before specialist fanout:

```
secret-scan       (ARC-187)
deterministic     (ARC-193)
dep-vuln-scan     (ARC-186)
ast-rules         (ARC-181)
trivy-evidence    (ARC-188)  ← NEW
   │
   ▼
combinedFactsBlock = [secretScan, depVulnBlock, astBlock, trivyBlock, deterministicBlock]
   │
   ▼
specialist fanout
```

### 4.4 Fetch + path-normalization strategy

The runner calls `client.getFileContent(owner, repo, path, headSha)` for the configured path (`.sigilix/trivy.sarif.json` default). On success → parse. On 404 → silent skip (telemetry: `sarif-evidence-skipped { reason: "no-report" }`).

**Path normalization** (Codex MAJOR #4 — `path-normalize.ts` module). SARIF producers emit `physicalLocation.artifactLocation.uri` in many shapes; v1 normalizes through:

1. **`artifactLocation.index` resolution** (Kimi MAJOR #4 — CodeQL uses index references): when `uri` is absent and `index` is present, look up `runs[].artifacts[index].location.uri`. If still absent → drop finding with `sarif-evidence-finding-no-path` telemetry.
2. **`uriBaseId` resolution**: SARIF uses symbolic base-IDs (e.g. `%SRCROOT%`). When set, the runner treats `uriBaseId === "%SRCROOT%"` as repo-root (the common case); other `uriBaseId` values → drop with telemetry.
3. **URI decoding**: percent-decode the path (e.g. `src%2Ffoo.js` → `src/foo.js`).
4. **`file://` strip**: drop the `file://` scheme prefix when present.
5. **Leading `./` strip**: collapse `./src/foo.js` → `src/foo.js`.
6. **Absolute-path rejection**: paths starting with `/` (after normalization) are dropped — they reference the scanner's host filesystem, not the repo. Telemetry: `sarif-evidence-finding-absolute-path-rejected`.
7. **Windows separator normalization**: replace `\` with `/`.
8. **Traversal rejection**: paths containing `..` segments after normalization → drop with `sarif-evidence-finding-path-traversal-rejected` telemetry.

The normalized path is then matched against the PR's changed-file set (§4.5).

### 4.5 Diff-line filter

Same shape as ARC-181: per-file `changedLines` set from the unified diff's `+` set, filtered to non-trivial new content. Findings in unchanged regions of touched files are NOT re-flagged.

For findings that don't carry a line number (some IaC checks are file-level, not line-level): the finding is kept if its path is in the changed-file set, regardless of which line inside changed.

## 5. Configuration

`sigilix.json` schema gain:

```ts
sarifEvidence?: {                // Renamed from `trivy?` — generic SARIF channel
  enabled?: boolean              // default true; literal `false` disables
  path?: string                  // default ".sigilix/trivy.sarif.json"; SINGLE FILE ONLY in v1 (no globs)
  severityThreshold?: "info" | "warning" | "error"  // default "warning"
  disabledRules?: string[]       // SARIF ruleIds to silence
  disabledCategories?: SarifFindingCategory[]  // bulk-disable a whole class (e.g. "license")
}
```

Parser strict-bool on `enabled`, strict-enum on `severityThreshold`, array-of-strings on `disabledRules` + `disabledCategories`.

## 6. Telemetry

| Event | When | Fields |
|---|---|---|
| `sarif-evidence-scan-skipped` | Disabled OR no report file | `{ owner, repo, prNumber, reason }` |
| `sarif-evidence-scan-ran` | Scan completed | `{ filesProcessed, findingsCount, durationMs }` |
| `sarif-evidence-finding` | Per emitted finding (post-threshold, post-disable) | `{ ruleId, severity, category, roleHint, path }` |
| `sarif-evidence-parse-failed` | SARIF parse threw / wrong version | `{ path, errMessage }` |
| `unsupported-sarif-version` | Top-level `version` not `2.1.0` | `{ path, foundVersion }` |

## 7. Testing strategy

Per AC, **3 fixture types**: 1 IaC, 1 dep/license, 1 Rego metadata.

- **IaC fixture**: K8s manifest with `securityContext.privileged: true`. Trivy/Kubescape rule `AVD-KSV-0017`. Verify: rendered finding has `category: "iac"`, `roleHint: "security"`, `severity: "error"` (mapped from SARIF `level: "error"`), `toolName: "Trivy"`.
- **Dep/license fixture**: SARIF report with one CVE finding (`CVE-2024-1234` in lodash) AND one license finding (`GPL-3.0` in some-pkg). Verify: CVE → `category: "vulnerability"` + `roleHint: "security"`; license → `category: "license"` + `roleHint: "security"` (NOT logic — §3.6 routes license to security since Sigilix has no compliance specialist).
- **Rego/Kubescape metadata fixture**: SARIF report with `tool.driver.name: "Kubescape"` and a `taxa` reference. Verify: `toolName: "Kubescape"`, taxonomy resolved to `roleHint: "security"`.
- **Edge cases**: malformed SARIF (no `runs` array), wrong version (`2.0.0`), empty `results` array (no-op), report path 404 (silent skip), finding with no line number (kept if path is changed).

## 8. Constraints / non-goals (v1)

- **No SBOM ingestion** — SBOM is metadata, not a finding. v2 candidate as a separate code-context channel.
- **No CycloneDX or other formats** — SARIF v2.1.0 only.
- **No custom Rego policies** — we accept Kubescape's bundled regolibrary findings as SARIF; we don't run Rego ourselves.
- **No auto-inline posting** — Trivy findings are too noisy in raw form.
- **No taxonomy map customization** — hard-coded mapping in v1.
- **No incremental cache** — full re-parse on every PR push.

## 9. Bundle-size budget

Hand-rolled SARIF parser ~150 LOC + runner + render ~300 LOC total. **Zero new dependencies.** Bundle delta ≤ 5 KB gzipped.

## 10. Decisions on prior open questions (resolved during sign-off)

1. **Ingest path** — repo-committed single SARIF file at `.sigilix/trivy.sarif.json` (overridable via `sarifEvidence.path`). Both signers approved. GHA artifact fetch + multi-file glob deferred to v2.
2. **License findings → `security`** (Codex MAJOR #2 + Kimi MAJOR #2). Sigilix has no `compliance` roleHint; `security` is the closest superset for governance/compliance findings. v2 candidate: introduce `compliance` roleHint as a separate specialist.
3. **SBOM emitted as compact metadata block** in the synth prompt only (≤ 20 lines: package count + top-N direct deps + license counts). Both signers agreed. NOT emitted as per-package findings.
4. **Single-file only in v1** (Codex MINOR #7 + Kimi MAJOR #3). Multi-tool aggregation done by user's CI before commit; SARIF supports multi-`runs[]` inside the single file.
5. **Severity-threshold default `"warning"`** (both signers — matches ARC-181 precedent).

## 11. Sign-off summary

### Codex (v1 → v2)

| Codex finding | v2 change |
|---|---|
| **[BLOCKING]** AC mismatch on SBOM | §2 + §3.6a — SBOM emitted as compact metadata block. AC clarified. |
| **[MAJOR]** License → `logic` is wrong | §3.6 — License → `security` (Sigilix has no compliance specialist). |
| **[MAJOR]** Taxonomy parsing too narrow | §3.6 — multi-source resolver inspects taxa, properties.tags, ruleId, name, shortDescription, tool.driver.name. |
| **[MAJOR]** Path normalization not explicit | §4.4 — `path-normalize.ts` covers URI decode, file://, ./, Windows separators, uriBaseId, absolute-path rejection, traversal rejection. |
| **[MINOR]** Add report-size + max-findings + stale-report telemetry | §3.1a — 2 MB cap, 200-finding cap, per-file 10-render cap, stale-report telemetry > 7 days. |
| **[MINOR]** Cap rendered count per file | §3.1a — 10-per-file render cap. |
| **[MINOR]** Multi-file glob over-scoped | §3.1 — single-file only; multi-`runs[]` in single file supported. |
| **[NIT]** Rename module → `sarif-evidence` | §4.1 — module renamed; config key renamed `sarifEvidence`; telemetry events renamed. |

### Kimi (v1 → v2)

| Kimi finding | v2 change |
|---|---|
| **[BLOCKING]** SBOM AC mismatch | Already addressed via Codex BLOCKING #1 reconciliation (§3.6a). |
| **[MAJOR]** License → `logic` misroutes | Already addressed via Codex MAJOR #2 (§3.6 routes to `security`). |
| **[MAJOR]** Multi-file glob threatens 5 KB budget | Already addressed via Codex MINOR #7 (single-file only). |
| **[MAJOR]** `artifactLocation.index` not handled | §4.4 — index resolution via `runs[].artifacts[index].location.uri`. |
| **[MINOR]** Telemetry naming `trivy-evidence-*` | §6 — renamed `sarif-evidence-*`. |
| **[NIT]** `source: "trivy" \| "kubescape" \| "other"` hard-coded | §4.2 — `toolName: string` (raw `tool.driver.name` preserved). |
