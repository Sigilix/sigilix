import { describe, expect, it } from "vitest"
import {
  badgeAssetUrl,
  getBadgeSvg,
  handleBadgeAssetRoute,
  LEGACY_WORKER_BADGE_BASE_URL,
  lookupGlyph,
  PUBLIC_BADGE_BASE_URL,
  BADGE_ASSET_VERSION,
  runnerEvidenceBadgeImg,
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
  it("serves a 20x20 P2 priority chip with hairline gutter + rx=1 (SIG-238 r9)", async () => {
    const res = handleBadgeAssetRoute(
      new Request(`${LEGACY_WORKER_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/p2.svg`)
    )

    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-type")).toContain("image/svg+xml")
    expect(res?.headers.get("cache-control")).toContain("immutable")
    const body = await res!.text()
    expect(body).toContain('aria-label="P2"')
    // SIG-238 r9: viewBox = native priority dims. The rect is shrunk
    // by a sub-pixel gutter (0.488px) and given rx=1 so the SVG owns
    // subtle corner rounding; combined with `<a href="#">` wrap + no
    // IMG width/height in the bot HTML, this defeats Primer's bubble
    // rule.
    expect(body).toContain('viewBox="0 0 20 20"')
    expect(body).toContain('width="20"')
    expect(body).toContain('height="20"')
    // Outer <svg fill="none"> matches Greptile — no implicit white bg.
    expect(body).toMatch(/<svg[^>]*\sfill="none"/)
    // Rect is 19.512x19.512 (hairline gutter), at default x=0 y=0,
    // with rx=1 + accent color fill. No shape-rendering attribute.
    expect(body).toContain('width="19.512"')
    expect(body).toContain('height="19.512"')
    expect(body).toContain('rx="1"')
    expect(body).toContain('fill="#84CC16"')
    // No <g translate> wrap any more (r7 era artifact).
    expect(body).not.toContain('<g transform="translate')
    // No crispEdges anywhere — the rx=1 owns the corner curve.
    expect(body).not.toContain('shape-rendering="crispEdges"')
    expect(body).not.toContain('rx="0.5"')
    // Path-baked glyph (Geist Mono Medium @ 9.5px) still ships unchanged.
    expect(body).toContain('fill="#0A0A0A"')
    expect(body).toContain('<path d="')
    expect(body).not.toContain("<text")
    expect(body).not.toContain('font-family')
    expect(body).not.toContain('font-size')
    expect(body).not.toContain('font-weight')
    expect(body).not.toContain('letter-spacing')
    expect(body).not.toContain('text-anchor')
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
    // SIG-238 r9: category pill drops the r7 padded viewBox; native
    // dims, hairline gutter, rx=1 owns the corner curve. Outer
    // height = CATEGORY_BADGE_HEIGHT = 20.
    expect(body).toContain('height="20"')
    expect(body).toMatch(/<svg[^>]*\sfill="none"/)
    expect(body).toContain('rx="1"')
    expect(body).not.toContain('rx="0.5"')
    expect(body).not.toContain('rx="0"')
    expect(body).not.toContain('shape-rendering="crispEdges"')
    expect(body).not.toContain('<g transform="translate')
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

  // SIG-184: runner-evidence trust pills (Kimi K2.6 spec, 2026-05-30). Text
  // pills in the PRIORITY treatment (solid bright fill + near-black glyph) at
  // category width.
  describe("SIG-184 runner-evidence trust pills", () => {
    it("renders the VERIFIED pill: cyan #06B6D4 fill, near-black glyph, rx=1, descriptive aria-label", () => {
      const svg = getBadgeSvg("runner-verified")
      expect(svg).toContain('fill="#06B6D4"')
      expect(svg).toContain('fill="#0A0A0A"') // priority treatment: dark glyph on bright fill
      expect(svg).toContain('rx="1"')
      expect(svg).toContain('aria-label="Runner verified: GitHub-signed receipt attests provenance"')
      // 8-char "VERIFIED" → categoryBadgeWidth = ceil(8*6.5+16) = 68; 20 tall.
      expect(svg).toContain('viewBox="0 0 68 20"')
    })

    it("renders the PENDING pill: amber-600 #D97706 fill — intentionally NOT P1's #F59E0B", () => {
      const svg = getBadgeSvg("runner-pending")
      expect(svg).toContain('fill="#D97706"')
      expect(svg).not.toContain("#F59E0B") // must not collide with the P1 severity badge
      expect(svg).toContain('aria-label="Runner evidence pending: receipt expected"')
    })

    it("builds raw.githubusercontent glyph URLs for the runner pills at the current version", () => {
      expect(badgeAssetUrl("runner-verified")).toBe(`${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/runner-verified.svg`)
      expect(badgeAssetUrl("runner-pending")).toBe(`${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/runner-pending.svg`)
    })

    it("runnerEvidenceBadgeImg maps the discriminant to a bare <img> with the descriptive alt", () => {
      const verified = runnerEvidenceBadgeImg("verified")
      expect(verified).toBe(
        `<img src="${badgeAssetUrl("runner-verified")}" alt="Runner verified: GitHub-signed receipt attests provenance">`,
      )
      const pending = runnerEvidenceBadgeImg("evidence-pending")
      expect(pending).toBe(
        `<img src="${badgeAssetUrl("runner-pending")}" alt="Runner evidence pending: receipt expected">`,
      )
      // Bare <img> per Kimi's spec for the check-run surface — no <a> wrap.
      expect(verified).not.toContain("<a ")
    })
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
      "VERIFIED", // SIG-184 runner-evidence pills
      "PENDING",
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
