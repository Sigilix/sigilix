// sig-training-data-consent — the separate R2 store: isolation + inert-when-absent.
import { describe, expect, it } from "vitest"
import { purgeTrainingData, storeTrainingRecord } from "@/src/features/training-consent/adapters/training-store"
import { makeR2 } from "@/src/features/training-consent/adapters/r2-fake.test-helpers"
import type { TrainingRecord } from "@/src/features/training-consent/domain/types"
import type { Env } from "@/src/shared/types/env"

const rec = (id: string): TrainingRecord => ({ kind: "learning", id, payload: "hello" })

describe("storeTrainingRecord", () => {
  it("writes under the installation partition prefix", async () => {
    const { bucket, store } = makeR2()
    const ok = await storeTrainingRecord({ SIGILIX_TRAINING_DATA: bucket }, 42, rec("a"), 1000)
    expect(ok).toBe(true)
    expect([...store.keys()].every((k) => k.startsWith("installation/42/"))).toBe(true)
  })

  it("no-ops (returns false) when the bucket binding is absent", async () => {
    const ok = await storeTrainingRecord({ SIGILIX_TRAINING_DATA: undefined } as unknown as Env, 42, rec("a"))
    expect(ok).toBe(false)
  })
})

describe("purgeTrainingData — right-to-forget, per-org isolation", () => {
  it("deletes ONLY the target org's partition, never another org's", async () => {
    const { bucket, store } = makeR2()
    const env = { SIGILIX_TRAINING_DATA: bucket }
    await storeTrainingRecord(env, 100, rec("a"), 1)
    await storeTrainingRecord(env, 100, rec("b"), 2)
    await storeTrainingRecord(env, 200, rec("c"), 3)

    const deleted = await purgeTrainingData(env, 100)
    expect(deleted).toBe(2)

    const remaining = [...store.keys()]
    expect(remaining.every((k) => k.startsWith("installation/200/"))).toBe(true)
    expect(remaining.some((k) => k.startsWith("installation/100/"))).toBe(false)
  })

  it("no-ops (0) when the bucket binding is absent", async () => {
    const deleted = await purgeTrainingData({ SIGILIX_TRAINING_DATA: undefined } as unknown as Env, 100)
    expect(deleted).toBe(0)
  })
})
