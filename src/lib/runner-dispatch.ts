// SIG-285 PR (runner-execution, "receipts"): the worker→runner DISPATCH primitive.
//
// The inbound half (a runner POSTs a signed SARIF receipt to /runner/ingest, the
// verification gate joins it to findings) is already live. This is the missing
// OUTBOUND half: the worker triggers a deterministic check ON DEMAND for a
// candidate finding, so a bug can be PROVEN (or refuted) by RUNNING a check —
// CodeRabbit's documented low-FP mechanism, paired with our v4-pro recall.
//
// MECHANISM: `workflow_dispatch` (App permission: Actions: read & write) on a
// thin CALLER workflow in the target repo (`.github/workflows/...`) that invokes
// Sigilix's pinned reusable runner workflow (OPENCLAW_RUNNER_WORKFLOW_REF). We
// pass the per-finding check spec as a single stringified `spec` input (GitHub
// caps workflow_dispatch at 10 string inputs).
//
// ASYNC / FIRE-AND-FORGET: a CI round-trip takes minutes — far longer than the
// 895s review budget — so dispatch never blocks a review. The receipt arrives
// later via /runner/ingest and AMENDS the posted review (or gates the next
// review of the same head). This module only fires the dispatch; it does not
// wait for the result.
//
// SAFETY: pure request-construction (fetch is injectable for tests). Flag-gated
// off|shadow|on (default OFF — dispatching workflows is a write action; ships
// dark, dogfood-gated via the existing OPENCLAW_RUNNER_* config). This module
// does NOT decide WHEN to dispatch or how to consume the receipt — the
// orchestrator owns that (a deliberate follow-up).

export type RunnerDispatchMode = "off" | "shadow" | "on"

/** Parse `OPENCLAW_RUNNER_DISPATCH_MODE`. Unknown/missing → `off` (dark default). */
export function parseRunnerDispatchMode(raw: string | undefined): RunnerDispatchMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "on") return "on"
  return "off"
}

/** The deterministic check the runner should execute for one finding. */
export interface RunnerCheckSpec {
  /** Stable finding id, echoed back in the receipt so the worker can re-join. */
  findingId: string
  path: string
  line: number
  /** Check family the runner knows how to run. */
  kind: "ast-grep" | "grep" | "test"
  /** The pattern / command / test selector (kind-specific). */
  spec: string
}

export interface DispatchRunnerCheckArgs {
  /** Installation access token (from getInstallationToken). */
  token: string
  owner: string
  repo: string
  /** The CALLER workflow file name, e.g. "sigilix-runner-dispatch.yml". */
  workflowFile: string
  /** Git ref the check runs against — the PR head sha (binds the receipt). */
  ref: string
  check: RunnerCheckSpec
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export interface DispatchResult {
  /** True on GitHub's 204 No Content (dispatch accepted). */
  dispatched: boolean
  status: number
  /** Present on failure (truncated). */
  error?: string
}

const GITHUB_API = "https://api.github.com"

/**
 * Fire a `workflow_dispatch` for one finding's check. Returns whether GitHub
 * accepted it (HTTP 204). Never throws — a dispatch failure must never affect
 * the review; the caller logs/telemeters the `DispatchResult`.
 */
export async function dispatchRunnerCheck(args: DispatchRunnerCheckArgs): Promise<DispatchResult> {
  const doFetch = args.fetchImpl ?? fetch
  const url = `${GITHUB_API}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/actions/workflows/${encodeURIComponent(args.workflowFile)}/dispatches`
  // GitHub workflow_dispatch: inputs are strings only — pass the spec as one
  // JSON string the caller workflow forwards to the reusable runner workflow.
  const body = JSON.stringify({ ref: args.ref, inputs: { spec: JSON.stringify(args.check) } })
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${args.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "sigilix-worker",
        "content-type": "application/json",
      },
      body,
    })
    if (res.status === 204) return { dispatched: true, status: 204 }
    let detail = ""
    try {
      detail = (await res.text()).slice(0, 300)
    } catch {
      /* ignore */
    }
    return { dispatched: false, status: res.status, error: detail }
  } catch (err) {
    return { dispatched: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
