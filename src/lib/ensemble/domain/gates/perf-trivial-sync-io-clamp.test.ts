// BT1 (pr/07): clamp a trivial version/help-probe sync-exec perf finding to P2.
// The only P0/P1 false positive on the pr/07 benchmark — the perf specialist
// rated a CONSTANT `execSync("… --version")` as Critical "blocking".

import { describe, it, expect } from "vitest"
import {
  clampIntentionalLiveEvalSerialLoopSeverity,
  clampTrivialSyncIoSeverity,
} from "@/src/lib/ensemble/domain/gates/validate-perf-finding"

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

  it("normalizes whitespace-padded paths before matching trivial sync-IO evidence", () => {
    const f = [{ path: "  src/report.ts  ", line: 9, category: "performance", score: 5 }]
    const alt = lines("src/report.ts", [[7, `  return execSync("/usr/bin/usage-report --version").toString().trim();`]])
    expect(clampTrivialSyncIoSeverity(f, alt)).toBe(1)
    expect(f[0].score).toBe(2)
  })

  it("falls back to a raw padded map key when the normalized key is unavailable", () => {
    const f = [{ path: "  src/report.ts  ", line: 9, category: "performance", score: 5 }]
    const alt = lines("  src/report.ts  ", [[7, `  return execSync("/usr/bin/usage-report --version").toString().trim();`]])
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

describe("clampIntentionalLiveEvalSerialLoopSeverity", () => {
  it("caps a sev>=4 serial live-eval harness finding to score 3", () => {
    const f = [{
      path: "tests/model-recall-eval.live.test.ts",
      line: 13,
      category: "performance",
      score: 4,
      headline: "Serial live-eval loop should parallelize `runCase`",
      body: "The benchmark awaits `runCase` for every case.",
    }]
    const alt = lines("tests/model-recall-eval.live.test.ts", [
      [9, "    const perCase = new Map<string, Result>()"],
      [10, "    for (let k = 0; k < repeats; k++) {"],
      [11, "      for (const c of cases) {"],
      [12, "        // Sequential by design: keep benchmark order stable and avoid provider bursts."],
      [13, "        const result = await runCase(c, apiKey)"],
      [14, "        perCase.set(c.id, result)"],
    ])

    expect(clampIntentionalLiveEvalSerialLoopSeverity(f, alt)).toBe(1)
    expect(f[0].score).toBe(3)
  })

  it("normalizes whitespace-padded finding paths before matching live-eval harness evidence", () => {
    const f = [{
      path: "  tests/model-recall-eval.live.test.ts  ",
      line: 13,
      category: "performance",
      score: 4,
      headline: "Serial live-eval loop should parallelize `runCase`",
      body: "The benchmark awaits `runCase` for every case.",
    }]
    const alt = lines("tests/model-recall-eval.live.test.ts", [
      [11, "      for (const c of cases) {"],
      [12, "        // Sequential by design: keep benchmark order stable and avoid provider bursts."],
      [13, "        const result = await runCase(c, apiKey)"],
      [14, "        perCase.set(c.id, result)"],
    ])

    expect(clampIntentionalLiveEvalSerialLoopSeverity(f, alt)).toBe(1)
    expect(f[0].score).toBe(3)
  })

  it("caps when the serial-eval intent is visible in the finding text instead of added lines", () => {
    const f = [{
      path: "tests/model-recall-eval.live.test.ts",
      line: 13,
      category: "performance",
      score: 4,
      headline: "Serial live-eval loop should parallelize `runCase`",
      body: "The loop is sequential by design for stable benchmark order and provider rate limits, but the finding still asks for Promise.all.",
    }]
    const alt = lines("tests/model-recall-eval.live.test.ts", [
      [10, "    for (let k = 0; k < repeats; k++) {"],
      [11, "      for (const c of cases) {"],
      [12, "        const result = await runCase(c, apiKey)"],
      [13, "        perCase.set(c.id, result)"],
      [14, "      }"],
    ])

    expect(clampIntentionalLiveEvalSerialLoopSeverity(f, alt)).toBe(1)
    expect(f[0].score).toBe(3)
  })

  it("does NOT cap production N+1 fanout even when a comment says sequential by design", () => {
    const f = [{
      path: "src/api/orders.ts",
      line: 5,
      category: "performance",
      score: 4,
      headline: "N+1 query waits sequentially in a loop",
      body: "The request handler awaits `getUser(id)` once per id.",
    }]
    const alt = lines("src/api/orders.ts", [
      [3, "  for (const id of ids) {"],
      [4, "    // sequential by design to keep response order stable"],
      [5, "    users.push(await getUser(id))"],
      [6, "  }"],
    ])

    expect(clampIntentionalLiveEvalSerialLoopSeverity(f, alt)).toBe(0)
    expect(f[0].score).toBe(4)
  })

  it("does NOT cap a live test serial await without explicit eval-rate-limit intent", () => {
    const f = [{
      path: "tests/model-recall-eval.live.test.ts",
      line: 13,
      category: "performance",
      score: 4,
      headline: "Serial live-eval loop should parallelize `runCase`",
      body: "The loop awaits `runCase` for each case.",
    }]
    const alt = lines("tests/model-recall-eval.live.test.ts", [
      [11, "      for (const c of cases) {"],
      [12, "        const result = await runCase(c, apiKey)"],
      [13, "        perCase.set(c.id, result)"],
      [14, "      }"],
    ])

    expect(clampIntentionalLiveEvalSerialLoopSeverity(f, alt)).toBe(0)
    expect(f[0].score).toBe(4)
  })

  it("does NOT cap a different real perf bug in a live-eval file with serial intent nearby", () => {
    const f = [{
      path: "tests/model-recall-eval.live.test.ts",
      line: 13,
      category: "performance",
      score: 4,
      headline: "`readFileSync` blocks every eval iteration",
      body: "`readFileSync` reloads fixtures inside the loop and should move out of the per-case path.",
    }]
    const alt = lines("tests/model-recall-eval.live.test.ts", [
      [10, "    for (let k = 0; k < repeats; k++) {"],
      [11, "      for (const c of cases) {"],
      [12, "        // Sequential by design: keep benchmark order stable and avoid provider bursts."],
      [13, "        const result = await runCase(c, apiKey)"],
      [14, "        const fixture = readFileSync(c.fixture, \"utf8\")"],
      [15, "        perCase.set(c.id, result)"],
    ])

    expect(clampIntentionalLiveEvalSerialLoopSeverity(f, alt)).toBe(0)
    expect(f[0].score).toBe(4)
  })
})
