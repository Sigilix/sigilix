// SIG-304 (review CLI) Phase 1b — the animated launch splash.

import { describe, it, expect } from "vitest"
import { renderSplashFrame, runWithSplash, TOTAL } from "./splash"
import { stripAnsi } from "./ansi"

describe("renderSplashFrame", () => {
  it("frame 0: wordmark blocks + 'reviewing' status + a progress bar, with ANSI", () => {
    const out = renderSplashFrame(0)
    expect(out.includes("\x1b[")).toBe(true) // truecolor ANSI present
    expect(out).toContain("█") // red wordmark blocks
    const plain = stripAnsi(out)
    expect(plain).toContain("reviewing your changes")
    expect(plain).toMatch(/\d+%/)
  })

  it("final frame: landed state (✓ + review complete + 100%)", () => {
    const plain = stripAnsi(renderSplashFrame(TOTAL - 1))
    expect(plain).toContain("review complete")
    expect(plain).toContain("landed")
    expect(plain).toContain("✓")
    expect(plain).toContain("100%")
  })

  it("is pure / deterministic for a given frame", () => {
    expect(renderSplashFrame(7)).toBe(renderSplashFrame(7))
  })
})

describe("runWithSplash", () => {
  const fakeOut = (sink: string[]): NodeJS.WriteStream =>
    ({
      write: (s: string) => {
        sink.push(s)
        return true
      },
    }) as unknown as NodeJS.WriteStream

  it("animates while work runs, restores the cursor, and returns the result", async () => {
    const writes: string[] = []
    const result = await runWithSplash(Promise.resolve("done"), {
      out: fakeOut(writes),
      frameMs: 0,
      sleep: async () => {},
    })
    expect(result).toBe("done")
    const all = writes.join("")
    expect(all).toContain("\x1b[?25l") // hid cursor
    expect(all).toContain("\x1b[?25h") // restored cursor
    expect(writes.length).toBeGreaterThan(1)
  })

  it("rejects + restores the cursor when work fails MID-animation (no orphaned rejection)", async () => {
    const writes: string[] = []
    let n = 0
    // rejects on a real macrotask, so the loop is mid-flight (≥1 frame) when it settles
    const deferred = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("midboom")), 0))
    const sleep = async (): Promise<void> => {
      n++
      await new Promise<void>((r) => setTimeout(r, 1))
    }
    await expect(runWithSplash(deferred, { out: fakeOut(writes), frameMs: 0, sleep })).rejects.toThrow("midboom")
    expect(n).toBeGreaterThan(0) // animated at least one frame before settling
    expect(writes.join("")).toContain("\x1b[?25h") // cursor restored
  })

  it("clamps total<=0 instead of throwing", async () => {
    const writes: string[] = []
    await expect(
      runWithSplash(Promise.resolve("ok"), { out: fakeOut(writes), total: 0, frameMs: 0, sleep: async () => {} }),
    ).resolves.toBe("ok")
  })

  it("restores the cursor and rethrows when work rejects", async () => {
    const writes: string[] = []
    await expect(
      runWithSplash(Promise.reject(new Error("boom")), { out: fakeOut(writes), frameMs: 0, sleep: async () => {} }),
    ).rejects.toThrow("boom")
    expect(writes.join("")).toContain("\x1b[?25h")
  })
})
