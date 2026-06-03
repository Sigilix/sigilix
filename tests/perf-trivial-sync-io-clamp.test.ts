// BT1 (pr/07): clamp a trivial version/help-probe sync-exec perf finding to P2.
// The only P0/P1 false positive on the pr/07 benchmark — the perf specialist
// rated a CONSTANT `execSync("… --version")` as Critical "blocking".

import { describe, it, expect } from "vitest"
import { clampTrivialSyncIoSeverity } from "../src/lib/validate-perf-finding"

const lines = (path: string, entries: [number, string][]) =>
  new Map([[path, new Map(entries)]])

describe("clampTrivialSyncIoSeverity", () => {
  it("caps a Critical perf finding citing a constant --version execSync to P2 (BT1)", () => {
    const f = [{ path: "src/report.ts", line: 9, category: "performance", score: 5 }]
    // the execSync is at line 7, the finding anchors at 9 — within the ±2 window
    const alt = lines("src/report.ts", [[7, `  return execSync("/usr/bin/usage-report --version").toString().trim();`]])
    expect(clampTrivialSyncIoSeverity(f, alt)).toBe(1)
    expect(f[0].score).toBe(2)
  })

  it("does NOT cap an INTERPOLATED exec (the real command injection — B1)", () => {
    const f = [{ path: "src/report.ts", line: 17, category: "performance", score: 5 }]
    const alt = lines("src/report.ts", [[17, "  const out = execSync(`/usr/bin/usage-report --account ${accountId} --format ${fmt}`);"]])
    expect(clampTrivialSyncIoSeverity(f, alt)).toBe(0)
    expect(f[0].score).toBe(5)
  })

  it("does NOT cap a real readFileSync blocking finding (no probe flag — B7)", () => {
    const f = [{ path: "src/report.ts", line: 13, category: "performance", score: 5 }]
    const alt = lines("src/report.ts", [[13, `  const tpl = readFileSync(path.join(__dirname, "templates", name), "utf8");`]])
    expect(clampTrivialSyncIoSeverity(f, alt)).toBe(0)
    expect(f[0].score).toBe(5)
  })

  it("does NOT cap a heavy CONSTANT command that is not a version/help probe", () => {
    const f = [{ path: "a.ts", line: 1, category: "performance", score: 5 }]
    const alt = lines("a.ts", [[1, `execSync("convert input.png output.jpg");`]])
    expect(clampTrivialSyncIoSeverity(f, alt)).toBe(0)
    expect(f[0].score).toBe(5)
  })

  it("only clamps sev>=4 (P0/P1); leaves score-3 (P2) and lower untouched (CodeRabbit #298)", () => {
    const probe = (score: number, category = "performance") => ({ path: "a.ts", line: 1, category, score })
    const f = [
      probe(5), // P0 → clamp
      probe(4), // P1 → clamp
      probe(3), // P2 → NOT clamped (already below the P0/P1 bar)
      probe(2), // P3 → NOT clamped
      probe(5, "security"), // wrong category → NOT clamped
    ]
    const alt = lines("a.ts", [[1, `execSync("tool --version")`]])
    expect(clampTrivialSyncIoSeverity(f, alt)).toBe(2) // only the two sev>=4
    expect(f.map((x) => x.score)).toEqual([2, 2, 3, 2, 5])
  })

  it("no-ops without the line map", () => {
    const f = [{ path: "a.ts", line: 1, category: "performance", score: 5 }]
    expect(clampTrivialSyncIoSeverity(f, undefined)).toBe(0)
    expect(f[0].score).toBe(5)
  })
})
