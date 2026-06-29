// LinearClient.createIssue — TDD test suite.
// Drives the method through the real `gql` private path by stubbing global
// `fetch`, exactly the way other LinearClient-adjacent tests do it.

import { afterEach, describe, expect, it, vi } from "vitest"
import { LinearClient } from "@/src/lib/linear"

const LINEAR_GRAPHQL = "https://api.linear.app/graphql"

function stubFetch(body: unknown, opts?: { status?: number }) {
  const status = opts?.status ?? 200
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  )
}

afterEach(() => vi.unstubAllGlobals())

const client = new LinearClient({ apiKey: "test-key" })

describe("LinearClient.createIssue", () => {
  it("POSTs to the Linear GraphQL endpoint with IssueCreate mutation and variables", async () => {
    stubFetch({
      data: {
        issueCreate: {
          success: true,
          issue: { id: "issue-uuid", identifier: "SIG-1", url: "https://linear.app/team/issue/SIG-1" },
        },
      },
    })

    await client.createIssue({ teamId: "team-uuid", title: "Test issue", description: "Test body" })

    const fetchMock = vi.mocked(globalThis.fetch)
    expect(fetchMock).toHaveBeenCalledOnce()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(LINEAR_GRAPHQL)
    expect(init.method).toBe("POST")

    const postedBody = JSON.parse(init.body as string) as { query: string; variables: unknown }
    expect(postedBody.query).toContain("IssueCreate")
    expect(postedBody.query).toContain("issueCreate")
    expect(postedBody.variables).toEqual({
      input: { teamId: "team-uuid", title: "Test issue", description: "Test body" },
    })
  })

  it("omits description from variables when not provided", async () => {
    stubFetch({
      data: {
        issueCreate: {
          success: true,
          issue: { id: "issue-uuid", identifier: "SIG-2", url: "https://linear.app/team/issue/SIG-2" },
        },
      },
    })

    await client.createIssue({ teamId: "team-uuid", title: "No-description issue" })

    const fetchMock = vi.mocked(globalThis.fetch)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const postedBody = JSON.parse(init.body as string) as { variables: { input: Record<string, unknown> } }
    expect(postedBody.variables.input).not.toHaveProperty("description")
  })

  it("includes assigneeId in the mutation input when provided (SIG-545 B3b)", async () => {
    stubFetch({
      data: {
        issueCreate: {
          success: true,
          issue: { id: "issue-uuid", identifier: "SIG-3", url: "https://linear.app/team/issue/SIG-3" },
        },
      },
    })

    await client.createIssue({ teamId: "team-uuid", title: "Assigned issue", assigneeId: "agent-user-uuid" })

    const fetchMock = vi.mocked(globalThis.fetch)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const postedBody = JSON.parse(init.body as string) as { variables: { input: Record<string, unknown> } }
    expect(postedBody.variables.input.assigneeId).toBe("agent-user-uuid")
  })

  it("omits assigneeId from variables when not provided", async () => {
    stubFetch({
      data: {
        issueCreate: {
          success: true,
          issue: { id: "issue-uuid", identifier: "SIG-4", url: "https://linear.app/team/issue/SIG-4" },
        },
      },
    })

    await client.createIssue({ teamId: "team-uuid", title: "Unassigned issue" })

    const fetchMock = vi.mocked(globalThis.fetch)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const postedBody = JSON.parse(init.body as string) as { variables: { input: Record<string, unknown> } }
    expect(postedBody.variables.input).not.toHaveProperty("assigneeId")
  })

  it("returns { id, identifier, url } on a successful response", async () => {
    stubFetch({
      data: {
        issueCreate: {
          success: true,
          issue: {
            id: "abc-123",
            identifier: "SIG-99",
            url: "https://linear.app/sigilix/issue/SIG-99",
          },
        },
      },
    })

    const result = await client.createIssue({ teamId: "t", title: "My title" })
    expect(result).toEqual({
      id: "abc-123",
      identifier: "SIG-99",
      url: "https://linear.app/sigilix/issue/SIG-99",
    })
  })

  it("throws when success is false", async () => {
    stubFetch({
      data: {
        issueCreate: {
          success: false,
          issue: null,
        },
      },
    })

    await expect(client.createIssue({ teamId: "t", title: "Fail" })).rejects.toThrow(
      /issueCreate returned success=false/,
    )
  })

  it("throws when success is true but issue is null", async () => {
    stubFetch({
      data: {
        issueCreate: {
          success: true,
          issue: null,
        },
      },
    })

    await expect(client.createIssue({ teamId: "t", title: "Null issue" })).rejects.toThrow(
      /issueCreate returned success=false/,
    )
  })

  it("propagates HTTP errors from the underlying gql call", async () => {
    stubFetch({ error: "unauthorized" }, { status: 401 })

    await expect(client.createIssue({ teamId: "t", title: "Error" })).rejects.toThrow(/Linear HTTP 401/)
  })
})
