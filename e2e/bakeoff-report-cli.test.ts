// SIG-86 — end-to-end smoke test for the bake-off report CLI.
// Sigilix testing-specialist on PR review: the CLI glue (arg parsing,
// file collection, NDJSON loading, envelope unwrap, output rendering,
// exit code semantics) ships untested. This file pins the happy path
// + the window-validation + the fail-exit-code contracts by spawning
// the real CLI as a child process. Slow (~1s) but realistic — no
// internal mocks, exercises the whole pipeline.

import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

const CLI = ["scripts/bakeoff-report.ts"]
const NPX_TSX = "npx"

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sig-86-cli-"))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeNdjson(name: string, lines: unknown[]): string {
  const path = join(tmpDir, name)
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return path
}

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(NPX_TSX, ["tsx", ...CLI, ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    timeout: 30_000,
  })
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

describe("bakeoff-report CLI — end-to-end", () => {
  it("runs the full pipeline against an NDJSON fixture and emits JSON + Markdown to stdout (--print-only)", () => {
    const path = writeNdjson("happy.ndjson", [
      {
        event: "shadow-verdict-comparison",
        ts: "2026-05-15T10:00:00Z",
        role: "synth",
        prodModel: "kimi",
        shadowModel: "deepseek",
        prodVerdictOk: true,
        shadowVerdictOk: true,
        prodElapsedMs: 30_000,
        shadowElapsedMs: 25_000,
        prodFindingsCount: 2,
        shadowFindingsCount: 2,
        score4PlusOverlapCount: 1,
        score4PlusProdOnlyCount: 0,
        score4PlusShadowOnlyCount: 0,
        shadowFailureReason: null,
      },
      {
        event: "shadow-model-attempt-completed",
        ts: "2026-05-15T10:00:00Z",
        role: "synth",
        attemptKind: "primary",
        attemptIndex: 1,
        model: "deepseek",
        timeoutMs: 60_000,
        elapsedMs: 25_000,
        outcome: "ok",
      },
    ])

    const { code, stdout, stderr } = runCli([
      "--input",
      path,
      "--since",
      "2026-05-01T00:00:00Z",
      "--until",
      "2026-05-31T00:00:00Z",
      "--print-only",
    ])

    expect(code).toBe(0)
    expect(stderr).toMatch(/parsed 2 shadow events/)
    expect(stdout).toContain("# Shadow bake-off decision report")
    expect(stdout).toContain("Role: `synth`")
    expect(stdout).toContain("Sample size:** 1")
    // Single sample is below the floor → inconclusive verdicts on the
    // comparative bars, regression flags still PASS at 0 events.
    expect(stdout).toContain("✅ PASS")
    expect(stdout).toContain("⚠️ INCONCLUSIVE")
    // JSON canonical artifact is also dumped before the markdown.
    expect(stdout).toContain('"generatedAt"')
    expect(stdout).toContain('"role": "synth"')
  })

  it("unwraps Cloudflare Logpush envelopes (Message-as-array shape) end-to-end", () => {
    // Pin the CR Major fix: a multi-element Message array (label + JSON
    // payload) must be unwrapped, not dropped as malformed.
    const innerJson = JSON.stringify({
      event: "shadow-cut-short",
      ts: "2026-05-15T10:00:00Z",
      role: "synth",
      elapsedAtCutMs: 5000,
      reason: "grace_deadline",
    })
    const path = writeNdjson("logpush.ndjson", [
      {
        Outcome: "ok",
        ScriptName: "sigilix",
        EventTimestampMs: 1_715_770_800_000,
        Logs: [{ Level: "log", Message: ["[shadow-runner]", innerJson] }],
      },
    ])

    const { code, stderr } = runCli([
      "--input",
      path,
      "--since",
      "2026-05-01T00:00:00Z",
      "--until",
      "2026-05-31T00:00:00Z",
      "--print-only",
    ])

    // Cut-short event → role exists in the report, exit code is 1 (FAIL
    // on any cut-short — regression flag).
    expect(code).toBe(1)
    expect(stderr).toMatch(/parsed 1 shadow events/)
    expect(stderr).toMatch(/role overall verdict is FAIL/)
  })

  it("exits 2 on a missing required --input argument", () => {
    const { code, stderr } = runCli(["--since", "2026-05-01T00:00:00Z", "--until", "2026-05-31T00:00:00Z"])
    expect(code).toBe(2)
    expect(stderr).toMatch(/missing required --input/)
  })

  it("exits 2 on a malformed --until ISO date", () => {
    const path = writeNdjson("noop.ndjson", [])
    const { code, stderr } = runCli(["--input", path, "--until", "not-an-iso"])
    expect(code).toBe(2)
    expect(stderr).toMatch(/bad --until/)
  })

  it("exits 2 when --since is after --until (inverted window)", () => {
    const path = writeNdjson("noop2.ndjson", [])
    const { code, stderr } = runCli([
      "--input",
      path,
      "--since",
      "2026-12-31T00:00:00Z",
      "--until",
      "2026-01-01T00:00:00Z",
    ])
    expect(code).toBe(2)
    expect(stderr).toMatch(/is after --until/)
  })

  it("skips non-matching extensions, malformed lines, and non-shadow events (parsing-stats coverage)", () => {
    // Sigilix testing-specialist on PR review: the bot wanted unit
    // tests for `collectFiles` (non-matching extensions),
    // `loadEvents` (malformed lines + non-shadow events). All three
    // exercised here via fixture content + stderr-count assertions.
    const dir = mkdtempSync(join(tmpDir, "mixed-"))
    writeFileSync(
      join(dir, "events.ndjson"),
      [
        // 1. Valid shadow event (counted as parsed).
        JSON.stringify({
          event: "shadow-verdict-comparison",
          ts: "2026-05-15T10:00:00Z",
          role: "synth",
          prodModel: "kimi",
          shadowModel: "deepseek",
          prodVerdictOk: true,
          shadowVerdictOk: true,
          prodElapsedMs: 1,
          shadowElapsedMs: 1,
          prodFindingsCount: 0,
          shadowFindingsCount: 0,
          score4PlusOverlapCount: 0,
          score4PlusProdOnlyCount: 0,
          score4PlusShadowOnlyCount: 0,
          shadowFailureReason: null,
        }),
        // 2. Non-shadow event (counted as skippedNonShadowEvents).
        JSON.stringify({ event: "some-other-event", ts: "2026-05-15T10:00:00Z" }),
        // 3. Malformed line (counted as badLines).
        "{not valid json",
        // 4. Blank line (skipped silently, not counted).
        "",
        // 5. JSON object without `event` key (counted as skippedNonShadowEvents).
        JSON.stringify({ ts: "2026-05-15T10:00:00Z", role: "synth" }),
      ].join("\n") + "\n",
    )
    // Non-matching extension — collectFiles must NOT pick this up.
    writeFileSync(join(dir, "README.md"), "# notes about the dump\n")
    writeFileSync(join(dir, "random.txt"), "should not be loaded\n")

    const { code, stderr } = runCli([
      "--input",
      dir,
      "--since",
      "2026-05-01T00:00:00Z",
      "--until",
      "2026-05-31T00:00:00Z",
      "--print-only",
    ])

    expect(code).toBe(0)
    // Exact stats: 1 file (README.md + random.txt skipped by
    // extension filter), 4 non-empty lines, 1 parsed shadow event,
    // 1 non-shadow skipped (`some-other-event` has a string `event`
    // outside KNOWN_EVENTS), 2 bad lines (the malformed JSON + the
    // no-`event`-field object, which unwrap rejects as malformed).
    expect(stderr).toMatch(/parsed 1 shadow events/)
    expect(stderr).toMatch(/1 files/)
    expect(stderr).toMatch(/4 lines/)
    expect(stderr).toMatch(/1 non-shadow skipped/)
    expect(stderr).toMatch(/2 bad lines/)
  })

  it("loads all .ndjson files from an --input directory and groups by role", () => {
    const dir = mkdtempSync(join(tmpDir, "multi-"))
    writeFileSync(
      join(dir, "a.ndjson"),
      JSON.stringify({
        event: "shadow-verdict-comparison",
        ts: "2026-05-10T10:00:00Z",
        role: "synth",
        prodModel: "kimi",
        shadowModel: "deepseek",
        prodVerdictOk: true,
        shadowVerdictOk: true,
        prodElapsedMs: 1,
        shadowElapsedMs: 1,
        prodFindingsCount: 0,
        shadowFindingsCount: 0,
        score4PlusOverlapCount: 0,
        score4PlusProdOnlyCount: 0,
        score4PlusShadowOnlyCount: 0,
        shadowFailureReason: null,
      }) + "\n",
    )
    writeFileSync(
      join(dir, "b.ndjson"),
      JSON.stringify({
        event: "shadow-verdict-comparison",
        ts: "2026-05-11T10:00:00Z",
        role: "logic",
        prodModel: "kimi",
        shadowModel: "deepseek",
        prodVerdictOk: true,
        shadowVerdictOk: true,
        prodElapsedMs: 1,
        shadowElapsedMs: 1,
        prodFindingsCount: 0,
        shadowFindingsCount: 0,
        score4PlusOverlapCount: 0,
        score4PlusProdOnlyCount: 0,
        score4PlusShadowOnlyCount: 0,
        shadowFailureReason: null,
      }) + "\n",
    )

    const { code, stdout } = runCli([
      "--input",
      dir,
      "--since",
      "2026-05-01T00:00:00Z",
      "--until",
      "2026-05-31T00:00:00Z",
      "--print-only",
    ])

    expect(code).toBe(0)
    expect(stdout).toContain("Role: `logic`")
    expect(stdout).toContain("Role: `synth`")
  })
})
