// SIG-360 (PR 8, commit 1): behavior-pinning golden matrix for
// `validateForSubmission` — the recall-safety-critical believability core —
// captured BEFORE it is relocated in commit 2, replayed for byte-identical
// parity after.
//
// Pattern (vitest-native, no extra tooling — mirrors
// tests/ensemble-golden-parity.test.ts): for each case in the deterministic
// matrix (tests/_golden/validation-matrix-cases.ts), wrap every `on*Dropped`
// callback with a recorder, run `validateForSubmission`, then:
//   - GOLDEN_UPDATE=1 + fixture missing → write the fixture (one-time capture),
//   - else → assert encode(result) AND the recorded telemetry are byte-
//     identical to the committed fixture.
// A MISSING fixture FAILS the test (CI never regenerates) so a relocation that
// silently changes behavior on a not-yet-captured case can't slip through.
//
// `encode` (the structural serde from ensemble-golden-capture) preserves
// Map/Set/undefined and encodes the runtime function fields as stubs, so the
// comparison catches Map/Set/key drift — not just deep-equal.

import { describe, it, expect } from "vitest"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { encode } from "@/src/lib/ensemble-golden-capture"
import { validateForSubmission } from "@/src/lib/triage-pr-review-ensemble"
import { MATRIX_CASES, type CallbackArg, type ValidateArgs } from "./_golden/validation-matrix-cases"

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "_golden", "validation-matrix")
const GOLDEN_UPDATE = process.env.GOLDEN_UPDATE === "1"

/** One recorded telemetry event: which callback fired, the finding it named, and the payload. */
interface RecordedEvent {
  callback: CallbackArg
  finding: { path: string; line: number; headline: string }
  payload: unknown
}

interface MatrixFixture {
  output: unknown
  telemetry: RecordedEvent[]
}

/** Build the args with every declared callback wrapped to push an ordered record. */
function withRecorders(
  args: ValidateArgs,
  callbacks: CallbackArg[],
  sink: RecordedEvent[],
): Parameters<typeof validateForSubmission>[0] {
  const wired: Record<string, unknown> = { ...args }
  for (const name of callbacks) {
    wired[name] = (finding: { path: string; line: number; headline: string }, payload: unknown): void => {
      sink.push({
        callback: name,
        finding: { path: finding.path, line: finding.line, headline: finding.headline },
        payload,
      })
    }
  }
  return wired as Parameters<typeof validateForSubmission>[0]
}

function fixturePath(id: string): string {
  return resolve(FIXTURES_DIR, `${id}.json`)
}

describe("validateForSubmission golden matrix (behavior-pinning for SIG-360 relocation)", () => {
  it.each(MATRIX_CASES.map((c) => ({ id: c.id, gate: c.gate, c })))(
    "[$gate] $id — byte-identical output + telemetry vs the committed fixture",
    ({ c }) => {
      const telemetry: RecordedEvent[] = []
      const args = withRecorders(c.buildArgs(), c.callbacks, telemetry)
      const result = validateForSubmission(args)
      const encoded = encode(result)
      const path = fixturePath(c.id)

      if (GOLDEN_UPDATE && !existsSync(path)) {
        mkdirSync(FIXTURES_DIR, { recursive: true })
        const fixture: MatrixFixture = { output: encoded, telemetry }
        writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf8")
        return
      }

      // A missing fixture is a hard failure under CI (no env var) — CI must
      // never regenerate, only assert. This catches a relocated case that was
      // never captured.
      expect(existsSync(path), `missing golden fixture for "${c.id}" — run GOLDEN_UPDATE=1 to capture`).toBe(true)
      const fixture = JSON.parse(readFileSync(path, "utf8")) as MatrixFixture
      expect(encoded).toEqual(fixture.output)
      expect(telemetry).toEqual(fixture.telemetry)
    },
  )

  it("the case ids are unique (no fixture would silently shadow another)", () => {
    const ids = MATRIX_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
