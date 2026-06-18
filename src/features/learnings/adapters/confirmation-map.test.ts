import { describe, expect, it } from "vitest"
import {
  recordConfirmationMapForThread,
  resolveConfirmationMap,
  type LearningConfirmationMapValue,
} from "@/src/features/learnings/adapters/confirmation-map"
import type { Env } from "@/src/shared/types/env"

function makeEnv() {
  const values = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return values.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      values.set(key, value)
    },
  }
  return { env: { OPENCLAW_STATE: kv } as unknown as Env, values }
}

const VALUE: LearningConfirmationMapValue = { scope: "repo", subjectId: "123", learningId: "abc123" }

describe("recordConfirmationMapForThread (SIG-464)", () => {
  it("resolves from BOTH the confirmation comment id and the thread-root id", async () => {
    const { env } = makeEnv()
    const CONFIRMATION_ID = 999
    const THREAD_ROOT_ID = 100 // the original finding; GitHub threads a forget reply here
    await recordConfirmationMapForThread(env, CONFIRMATION_ID, THREAD_ROOT_ID, VALUE)
    // GitHub flattens review-comment threads → a `@sigilix forget` reply's in_reply_to is the
    // thread root, not the confirmation comment. The root must resolve the learning.
    expect(await resolveConfirmationMap(env, THREAD_ROOT_ID)).toEqual(VALUE)
    // ...and the confirmation comment id still resolves (the original direct path).
    expect(await resolveConfirmationMap(env, CONFIRMATION_ID)).toEqual(VALUE)
  })

  it("writes a single key when the thread root equals the confirmation id", async () => {
    const { env, values } = makeEnv()
    await recordConfirmationMapForThread(env, 42, 42, VALUE)
    expect(values.size).toBe(1)
    expect(await resolveConfirmationMap(env, 42)).toEqual(VALUE)
  })

  it("writes a single key when the thread root is undefined", async () => {
    const { env, values } = makeEnv()
    await recordConfirmationMapForThread(env, 7, undefined, VALUE)
    expect(values.size).toBe(1)
    expect(await resolveConfirmationMap(env, 7)).toEqual(VALUE)
  })
})
