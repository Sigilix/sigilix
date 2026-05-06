# ARC-186 — Dependency vulnerability lookup — design spec

**Status:** v3 — fully dual-signed-off (Codex + Kimi APPROVE-WITH-CHANGES, all blocking + major findings addressed)
**Linear:** [ARC-186](https://linear.app/arc-and-anchor/issue/ARC-186/dependency-vulnerability-lookup-aikido-intel-style-advisory-records)
**Reference:** `AikidoSec/intel:README.md`, `AikidoSec/safe-chain`

---

## 1. Problem

Sigilix's security specialist is pure-LLM — it hallucinates CVEs and misses real ones because the model has no ground-truth vulnerability data. ARC-186 adds a **deterministic dependency-vulnerability check** that runs BEFORE the LLM specialist fanout (mirroring the ARC-187 secret-scan and ARC-193 deterministic-checks pattern). Findings are injected into the security specialist's prompt as authoritative facts.

## 2. Acceptance criteria (v1, refined)

- Parses **npm** dependency manifests (`package.json` + `package-lock.json`) into normalized coords `{ecosystem: "npm", name, version, source_path}`.
- Loads advisory records matching Aikido Intel's field shape from a **bundled JSON snapshot** committed to the repo (no external API calls in v1).
- Version matching handles **semver ranges**, exact versions, and explicit non-vulnerable-from + patched-versions.
- Emits **structured findings** to the security specialist's prompt before the LLM call: affected dep + version, advisory id/source, vulnerable range, patched versions, severity, fix guidance, match type.
- A PR adding a vulnerable npm package surfaces a deterministic dep finding before the LLM runs.
- A PR with a patched version suppresses the finding without LLM judgment.

**v2 (deferred):** Python ecosystems (`requirements.txt`, `Pipfile`, `Pipfile.lock`), external Aikido API fetching, license metadata, transitive dependency resolution, lockfile-only diffs (no `package.json` change).

## 3. Architecture

```
PR diff arrives
  │
  ├─ secret-scan (ARC-187, existing)
  ├─ deterministic-checks (ARC-193, existing)
  └─ dep-vuln-scan (ARC-186, new) ────────┐
        │                                  │
        │ 1. Parse changed manifest paths  │
        │    (package.json + lockfile)     │
        │ 2. Diff: previous vs current     │
        │    deps to extract added /       │
        │    upgraded entries              │
        │ 3. Lookup each in bundled DB     │
        │ 4. Match version against         │
        │    vulnerable_ranges - patched   │
        │ 5. Emit findings array           │
        ▼                                  │
   Security specialist prompt              │
   (findings injected as facts)            │
        │                                  │
   Security specialist LLM call ◀──────────┘
```

Pure-pre-LLM: zero model calls, zero external network calls in v1. The bundled advisory DB lives at `src/data/dep-vulns.json` (~few hundred KB, committed). Updated quarterly via a separate operator workflow (out of scope for v1 — next-quarter ARC ticket).

## 4. Manifest parsing

### `package.json`

```ts
parsePackageJson(raw: string): { name?, version?, dependencies?, devDependencies?, peerDependencies? }
```

Extracts the **declared** ranges (NOT resolved). The lockfile is the authoritative resolved-version source; we use `package.json` for the dep set and `package-lock.json` for the resolved version of each.

### `package-lock.json` (npm v6 + npm v7+ formats)

```ts
parsePackageLock(raw: string, rootDeps: Set<string>): Map<name, version>
```

- npm v6: `dependencies.<name>.version` (top-level entries only — recursive nesting is transitive, ignored in v1)
- npm v7+: `packages["node_modules/<name>"].version` for un-scoped packages, `packages["node_modules/@scope/pkg"].version` for scoped packages.

**Codex MAJOR #2: top-level-only filter.** npm v7+ flattens (hoists) transitive deps into `node_modules/<name>` entries, so the lockfile alone can't distinguish "root dep" from "deep transitive". Pass the root `package.json`'s `dependencies + devDependencies + peerDependencies` keys as `rootDeps` and filter the lockfile entries to only those names. Scoped paths (`node_modules/@scope/pkg`) are normalized to `@scope/pkg` for the comparison.

v1 supports BOTH lockfile formats (dispatches on the `lockfileVersion` field).

### Diff-extracted manifests (Codex MAJOR #3 — base-lockfile fetch)

To detect *upgrades* in resolved versions (not just declared range changes), v1 fetches BOTH `package.json` and `package-lock.json` at the **head SHA** AND at the **base SHA**. The "added/upgraded" set is computed by:

```
added = headLockResolved \ baseLockResolved   (by name + version pair)
```

A simple set-difference on `(name, version)` tuples surfaces:
- Brand-new deps (name not in base)
- Version bumps (name in base but with different version)

If the lockfile changed but `package.json` did not, the upgrade IS still detected — `package-lock.json` is the authoritative source for resolved versions. (This addresses Codex MAJOR #3: lockfile-only changes are detected.)

If a manifest is missing or fails to parse on either side, the scan skips that pair with a structured warning — never fails the review.

### Missing-lockfile policy (Kimi MAJOR #3)

Many npm libraries gitignore `package-lock.json`. v1 makes the lockfile **strictly required for the scan to fire**:

- No lockfile at head SHA → emit `dep-vuln-scan-skipped { reason: "missing-lockfile" }` and exit cleanly. No findings, no LLM-side noise.
- No lockfile at base SHA but present at head → first PR introducing the lockfile; treat ALL head-resolved packages as "added" and scan them.
- Lockfile at base, missing at head → unusual. Same skip reason; lockfile deletion is out of v1 scope.

A `package.json`-only fallback (declared ranges without resolved versions) is **not implemented in v1** because the matching is fundamentally less precise (a range like `^1.0.0` could resolve to anything from 1.0.0 to <2.0.0). Listed as v2 future scope. Repos without lockfiles get the silent-skip behavior with operator-visible telemetry.

### Diff-extracted manifests

PR diffs are unified-diff text. We need the **current** state of each manifest at the PR head. Use the existing `client.getFileContent(owner, repo, path, ref)` helper to fetch:
- `package.json` at the PR head SHA
- `package-lock.json` at the PR head SHA
- `package.json` at the PR base SHA (to compute "what was added/upgraded")

If a manifest is missing or fails to parse, the scan skips that ecosystem with a structured warning — never fails the review.

## 5. Advisory database schema

Bundled JSON snapshot at `src/data/dep-vulns.json`:

```ts
interface AdvisoryRecord {
  id: string                     // e.g. "GHSA-abcd-1234-efgh"
  source: "github" | "npm" | "snyk" | "aikido"
  ecosystem: "npm"               // v1 only
  package_name: string
  vulnerable_ranges: string[]    // semver ranges, e.g. [">=1.0.0 <1.4.2"]
  patch_versions: string[]       // semver, e.g. ["1.4.2", "2.0.0"]
  non_vulnerable_versions?: string[]  // explicit safe versions outside the range
  severity_class: "low" | "medium" | "high" | "critical"
  aikido_score?: number          // 0-100, optional
  summary: string                // 1-line headline
  fix_guidance?: string          // "Upgrade to >=1.4.2"
}
```

The bundled file ships in the Worker bundle (~few hundred KB; well within the 25 MB hard cap). A snapshot from Aikido Intel's public JSON is the v1 source — operator updates the file by re-running a manual script (`scripts/refresh-advisories.ts`, out of v1 scope but listed for context).

## 6. Version matching

```ts
matchVersion(version: string, advisory: AdvisoryRecord): MatchType | null

type MatchType =
  | "exact-vulnerable"     // version is in vulnerable_ranges
  | "explicit-safe"        // version is in non_vulnerable_versions
  | "patched"              // version >= some patch_versions entry
  | "out-of-range"         // version is below or above all ranges
```

Uses a Worker-runtime-safe semver matcher. Options:
- **Bundle the `semver` npm package** — well-tested, ~25 KB; adds one dependency. Compatible with Workers runtime (no Node-only APIs in the matcher).
- **Hand-roll a minimal subset** — only operators we actually need (`>=`, `<`, `<=`, `>`, `||`, exact). ~150 LOC. Avoids the dependency.

v1 leans **bundle `semver`** — battle-tested matching is more important than dependency count, and `semver` is widely audited. Open question §11.

A finding is emitted ONLY when:
- `matchVersion` returns `range-vulnerable` (the version is inside one of the `vulnerable_ranges`)
- AND the version is NOT explicitly listed in `non_vulnerable_versions`
- AND the version is NOT covered by **the matched range's** patched cutoffs

**Codex BLOCKING #1: range-aware patch evaluation.** A naive "version >= any patch_versions entry" rule is wrong: for a vulnerability with separate ranges per major (e.g. vulnerable in `>=1.0.0 <1.4.2` AND `>=2.0.0 <2.1.3`, patched in `1.4.2` and `2.1.3`), the global-min cutoff would suppress a real `2.0.5` vuln because `2.0.5 >= 1.4.2`. v2 changes the model:

```ts
interface AdvisoryRangeRecord {
  vulnerable_range: string       // e.g. ">=2.0.0 <2.1.3"
  patched_in: string             // e.g. "2.1.3" — the fix release for THIS range
}

interface AdvisoryRecord {
  // ... id, source, ecosystem, package_name, severity_class, summary, fix_guidance ...
  ranges: AdvisoryRangeRecord[]  // one entry per affected major/minor
  non_vulnerable_versions?: string[]
}
```

Suppression logic becomes:
1. For each `range` in `advisory.ranges`, check `version` against `range.vulnerable_range`. If matched, find `range.patched_in` and confirm `version < range.patched_in` (i.e. NOT yet upgraded past the fix for THIS major).
2. If matched AND not yet patched-in-range → emit finding.
3. If `version` appears in `non_vulnerable_versions` → suppress regardless.

This correctly handles cases where a single advisory has fixes in multiple majors.

### Match-type naming (Codex MINOR #5)

Renamed from `exact-vulnerable` to `range-vulnerable` in v2 since the version matched a *range*, not an exact-equality. Findings include the specific matched range string.

### Semver normalization (Codex MINOR #6)

The matcher applies these rules before comparison:
- Strip a leading `v` (e.g. `v1.2.3` → `1.2.3`)
- Reject invalid versions (return null + emit `dep-vuln-version-skipped` telemetry; never throws)
- Prerelease handling: `includePrerelease: false` by default — prereleases are treated as outside any non-prerelease range. (Most advisories specify stable versions; matching prereleases produces noise.)

## 7. Finding shape

```ts
interface DepVulnFinding {
  ecosystem: "npm"
  package_name: string
  version: string                // resolved version from lockfile
  source_path: string            // e.g. "package-lock.json"
  advisory_id: string            // e.g. "GHSA-abcd-1234-efgh"
  advisory_source: string        // matches AdvisoryRecord.source
  vulnerable_range: string       // the matched range from advisory
  patch_versions: string[]
  severity: "low" | "medium" | "high" | "critical"
  summary: string
  fix_guidance: string | null
  match_type: "exact-vulnerable"
}
```

These get rendered into the security specialist's prompt under a new `[DEPENDENCY VULNERABILITIES — pre-LLM]` section. Format mirrors the ARC-187 secret-scan + ARC-193 deterministic-checks blocks: structured, machine-extracted facts the model treats as authoritative.

The synthesizer also receives the same block (so it doesn't have to derive these from the security specialist's free-form output).

## 8. Configuration

`sigilix.json` gains an opt-OUT:

```json
{
  "depVulnScan": {
    "enabled": false
  }
}
```

Default behavior (missing field) = **enabled**. Strict-bool parsing — `"false"` doesn't disable. Mirror of the ARC-191 `describe.enabled` shape.

## 9. Telemetry

| Event | When |
|---|---|
| `dep-vuln-scan-skipped` | gate fired (`enabled: false`, no manifest, parse failure) |
| `dep-vuln-scan-ran` | scan completed; fields `{owner, repo, prNumber, manifestsScanned, depsScanned, findingsCount, durationMs}` |
| `dep-vuln-finding` | per-finding event for severity-aggregation telemetry |

## 10. Decisions explicitly NOT in scope

1. **External API fetching.** Bundled snapshot only in v1. Live API integration is a separate ticket once we know which provider is operationally cheapest (Aikido vs OSS Index vs GitHub Advisory).
2. **Python ecosystems.** Defer to v2.
3. **License metadata.** Defer.
4. **Transitive dependencies.** Top-level only in v1. Transitive resolution would require recursive lockfile walks + much larger memory footprint per scan.
5. **Auto-fix suggestions.** v1 emits findings; the security specialist decides how to phrase the recommendation.

## 10a. Bundled DB framing (Codex MAJOR #4)

The v1 bundled DB is a **partial advisory snapshot** — top-N severity + popularity-weighted recent advisories, capped at 500 KB. Findings are framed as "known bundled advisories" — false negatives are deterministic-by-design and acceptable for v1. Steady-state coverage requires the v2 live-API integration.

To make the staleness operationally legible:
- The bundled file's first record is a metadata header: `{snapshotDate, sourceHash, advisoryCount, schemaVersion}`.
- Telemetry emits `dep-vuln-snapshot-meta` once per scan with these fields so downstream tools can flag old snapshots.
- A build-time check enforces the 500 KB cap (CI fails if `src/data/dep-vulns.json` exceeds it). Prevents silent drift past the bundle budget.
- **Retention policy** (Kimi MINOR #5): the manual refresh script enforces an explicit selection rule — all `critical` + `high` advisories regardless of age, plus all `medium` advisories from the last 12 months, plus the top-N packages by npm download count for `low`. No older `low`-severity advisories. Documented in `scripts/refresh-advisories.ts` (out of v1 scope but rule is locked in for the operator).
- The README documents the snapshot model + the planned operator workflow for quarterly refreshes.

## 10b. Workspaces / monorepos (Codex MINOR #7 — explicit deferral)

v1 scans every changed `package.json` + `package-lock.json` PAIR as an independent unit. Workspace-level manifests (`pnpm-workspace.yaml`, `lerna.json`, `package.json` with `workspaces` field) are NOT walked recursively — each touched leaf manifest is scanned standalone. Deferred to v2 alongside transitive resolution.

## 11. Decisions on prior open questions (resolved during sign-off)

1. **Bundle `semver`** with tree-shaken imports (`satisfies`, `gte`). Pin a specific audited version. Both signers agreed.
2. **500 KB cap accepted** with explicit retention policy (§10a) + snapshot metadata (§5). Both signers agreed.
3. **Inline JSON import** (`import db from "../data/dep-vulns.json"`). Both signers agreed. Build-time size check in CI.
4. **Empty findings → omit the section entirely** in the prompt. Both signers agreed. Internal API still returns an empty array so downstream code doesn't infer scan failure.

## 12. Sign-off summary

### Codex (v1 → v2)

| Codex finding | v2 change |
|---|---|
| **[BLOCKING]** Patch suppression incorrect (global vs range-scoped) | §6 schema changed to `ranges: AdvisoryRangeRecord[]` with per-range `patched_in`. Suppression is range-aware. |
| **[MAJOR]** v7+ hoisted-transitive confusion | §4 lockfile parser intersects with root `package.json` deps; scoped paths normalized. |
| **[MAJOR]** Base-lockfile fetch missing | §4 explicitly fetches base + head lockfiles; lockfile-only PRs detected. |
| **[MAJOR]** 500 KB cap → false negatives by design | §10a frames as "partial advisory snapshot" with metadata + build-time check + quarterly refresh. |
| **[MINOR]** Match-type naming (`exact-vulnerable` → `range-vulnerable`) | Renamed in §6. Findings include matched range string. |
| **[MINOR]** Semver normalization rules | §6 documents v-prefix strip, invalid-version reject, `includePrerelease: false`. |
| **[MINOR]** Workspaces/monorepos not addressed | §10b deferred explicitly; v1 scans leaf manifest pairs independently. |

### Kimi (v2 → v3)

| Kimi finding | v3 change |
|---|---|
| **[BLOCKING]** Base-lockfile fetch missing | Already addressed in v2 §4. |
| **[MAJOR]** Range-scoped patch suppression | Already addressed in v2 §6. |
| **[MAJOR]** Missing-lockfile policy explicit | New "Missing-lockfile policy" subsection in §4 — strict skip with telemetry; package.json-only fallback deferred to v2. |
| **[MINOR]** snapshot_generated_at field | Already addressed in v2 §10a (`snapshotDate` in metadata header). |
| **[MINOR]** 500 KB retention policy explicit | §10a now documents the selection rule (all critical/high + medium last 12 months + top-N low by download count). |
| **[NIT]** "added/modified" vs "added/upgraded" wording | Internal-only — telemetry field is already `match_type`; no externally-visible "upgrade" wording. |
| **[NIT]** Pin semver version + tree-shake | Plan task will pin + import only `satisfies` + `gte`. |
