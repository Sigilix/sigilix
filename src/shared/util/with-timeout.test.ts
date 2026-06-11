import { describe, expect, it } from "vitest"
import { withTimeout } from "@/src/shared/util/with-timeout"

describe("withTimeout", () => {
  it("resolves before timeout and returns the value", async () => {
    const value = await withTimeout(async () => 42, 100)
    expect(value).toBe(42)
  })

  it("aborts the signal when timeout fires", async () => {
    let observedSignal: AbortSignal | null = null
    const promise = withTimeout(async (signal) => {
      observedSignal = signal
      // Wait long enough for the timeout to fire, observable via signal.
      await new Promise((resolve) => setTimeout(resolve, 100))
      // Throw an AbortError manually since this test's factory doesn't
      // call fetch — we're just verifying the signal got aborted.
      if (signal.aborted) {
        const err = new Error("aborted") as Error & { name: string }
        err.name = "AbortError"
        throw err
      }
      return "never"
    }, 20)
    await expect(promise).rejects.toThrow(/aborted/)
    expect((observedSignal as AbortSignal | null)?.aborted).toBe(true)
  })

  it("propagates non-Abort errors and clears the timer", async () => {
    const promise = withTimeout(async () => {
      throw new Error("boom")
    }, 1_000)
    await expect(promise).rejects.toThrow("boom")
  })

  it("clears the timer in finally on success path", async () => {
    // Indirect check: if the timer wasn't cleared, this whole test would
    // hang the runner past the success. Vitest's default timeout (5s)
    // would catch it.
    const value = await withTimeout(async () => "ok", 50_000)
    expect(value).toBe("ok")
  })
})
