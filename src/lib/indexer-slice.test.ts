import { describe, expect, it, vi } from "vitest"
import { processSlice } from "@/src/lib/indexer-slice"
import type { Env } from "@/src/shared/types/env"

describe("processSlice", () => {
  it("writes indexed commit and run metadata into Vectorize records", async () => {
    const upsert = vi.fn(async (_records: Array<{ metadata: Record<string, unknown> }>) => undefined)
    const kv = new Map<string, string>()
    const env = {
      AI: {
        run: async (_model: string, input: { text: string[] }) => ({
          data: input.text.map(() => Array(768).fill(0.1)),
        }),
      },
      OPENCLAW_CODE_INDEX: { upsert },
      OPENCLAW_STATE: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => {
          kv.set(key, value)
        },
      },
    } as unknown as Env
    const client = {
      getFileContent: async () => "export function foo() {\n  return 1\n}\n",
    }

    await processSlice({
      client: client as never,
      env,
      owner: "Sigilix",
      repo: "sigilix",
      stateRepo: "sigilix",
      namespace: "sigilix/sigilix",
      headSha: "abc123456789",
      runId: "run-abc",
      files: [{ path: "src/foo.ts", size: 42 }],
      astChunking: false,
    })

    const records = upsert.mock.calls.flatMap((call) => call[0] as Array<{ metadata: Record<string, unknown> }>)
    expect(records).toHaveLength(1)
    expect(records[0]!.metadata).toMatchObject({
      headSha: "abc123456789",
      runId: "run-abc",
    })
  })
})
