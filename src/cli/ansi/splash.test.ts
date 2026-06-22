// SIG-304 (review CLI) Phase 1b — the animated launch splash.

import { describe, it, expect } from "vitest"
import { renderSplashFrame, runWithSplash, TOTAL } from "./splash"
import { stripAnsi } from "./ansi"

describe("renderSplashFrame", () => {
  it("frame 0: spinning Earth (half-block) + sigil stamp + 'reviewing' status, with ANSI", () => {
    const out = renderSplashFrame(0)
    expect(out.includes("\x1b[")).toBe(true) // truecolor ANSI present
    expect(out).toContain("▀") // half-block Earth / stars
    const plain = stripAnsi(out)
    expect(plain).toContain("sigilix") // tiny corner stamp wordmark
    expect(plain).toContain("❖") // the sigil stamp glyph
    expect(plain).toContain("reviewing your changes")
  })

  it("final frame: complete state (✓ + review complete)", () => {
    const plain = stripAnsi(renderSplashFrame(TOTAL - 1))
    expect(plain).toContain("review complete")
    expect(plain).toContain("✓")
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

  it("redraws IN PLACE — no \\x1b[2J scrollback churn, steps the cursor up to overwrite", async () => {
    const writes: string[] = []
    await runWithSplash(Promise.resolve("ok"), { out: fakeOut(writes), frameMs: 0, sleep: async () => {} })
    const all = writes.join("")
    expect(all).not.toContain("\x1b[2J") // never a full-screen clear → no stacked frames in scrollback
    expect(all).toMatch(/\x1b\[\d+A/) // moves the cursor up to redraw the same lines
  })

  it("does NOT show '✓ review complete' when the work fails (no false success)", async () => {
    const writes: string[] = []
    await expect(
      runWithSplash(Promise.reject(new Error("boom")), { out: fakeOut(writes), frameMs: 0, sleep: async () => {} }),
    ).rejects.toThrow("boom")
    expect(stripAnsi(writes.join(""))).not.toContain("review complete")
  })

  it("restores the cursor and rethrows when work rejects", async () => {
    const writes: string[] = []
    await expect(
      runWithSplash(Promise.reject(new Error("boom")), { out: fakeOut(writes), frameMs: 0, sleep: async () => {} }),
    ).rejects.toThrow("boom")
    expect(writes.join("")).toContain("\x1b[?25h")
  })
})
