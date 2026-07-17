import { describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { enqueuePrOverviewRepair } from "./publish-helpers"

describe("enqueuePrOverviewRepair", () => {
  it("schedules one delayed stale-safe repair with dedupe bypass", async () => {
    const send = vi.fn(async () => undefined)
    const env = { OPENCLAW_JOBS: { send } } as unknown as Env

    const queued = await enqueuePrOverviewRepair({
      env,
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 894,
      headSha: "a".repeat(40),
      installationId: 7,
      reason: "inline-overview-budget-exhausted",
    })

    expect(queued).toBe(true)
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(
      {
        type: "pr-overview",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 894,
        headSha: "a".repeat(40),
        installationId: 7,
        skipDedupe: true,
      },
      { delaySeconds: 60 },
    )
  })
})
