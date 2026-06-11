// ARC-190 Task 8 — smoke test: every KV-routed sibling emits at least
// one telemetry event tagged `dedupe_system: "kv"` so dashboards can
// split DO-routed work from KV-routed work after rollout.
//
// This is a structural test against source — full per-handler
// integration tests would require auth + GitHub client + env shaping
// for each branch and are out of scope for the tag rollout. The
// emission semantics are otherwise covered by the existing handler
// tests.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(__dirname, "..")

interface SiblingProbe {
  name: string
  file: string
  /** Event name emitted at the dedupe-skip site. Asserts the tag is
   * adjacent to (i.e., in the same JSON.stringify block as) this event
   * — close enough that an accidental removal/typo would fail. */
  event: string
}

const SIBLINGS: SiblingProbe[] = [
  { name: "pr-overview", file: "src/lib/triage-pr-overview.ts", event: "pr-overview-skipped" },
  { name: "pr-improve", file: "src/lib/triage-pr-improve.ts", event: "pr-improve-skipped" },
  { name: "pr-describe", file: "src/lib/triage-pr-describe.ts", event: "pr-describe-skipped" },
  {
    name: "pr-stale-mark",
    file: "src/lib/triage-pr-stale-mark.ts",
    event: "review-stale-superseded",
  },
  { name: "ci-triage", file: "src/lib/triage-ci.ts", event: "ci-triage-skipped" },
  { name: "github-mention", file: "src/lib/github-mention.ts", event: "github-mention-skipped" },
]

/**
 * Find every JSON.stringify({...}) call in `src` whose body contains
 * `event: "<name>"`. Returns the body slice for each match (used to
 * verify the tag lives inside the same block).
 */
function findStringifyBlocksWithEvent(src: string, eventName: string): string[] {
  const out: string[] = []
  const re = /JSON\.stringify\(\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    // Walk the brace pair from the first `{` after JSON.stringify(.
    let depth = 1
    let i = m.index + m[0].length
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === "{") depth++
      else if (ch === "}") depth--
      i++
    }
    const body = src.slice(m.index + m[0].length, i - 1)
    if (body.includes(`event: "${eventName}"`)) out.push(body)
  }
  return out
}

describe('ARC-190 — KV-routed siblings carry dedupe_system: "kv" telemetry tag', () => {
  for (const probe of SIBLINGS) {
    it(`${probe.name}: ${probe.event} emission carries dedupe_system: "kv"`, () => {
      const src = readFileSync(resolve(ROOT, probe.file), "utf-8")
      const blocks = findStringifyBlocksWithEvent(src, probe.event)
      expect(
        blocks.length,
        `${probe.name}: no JSON.stringify block emitting "${probe.event}" in ${probe.file}`,
      ).toBeGreaterThan(0)
      // At least one block emitting this event must carry the tag.
      const tagged = blocks.filter((b) => /dedupe_system:\s*"kv"/.test(b))
      expect(tagged.length, `${probe.name}: ${probe.event} block is missing dedupe_system: "kv"`).toBeGreaterThan(0)
    })
  }
})
