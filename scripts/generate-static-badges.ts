// SIG-238 — pre-render the runtime-composed BADGE_SVGS to static files
// the GitHub repo can serve directly via raw.githubusercontent.com.
//
// Why: GitHub's `js-gh-image-fallback` client-side JS injects an
// inline `border-radius: 6px` + `background-color: var(--bgColor-muted)`
// style onto every `<img>` it considers a "user-supplied external
// image" — which is what we get when the badge `src` is our
// workers.dev domain (Camo-proxied). Greptile, by contrast, renders
// perfectly square badges on the same surface. The empirical
// difference is that Greptile-style badges served from a
// raw.githubusercontent.com URL are same-origin (no Camo) and the
// `js-gh-image-fallback` script doesn't fire on them.
//
// This script is the build-time half of the fix. The runtime
// `badgeAssetUrl()` will be flipped to emit
// `https://raw.githubusercontent.com/Sigilix/sigilix/main/assets/badges/v<version>/<name>.svg`,
// and the SVG files in `assets/badges/v<version>/` need to actually
// exist at the URL. Run this script once per version bump:
//
//   pnpm tsx scripts/generate-static-badges.ts
//
// then commit the resulting `assets/badges/v<version>/*.svg` files.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BADGE_ASSET_VERSION, getBadgeSvg, type ReviewBadgeAssetName } from "../src/lib/badge-assets"

// Exhaustive list — keep in sync with `BADGE_SVGS` keys in `badge-assets.ts`.
const ALL_BADGES: readonly ReviewBadgeAssetName[] = [
  "p0",
  "p1",
  "p2",
  "p3",
  "logic",
  "security",
  "performance",
  "error-handling",
  "testing",
  "complexity",
  "style",
  "syntax",
  "docs",
] as const

function repoRoot(): string {
  // ESM-compatible __dirname: this file lives at scripts/, repo root
  // is the parent.
  const here = dirname(fileURLToPath(import.meta.url))
  return dirname(here)
}

function main(): void {
  const root = repoRoot()
  const outDir = join(root, "assets", "badges", BADGE_ASSET_VERSION)
  mkdirSync(outDir, { recursive: true })

  let written = 0
  for (const name of ALL_BADGES) {
    const svg = getBadgeSvg(name)
    const outPath = join(outDir, `${name}.svg`)
    writeFileSync(outPath, svg, "utf8")
    written += 1
    console.log(`wrote ${outPath} (${svg.length} bytes)`)
  }
  console.log(`\nDone. ${written} badge SVGs written to ${outDir}`)
}

main()
