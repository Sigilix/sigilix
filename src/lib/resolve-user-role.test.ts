// resolve-user-role.ts — unit tests. The helper takes an injected fetch impl
// so these run without touching global fetch or any request/session
// machinery (see auth-me-route.test.ts for the full /auth/me integration).

import { describe, expect, it, vi } from "vitest"
import { resolveUserRole, isAdminOfInstallation } from "@/src/lib/resolve-user-role"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface Installation {
  id: number
  account: { type: "User" | "Organization"; login: string }
}

/** An org's self-membership fixture: role + GitHub's invite-acceptance state (defaults to "active"). */
interface OrgMembershipFixture {
  role: string
  state?: string
}

/** Builds a fetch stub: GET /user/installations returns `installations`; GET
 * /user/memberships/orgs (the self-memberships LIST) returns an item per
 * entry in `orgMemberships`. */
function stubFetch(
  installations: Installation[],
  orgMemberships: Record<string, OrgMembershipFixture> = {},
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/user/installations")) {
      return jsonResponse({ total_count: installations.length, installations })
    }
    if (url.includes("/user/memberships/orgs")) {
      const items = Object.entries(orgMemberships).map(([login, m]) => ({
        role: m.role,
        state: m.state ?? "active",
        organization: { login },
      }))
      return jsonResponse(items)
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

  it("admin of an org WITHOUT a connected install → member (only connected org installs count)", async () => {
    // The user is an admin of "other-org", but Sigilix is only installed on
    // "acme" (where they're a member). Their org-admin status elsewhere must
    // not gate the portal.
    const fetchImpl = stubFetch([{ id: 2, account: { type: "Organization", login: "acme" } }], {
      acme: { role: "member" },
      "other-org": { role: "admin" },
    })
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
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

  it("memberships list errors → member (org-admin path soft-fails)", async () => {
    // /user/installations succeeds (org install), but the memberships list
    // throws — the org-admin lookup soft-fails to no admin orgs → member.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/user/installations")) {
        return jsonResponse({
          total_count: 1,
          installations: [{ id: 2, account: { type: "Organization", login: "acme" } }],
        })
      }
      if (url.includes("/user/memberships/orgs")) {
        throw new Error("boom")
      }
      return jsonResponse({ message: "unexpected" }, 404)
    }) as unknown as typeof fetch
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("member")
  })

  it("personal-install ownership still grants admin even if the memberships list fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/user/installations")) {
        return jsonResponse({
          total_count: 1,
          installations: [{ id: 1, account: { type: "User", login: "octocat" } }],
        })
      }
      if (url.includes("/user/memberships/orgs")) {
        throw new Error("boom")
      }
      return jsonResponse({ message: "unexpected" }, 404)
    }) as unknown as typeof fetch
    const role = await resolveUserRole("token", "octocat", fetchImpl)
    expect(role).toBe("admin")
  })

  it("walks multiple pages of the memberships list", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/user/installations")) {
        return jsonResponse({
          total_count: 1,
          installations: [{ id: 3, account: { type: "Organization", login: "acme" } }],
        })
      }
      if (url.includes("/user/memberships/orgs")) {
        const pageMatch = /[?&]page=(\d+)/.exec(url)
        const page = pageMatch ? Number(pageMatch[1]) : 1
        if (page === 1) {
          // A full page of 100 non-matching memberships forces a second page fetch.
          const filler = Array.from({ length: 100 }, (_, i) => ({
            role: "member",
            state: "active",
            organization: { login: `filler-${i}` },
          }))
          return jsonResponse(filler)
        }
        return jsonResponse([{ role: "admin", state: "active", organization: { login: "acme" } }])
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

describe("isAdminOfInstallation (SIG-303 — scoped to ONE installation)", () => {
  it("admin of the queried org install → true", async () => {
    const fetchImpl = stubFetch([{ id: 5, account: { type: "Organization", login: "acme" } }], {
      acme: { role: "admin" },
    })
    expect(await isAdminOfInstallation("token", "octocat", 5, fetchImpl)).toBe(true)
  })

  it("P1: owns a PERSONAL install but is only a MEMBER of the queried org → false", async () => {
    // The exact leak the aggregate resolveUserRole would allow: personal-install
    // owner (aggregate "admin") who is a mere member of org B must be DENIED B.
    const fetchImpl = stubFetch(
      [
        { id: 2, account: { type: "User", login: "octocat" } },
        { id: 5, account: { type: "Organization", login: "org-b" } },
      ],
      { "org-b": { role: "member" } },
    )
    expect(await resolveUserRole("token", "octocat", fetchImpl)).toBe("admin") // aggregate says admin…
    expect(await isAdminOfInstallation("token", "octocat", 5, fetchImpl)).toBe(false) // …but not of org B
  })

  it("owns the queried personal install → true; someone else's personal install → false", async () => {
    const own = stubFetch([{ id: 2, account: { type: "User", login: "octocat" } }])
    expect(await isAdminOfInstallation("token", "octocat", 2, own)).toBe(true)
    const other = stubFetch([{ id: 2, account: { type: "User", login: "someone-else" } }])
    expect(await isAdminOfInstallation("token", "octocat", 2, other)).toBe(false)
  })

  it("installation the token can't see → false", async () => {
    const fetchImpl = stubFetch([{ id: 5, account: { type: "Organization", login: "acme" } }], {
      acme: { role: "admin" },
    })
    expect(await isAdminOfInstallation("token", "octocat", 999, fetchImpl)).toBe(false)
  })

  it("pending (non-active) admin invite does not grant admin", async () => {
    const fetchImpl = stubFetch([{ id: 5, account: { type: "Organization", login: "acme" } }], {
      acme: { role: "admin", state: "pending" },
    })
    expect(await isAdminOfInstallation("token", "octocat", 5, fetchImpl)).toBe(false)
  })

  it("fails closed to false on a GitHub error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "boom" }, 500)) as unknown as typeof fetch
    expect(await isAdminOfInstallation("token", "octocat", 5, fetchImpl)).toBe(false)
  })
})
