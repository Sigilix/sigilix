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
  it("serves a 20x20 filled-square P2 priority chip with a path-baked glyph (SIG-216)", async () => {
    const res = handleBadgeAssetRoute(
      new Request(badgeAssetUrl("p2"))
    )

    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-type")).toContain("image/svg+xml")
    expect(res?.headers.get("cache-control")).toContain("immutable")
    const body = await res!.text()
    expect(body).toContain('aria-label="P2"')
    expect(body).toContain('viewBox="0 0 20 20"')
    // Filled square: rect fill = accent hue, dark glyph on top. No stroke.
    expect(body).toContain('fill="#84CC16"')
    expect(body).toContain('rx="1"')
    // Path-baked glyph (Geist Mono Medium @ 9.5px) replaces the live <text>
    // element. Color is the SIG-216 spec value #0A0A0A.
    expect(body).toContain('fill="#0A0A0A"')
    expect(body).toContain('<path d="')
    expect(body).not.toContain("<text")
    expect(body).not.toContain('font-family')
    expect(body).not.toContain('font-size')
    expect(body).not.toContain('font-weight')
    expect(body).not.toContain('letter-spacing')
    expect(body).not.toContain('text-anchor')
    expect(body).not.toContain('fill="none"')
    expect(body).not.toContain('stroke=')
    expect(body).not.toContain('stroke-opacity')
    expect(body).not.toContain("<image")
    expect(body).toBe(getBadgeSvg("p2"))
  })

  it("serves low-saturation filled category chips for specialist labels (Kimi R2 + SIG-216 path-bake)", async () => {
    const res = handleBadgeAssetRoute(
      new Request(badgeAssetUrl("security"))
    )

    expect(res?.status).toBe(200)
    const body = await res!.text()
    expect(body).toContain('aria-label="SECURITY"')
    // 20px-tall pill matches the priority badge height for visual unity.
    expect(body).toContain('height="20"')
    expect(body).toContain('rx="2"')
    // Hue identity preserved (magenta family) but desaturated/darkened for BG
    // and brightened for FG. Original accent #F0ABFC no longer appears verbatim.
    expect(body).not.toContain('#F0ABFC')
    expect(body).toContain('fill="#322833"') // BG @ S=12% L=18%, hue 295
    expect(body).toContain('fill="#EAC0F2"') // FG @ S=65% L=85%, hue 295
    // SIG-216 path-bake: no <text>, no font attrs — just a <path>.
    expect(body).toContain('<path d="')
    expect(body).not.toContain("<text")
    expect(body).not.toContain('font-family')
    expect(body).not.toContain('font-size')
    expect(body).not.toContain('font-weight')
    expect(body).not.toContain('letter-spacing')
    expect(body).toBe(getBadgeSvg("security"))
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

  it("rejects prototype property names instead of serving inherited values", () => {
    expect(handleBadgeAssetRoute(new Request(`${PUBLIC_BADGE_BASE_URL}/constructor.svg`))).toBeNull()
  })

  it("builds unauthenticated HTTPS image URLs", () => {
    expect(badgeAssetUrl("p2")).toBe(`${PUBLIC_BADGE_BASE_URL}/v20260526-1/p2.svg`)
    expect(badgeAssetUrl("security")).toBe(`${PUBLIC_BADGE_BASE_URL}/v20260526-1/security.svg`)
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
