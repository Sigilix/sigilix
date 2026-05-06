# ARC-188 — Trivy/SAST evidence channel — design spec

**Status:** DRAFT v1 — pending dual sign-off (Kimi K2.6 + Codex)
**Linear:** [ARC-188](https://linear.app/arc-and-anchor/issue/ARC-188/trivysast-evidence-channel-iac-dep-license-findings)
**Branch:** `arc-188-trivy-evidence`
**Sibling pre-LLM scanners (already shipped):** ARC-187 secret-scan, ARC-193 deterministic-checks, ARC-186 dep-vuln-scan, ARC-181 AST rule-pack scanner

---

## 1. Problem

Sigilix has zero IaC awareness today. Kubernetes manifests, Dockerfiles, Terraform/HCL, CloudFormation, Helm — the LLM specialist sees these as opaque YAML/HCL and can flag obvious anti-patterns but misses everything that a real IaC scanner like Trivy + Kubescape would catch deterministically. ARC-188 adds a **generic deterministic SARIF evidence channel** that lets a CI pipeline upload SARIF reports (Trivy is the prototype consumer; the channel works for any tool emitting SARIF v2.1.0) and pipes the findings into the specialist prompts as authoritative facts.

## 2. Acceptance criteria (v1, refined)

- [ ] Sigilix ingests SARIF v2.1.0 reports for changed files in a PR.
- [ ] IaC, misconfiguration, dependency, secret, SBOM, and license finding categories are all supported (each maps to a `roleHint` for prompt injection).
- [ ] Specialist + synth prompts clearly separate deterministic scanner findings from LLM-authored observations (mirrors ARC-181/186/187/193 omit-empty contract).
- [ ] Test coverage: 1 Trivy IaC finding fixture (K8s manifest misconfig), 1 dep/license finding fixture (npm CVE + GPL-3.0 license violation), 1 Rego metadata fixture (Kubescape-style rule metadata).

## 3. Scope decisions (lock before plan)

### 3.1 Ingest path — **Repo-committed `.sigilix/trivy.sarif.json` at PR head**

Three options considered:

| Option | Pros | Cons |
|---|---|---|
| **Repo-committed file at known path** | Zero infra; user runs Trivy in CI + commits artifact OR pre-commit hook | Stale-after-push if user forgets to refresh; LFS-y for big reports |
| GitHub Actions workflow-run artifact fetch | Always fresh from CI | Requires `actions: read` scope expansion; GHA artifact API is annoying |
| Webhook receiver (Trivy posts to Sigilix) | Real-time | New endpoint + auth surface; ops complexity |

**v1 lock: repo-committed file at `.sigilix/trivy.sarif.json` (path configurable via `sigilix.json`).** Mirrors how `sigilix.json` itself is fetched — single Contents API call per PR, no new auth surface, and the user is in control of when the report refreshes. v2 candidate: workflow-run artifact fetch, behind an opt-in flag.

The ingestor accepts EITHER:
- `.sigilix/trivy.sarif.json` — single SARIF report
- `.sigilix/trivy/*.sarif.json` — multiple reports (e.g. one per scan target: filesystem + git + image)

`sigilix.json` `trivy.path` overrides the default, accepting either a single path or a glob.

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

### 3.6 Finding categorization (SARIF `taxa` → `roleHint`)

SARIF rules carry `taxa` references that map to taxonomy IDs. Trivy + Kubescape use these to tag findings as `Kubernetes`, `Dockerfile`, `Terraform`, `License`, `Vulnerability`, `Secret`, `SBOM`. v1 maps these to `roleHint`:

| SARIF taxonomy match | `roleHint` |
|---|---|
| `Kubernetes` / `Helm` / `Dockerfile` / `Terraform` / `CloudFormation` / `Misconfiguration` / `IaC` | `security` |
| `License` | `logic` (license is a compliance call, not a security gate) |
| `Vulnerability` / `CVE` / `GHSA` / `Secret` | `security` |
| `SBOM` | (not emitted as a finding — SBOM is metadata, not a finding) |
| Anything else | `security` (conservative default) |

The mapping is hard-coded in v1; users can override via `sigilix.json` `trivy.taxonomyMap` in v2.

## 4. Architecture

### 4.1 Module layout

```
src/lib/trivy-evidence/
├── sarif-parser.ts       — defensive SARIF v2.1.0 parser
├── runner.ts             — runTrivyEvidence orchestrator
├── render.ts             — renderTrivyFindingsForPrompt + JSON for synth
└── types.ts              — TrivyFinding shape
```

### 4.2 Finding shape

```ts
export type TrivyFindingCategory =
  | "iac" | "misconfiguration" | "vulnerability"
  | "license" | "secret" | "other"

export interface TrivyFinding {
  ruleId: string                 // e.g. "AVD-KSV-0001" (Kubescape) or "CVE-2024-1234"
  severity: "info" | "warning" | "error"
  roleHint: "security" | "logic" | "performance" | "tests"
  category: TrivyFindingCategory
  path: string                   // physicalLocation.artifactLocation.uri (relative)
  line?: number                  // 1-based startLine if present in region
  message: string                // SARIF result.message.text
  ruleName?: string              // resolved rule name from runs[].tool.driver.rules[]
  ruleHelpText?: string          // resolved rule help text (truncated to 500 chars)
  source: "trivy" | "kubescape" | "other"  // resolved from runs[].tool.driver.name
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

### 4.4 Fetch strategy

The runner calls `client.getFileContent(owner, repo, path, headSha)` for the configured path (`.sigilix/trivy.sarif.json` default). On success → parse. On 404 → silent skip (telemetry: `trivy-evidence-skipped { reason: "no-report" }`).

For multi-file glob (`.sigilix/trivy/*.sarif.json`): list contents via existing `listFiles`-style helper, fetch each in parallel, merge findings.

### 4.5 Diff-line filter

Same shape as ARC-181: per-file `changedLines` set from the unified diff's `+` set, filtered to non-trivial new content. Findings in unchanged regions of touched files are NOT re-flagged.

For findings that don't carry a line number (some IaC checks are file-level, not line-level): the finding is kept if its path is in the changed-file set, regardless of which line inside changed.

## 5. Configuration

`sigilix.json` schema gain:

```ts
trivy?: {
  enabled?: boolean              // default true; literal `false` disables
  path?: string                  // default ".sigilix/trivy.sarif.json"; supports globs
  severityThreshold?: "info" | "warning" | "error"  // default "warning"
  disabledRules?: string[]       // SARIF ruleIds to silence
  disabledCategories?: TrivyFindingCategory[]  // bulk-disable a whole class (e.g. "license")
}
```

Parser strict-bool on `enabled`, strict-enum on `severityThreshold`, array-of-strings on `disabledRules` + `disabledCategories`.

## 6. Telemetry

| Event | When | Fields |
|---|---|---|
| `trivy-evidence-scan-skipped` | Disabled OR no report file | `{ owner, repo, prNumber, reason }` |
| `trivy-evidence-scan-ran` | Scan completed | `{ filesProcessed, findingsCount, durationMs }` |
| `trivy-evidence-finding` | Per emitted finding (post-threshold, post-disable) | `{ ruleId, severity, category, roleHint, path }` |
| `trivy-evidence-parse-failed` | SARIF parse threw / wrong version | `{ path, errMessage }` |
| `unsupported-sarif-version` | Top-level `version` not `2.1.0` | `{ path, foundVersion }` |

## 7. Testing strategy

Per AC, **3 fixture types**: 1 IaC, 1 dep/license, 1 Rego metadata.

- **IaC fixture**: K8s manifest with `securityContext.privileged: true`. Trivy/Kubescape rule `AVD-KSV-0017`. Verify: rendered finding has `category: "iac"`, `roleHint: "security"`, `severity: "error"` (mapped from SARIF `level: "error"`), `source: "trivy"`.
- **Dep/license fixture**: SARIF report with one CVE finding (`CVE-2024-1234` in lodash) AND one license finding (`GPL-3.0` in some-pkg). Verify: CVE → `category: "vulnerability"`; license → `category: "license"` + `roleHint: "logic"`.
- **Rego/Kubescape metadata fixture**: SARIF report with `tool.driver.name: "Kubescape"` and a `taxa` reference. Verify: `source: "kubescape"`, taxonomy resolved to `roleHint: "security"`.
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

## 10. Open questions for sign-off

1. **Ingest path.** §3.1 locks the repo-committed `.sigilix/trivy.sarif.json` model. GHA artifact fetch is more "real-time" but adds auth + complexity. Sign off on the v1 cut?
2. **License findings as `logic` not `security`.** §3.6 maps license violations to the logic specialist on the theory that license compliance is a business / legal call rather than a runtime-security one. Counter-argument: license violation IS a security/compliance issue and `security` is the better hint. Recommend?
3. **SBOM exclusion.** §8 — should v1 emit SBOM packages as a metadata block (no findings, just a list) so the LLM has context on what's in the dependency tree? Or strict no-emit?
4. **Multi-file glob.** §3.1 + §4.4 — accept `.sigilix/trivy/*.sarif.json` as a glob? Or single-file only in v1 to keep the runner simple?
5. **Severity-threshold default.** Same question as ARC-181 — `"warning"` (drops `note`/`info`) vs `"info"` (everything). v1 leans `"warning"` per ARC-181 precedent.

## 11. Sign-off summary

(To be added after Codex + Kimi return.)
