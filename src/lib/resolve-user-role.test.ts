// resolve-user-role.ts — unit tests. The helper takes an injected fetch impl
// so these run without touching global fetch or any request/session
// machinery (see auth-me-route.test.ts for the full /auth/me integration).

import { describe, expect, it, vi } from "vitest"
import { resolveUserRole } from "@/src/lib/resolve-user-role"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface Installation {
  id: number
  account: { type: "User" | "Organization"; login: string }
}

/** An org's membership fixture: role + GitHub's invite-acceptance state (defaults to "active"). */
interface OrgMembershipFixture {
  role: string
  state?: string
}

/** Builds a fetch stub: GET /user/installations returns `installations`; GET
 * /user/memberships/orgs/{org} returns `orgMemberships[org]` (or 404 if absent). */
function stubFetch(
  installations: Installation[],
  orgMemberships: Record<string, OrgMembershipFixture> = {},
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/user/installations")) {
      return jsonResponse({ total_count: installations.length, installations })
    }
    const membershipMatch = /\/user\/memberships\/orgs\/([^/?]+)/.exec(url)
    if (membershipMatch) {
      const org = decodeURIComponent(membershipMatch[1]!)
      const membership = orgMemberships[org]
      if (!membership) return jsonResponse({ message: "Not Found" }, 404)
      return jsonResponse({ role: membership.role, state: membership.state ?? "active" })
    }
    return jsonResponse({ message: "unexpected url in test: " + url }, 404)
  }) as unknown as typeof fetch
}

describe("resolveUserRole", () => {
  it("personal-install-owner → admin (account.type=User, login matches session)", async () => {
    const fetchImpl = stubFetch([{ id: 1, account: { type: "User", login: "octocat" } }])
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("admin")
  })

  it("personal install owned by someone else → member (login does not match)", async () => {
    const fetchImpl = stubFetch([{ id: 1, account: { type: "User", login: "someone-else" } }])
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
  })

  it("org member → member", async () => {
    const fetchImpl = stubFetch([{ id: 2, account: { type: "Organization", login: "acme" } }], {
      acme: { role: "member" },
    })
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
  })

  it("org admin → admin", async () => {
    const fetchImpl = stubFetch([{ id: 2, account: { type: "Organization", login: "acme" } }], {
      acme: { role: "admin" },
    })
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("admin")
  })

  it("admin-of-one-org-among-many → admin", async () => {
    const fetchImpl = stubFetch(
      [
        { id: 2, account: { type: "Organization", login: "acme" } },
        { id: 3, account: { type: "Organization", login: "widgets-inc" } },
      ],
      { acme: { role: "member" }, "widgets-inc": { role: "admin" } },
    )
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("admin")
  })

  it("pending (unaccepted) admin invite → member, not admin", async () => {
    const fetchImpl = stubFetch([{ id: 2, account: { type: "Organization", login: "acme" } }], {
      acme: { role: "admin", state: "pending" },
    })
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
  })

  it("GitHub error on /user/installations → member fallback", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
  })

  it("GitHub 5xx on /user/installations → member fallback", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "server error" }, 500)) as unknown as typeof fetch
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
  })

  it("malformed JSON on /user/installations → member fallback", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
  })

  it("no installations → member", async () => {
    const fetchImpl = stubFetch([])
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
  })

  it("org membership lookup errors are soft-failed and do not block other installations", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/user/installations")) {
        return jsonResponse({
          total_count: 2,
          installations: [
            { id: 2, account: { type: "Organization", login: "flaky-org" } },
            { id: 3, account: { type: "Organization", login: "acme" } },
          ],
        })
      }
      if (url.includes("/user/memberships/orgs/flaky-org")) {
        throw new Error("boom")
      }
      if (url.includes("/user/memberships/orgs/acme")) {
        return jsonResponse({ role: "admin", state: "active" })
      }
      return jsonResponse({ message: "unexpected" }, 404)
    }) as unknown as typeof fetch
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("admin")
  })

  it("walks multiple pages of /user/installations before checking org membership", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/user/installations")) {
        const pageMatch = /[?&]page=(\d+)/.exec(url)
        const page = pageMatch ? Number(pageMatch[1]) : 1
        if (page === 1) {
          return jsonResponse({
            total_count: 2,
            installations: [{ id: 1, account: { type: "User", login: "someone-else" } }],
          })
        }
        return jsonResponse({
          total_count: 2,
          installations: [{ id: 2, account: { type: "Organization", login: "acme" } }],
        })
      }
      if (url.includes("/user/memberships/orgs/acme")) {
        return jsonResponse({ role: "admin", state: "active" })
      }
      return jsonResponse({ message: "unexpected" }, 404)
    }) as unknown as typeof fetch
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("admin")
  })

  it("never includes the access token in any logged output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const secretToken = "ghu_super_secret_dont_leak_me"
    const fetchImpl = stubFetch([{ id: 1, account: { type: "User", login: "octocat" } }])

    await resolveUserRole(secretToken, "octocat", fetchImpl)

    const allLoggedArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat()
    for (const arg of allLoggedArgs) {
      expect(String(arg)).not.toContain(secretToken)
    }
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
