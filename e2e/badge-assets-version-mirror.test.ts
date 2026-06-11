// CodeRabbit P1 on PR #197 — version-bump guard.
//
// CR's full ask was an HTTP-GET check against
// `${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/<name>.svg` to
// confirm the glyphs repo has actually published the matching tag
// before we merge a bot-side version bump. This file implements the
// LOCAL half of that contract — every name in `ALL_BADGE_NAMES`
// must have a corresponding committed `.svg` file under the version
// directory. That catches the more-common failure mode (someone bumps
// `BADGE_ASSET_VERSION` without re-running `generate-static-badges`)
// without burning 13 network requests per CI run on the less-common
// failure mode (someone merges before the glyphs PR is tagged).
//
// The HTTP-side guard is deferred — the PR sequencing rule (glyphs
// PR merge + tag push BEFORE the bot PR merge) is the human-side
// equivalent and is documented in the PR body. A future SIG-238 r8
// follow-up could add the HTTP probe as a separate workflow step
// gated on `OPENCLAW_PROD_BADGE_PROBE=true` to opt-in to the network
// cost only on release-prep PRs.

import { readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ALL_BADGE_NAMES, BADGE_ASSET_VERSION, getBadgeSvg } from "@/src/lib/badge-assets"

const REPO_ROOT = (() => {
  // tests/ live at the repo root → __dirname here is `<root>/tests`.
  const here = dirname(fileURLToPath(import.meta.url))
  return dirname(here)
})()

const VERSION_DIR = join(REPO_ROOT, "assets", "badges", BADGE_ASSET_VERSION)

describe(`badge assets — local mirror parity for ${BADGE_ASSET_VERSION}`, () => {
  it.each(ALL_BADGE_NAMES)("%s.svg exists at assets/badges/<version>/", (name) => {
    const path = join(VERSION_DIR, `${name}.svg`)
    const stat = statSync(path)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBeGreaterThan(0)
  })

  it.each(ALL_BADGE_NAMES)("%s.svg on disk matches runtime getBadgeSvg() byte-for-byte", (name) => {
    // Stronger contract than just "file exists" — the committed file
    // MUST be the exact output of `generate-static-badges` at the
    // current `BADGE_ASSET_VERSION`. If someone bumps the version
    // and re-runs the generator but commits stale bytes (e.g. a
    // partial commit), this catches the drift before the version
    // ships pointing at a tag that has the wrong shape.
    const path = join(VERSION_DIR, `${name}.svg`)
    const onDisk = readFileSync(path, "utf8")
    expect(onDisk).toBe(getBadgeSvg(name))
  })
})
