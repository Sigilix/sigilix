import { afterEach, describe, expect, it, vi } from "vitest"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { CREATOR_HEADER, DeepResearchDO } from "@/src/do/deep-research/deep-research-do"
import { handleResearchCreate } from "@/src/do/deep-research/routes"
import type { ResearchModelFn } from "@/src/do/deep-research/model"
import type { Env } from "@/src/shared/types/env"

const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(11))
const SESSION_COOKIE = "__Host-sigilix_session"

function makeKv(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const value = values.get(key)
      return value === undefined ? null : type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
    list: async () => ({ keys: [], list_complete: true }),
  } as unknown as KVNamespace
}

function makeDoState(): DurableObjectState {
  const values = new Map<string, unknown>()
  return {
    id: { toString: () => "research-e2e-run" },
    waitUntil: () => undefined,
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async <T>(key: string, value: T) => void values.set(key, value),
      delete: async (key: string) => values.delete(key),
      deleteAll: async () => void values.clear(),
      setAlarm: async () => undefined,
      list: async <T>(options?: { prefix?: string }) =>
        new Map([...values.entries()].filter(([key]) => key.startsWith(options?.prefix ?? "")) as Array<[string, T]>),
    },
  } as unknown as DurableObjectState
}

async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text()
  return text
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("portal research to tenant MCP evidence", () => {
  it("verifies the session selector, keeps session ownership, and uses the fixed chat broker route", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const kv = makeKv()
    await createSession({
      kv,
      sessionId: "session-e2e",
      login: "developer",
      githubUserId: 42,
      accessToken: "github-user-token",
      encryptionKeyB64url: ENC_KEY,
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(input.toString()).toContain("/user/installations?")
        return new Response(JSON.stringify({ installations: [{ id: 99 }] }))
      }),
    )

    const brokerNames: string[] = []
    const brokerCalls: Array<{ path: string; body: Record<string, unknown> }> = []
    const mcpNamespace = {
      idFromName(name: string) {
        brokerNames.push(name)
        return { name }
      },
      get() {
        return {
          async fetch(request: Request): Promise<Response> {
            const path = new URL(request.url).pathname
            const body = (await request.json()) as Record<string, unknown>
            brokerCalls.push({ path, body })
            if (path.endsWith("/catalog")) {
              return Response.json({
                tools: [
                  {
                    serverId: "linear-grant",
                    vendor: "linear",
                    name: "list_comments",
                    inputSchema: { type: "object", properties: { issueId: { type: "string" } } },
                  },
                ],
              })
            }
            return Response.json({
              result: {
                untrusted: true,
                content: [{ type: "text", text: "Please cover the tenant-boundary regression." }],
                truncated: false,
              },
            })
          },
        }
      },
    } as unknown as DurableObjectNamespace
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      MCP_CONNECTIONS: mcpNamespace,
    } as unknown as Env
    const research = new DeepResearchDO(makeDoState(), env)
    const model: ResearchModelFn = async (role, _messages, tools) => {
      if (tools?.length) {
        return {
          text: "",
          tokens: 2,
          toolCalls: [{ function: { name: "sigilix_mcp_0", arguments: { issueId: "SIG-193" } } }],
        }
      }
      return {
        text:
          role === "finalReport"
            ? "The comment asks for tenant-boundary coverage [MCP: Linear/list_comments]."
            : "factual",
        tokens: 2,
      }
    }
    research.setTestHooks({ model })
    env.DEEP_RESEARCH = {
      newUniqueId: () => ({ toString: () => "research-e2e-run" }),
      get: () => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => research.fetch(new Request(input, init)),
      }),
    } as unknown as DurableObjectNamespace

    const response = await handleResearchCreate(
      new Request("https://api.sigilix.ai/v1/research", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=session-e2e`,
        },
        body: JSON.stringify({
          question: "What are the latest comments in Linear issue SIG-193?",
          mode: "chat",
          installationId: 99,
        }),
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    )

    expect(response.status).toBe(200)
    await (research as unknown as { driveDone: Promise<void> }).driveDone
    const events = await readSse(
      await research.fetch(
        new Request("https://deep-research.do/stream", {
          headers: { [CREATOR_HEADER]: "session:42" },
        }),
      ),
    )
    expect(events.find((event) => event.type === "final")?.markdown).toContain("[MCP: Linear/list_comments]")
    expect(brokerNames).toEqual(["tenant:99"])
    expect(brokerCalls).toEqual([
      { path: "/broker/runtime/chat/catalog", body: {} },
      {
        path: "/broker/runtime/chat/invoke",
        body: {
          runId: "research-e2e-run",
          serverId: "linear-grant",
          toolName: "list_comments",
          arguments: { issueId: "SIG-193" },
        },
      },
    ])
  })
})
