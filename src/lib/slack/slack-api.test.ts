// SIG-196: Slack Web API wrapper tests — postMessage, fetchThread, capAndRedact.
// Follows TDD: failing tests written first, then implementation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { capAndRedactThread, fetchSlackThread, isSlackOrgTeacher, postSlackMessage } from "@/src/lib/slack/slack-api"

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type MockFetch = ReturnType<typeof vi.fn>
let mockFetch: MockFetch

function makeFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  mockFetch = vi.fn()
  globalThis.fetch = mockFetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// postSlackMessage
// ---------------------------------------------------------------------------

describe("postSlackMessage", () => {
  it("sends POST to chat.postMessage with correct URL, headers, and body (with thread_ts)", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true }))

    const result = await postSlackMessage({
      botToken: "xoxb-test-token",
      channel: "C01234",
      threadTs: "1234567890.000100",
      text: "hello world",
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://slack.com/api/chat.postMessage")
    expect(init.method).toBe("POST")

    const headers = init.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer xoxb-test-token")
    expect(headers["Content-Type"]).toBe("application/json; charset=utf-8")

    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body["channel"]).toBe("C01234")
    expect(body["text"]).toBe("hello world")
    expect(body["thread_ts"]).toBe("1234567890.000100")

    expect(result).toEqual({ ok: true })
  })

  it("omits thread_ts when not provided", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true }))

    await postSlackMessage({ botToken: "xoxb-test-token", channel: "C01234", text: "no thread" })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(body, "thread_ts")).toBe(false)
  })

  it("returns { ok: false } when Slack returns ok: false", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: false, error: "channel_not_found" }))

    const result = await postSlackMessage({ botToken: "xoxb-test-token", channel: "CXXX", text: "hi" })
    expect(result).toEqual({ ok: false })
  })

  it("returns { ok: false } on fetch throw (never throws)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"))

    const result = await postSlackMessage({ botToken: "xoxb-test-token", channel: "C01234", text: "hi" })
    expect(result).toEqual({ ok: false })
  })

  it("maps json.ok truthy value to { ok: true }", async () => {
    // Slack always returns a boolean, but defence against truthy non-bool
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: 1 }))

    const result = await postSlackMessage({ botToken: "xoxb-test-token", channel: "C01234", text: "hi" })
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fetchSlackThread
// ---------------------------------------------------------------------------

describe("fetchSlackThread", () => {
  it("GETs conversations.replies with correct params and returns message texts", async () => {
    const messages = [
      { text: "first message", user: "U001" },
      { text: "second message", user: "U002" },
    ]
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true, messages }))

    const result = await fetchSlackThread({
      botToken: "xoxb-test-token",
      channel: "C01234",
      threadTs: "1234567890.000100",
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("https://slack.com/api/conversations.replies")
    expect(url).toContain("channel=C01234")
    expect(url).toContain("ts=1234567890.000100")
    expect(url).toContain("limit=20") // default

    const headers = init.headers as Record<string, string>
    expect(headers["Authorization"]).toBe("Bearer xoxb-test-token")

    expect(result).toEqual(["first message", "second message"])
  })

  it("respects maxMessages cap", async () => {
    const messages = [1, 2, 3, 4, 5].map((i) => ({ text: `msg ${i}` }))
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true, messages }))

    const result = await fetchSlackThread({
      botToken: "xoxb-test-token",
      channel: "C01234",
      threadTs: "1234567890.000100",
      maxMessages: 3,
    })

    // URL must use the provided limit
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("limit=3")

    expect(result).toHaveLength(3)
    expect(result).toEqual(["msg 1", "msg 2", "msg 3"])
  })

  it("filters out non-string and empty text entries", async () => {
    const messages = [
      { text: "valid" },
      { text: "" },
      { user: "U001" }, // no text field
      { text: 42 }, // non-string
      { text: "also valid" },
    ]
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true, messages }))

    const result = await fetchSlackThread({
      botToken: "xoxb-test-token",
      channel: "C01234",
      threadTs: "1234567890.000100",
    })

    expect(result).toEqual(["valid", "also valid"])
  })

  it("returns [] when Slack returns ok: false (never throws)", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: false, error: "channel_not_found" }))

    const result = await fetchSlackThread({
      botToken: "xoxb-test-token",
      channel: "C01234",
      threadTs: "1234567890.000100",
    })

    expect(result).toEqual([])
  })

  it("returns [] on fetch throw (never throws)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"))

    const result = await fetchSlackThread({
      botToken: "xoxb-test-token",
      channel: "C01234",
      threadTs: "1234567890.000100",
    })

    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// capAndRedactThread
// ---------------------------------------------------------------------------

describe("capAndRedactThread", () => {
  it("joins messages with newlines", () => {
    const result = capAndRedactThread(["hello", "world"])
    expect(result).toBe("hello\nworld")
  })

  it("returns empty string for empty array", () => {
    expect(capAndRedactThread([])).toBe("")
  })

  it("truncates output to maxChars and appends ellipsis", () => {
    const long = "a".repeat(100)
    const result = capAndRedactThread([long], 50)
    expect(result).toHaveLength(51) // 50 chars + "…"
    expect(result.endsWith("…")).toBe(true)
  })

  it("does not truncate when output is exactly maxChars", () => {
    const msg = "a".repeat(50)
    const result = capAndRedactThread([msg], 50)
    expect(result).toBe(msg)
    expect(result.endsWith("…")).toBe(false)
  })

  it("uses default 6000-char cap", () => {
    const long = "a".repeat(7000)
    const result = capAndRedactThread([long])
    expect(result.length).toBe(6001) // 6000 + "…"
    expect(result.endsWith("…")).toBe(true)
  })

  it("redacts a message containing an AWS access key (AKIAIOSFODNN7EXAMPLE)", () => {
    // AKIAIOSFODNN7EXAMPLE is a well-known AWS access key ID used in docs
    // pattern: AKIA[0-9A-Z]{16} — AKIAIOSFODNN7EXAMPLE = AKIA + IOSFODNN7EXAMPLE (16 chars)
    const secret = "AKIAIOSFODNN7EXAMPLE"
    const result = capAndRedactThread([`token=${secret}`, "clean message"])
    expect(result).toContain("[redacted: contained a secret]")
    expect(result).not.toContain(secret)
    expect(result).toContain("clean message")
  })

  it("keeps clean messages when only one message contains a secret", () => {
    const result = capAndRedactThread(["safe text", "AKIAIOSFODNN7EXAMPLE is here", "also safe"])
    const lines = result.split("\n")
    expect(lines[0]).toBe("safe text")
    expect(lines[1]).toBe("[redacted: contained a secret]")
    expect(lines[2]).toBe("also safe")
  })

  it("redacts messages containing a Stripe secret key", () => {
    const secret = "sk_live_abcdefghijklmnopqrstuvwx"
    const result = capAndRedactThread([`My key is ${secret}`])
    expect(result).toBe("[redacted: contained a secret]")
  })

  it("redacts before truncating (redaction happens per-message before join+cap)", () => {
    // A message with a secret should be redacted even if it appears within a long thread
    const secret = "AKIAIOSFODNN7EXAMPLE"
    const messages = ["normal", `bad: ${secret}`, "normal2"]
    const result = capAndRedactThread(messages, 10000)
    expect(result).toContain("[redacted: contained a secret]")
    expect(result).not.toContain(secret)
  })
})

// ---------------------------------------------------------------------------
// isSlackOrgTeacher — org-teach authorization (fail-closed)
// ---------------------------------------------------------------------------

describe("isSlackOrgTeacher", () => {
  it("authorizes a workspace admin", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true, user: { is_admin: true } }))
    const res = await isSlackOrgTeacher({ botToken: "xoxb-t", userId: "U1" })
    expect(res).toEqual({ authorized: true, reason: "admin" })
    // Hits users.info with the user id and the bot bearer token.
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("/users.info")
    expect(url).toContain("user=U1")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-t")
  })

  it("authorizes an owner / primary owner", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true, user: { is_owner: true } }))
    expect(await isSlackOrgTeacher({ botToken: "xoxb-t", userId: "U1" })).toEqual({ authorized: true, reason: "admin" })
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true, user: { is_primary_owner: true } }))
    expect(await isSlackOrgTeacher({ botToken: "xoxb-t", userId: "U1" })).toEqual({ authorized: true, reason: "admin" })
  })

  it("denies a non-admin member (reason: not-admin)", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: true, user: { is_admin: false } }))
    expect(await isSlackOrgTeacher({ botToken: "xoxb-t", userId: "U1" })).toEqual({
      authorized: false,
      reason: "not-admin",
    })
  })

  it("FAIL-CLOSED on a Slack API error, surfacing the error code (e.g. missing_scope)", async () => {
    mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: false, error: "missing_scope" }))
    expect(await isSlackOrgTeacher({ botToken: "xoxb-t", userId: "U1" })).toEqual({
      authorized: false,
      reason: "api-missing_scope",
    })
  })

  it("FAIL-CLOSED on a network error (reason: lookup-error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("boom"))
    expect(await isSlackOrgTeacher({ botToken: "xoxb-t", userId: "U1" })).toEqual({
      authorized: false,
      reason: "lookup-error",
    })
  })

  it("FAIL-CLOSED without a bot token or user id (no network call)", async () => {
    expect(await isSlackOrgTeacher({ botToken: null, userId: "U1" })).toEqual({
      authorized: false,
      reason: "no-bot-token",
    })
    expect(await isSlackOrgTeacher({ botToken: "xoxb-t", userId: "" })).toEqual({
      authorized: false,
      reason: "no-user-id",
    })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
