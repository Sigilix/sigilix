# Runner-evidence ("defensible receipt") — ops

SIG-184. A reusable GitHub Action (`Sigilix/runner`) runs the deterministic
tools **inside the customer's CI**, normalizes output to SARIF, mints a
GitHub-signed **OIDC receipt**, and POSTs both to the worker's
`POST /runner/ingest`. The worker verifies the token, enforces single-use, and
stores a hash-backed receipt; at review time a verified receipt backs the review
and the check-run renders a **VERIFIED / PENDING** trust pill. Source never
leaves the customer's infrastructure — only normalized SARIF does.

## Install (customer side)

Add a caller workflow that invokes the pinned reusable workflow. This is exactly
what our own dogfood does — see `.github/workflows/sigilix-runner.yml`:

```yaml
name: Sigilix runner evidence
on: [pull_request]
permissions:
  contents: read            # restrictive workflow-level default
jobs:
  evidence:
    permissions:
      contents: read
      id-token: write        # the ONLY elevated grant — to mint the OIDC receipt
    uses: Sigilix/runner/.github/workflows/scan.yml@<commit-sha>
    with:
      ingest-url: https://sigilix.dan-martinezjulio.workers.dev/runner/ingest
      oidc-audience: sigilix-runner-ingest
```

Matching semantics (the provenance gate checks both):
- `oidc-audience` MUST equal `OPENCLAW_RUNNER_OIDC_AUDIENCE` **exactly** (the
  token's `aud` is compared byte-for-byte).
- The `uses:` **path** MUST equal `OPENCLAW_RUNNER_WORKFLOW_REF` — i.e. the
  `owner/repo/path` portion, with the `@<sha>` pin **stripped** (the worker
  matches the token's `job_workflow_ref` path, not the ref). `owner/repo` is
  compared case-**insensitively**, the path case-**sensitively** (GitHub paths
  are case-sensitive).

`tests/runner-evidence-contract-drift.test.ts` guards our own dogfood against
drifting from the worker config under exactly these rules.

## Worker config (`wrangler.toml [vars]`)

| var | current value | purpose |
|---|---|---|
| `OPENCLAW_RUNNER_OIDC_AUDIENCE` | `sigilix-runner-ingest` | required `aud` of a valid receipt token |
| `OPENCLAW_RUNNER_WORKFLOW_REF` | `Sigilix/runner/.github/workflows/scan.yml` | the pinned reusable-workflow `owner/repo/path` the token's `job_workflow_ref` must match |
| `OPENCLAW_RUNNER_EVIDENCE_MODE` | `post` | `off` \| `shadow` \| `post` (post = receipt SARIF backs the review + the pill renders) |

**Rollback** is a one-line flag flip: `OPENCLAW_RUNNER_EVIDENCE_MODE = "off"`
(no schema/data migration; the ingest route then ignores receipts and reviews
revert to the repo-pull SARIF path). Setting the audience/ref empty re-503s the
ingest route.

## Presence telemetry — `GET /metrics/runner-evidence`

Rolling per-state (× evidence-pending reason) daily counters + a per-repo
latest-state roll, served by `RunnerEvidenceMetricsDO` (SQLite, 35-day
retention, one increment per review). Bearer-guarded by the shared
`OPENCLAW_VALIDATION_METRICS_TOKEN` (same as `/metrics/validation`,
`/metrics/graph`).

```sh
curl -s -H "authorization: Bearer $TOKEN" \
  "https://sigilix.dan-martinezjulio.workers.dev/metrics/runner-evidence?window=7d" | jq
```

```jsonc
{
  "window": { "days": 7, "startDay": "…", "endDay": "…" },
  "mode": "post",
  "counts": {
    "verified":        { "": 12 },
    "evidence-pending": { "merge-sha-unavailable": 3, "merge-sha-mismatch": 1 },
    "runner-absent":   { "": 840 }   // every repo without the Action
  },
  "repoPresence": [
    { "owner": "Sigilix", "repo": "sigilix", "lastState": "verified", "lastReason": "", "lastSeenAt": "…" }
  ]
}
```

- **Adoption** = `verified + evidence-pending` over the total. The denominator is
  every review while the flag is on (shadow/post): a repo without the Action — or
  without a GitHub `repository.id` in scope — records `runner-absent`, so it's the
  majority bucket until adoption grows.
- **Why-pending** = the `evidence-pending` reason breakdown (e.g.
  `merge-sha-unavailable` = GitHub hadn't computed the PR's merge commit yet when
  the review ran; `merge-sha-mismatch` = a stale/retargeted receipt — the CR-4
  forge-proof bind doing its job).
- `repoPresence` = which repos are live + their latest observed state.

`window` accepts `1`–`30` (days), default `7`.

## Tool telemetry — `GET /metrics/runner-tools`

Accepted runner receipts can also carry a normalized scan manifest. The worker
records that manifest into `RunnerToolMetricsDO` with one row per tool/status,
so dogfood can see which tools are enabled, missing output, invalid, empty, or
producing findings before adding more catalog entries.

```sh
curl -s -H "authorization: Bearer $TOKEN" \
  "https://sigilix.dan-martinezjulio.workers.dev/metrics/runner-tools?window=7d" | jq
```

```jsonc
{
  "window": { "days": 7, "startDay": "…", "endDay": "…" },
  "manifestReceipts": 12,
  "toolRows": 360,
  "tools": [
    {
      "toolId": "eslint",
      "statuses": { "produced": 5, "empty": 7 },
      "enabledReceipts": 12,
      "runCount": 12,
      "resultCount": 19
    }
  ],
  "latestByRepo": [
    {
      "owner": "Sigilix",
      "repo": "sigilix",
      "toolId": "eslint",
      "enabled": true,
      "status": "produced",
      "runCount": 1,
      "resultCount": 3,
      "lastSeenAt": "…"
    }
  ]
}
```

- **Tool coverage** = `enabledReceipts` and `statuses` by tool. `missing-output`
  or `invalid-output` means the runner catalog entry is not yet dependable.
- **Signal volume** = `resultCount`; high `empty` plus low `resultCount` means a
  tool may still be useful but has not produced dogfood evidence in-window.
- Duplicate receipt retries do not increment this metric; only the first
  accepted receipt for a runner attempt records the manifest.
