// SIG-224 — end-to-end smoke test for the dynamic-dispatcher monitor CLI.
// Spawns the npm script so package.json wiring, CLI arg parsing, JSONL
// loading, Logpush unwrap, and output rendering stay covered together.

import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sig-224-dispatch-monitor-"))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeJsonl(name: string, lines: unknown[]): string {
  const path = join(tmpDir, name)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
  return path
}

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("npm", ["run", "--silent", "dispatch-monitor", "--", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
  })
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

describe("dispatch-monitor CLI — end-to-end", () => {
  it("prints the markdown monitor from a JSONL file", () => {
    const path = writeJsonl("dispatch.ndjson", [
      {
        event: "dispatcher-savings-summary",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 10,
        headSha: "abc1234",
        mode: "enforce_rules",
        savingsType: "actual",
        baselineSpecialists: ["logic", "security", "performance", "tests"],
        dispatcherSpecialists: ["security"],
        actualSpecialists: ["security"],
        projectedSkippedRoles: ["logic", "performance", "tests"],
        actualNotInvokedRoles: ["logic", "performance", "tests"],
        projectedSpecialistCallsAvoided: 3,
        actualSpecialistCallsAvoided: 3,
        layerVotes: { llmOutcome: "skipped_rules_only_mode" },
      },
    ])

    const { code, stdout, stderr } = runCli(["--input", path])

    expect(code).toBe(0)
    expect(stderr).toContain("[dispatch-monitor] files=1 parsed=1 bad=0 skipped=0")
    expect(stdout).toContain("# Dispatch Monitor")
    expect(stdout).toContain("| Actual specialist calls avoided | 3 |")
    expect(stdout).toContain("| Sigilix/sigilix#10@abc1234 | enforce_rules | actual | 3 | 3 |")
  })

  it("prints JSON and unwraps Cloudflare Logpush envelopes from a directory", () => {
    const dir = mkdtempSync(join(tmpDir, "logpush-"))
    writeFileSync(
      join(dir, "events.log"),
      JSON.stringify({
        EventTimestampMs: 1_760_000_000_000,
        Logs: [
          {
            Message: [
              "label",
              JSON.stringify({
                event: "dispatcher-savings-summary",
                owner: "Sigilix",
                repo: "sigilix",
                prNumber: 11,
                headSha: "def5678",
                mode: "shadow",
                savingsType: "shadow",
                baselineSpecialists: ["logic", "security", "performance", "tests"],
                dispatcherSpecialists: ["logic", "security", "tests"],
                actualSpecialists: ["logic", "security", "performance", "tests"],
                projectedSkippedRoles: ["performance"],
                actualNotInvokedRoles: [],
                projectedSpecialistCallsAvoided: 1,
                actualSpecialistCallsAvoided: 0,
                layerVotes: { llmOutcome: "ok" },
              }),
            ],
          },
        ],
      }) + "\n",
    )
    writeFileSync(join(dir, "ignored.txt"), "not loaded\n")

    const { code, stdout } = runCli(["--input", dir, "--format", "json"])

    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as {
      files: number
      report: { dispatchReviews: number; byMode: Record<string, { reviews: number }> }
    }
    expect(parsed.files).toBe(1)
    expect(parsed.report.dispatchReviews).toBe(1)
    expect(parsed.report.byMode.shadow?.reviews).toBe(1)
  })
})
