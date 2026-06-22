// SIG-494 — the agent grounding token-delta RULER. Measures blind (read the relevant
// file in full) vs grounded (the live POST /v1/context slice) input+output tokens across
// a fixed task set, and asserts grounding is cheaper IN AGGREGATE. This is the repeatable
// guard for the cost moat: re-run it whenever the retrieval / budget / packing changes.
//
// Live: needs OPENROUTER_API_KEY (the model) + SIGILIX_API_KEY + SIGILIX_ENDPOINT (the
// deployed /v1/context). SKIPS in CI / `npm run build` so the gate stays green. Run:
//
//   OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY' .dev.vars | cut -d= -f2-)" \
//   SIGILIX_API_KEY="$(grep -E '^SIGILIX_API_KEY' .dev.vars | cut -d= -f2-)" \
//   SIGILIX_ENDPOINT="$(grep -E '^SIGILIX_ENDPOINT' .dev.vars | cut -d= -f2-)" \
//   npx vitest run e2e/agent-token-delta.live.test.ts
//
// "blind = read the one relevant file" is a LOWER BOUND on real blind cost (a real agent
// also greps to FIND the file, reads neighbors, and re-reads across turns), so a passing
// margin here understates the real-world win.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const OR_KEY = process.env.OPENROUTER_API_KEY
const SIG_KEY = process.env.SIGILIX_API_KEY
const EP = process.env.SIGILIX_ENDPOINT
const MODEL = process.env.AGENT_DELTA_MODEL ?? "openai/gpt-oss-120b"
const OWNER = process.env.AGENT_DELTA_OWNER ?? "Sigilix"
const REPO = process.env.AGENT_DELTA_REPO ?? "sigilix"

const SYS =
  "You are a senior engineer. Answer in 1-2 sentences using ONLY the provided context. If insufficient, say exactly: INSUFFICIENT CONTEXT."

// Tasks whose answer lives in a known file (for the blind baseline). The repo must be
// indexed in the deployed Worker for the grounded leg to return context.
const TASKS: ReadonlyArray<{ q: string; files: string[] }> = [
  {
    q: "What does teamKeyToNamespace return when there is no mapping for the team key?",
    files: ["src/lib/retrieval.ts"],
  },
  {
    q: "In the runner ingest route, what is verified before the request body is read, and why does the order matter?",
    files: ["src/lib/runner-ingest-route.ts"],
  },
  {
    q: "How does gatherAgentContext avoid duplicating tokens between the symbol block and the raw chunks?",
    files: ["src/lib/agent-context.ts"],
  },
]

interface ChatUsage {
  in: number
  out: number
}

async function orChat(content: string): Promise<ChatUsage> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${OR_KEY ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content },
      ],
      usage: { include: true },
    }),
  })
  const json = (await res.json()) as { usage?: { prompt_tokens: number; completion_tokens: number } }
  if (!json.usage) throw new Error("OpenRouter returned no usage")
  return { in: json.usage.prompt_tokens, out: json.usage.completion_tokens }
}

async function groundedContext(query: string): Promise<string | null> {
  const res = await fetch(`${EP}/v1/context`, {
    method: "POST",
    headers: { authorization: `Bearer ${SIG_KEY ?? ""}`, "content-type": "application/json" },
    body: JSON.stringify({ owner: OWNER, repo: REPO, query }),
  })
  const json = (await res.json()) as { context?: string | null }
  return json.context ?? null
}

describe.skipIf(!OR_KEY || !SIG_KEY || !EP)("SIG-494 — agent grounding token-delta ruler", () => {
  it("grounded uses fewer total tokens than blind across the task set", async () => {
    let blindTotal = 0
    let groundedTotal = 0
    for (const task of TASKS) {
      const ctx = await groundedContext(task.q)
      const grounded = await orChat(`CONTEXT:\n${ctx ?? "(none)"}\n\nQUESTION: ${task.q}`)
      const blob = task.files.map((f) => `=== ${f} ===\n${readFileSync(join(process.cwd(), f), "utf8")}`).join("\n\n")
      const blind = await orChat(`CONTEXT:\n${blob}\n\nQUESTION: ${task.q}`)
      blindTotal += blind.in + blind.out
      groundedTotal += grounded.in + grounded.out
      console.log(
        `[token-delta] "${task.q.slice(0, 44)}…" blind=${blind.in + blind.out} grounded=${grounded.in + grounded.out}`,
      )
    }
    const savedPct = ((blindTotal - groundedTotal) / blindTotal) * 100
    console.log(`[token-delta] TOTAL blind=${blindTotal} grounded=${groundedTotal} saved=${savedPct.toFixed(0)}%`)
    // Aggregate invariant — the moat: grounded must beat blind-read-the-file (a lower bound).
    expect(groundedTotal).toBeLessThan(blindTotal)
  }, 300_000)
})
