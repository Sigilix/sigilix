import { describe, expect, it } from "vitest"
import {
  badgeAssetUrl,
  getBadgeSvg,
  handleBadgeAssetRoute,
  LEGACY_WORKER_BADGE_BASE_URL,
  lookupGlyph,
  PUBLIC_BADGE_BASE_URL,
  BADGE_ASSET_VERSION,
} from "../src/lib/badge-assets"
import { BADGE_GLYPH_PATHS } from "../src/lib/badge-glyph-paths"
import worker, { type Env } from "../src/index"

function ctx(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext
}

describe("badge assets (SIG-201)", () => {
  it("serves a 32x32 padded P2 priority chip with a 20x20 inset rect + translated glyph (SIG-238 r7)", async () => {
    const res = handleBadgeAssetRoute(
      new Request(`${LEGACY_WORKER_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/p2.svg`)
    )

    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-type")).toContain("image/svg+xml")
    expect(res?.headers.get("cache-control")).toContain("immutable")
    const body = await res!.text()
    expect(body).toContain('aria-label="P2"')
    // SIG-238 round-7 (Kimi K2.6 spec 2026-05-27): visible 20×20 rect lives
    // INSIDE a 32×32 padded viewBox so GitHub Primer's border-radius clips
    // the transparent margin instead of the colored corner. Round 4's
    // "drop the <a> wrap" was necessary but insufficient — Primer rounds
    // bare <img> too now. Geometry padding is the only stable fix because
    // inline `style` is sanitizer-stripped.
    expect(body).toContain('viewBox="0 0 32 32"')
    expect(body).toContain('width="32"')
    expect(body).toContain('height="32"')
    // Visible rect is INSET at (6, 6) and STILL 20×20 — glyph paths are
    // baked for that coord space + repositioned by the wrapping <g>.
    expect(body).toContain('x="6" y="6" width="20" height="20"')
    // Filled square: rect fill = accent hue, dark glyph on top. No stroke.
    expect(body).toContain('fill="#84CC16"')
    // rx=0 + crispEdges SCOPED TO THE RECT preserved from round 2.
    expect(body).toContain('rx="0" fill="#84CC16" shape-rendering="crispEdges"')
    expect(body).not.toContain('rx="0.5"')
    // Crisp-edge hint MUST NOT leak onto the glyph path — letter anti-
    // aliasing matters for legibility.
    expect(body).not.toMatch(/<path[^>]*shape-rendering="crispEdges"/)
    // Glyph wrapped in <g translate(6 6)> so its baked (0,0)-(20,20)
    // coords land inside the inset rect. Without the translate, the
    // glyph would render in the top-left transparent margin, off the
    // colored rect.
    expect(body).toContain('<g transform="translate(6 6)">')
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
      new Request(`${LEGACY_WORKER_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/security.svg`)
    )

    expect(res?.status).toBe(200)
    const body = await res!.text()
    expect(body).toContain('aria-label="SECURITY"')
    // SIG-238 round-7: visible pill is still 20px tall + categoryBadgeWidth
    // wide, but wrapped in a 12px-padded viewBox. Outer height = 32; the
    // INNER rect attributes pin the visible-pill geometry.
    expect(body).toContain('height="32"')
    expect(body).toContain('y="6"')
    expect(body).toContain('height="20"')
    // Category pill matches the priority badge geometry: rx=0 +
    // crisp-edge pixel snapping on the rect. See `renderBadgeSvg` test
    // above for the founder-direction rationale.
    expect(body).toContain('rx="0"')
    expect(body).toContain('shape-rendering="crispEdges"')
    expect(body).not.toContain('rx="0.5"')
    expect(body).not.toMatch(/<path[^>]*shape-rendering="crispEdges"/)
    expect(body).toContain('<g transform="translate(6 6)">')
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

  it("supports HEAD for external image probes without returning a body (worker self-serve path)", async () => {
    const res = handleBadgeAssetRoute(
      new Request(`${LEGACY_WORKER_BADGE_BASE_URL}/p1.svg`, { method: "HEAD" })
    )

    expect(res?.status).toBe(200)
    expect(await res!.text()).toBe("")
  })

  it("ignores non-badge paths so the main router can 404 them", () => {
    expect(handleBadgeAssetRoute(new Request(`${LEGACY_WORKER_BADGE_BASE_URL}/p4.svg`))).toBeNull()
    expect(handleBadgeAssetRoute(new Request(`${LEGACY_WORKER_BADGE_BASE_URL}/p2.png`))).toBeNull()
  })

  it("rejects prototype property names instead of serving inherited values", () => {
    expect(handleBadgeAssetRoute(new Request(`${LEGACY_WORKER_BADGE_BASE_URL}/constructor.svg`))).toBeNull()
  })

  it("builds Sigilix/sigilix-glyphs raw URLs at the current asset version (SIG-238 round-6 — the actual fix)", () => {
    // SIG-238 round-6: badge host is now `Sigilix/sigilix-glyphs`
    // (a separate PUBLIC repo for the glyph SVGs only). Tag-based
    // versioning: each BADGE_ASSET_VERSION bump = a new git tag in
    // sigilix-glyphs containing the corresponding SVGs. The URL
    // bypasses Camo (same-origin to github.com) AND loads anonymously
    // (public repo).
    expect(badgeAssetUrl("p2")).toBe(`${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/p2.svg`)
    expect(badgeAssetUrl("security")).toBe(`${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/security.svg`)
    expect(badgeAssetUrl("p2")).toContain("raw.githubusercontent.com/Sigilix/sigilix-glyphs")
    expect(badgeAssetUrl("p2")).not.toContain("sigilix.dan-martinezjulio.workers.dev")
    expect(badgeAssetUrl("p2")).not.toContain("Sigilix/sigilix/main")
  })

  // Sigilix bot P1 (PR #176): structural sanity for the path-baked
  // glyph table. Guards against (a) shipping a regeneration that
  // dropped a label, (b) corrupted `d` strings, and (c) adding a new
  // label without re-running `pnpm regenerate-badge-paths`.
  describe("BADGE_GLYPH_PATHS structural sanity (SIG-216 fix-up)", () => {
    const EXPECTED_LABELS = [
      "P0",
      "P1",
      "P2",
      "P3",
      "TESTING",
      "SECURITY",
      "LOGIC",
      "PERF",
      "ERROR",
      "COMPLEXITY",
      "STYLE",
      "SYNTAX",
      "DOCS",
    ] as const

    it("has an entry for every expected label", () => {
      for (const label of EXPECTED_LABELS) {
        expect(BADGE_GLYPH_PATHS[label]).toBeDefined()
      }
    })

    it("every entry's `d` is non-empty and starts with a valid SVG Move command", () => {
      for (const label of EXPECTED_LABELS) {
        const entry = BADGE_GLYPH_PATHS[label]!
        expect(entry.d.length).toBeGreaterThan(0)
        expect(entry.d).toMatch(/^M[0-9. -]+/)
      }
    })

    it("every entry's width and height are positive numbers", () => {
      for (const label of EXPECTED_LABELS) {
        const entry = BADGE_GLYPH_PATHS[label]!
        expect(entry.width).toBeGreaterThan(0)
        expect(entry.height).toBeGreaterThan(0)
      }
    })

    it("lookupGlyph('P0') returns the P0 entry", () => {
      expect(lookupGlyph("P0")).toBe(BADGE_GLYPH_PATHS["P0"])
    })

    it("lookupGlyph throws on an unknown label so a forgotten regeneration surfaces in tests", () => {
      expect(() => lookupGlyph("NONEXISTENT_LABEL")).toThrow(/no baked glyph/)
    })
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
      new Request(`${LEGACY_WORKER_BADGE_BASE_URL}/p2.svg`),
      env,
      ctx(),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('aria-label="P2"')
  })
})
