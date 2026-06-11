// SIG-318 (PR 0b): golden-output parity test — the linchpin that proves ZERO
// behavior change across the ensemble decomposition.
//
// Loads every captured fixture in `tests/_golden/ensemble-fixtures/*.json`,
// decodes it, and re-runs the two pure ensemble seams against the captured
// inputs, asserting the CANONICAL-ENCODED output is byte-identical to what was
// captured (order-sensitive — catches Map/Set/key drift, not just deep-equal):
//   - encode(validateForSubmission(decode(fx.validate.args)))  === fx.validate.output
//   - encode(buildReviewSubmissionWithMetadata(decode(fx.render.input))) === fx.render.output
//
// With an EMPTY fixtures dir this loop is a green no-op (expected for PR 0b —
// the mechanism ships first; fixtures are lifted from prod logs in a separate
// founder-driven step). It gains teeth the moment a fixture lands: any drift in
// the decomposed validate/render path then fails the build.
//
// The captured `on*Dropped` callbacks decode to recording no-op stubs (they
// only emit telemetry, never affecting the returned value), so the replay is
// deterministic and side-effect-free.

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { decode, encode, type EnsembleGoldenFixture } from "@/src/lib/ensemble-golden-capture"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import { buildReviewSubmissionWithMetadata } from "@/src/lib/triage-pr-review"

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "_golden", "ensemble-fixtures")

function loadFixtures(): { file: string; fx: EnsembleGoldenFixture }[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"))
  return files.map((file) => ({
    file,
    fx: JSON.parse(readFileSync(resolve(FIXTURES_DIR, file), "utf8")) as EnsembleGoldenFixture,
  }))
}

// Typed wrappers — the fixtures hold structurally-encoded args; `decode`
// returns `unknown`, and the seams own the real shapes. The cast is confined
// here so the replay reads cleanly.
type ValidateArgs = Parameters<typeof validateForSubmission>[0]
type RenderArgs = Parameters<typeof buildReviewSubmissionWithMetadata>[0]

describe("ensemble golden-output parity (validate + render seams)", () => {
  const fixtures = loadFixtures()

  it("has a fixtures directory (empty is OK for PR 0b — the loop no-ops until fixtures land)", () => {
    // Sanity: the dir resolves and is readable. The real teeth are the
    // per-fixture cases below, which `it.each` skips when there are none.
    expect(Array.isArray(fixtures)).toBe(true)
  })

  it.each(fixtures)("validate seam replays byte-identical for $file", ({ fx }) => {
    const args = decode(fx.validate.args) as ValidateArgs
    const actual = validateForSubmission(args)
    // Byte-identical: compare the CANONICAL-ENCODED actual to the captured
    // encoded payload (order-sensitive — catches Map/Set/key drift), not
    // decoded deep-equality (CodeRabbit #408).
    expect(encode(actual)).toEqual(fx.validate.output)
  })

  it.each(fixtures)("render seam replays byte-identical for $file", ({ fx }) => {
    const input = decode(fx.render.input) as RenderArgs
    const actual = buildReviewSubmissionWithMetadata(input)
    expect(encode(actual)).toEqual(fx.render.output)
  })
})
