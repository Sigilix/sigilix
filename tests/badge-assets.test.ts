import { describe, expect, it } from "vitest"
import {
  badgeAssetUrl,
  getBadgeSvg,
  handleBadgeAssetRoute,
  PUBLIC_BADGE_BASE_URL,
} from "../src/lib/badge-assets"
import worker, { type Env } from "../src/index"

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

describe("badge assets (SIG-201)", () => {
  it("serves a compact color-coded P2 priority chip from a public Worker route", async () => {
    const res = handleBadgeAssetRoute(
      new Request(badgeAssetUrl("p2"))
    )

    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-type")).toContain("image/svg+xml")
    expect(res?.headers.get("cache-control")).toContain("immutable")
    const body = await res!.text()
    expect(body).toContain('aria-label="P2"')
    expect(body).toContain('viewBox="0 0 34 24"')
    expect(body).toContain('fill="#84CC16"')
    expect(body).toContain('fill="#0B0C10"')
    expect(body).toContain('text-anchor="middle"')
    expect(body).not.toContain("<image")
    expect(body).toContain("<text")
    expect(body).toBe(getBadgeSvg("p2"))
  })

  it("supports HEAD for external image probes without returning a body", async () => {
    const res = handleBadgeAssetRoute(
      new Request(`${PUBLIC_BADGE_BASE_URL}/p1.svg`, { method: "HEAD" })
    )

    expect(res?.status).toBe(200)
    expect(await res!.text()).toBe("")
  })

  it("ignores non-badge paths so the main router can 404 them", () => {
    expect(handleBadgeAssetRoute(new Request(`${PUBLIC_BADGE_BASE_URL}/p4.svg`))).toBeNull()
    expect(handleBadgeAssetRoute(new Request(`${PUBLIC_BADGE_BASE_URL}/p2.png`))).toBeNull()
  })

  it("builds unauthenticated HTTPS image URLs", () => {
    expect(badgeAssetUrl("p2")).toBe(`${PUBLIC_BADGE_BASE_URL}/v20260524-6/p2.svg`)
    expect(badgeAssetUrl("p2")).not.toContain("raw.githubusercontent.com")
  })

  it("routes badge assets before env validation so broken config cannot break GitHub images", async () => {
    const env = {
      OPENCLAW_VALIDATE_GITHUB_INSTALLATIONS: "strict",
      OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({
        SIG: { owner: "Arc-and-Anchor", repo: "sigilix" },
      }),
      OPENCLAW_GITHUB_INSTALLATION_MAP: "{}",
    } as Partial<Env> as Env

    const res = await worker.fetch(
      new Request(`${PUBLIC_BADGE_BASE_URL}/p2.svg`),
      env,
      ctx(),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('aria-label="P2"')
  })
})
