// GitHub @-mention reply pure helpers — response parser + reply
// formatter. The handler itself orchestrates network calls and is
// covered by integration smoke; these tests pin down the JSON-shape
// tolerance and the marker discipline.

import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  getInstallationTokenMock,
  listIssueCommentsMock,
  listPullRequestReviewCommentsMock,
  addReactionToIssueCommentMock,
  addReactionToReviewCommentMock,
  listPullRequestReviewsMock,
  dismissReviewMock,
  createIssueCommentMock,
  replyToReviewCommentMock,
} = vi.hoisted(() => ({
  getInstallationTokenMock: vi.fn(async () => "fake-token"),
  listIssueCommentsMock: vi.fn(),
  listPullRequestReviewCommentsMock: vi.fn(),
  addReactionToIssueCommentMock: vi.fn(),
  addReactionToReviewCommentMock: vi.fn(),
  listPullRequestReviewsMock: vi.fn(),
  dismissReviewMock: vi.fn(),
  createIssueCommentMock: vi.fn(),
  replyToReviewCommentMock: vi.fn(),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: getInstallationTokenMock,
}))

vi.mock("../src/lib/github", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/github")>()
  class FakeGitHubClient {
    listIssueComments = listIssueCommentsMock
    listPullRequestReviewComments = listPullRequestReviewCommentsMock
    addReactionToIssueComment = addReactionToIssueCommentMock
    addReactionToReviewComment = addReactionToReviewCommentMock
    listPullRequestReviews = listPullRequestReviewsMock
    dismissReview = dismissReviewMock
    createIssueComment = createIssueCommentMock
    replyToReviewComment = replyToReviewCommentMock
  }
  return {
    ...actual,
    GitHubClient: FakeGitHubClient,
  }
})

import {
  acquireReviewDismissInProgressLock,
  dismissLatestBlockingSigilixReview,
  formatReviewDismissReply,
  formatReply,
  handleGithubMention,
  isAuthorAllowedForReviewDismiss,
  isReviewDismissRequest,
  parseDismissCommand,
  parseFindingCategory,
  parseGithubMentionResponse,
  parseReviewDismissDedupeRecord,
  preferPersistedReason,
  releaseReviewDismissInProgressLock,
  serializeReviewDismissDedupeRecord,
  serializeReviewDismissInProgressRecord,
} from "../src/lib/github-mention"
import {
  LEGACY_REVIEW_BODY_MARKER,
  SIGILIX_REVIEW_BODY_MARKER,
} from "../src/lib/dismiss-prior-reviews"
import type { Env } from "../src/index"

beforeEach(() => {
  getInstallationTokenMock.mockReset()
  getInstallationTokenMock.mockResolvedValue("fake-token")
  listIssueCommentsMock.mockReset()
  listPullRequestReviewCommentsMock.mockReset()
  addReactionToIssueCommentMock.mockReset()
  addReactionToReviewCommentMock.mockReset()
  listPullRequestReviewsMock.mockReset()
  dismissReviewMock.mockReset()
  createIssueCommentMock.mockReset()
  replyToReviewCommentMock.mockReset()
  addReactionToIssueCommentMock.mockResolvedValue(undefined)
  addReactionToReviewCommentMock.mockResolvedValue(undefined)
  dismissReviewMock.mockResolvedValue(undefined)
  createIssueCommentMock.mockResolvedValue({ id: 777 })
  replyToReviewCommentMock.mockResolvedValue({ id: 888 })
})

describe("parseGithubMentionResponse", () => {
  const valid = {
    answer: "Fixed — guard now uses `<=` on `bounds.length` at `src/lib/foo.ts:42`.",
    confidence: 4,
    abstain: false,
  }

  it("parses a well-formed JSON object", () => {
    const out = parseGithubMentionResponse(JSON.stringify(valid))
    expect(out?.answer).toBe(valid.answer)
    expect(out?.confidence).toBe(4)
    expect(out?.abstain).toBe(false)
  })

  it("strips a surrounding ```json fence", () => {
    const text = "```json\n" + JSON.stringify(valid) + "\n```"
    expect(parseGithubMentionResponse(text)?.answer).toBe(valid.answer)
  })

  it("extracts JSON from prose-wrapped output", () => {
    const text = `Here's my answer:\n\n${JSON.stringify(valid)}\n\n— Arc`
    expect(parseGithubMentionResponse(text)?.answer).toBe(valid.answer)
  })

  it("returns null on missing answer", () => {
    expect(parseGithubMentionResponse(JSON.stringify({ ...valid, answer: "" }))).toBeNull()
  })

  it("falls back to confidence 3 when confidence is out of range", () => {
    const out = parseGithubMentionResponse(JSON.stringify({ ...valid, confidence: 99 }))
    expect(out?.confidence).toBe(3)
  })

  it("falls back to confidence 3 when confidence is missing", () => {
    const obj = { answer: valid.answer, abstain: false }
    const out = parseGithubMentionResponse(JSON.stringify(obj))
    expect(out?.confidence).toBe(3)
  })

  it("coerces abstain to boolean", () => {
    const out = parseGithubMentionResponse(
      JSON.stringify({ answer: valid.answer, confidence: 2, abstain: "yes" })
    )
    expect(out?.abstain).toBe(true)
  })

  it("returns null on non-object input", () => {
    expect(parseGithubMentionResponse("[1, 2, 3]")).toBeNull()
    expect(parseGithubMentionResponse("not json")).toBeNull()
  })
})

describe("formatReply", () => {
  it("prepends the dedupe marker so Arc's own replies are detectable", () => {
    const out = formatReply({
      answer: "Fixed — guard now uses `<=` on `bounds.length`.",
      confidence: 5,
      abstain: false,
    })
    expect(out.startsWith("<!-- sigilix:gh-mention-reply -->")).toBe(true)
    expect(out).toContain("Fixed — guard now uses")
  })

  it("preserves the model's Markdown verbatim under the marker", () => {
    const answer = "Returns `null` when `x` is empty — see `src/lib/foo.ts:42`."
    const out = formatReply({ answer, confidence: 3, abstain: false })
    expect(out.endsWith(answer)).toBe(true)
  })
})

describe("isReviewDismissRequest", () => {
  it("accepts the bare + canonical command shapes", () => {
    expect(isReviewDismissRequest("dismiss")).toBe(true)
    expect(isReviewDismissRequest("Dismiss this review.")).toBe(true)
    expect(isReviewDismissRequest("dismiss review")).toBe(true)
  })

  it("rejects bodies that don't START with the dismiss prefix", () => {
    expect(isReviewDismissRequest("can you dismiss this?")).toBe(false)
    expect(isReviewDismissRequest("please review")).toBe(false)
  })

  it("accepts the new reason-bearing forms (label-shaped residual only)", () => {
    // SIG-173: `dismiss <label>` is treated as a dismiss command. Typos on
    // a label-shaped residual still parse as `unlabeled` so the dismiss
    // goes through. Free prose that just happens to start with "dismiss"
    // does NOT trigger — see the next test.
    expect(isReviewDismissRequest("dismiss too-minor")).toBe(true)
    expect(isReviewDismissRequest("dismiss notabug")).toBe(true)
  })

  it("rejects prose that happens to start with the word 'dismiss' (SIG-173 follow-up)", () => {
    // The residual after the dismiss prefix must be label-shaped (<=3
    // words, [a-z0-9 _-], <=32 chars). Anything else is prose, not a
    // command — the comment is left alone for the question-answer path.
    expect(isReviewDismissRequest("dismiss the finding after checking this file")).toBe(false)
    expect(isReviewDismissRequest("dismiss the irrelevant context you raised here is concerning")).toBe(false)
    expect(isReviewDismissRequest("dismiss the bug i mentioned earlier")).toBe(false)
  })
})

describe("parseDismissCommand", () => {
  it("returns null on non-dismiss bodies", () => {
    expect(parseDismissCommand("can you take another look?")).toBeNull()
    expect(parseDismissCommand("review this please")).toBeNull()
    expect(parseDismissCommand("")).toBeNull()
  })

  it("defaults bare dismiss to unlabeled", () => {
    expect(parseDismissCommand("dismiss")).toEqual({ kind: "dismiss", reason: "unlabeled" })
    expect(parseDismissCommand("Dismiss.")).toEqual({ kind: "dismiss", reason: "unlabeled" })
    expect(parseDismissCommand("dismiss review")).toEqual({ kind: "dismiss", reason: "unlabeled" })
    expect(parseDismissCommand("dismiss this review")).toEqual({ kind: "dismiss", reason: "unlabeled" })
  })

  it("parses all five canonical labels (hyphen form)", () => {
    expect(parseDismissCommand("dismiss not-a-bug")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
    expect(parseDismissCommand("dismiss bad-anchor")).toEqual({ kind: "dismiss", reason: "bad-anchor" })
    expect(parseDismissCommand("dismiss already-covered")).toEqual({ kind: "dismiss", reason: "already-covered" })
    expect(parseDismissCommand("dismiss too-minor")).toEqual({ kind: "dismiss", reason: "too-minor" })
    expect(parseDismissCommand("dismiss wrong-context")).toEqual({ kind: "dismiss", reason: "wrong-context" })
  })

  it("accepts mixed case", () => {
    expect(parseDismissCommand("Dismiss TOO-MINOR")).toEqual({ kind: "dismiss", reason: "too-minor" })
    expect(parseDismissCommand("DISMISS Not-A-Bug")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
  })

  it("tolerates underscores and spaces in place of hyphens", () => {
    expect(parseDismissCommand("dismiss not_a_bug")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
    expect(parseDismissCommand("dismiss not a bug")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
    expect(parseDismissCommand("dismiss too_minor")).toEqual({ kind: "dismiss", reason: "too-minor" })
    expect(parseDismissCommand("dismiss too minor")).toEqual({ kind: "dismiss", reason: "too-minor" })
  })

  it("tolerates surrounding whitespace + a longer prefix", () => {
    expect(parseDismissCommand("  dismiss   too-minor  ")).toEqual({ kind: "dismiss", reason: "too-minor" })
    expect(parseDismissCommand("dismiss this review too-minor")).toEqual({ kind: "dismiss", reason: "too-minor" })
    expect(parseDismissCommand("dismiss review too minor.")).toEqual({ kind: "dismiss", reason: "too-minor" })
  })

  it("falls back to unlabeled on an unknown / typo'd label (forgiving parse)", () => {
    expect(parseDismissCommand("dismiss notabug")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
    expect(parseDismissCommand("dismiss whatever")).toEqual({ kind: "dismiss", reason: "unlabeled" })
    expect(parseDismissCommand("dismiss nope")).toEqual({ kind: "dismiss", reason: "unlabeled" })
    expect(parseDismissCommand("dismiss too-mnir")).toEqual({ kind: "dismiss", reason: "unlabeled" })
  })

  it("returns null on free prose that happens to start with 'dismiss' (SIG-173 follow-up)", () => {
    // The residual must be label-shape (<=3 label-shape words, <=32 chars).
    // Multi-word prose, special chars, or anything over the cap are NOT
    // commands — the body is left for the question-answer path to handle.
    expect(parseDismissCommand("dismiss the finding after checking this file")).toBeNull()
    expect(parseDismissCommand("dismiss because xyz, this is fine")).toBeNull()
    expect(parseDismissCommand("dismiss the irrelevant context you raised here is concerning")).toBeNull()
    // Punctuation / special chars are NOT label-shape.
    expect(parseDismissCommand("dismiss not (a bug)")).toBeNull()
    // Over the 32-char rest cap.
    expect(parseDismissCommand("dismiss aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull()
  })

  it("pins the boundary: 3-word label-shape residual still parses", () => {
    // "not a bug" is 3 words, all label-shape — the hyphen-tolerant alias
    // table converts the space-separated form to the canonical label.
    expect(parseDismissCommand("dismiss not a bug")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
  })

  it("tolerates markdown-emphasis and trailing-emoji wrappers around labels (SIG-173 follow-up)", () => {
    expect(parseDismissCommand("dismiss *not-a-bug*")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
    expect(parseDismissCommand("dismiss `not-a-bug`")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
    expect(parseDismissCommand("dismiss _too-minor_")).toEqual({ kind: "dismiss", reason: "too-minor" })
    expect(parseDismissCommand("dismiss not-a-bug 🎉")).toEqual({ kind: "dismiss", reason: "not-a-bug" })
    expect(parseDismissCommand("dismiss too-minor 🤷‍♀️")).toEqual({ kind: "dismiss", reason: "too-minor" })
  })
})

describe("preferPersistedReason (SIG-173 follow-up)", () => {
  it("falls back to the fresh reason when no persisted record exists", () => {
    expect(preferPersistedReason(null, "too-minor")).toBe("too-minor")
  })

  it("falls back to fresh when the record is the in-progress lock kind", () => {
    expect(preferPersistedReason({ kind: "review-dismiss-in-progress" }, "too-minor")).toBe("too-minor")
  })

  it("returns the persisted reason verbatim when present", () => {
    expect(
      preferPersistedReason(
        {
          kind: "review-dismiss-result",
          result: { kind: "dismissed", reviewId: 1 },
          dismissReason: "bad-anchor",
        },
        "too-minor",
      ),
    ).toBe("bad-anchor")
  })

  it("preserves a persisted 'unlabeled' over a fresh labeled command", () => {
    expect(
      preferPersistedReason(
        {
          kind: "review-dismiss-result",
          result: { kind: "dismissed", reviewId: 1 },
          dismissReason: "unlabeled",
        },
        "too-minor",
      ),
    ).toBe("unlabeled")
  })

  it("treats a legacy record (no dismissReason field) as 'unlabeled' — fresh label does NOT win", () => {
    // Pre-SIG-173 records have no field. The original dismiss was, by
    // definition, unlabeled — a replay must not silently rewrite history.
    expect(
      preferPersistedReason(
        {
          kind: "review-dismiss-result",
          result: { kind: "dismissed", reviewId: 1 },
        },
        "too-minor",
      ),
    ).toBe("unlabeled")
  })
})

describe("isAuthorAllowedForReviewDismiss", () => {
  it("allows trusted repository relationships", () => {
    expect(isAuthorAllowedForReviewDismiss("OWNER")).toBe(true)
    expect(isAuthorAllowedForReviewDismiss("member")).toBe(true)
    expect(isAuthorAllowedForReviewDismiss("COLLABORATOR")).toBe(true)
  })

  it("rejects untrusted or missing relationships", () => {
    expect(isAuthorAllowedForReviewDismiss("CONTRIBUTOR")).toBe(false)
    expect(isAuthorAllowedForReviewDismiss("FIRST_TIME_CONTRIBUTOR")).toBe(false)
    expect(isAuthorAllowedForReviewDismiss("NONE")).toBe(false)
    expect(isAuthorAllowedForReviewDismiss(undefined)).toBe(false)
  })
})

describe("review dismiss dedupe records", () => {
  it("round-trips an in-progress record", () => {
    expect(parseReviewDismissDedupeRecord(serializeReviewDismissInProgressRecord())).toEqual({
      kind: "review-dismiss-in-progress",
    })
  })

  it("round-trips a tokenized in-progress lock record", () => {
    const parsed = parseReviewDismissDedupeRecord(
      serializeReviewDismissInProgressRecord("lock-token-1")
    )
    expect(parsed).toMatchObject({
      kind: "review-dismiss-in-progress",
      token: "lock-token-1",
    })
    expect(typeof parsed?.createdAt).toBe("number")
  })

  it("round-trips result records before and after a reply is posted", () => {
    const result = { kind: "dismissed" as const, reviewId: 10 }

    expect(parseReviewDismissDedupeRecord(serializeReviewDismissDedupeRecord(result))).toEqual({
      kind: "review-dismiss-result",
      result,
    })
    expect(parseReviewDismissDedupeRecord(serializeReviewDismissDedupeRecord(result, 4242))).toEqual({
      kind: "review-dismiss-result",
      result,
      replyCommentId: 4242,
    })
  })

  it("rejects malformed stored values", () => {
    expect(parseReviewDismissDedupeRecord("not json")).toBeNull()
    expect(parseReviewDismissDedupeRecord(null)).toBeNull()
    expect(parseReviewDismissDedupeRecord("[]")).toBeNull()
    expect(parseReviewDismissDedupeRecord(JSON.stringify({ kind: "other" }))).toBeNull()
    expect(parseReviewDismissDedupeRecord(JSON.stringify({ kind: "review-dismiss-result" }))).toBeNull()
    expect(parseReviewDismissDedupeRecord(JSON.stringify({
      kind: "review-dismiss-result",
      result: { kind: "dismissed" },
    }))).toBeNull()
  })
})

describe("handleGithubMention dismiss path", () => {
  function makeEnv(initial?: Record<string, string>): {
    env: Env
    store: Map<string, string>
    metricsBatches: Array<{ events: Array<{ kind: string; reason?: string }> }>
  } {
    const store = new Map(Object.entries(initial ?? {}))
    const kv = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
      delete: vi.fn(async (key: string) => { store.delete(key) }),
    } as unknown as KVNamespace
    // SIG-173 follow-up: minimal VALIDATION_METRICS_DO stub so the
    // dismissal-metric record call hits the happy path instead of
    // silently swallowing a binding-missing error. Captures recorded
    // batches for assertion-side inspection.
    const metricsBatches: Array<{ events: Array<{ kind: string; reason?: string }> }> = []
    const metricsStub = {
      async recordBatch(args: { events: Array<{ kind: string; reason?: string }> }) {
        metricsBatches.push(args)
      },
    }
    const metricsNs = {
      idFromName: (_name: string) => "global-id",
      get: (_id: unknown) => metricsStub,
    }
    return {
      store,
      metricsBatches,
      env: {
        OPENCLAW_STATE: kv,
        GITHUB_APP_ID: "1",
        GITHUB_PRIVATE_KEY: "private-key",
        VALIDATION_METRICS_DO: metricsNs,
      } as unknown as Env,
    }
  }

  it("dismisses, posts a reply, and stores the terminal dedupe record", async () => {
    const { env, store } = makeEnv()
    listIssueCommentsMock.mockResolvedValue([
      {
        id: 4242,
        body: "@sigilix dismiss",
        user: { login: "human" },
        author_association: "MEMBER",
      },
    ])
    listPullRequestReviewsMock.mockResolvedValue([
      {
        id: 90,
        state: "CHANGES_REQUESTED",
        user: { login: "sigilix[bot]" },
        body: SIGILIX_REVIEW_BODY_MARKER,
        commitId: null,
      },
    ])

    await handleGithubMention({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
      installationId: 99,
      surface: "issue",
      commentId: 4242,
      env,
    })

    expect(getInstallationTokenMock).toHaveBeenCalledWith(expect.objectContaining({
      installationId: 99,
    }))
    expect(addReactionToIssueCommentMock).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      4242,
      "eyes",
    )
    expect(dismissReviewMock).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      90,
      "Dismissed by explicit @sigilix dismiss request.",
    )
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      expect.stringContaining("Dismissed the latest blocking Sigilix review"),
    )
    expect(parseReviewDismissDedupeRecord(store.get("gh-mention:4242") ?? null)).toEqual({
      kind: "review-dismiss-result",
      result: { kind: "dismissed", reviewId: 90 },
      replyCommentId: 777,
      dismissReason: "unlabeled",
    })
  })

  it("reuses a stored dismiss result awaiting reply without dismissing again", async () => {
    const { env, store } = makeEnv({
      "gh-mention:4242": serializeReviewDismissDedupeRecord({ kind: "not-found" }),
    })
    listIssueCommentsMock.mockResolvedValue([
      {
        id: 4242,
        body: "@sigilix dismiss",
        user: { login: "human" },
        author_association: "MEMBER",
      },
    ])

    await handleGithubMention({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
      installationId: 99,
      surface: "issue",
      commentId: 4242,
      env,
    })

    expect(listPullRequestReviewsMock).not.toHaveBeenCalled()
    expect(dismissReviewMock).not.toHaveBeenCalled()
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      expect.stringContaining("couldn't find an active blocking Sigilix review"),
    )
    expect(parseReviewDismissDedupeRecord(store.get("gh-mention:4242") ?? null)).toEqual({
      kind: "review-dismiss-result",
      result: { kind: "not-found" },
      replyCommentId: 777,
      dismissReason: "unlabeled",
    })
  })

  it("rejects untrusted dismiss requests before mutating reviews", async () => {
    const { env, store } = makeEnv()
    listIssueCommentsMock.mockResolvedValue([
      {
        id: 4242,
        body: "@sigilix dismiss",
        user: { login: "drive-by" },
        author_association: "FIRST_TIME_CONTRIBUTOR",
      },
    ])

    await handleGithubMention({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
      installationId: 99,
      surface: "issue",
      commentId: 4242,
      env,
    })

    expect(addReactionToIssueCommentMock).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      4242,
      "eyes",
    )
    expect(listPullRequestReviewsMock).not.toHaveBeenCalled()
    expect(dismissReviewMock).not.toHaveBeenCalled()
    expect(createIssueCommentMock).not.toHaveBeenCalled()
    expect(store.has("gh-mention:4242")).toBe(false)
  })

  it("legacy record (no dismissReason field) preserves 'unlabeled' on a fresh labeled replay (SIG-173 follow-up)", async () => {
    // The original dismiss landed before SIG-173 shipped — the record has
    // no `dismissReason` field. A fresh `@sigilix dismiss too-minor` replay
    // arrives. The dedupe-record write that follows must NOT silently
    // overwrite the original (unlabeled) intent with "too-minor".
    const legacyJson = JSON.stringify({
      kind: "review-dismiss-result",
      result: { kind: "dismissed", reviewId: 90 },
      // No replyCommentId — this is the pendingDismissReply branch.
      // No dismissReason — pre-SIG-173 shape.
    })
    const { env, store } = makeEnv({ "gh-mention:4242": legacyJson })
    listIssueCommentsMock.mockResolvedValue([
      {
        id: 4242,
        body: "@sigilix dismiss too-minor",
        user: { login: "human" },
        author_association: "MEMBER",
      },
    ])

    await handleGithubMention({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
      installationId: 99,
      surface: "issue",
      commentId: 4242,
      env,
    })

    // We did NOT re-dismiss (the result was already persisted).
    expect(dismissReviewMock).not.toHaveBeenCalled()
    // Persisted "unlabeled" wins; the fresh "too-minor" does NOT take over.
    expect(parseReviewDismissDedupeRecord(store.get("gh-mention:4242") ?? null)).toEqual({
      kind: "review-dismiss-result",
      result: { kind: "dismissed", reviewId: 90 },
      replyCommentId: 777,
      dismissReason: "unlabeled",
    })
  })

  // SIG-173 self-review (PR #171, finding 1, P1): end-to-end coverage for
  // the LABELED dismiss command (`@sigilix dismiss <reason>`). The bare
  // `dismiss` flow is exercised by the first test in this describe block;
  // this one pins all four labeled-flow invariants in a single fire:
  //   (1) dismissLatestBlockingSigilixReview runs end-to-end
  //   (2) the dedupe record persists `dismissReason: "too-minor"`
  //   (3) the bot's reply body carries the `(reason: too-minor)` suffix
  //       produced by formatReviewDismissReply
  //   (4) VALIDATION_METRICS_DO receives a recordBatch with the
  //       `dismissal-reason` event (`recordDismissalMetric` happy path)
  it("end-to-end labeled dismiss (`@sigilix dismiss too-minor`) persists reason, suffixes reply, records metric (SIG-173)", async () => {
    const { env, store, metricsBatches } = makeEnv()
    listIssueCommentsMock.mockResolvedValue([
      {
        id: 4242,
        body: "@sigilix dismiss too-minor",
        user: { login: "human" },
        author_association: "MEMBER",
      },
    ])
    listPullRequestReviewsMock.mockResolvedValue([
      {
        id: 90,
        state: "CHANGES_REQUESTED",
        user: { login: "sigilix[bot]" },
        body: SIGILIX_REVIEW_BODY_MARKER,
        commitId: null,
      },
    ])

    await handleGithubMention({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 7,
      installationId: 99,
      surface: "issue",
      commentId: 4242,
      env,
    })

    // (1) The dismiss API call fired against the right review.
    expect(dismissReviewMock).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      90,
      "Dismissed by explicit @sigilix dismiss request.",
    )
    // (3) Reason landed in the bot's acknowledgement reply body via
    // formatReviewDismissReply. Match the literal suffix shape so a copy
    // change requires intentionally updating this assertion.
    expect(createIssueCommentMock).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      expect.stringContaining("(reason: too-minor)"),
    )
    // (2) Reason landed in the dedupe record so a replay re-renders the
    // same copy (and `preferPersistedReason` returns the canonical label).
    expect(parseReviewDismissDedupeRecord(store.get("gh-mention:4242") ?? null)).toEqual({
      kind: "review-dismiss-result",
      result: { kind: "dismissed", reviewId: 90 },
      replyCommentId: 777,
      dismissReason: "too-minor",
    })
    // (4) `recordDismissalMetric` actually fires on the happy path (the
    // env binds VALIDATION_METRICS_DO so we exercise the real call site,
    // not the swallowed-error fallback).
    expect(metricsBatches).toHaveLength(1)
    expect(metricsBatches[0].events).toEqual([
      { kind: "dismissal-reason", reason: "too-minor" },
    ])
  })
})

describe("review dismiss in-progress lock", () => {
  function makeKv(initial?: string): { kv: KVNamespace; store: Map<string, string> } {
    const store = new Map<string, string>()
    if (initial) store.set("gh-mention:1", initial)
    return {
      store,
      kv: {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
        delete: vi.fn(async (key: string) => { store.delete(key) }),
      } as unknown as KVNamespace,
    }
  }

  it("acquires an empty key and stores a tokenized sentinel", async () => {
    const { kv, store } = makeKv()

    const lock = await acquireReviewDismissInProgressLock(kv, "gh-mention:1")

    expect(lock.acquired).toBe(true)
    if (!lock.acquired) throw new Error("expected lock")
    expect(parseReviewDismissDedupeRecord(store.get("gh-mention:1") ?? null)).toMatchObject({
      kind: "review-dismiss-in-progress",
      token: lock.token,
    })
  })

  it("does not acquire when a terminal result already exists", async () => {
    const result = { kind: "dismissed" as const, reviewId: 99 }
    const { kv } = makeKv(serializeReviewDismissDedupeRecord(result))

    const lock = await acquireReviewDismissInProgressLock(kv, "gh-mention:1")

    expect(lock).toEqual({
      acquired: false,
      record: { kind: "review-dismiss-result", result },
    })
  })

  it("clears only the matching in-progress sentinel", async () => {
    const { kv, store } = makeKv(serializeReviewDismissInProgressRecord("ours"))

    await releaseReviewDismissInProgressLock(kv, "gh-mention:1", "theirs")
    expect(store.has("gh-mention:1")).toBe(true)

    await releaseReviewDismissInProgressLock(kv, "gh-mention:1", "ours")
    expect(store.has("gh-mention:1")).toBe(false)
  })
})

describe("dismissLatestBlockingSigilixReview", () => {
  function clientWithReviews(reviews: Array<{
    id: number
    state: string
    login?: string
    body?: string
  }>) {
    return {
      listPullRequestReviews: vi.fn(async () => reviews.map((r) => ({
        id: r.id,
        state: r.state,
        user: r.login ? { login: r.login } : null,
        body: r.body ?? "",
        commitId: null,
      }))),
      dismissReview: vi.fn(async () => undefined),
    }
  }

  const base = { owner: "Arc-and-Anchor", repo: "sigilix", prNumber: 7 }

  it("dismisses the highest-id blocking Sigilix review by API", async () => {
    const client = clientWithReviews([
      { id: 13, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: SIGILIX_REVIEW_BODY_MARKER },
      { id: 11, state: "CHANGES_REQUESTED", login: "coderabbitai", body: SIGILIX_REVIEW_BODY_MARKER },
      { id: 12, state: "COMMENTED", login: "sigilix[bot]", body: SIGILIX_REVIEW_BODY_MARKER },
      { id: 10, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: SIGILIX_REVIEW_BODY_MARKER },
    ])

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({ kind: "dismissed", reviewId: 13 })
    expect(client.dismissReview).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      13,
      "Dismissed by explicit @sigilix dismiss request.",
    )
  })

  it("does not dismiss human or unmarked reviews", async () => {
    const client = clientWithReviews([
      { id: 20, state: "CHANGES_REQUESTED", login: "human", body: SIGILIX_REVIEW_BODY_MARKER },
      { id: 21, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: "missing marker" },
    ])

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({ kind: "not-found" })
    expect(client.dismissReview).not.toHaveBeenCalled()
  })

  it("dismisses a blocking Sigilix review with the legacy marker", async () => {
    const client = clientWithReviews([
      { id: 25, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: LEGACY_REVIEW_BODY_MARKER },
    ])

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({ kind: "dismissed", reviewId: 25 })
    expect(client.dismissReview).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      25,
      "Dismissed by explicit @sigilix dismiss request.",
    )
  })

  it("reports review-list failures instead of throwing or claiming success", async () => {
    const client = clientWithReviews([])
    client.listPullRequestReviews.mockRejectedValueOnce(new Error("secondary rate limit"))

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({
      kind: "list-failed",
      error: "secondary rate limit",
    })
    expect(client.dismissReview).not.toHaveBeenCalled()
  })

  it("reports permission/API failures instead of claiming success", async () => {
    const client = clientWithReviews([
      { id: 30, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: SIGILIX_REVIEW_BODY_MARKER },
    ])
    client.dismissReview.mockRejectedValueOnce(new Error("Resource not accessible by integration"))

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({
      kind: "dismiss-failed",
      reviewId: 30,
      error: "Resource not accessible by integration",
    })
  })
})

describe("formatReviewDismissReply", () => {
  it("keeps the GitHub mention marker and honest success copy", () => {
    const out = formatReviewDismissReply({ kind: "dismissed", reviewId: 10 })
    expect(out.startsWith("<!-- sigilix:gh-mention-reply -->")).toBe(true)
    expect(out).toContain("Dismissed the latest blocking Sigilix review")
  })

  it("formats the no-active-review branch", () => {
    const out = formatReviewDismissReply({ kind: "not-found" })
    expect(out.startsWith("<!-- sigilix:gh-mention-reply -->")).toBe(true)
    expect(out).toContain("couldn't find an active blocking Sigilix review")
  })

  it("formats the review-list failure branch", () => {
    const out = formatReviewDismissReply({ kind: "list-failed", error: "rate limited" })
    expect(out.startsWith("<!-- sigilix:gh-mention-reply -->")).toBe(true)
    expect(out).toContain("couldn't list this PR's reviews")
  })

  it("formats the dismiss failure branch", () => {
    const out = formatReviewDismissReply({
      kind: "dismiss-failed",
      reviewId: 10,
      error: "forbidden",
    })
    expect(out.startsWith("<!-- sigilix:gh-mention-reply -->")).toBe(true)
    expect(out).toContain("GitHub rejected the dismissal request")
  })

  it("surfaces the labelled reason in the success copy", () => {
    const out = formatReviewDismissReply({ kind: "dismissed", reviewId: 10 }, "too-minor")
    expect(out).toContain("(reason: too-minor)")
    expect(out).toContain("Dismissed the latest blocking Sigilix review")
  })

  it("omits the reason annotation on unlabeled dismissals (clean default copy)", () => {
    const out = formatReviewDismissReply({ kind: "dismissed", reviewId: 10 }, "unlabeled")
    expect(out).not.toContain("reason:")
  })

  it("does not annotate non-success branches with the reason", () => {
    const out = formatReviewDismissReply({ kind: "not-found" }, "too-minor")
    expect(out).not.toContain("reason:")
  })
})

describe("parseFindingCategory (SIG-147)", () => {
  const marker = (cat: string) => `<!-- sigilix:pr-review-finding -->\n<!-- sigilix:category:${cat} -->\nbody`
  it("parses a valid category marker", () => {
    expect(parseFindingCategory(marker("security"))).toBe("security")
    expect(parseFindingCategory(marker("error-handling"))).toBe("error-handling")
  })
  it("falls back to 'logic' when the marker is absent", () => {
    expect(parseFindingCategory("a finding body with no markers")).toBe("logic")
  })
  it("falls back to 'logic' on an unrecognized category", () => {
    expect(parseFindingCategory(marker("bogus"))).toBe("logic")
  })
})
