// sig-gitlab-adapter (GitLab support PR 3): the `gitlab-mr-review` CONSUMER,
// end-to-end. Drives a `gitlab-mr-review` job THROUGH the real `dispatchJob`
// switch -> the real `dispatchGitLabMrReview` consumer -> the orchestrator seam,
// with the GitLab REST API mocked at `fetch`. `handlePrReviewEnsemble` is the ONE
// seam stubbed — its stub drives the REAL injected `GitLabClient` exactly as the
// orchestrator's publish phase does (fetch the diff + a file, then post the
// review) — so the assertions prove a real GitLab MR gets a posted review through
// the real client wire mapping (summary note + inline discussion), that the
// per-project token + allowlist gate work, and that a degraded/errored run
// SURFACES on the MR and is never a silent clean pass.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import type { EnsembleHandlerArgs, EnsembleResult } from "@/src/lib/triage-pr-review-ensemble"

// ─── the ensemble seam: partial-mock (keeps every other real export + the
// load-time budget assertion) and override only `handlePrReviewEnsemble`. ─────
const { ensembleMock } = vi.hoisted(() => ({
  ensembleMock: vi.fn<(args: EnsembleHandlerArgs) => Promise<EnsembleResult>>(),
}))
vi.mock("@/src/lib/triage-pr-review-ensemble", async (importActual) => {
  const actual = await importActual()
  return { ...(actual as object), handlePrReviewEnsemble: ensembleMock }
})

import { dispatchJob } from "@/src/index-dispatch"

// ─── mocked GitLab REST v4 ────────────────────────────────────────────────────
interface Call {
  method: string
  url: string
  body: unknown
  token: string | undefined
}
let calls: Call[]

function res(status: number, payload: unknown, kind: "json" | "text" = "json"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (kind === "text" ? String(payload) : JSON.stringify(payload)),
  } as unknown as Response
}

function headerToken(init?: RequestInit): string | undefined {
  const h = init?.headers as Record<string, string> | undefined
  return h?.["private-token"]
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        token: headerToken(init),
      }
      calls.push(call)
      const u = call.url
      if (call.method === "GET" && /\/merge_requests\/7$/.test(u)) {
        return res(200, {
          iid: 7,
          state: "opened",
          title: "Add feature",
          source_branch: "feature/x",
          target_branch: "main",
          sha: "c".repeat(40),
          diff_refs: { base_sha: "b".repeat(40), start_sha: "b".repeat(40), head_sha: "c".repeat(40) },
        })
      }
      if (call.method === "GET" && /\/merge_requests\/7\/changes$/.test(u)) {
        return res(200, {
          changes: [{ old_path: "src/app.ts", new_path: "src/app.ts", diff: "@@ -1,3 +1,4 @@\n line\n+added\n" }],
        })
      }
      if (call.method === "GET" && /\/repository\/files\/.+\/raw/.test(u)) {
        return res(200, "const x = 1\n", "text")
      }
      if (call.method === "POST" && /\/merge_requests\/7\/notes$/.test(u)) {
        return res(201, { id: 111 })
      }
      if (call.method === "POST" && /\/merge_requests\/7\/discussions$/.test(u)) {
        return res(201, { id: "disc-1" })
      }
      return res(404, { message: `unmatched ${call.method} ${u}` })
    }),
  )
}

// ─── env + job fixtures ───────────────────────────────────────────────────────
function makeEnv(over: Partial<Env> = {}, kv: Record<string, string> = {}): Env {
  return {
    SIGILIX_GITLAB_TOKEN: "glpat-global",
    OPENCLAW_STATE: {
      get: async (key: string) => kv[key] ?? null,
      put: async (key: string, value: string) => {
        kv[key] = value
      },
    } as unknown as Env["OPENCLAW_STATE"],
    ...over,
  } as unknown as Env
}

const doneKey = (headSha = "c".repeat(40)) => `gitlab-mr-review-done:42:7:${headSha}`

const JOB: Extract<JobMessage, { type: "gitlab-mr-review" }> = {
  type: "gitlab-mr-review",
  projectPath: "grp/sub/proj",
  projectId: 42,
  mrIid: 7,
  headSha: "c".repeat(40),
  baseSha: "b".repeat(40),
  sourceBranch: "feature/x",
  targetBranch: "main",
  deliveryId: "d-1",
}

/** A stub `handlePrReviewEnsemble` that drives the REAL injected GitLab client
 *  exactly as the orchestrator publish phase does: fetch the diff + a file, then
 *  post a review (summary body + one inline finding). Returns `posted`. */
async function postingEnsemble(args: EnsembleHandlerArgs): Promise<EnsembleResult> {
  const c = args.githubClient! // always injected by the consumer on the GitLab path
  await c.getPullRequestDiff(args.owner, args.repo, args.prNumber) // GET /changes
  await c.getFileContent(args.owner, args.repo, "src/app.ts", args.headSha) // GET /files/raw
  await c.submitReview(args.owner, args.repo, args.prNumber, {
    event: "REQUEST_CHANGES",
    body: "## Sigilix review\n1 blocking issue found.",
    comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "SQL injection risk on this line." }],
  })
  return { status: "posted", reviewMeta: { surface: "review" }, telemetry: {} } as unknown as EnsembleResult
}

function findCall(pred: (c: Call) => boolean): Call {
  const c = calls.find(pred)
  if (!c) throw new Error("expected a matching fetch call, found none")
  return c
}

beforeEach(() => {
  calls = []
  ensembleMock.mockReset()
  installFetch()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("dispatchJob — gitlab-mr-review consumer (e2e: a real MR gets a posted review)", () => {
  it("routes through dispatch -> consumer -> orchestrator and POSTs a summary note + inline discussion", async () => {
    ensembleMock.mockImplementation(postingEnsemble)

    await expect(dispatchJob(JOB, makeEnv())).resolves.toBeUndefined()

    // The consumer invoked the SAME ensemble GitHub uses, with the GitLab client injected.
    expect(ensembleMock).toHaveBeenCalledTimes(1)
    const args = ensembleMock.mock.calls[0]![0]
    expect(args.owner).toBe("grp") // projectPath split at the first slash (nested groups survive)
    expect(args.repo).toBe("sub/proj")
    expect(args.prNumber).toBe(7)
    expect(args.headSha).toBe("c".repeat(40))
    expect(args.scmProvider).toBe("gitlab")
    expect(args.installationId).toBe(0) // GitHub concept; 0 on the GitLab path
    expect(args.repoId).toBeUndefined() // omitted -> usage-metering + getCommit paths stay inert
    expect(args.githubClient).toBeDefined()

    // The review reached GitLab: a summary NOTE + an inline DISCUSSION, on MR iid 7.
    const summary = findCall((c) => c.method === "POST" && /\/merge_requests\/7\/notes$/.test(c.url))
    expect((summary.body as { body: string }).body).toContain("Sigilix review")
    const inline = findCall((c) => c.method === "POST" && /\/merge_requests\/7\/discussions$/.test(c.url))
    const pos = (inline.body as { position: { new_line: number; new_path: string } }).position
    expect(pos.new_path).toBe("src/app.ts")
    expect(pos.new_line).toBe(2)

    // The project is addressed by its immutable NUMERIC id on every call (Codex
    // hardening) — not the mutable, potentially-mismatched path.
    expect(summary.url).toContain("/projects/42/")
    expect(summary.url).not.toContain("grp%2Fsub%2Fproj")
    // The diff + a file were fetched through the real client read verbs.
    expect(calls.some((c) => /\/merge_requests\/7\/changes$/.test(c.url))).toBe(true)
    expect(calls.some((c) => /\/repository\/files\/.+\/raw/.test(c.url))).toBe(true)
  })

  it("uses the GLOBAL token when no per-project token is configured", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    await dispatchJob(JOB, makeEnv())
    expect(findCall((c) => c.method === "POST").token).toBe("glpat-global")
  })

  it("uses the PER-PROJECT token from KV when present (mirrors GitHub installation->token)", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    await dispatchJob(JOB, makeEnv({}, { "gitlab-project-token:42": "glpat-project-42" }))
    expect(findCall((c) => c.method === "POST").token).toBe("glpat-project-42")
  })
})

describe("dispatchJob — gitlab-mr-review allowlist gate (pre-launch project gate)", () => {
  it("IGNORES a project not on the allowlist (no ensemble run, nothing posted)", async () => {
    const env = makeEnv({ SIGILIX_GITLAB_ALLOWED_PROJECTS: "999,other/proj" })
    await dispatchJob(JOB, env)
    expect(ensembleMock).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0) // nothing posted to GitLab
  })

  it("REVIEWS a project that IS on the allowlist (by numeric id)", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    await dispatchJob(JOB, makeEnv({ SIGILIX_GITLAB_ALLOWED_PROJECTS: "42" }))
    expect(ensembleMock).toHaveBeenCalledTimes(1)
  })

  it("REVIEWS a project that IS on the allowlist (by path)", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    await dispatchJob(JOB, makeEnv({ SIGILIX_GITLAB_ALLOWED_PROJECTS: "grp/sub/proj" }))
    expect(ensembleMock).toHaveBeenCalledTimes(1)
  })

  it("a per-project token implicitly allowlists the project even when it isn't listed", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    await dispatchJob(
      JOB,
      makeEnv({ SIGILIX_GITLAB_ALLOWED_PROJECTS: "999" }, { "gitlab-project-token:42": "glpat-project-42" }),
    )
    expect(ensembleMock).toHaveBeenCalledTimes(1)
    expect(findCall((c) => c.method === "POST").token).toBe("glpat-project-42")
  })

  it("with NO allowlist configured, all projects are reviewed (back-compat)", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    await dispatchJob(JOB, makeEnv())
    expect(ensembleMock).toHaveBeenCalledTimes(1)
  })

  it("does NOT run (and posts nothing) when no token is configured anywhere", async () => {
    // No SIGILIX_GITLAB_TOKEN and no per-project KV entry.
    const env = { OPENCLAW_STATE: { get: async () => null } } as unknown as Env
    await dispatchJob(JOB, env)
    expect(ensembleMock).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })
})

describe("dispatchJob — gitlab-mr-review tenant-isolation + lifecycle guards (Codex PR-3)", () => {
  it("SKIPS an MR that closed between webhook enqueue and consume (no ensemble, nothing posted)", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    // Override the MR GET to report a CLOSED MR.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET"
        const u = String(input)
        if (method === "GET" && /\/merge_requests\/7$/.test(u)) {
          return res(200, { iid: 7, state: "closed", merged_at: null, diff_refs: null })
        }
        return res(404, { message: `unexpected ${method} ${u}` })
      }) as unknown as typeof fetch,
    )
    await dispatchJob(JOB, makeEnv())
    expect(ensembleMock).not.toHaveBeenCalled()
  })

  it("FAILS CLOSED (rejects -> queue retry) on a per-tenant token KV read error; does not run with a wrong credential", async () => {
    const env = {
      SIGILIX_GITLAB_TOKEN: "glpat-global",
      OPENCLAW_STATE: {
        get: async () => {
          throw new Error("KV transient")
        },
      },
    } as unknown as Env
    await expect(dispatchJob(JOB, env)).rejects.toThrow(/KV transient/)
    expect(ensembleMock).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("addresses the project by its numeric id even for a nested-group path", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    await dispatchJob(JOB, makeEnv())
    // Every recorded call hits /projects/42/, never the encoded path.
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.url).toContain("/projects/42/")
  })
})

describe("dispatchJob — gitlab-mr-review dedup (GitLab stand-in for PrReviewRunDO)", () => {
  it("DEDUPES a duplicate delivery of an already-reviewed head (no ensemble, nothing posted)", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    // A prior run marked this (projectId, mrIid, headSha) done.
    const env = makeEnv({}, { [doneKey()]: "1" })
    await dispatchJob(JOB, env)
    expect(ensembleMock).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("marks the head reviewed after a posted run so a re-delivery is deduped", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    const store: Record<string, string> = {}
    await dispatchJob(JOB, makeEnv({}, store))
    expect(store[doneKey()]).toBe("1")

    // Second (duplicate) delivery with the same store -> deduped.
    ensembleMock.mockClear()
    calls.length = 0
    await dispatchJob(JOB, makeEnv({}, store))
    expect(ensembleMock).not.toHaveBeenCalled()
  })

  it("does NOT mark an errored head (a genuine re-delivery may retry — recall over dedup)", async () => {
    ensembleMock.mockResolvedValue({
      status: "errored",
      telemetry: { internalError: "boom" },
    } as unknown as EnsembleResult)
    const store: Record<string, string> = {}
    await dispatchJob(JOB, makeEnv({}, store))
    expect(store[doneKey()]).toBeUndefined()
  })

  it("dedup FAILS OPEN: a KV read error on the dedup key still runs the review (never suppresses)", async () => {
    ensembleMock.mockImplementation(postingEnsemble)
    // get throws ONLY for the dedup key; the token lookup (different key) succeeds.
    const env = {
      SIGILIX_GITLAB_TOKEN: "glpat-global",
      OPENCLAW_STATE: {
        get: async (key: string) => {
          if (key.startsWith("gitlab-mr-review-done:")) throw new Error("kv blip")
          return null
        },
        put: async () => {},
      },
    } as unknown as Env
    await dispatchJob(JOB, env)
    expect(ensembleMock).toHaveBeenCalledTimes(1) // ran despite the dedup KV error
  })
})

describe("dispatchJob — gitlab-mr-review RECALL-SAFETY (a degraded/errored run never passes clean)", () => {
  it("an errored run that posted NO notice surfaces a FAILURE note on the MR (not a clean pass)", async () => {
    ensembleMock.mockResolvedValue({
      status: "errored",
      telemetry: { internalError: "getPullRequestDiff: GitLab truncated the MR change set" },
      // reviewMeta undefined -> the orchestrator errored before posting anything.
    } as unknown as EnsembleResult)

    await dispatchJob(JOB, makeEnv())

    // A single MR note is posted, and it is an explicit NON-clean failure notice.
    const notes = calls.filter((c) => c.method === "POST" && /\/notes$/.test(c.url))
    expect(notes).toHaveLength(1)
    const body = (notes[0]!.body as { body: string }).body
    expect(body).toContain("could not complete this review")
    expect(body).toContain("not")
    // Never an approval / clean pass, and no inline discussions were posted.
    expect(body.toLowerCase()).not.toContain("approve")
    expect(calls.some((c) => /\/discussions$/.test(c.url))).toBe(false)
  })

  it("an errored run that ALREADY posted a skip-notice (surface `skip-notice`) does NOT double-post", async () => {
    ensembleMock.mockResolvedValue({
      status: "errored",
      telemetry: { fellBackReason: "specialists_all_failed" },
      reviewMeta: { surface: "skip-notice" }, // the orchestrator's bailWithSkipNotice posted a note
    } as unknown as EnsembleResult)

    await dispatchJob(JOB, makeEnv())

    // The real orchestrator already surfaced the skip-notice — no second note.
    expect(calls.filter((c) => c.method === "POST" && /\/notes$/.test(c.url))).toHaveLength(0)
  })

  it("an errored run with annotations-only reviewMeta (NO posted notice) STILL surfaces a failure note (Codex P2)", async () => {
    // reviewMeta is present but its surface is NOT `skip-notice` (e.g. Lane-A
    // SARIF check annotations built before a later failure). `reviewMeta !==
    // undefined` is NOT proof a note was posted, so the consumer must still post
    // the failure note — otherwise the errored review is silent on the MR.
    ensembleMock.mockResolvedValue({
      status: "errored",
      telemetry: { internalError: "boom after SARIF" },
      reviewMeta: { event: "REQUEST_CHANGES", findingsCount: 0 }, // no `surface`
    } as unknown as EnsembleResult)

    await dispatchJob(JOB, makeEnv())

    const notes = calls.filter((c) => c.method === "POST" && /\/notes$/.test(c.url))
    expect(notes).toHaveLength(1)
    expect((notes[0]!.body as { body: string }).body).toContain("could not complete this review")
  })

  it("AWAITS post-review-work on a posted run and logs a blocked outcome (merge-gated amendment lane)", async () => {
    // A `posted` result carrying a `postReviewWork` that resolves to a failure
    // must be AWAITED (not dropped) and surfaced — mirrors the GitHub dispatcher.
    let awaited = false
    ensembleMock.mockResolvedValue({
      status: "posted",
      reviewMeta: { surface: "review" },
      telemetry: {},
      postReviewWork: (async () => {
        awaited = true
        return { status: "failed", error: "amendment submit failed" }
      })(),
    } as unknown as EnsembleResult)

    await dispatchJob(JOB, makeEnv())
    expect(awaited).toBe(true) // the consumer waited for the follow-up work
  })

  it("a legitimate `skipped` run (nothing to review) posts nothing and is NOT treated as an error", async () => {
    ensembleMock.mockResolvedValue({
      status: "skipped",
      telemetry: { fellBackReason: "label_gate_skip" },
    } as unknown as EnsembleResult)

    await dispatchJob(JOB, makeEnv())
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0)
  })
})
