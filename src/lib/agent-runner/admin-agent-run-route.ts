// SIG-545 B1 proof harness: admin-gated manual dispatch of an agent-runner task,
// so a ticket → PR can be exercised end-to-end before the real trigger (B3)
// exists. Bearer-auth on OPENCLAW_ADMIN_TOKEN; the model key + installation token
// are sourced server-side and NEVER returned/logged.
import { requireBearerToken } from "@/src/lib/auth-bearer"
import { dispatchAgentRun, getAgentRunStatus } from "@/src/lib/agent-runner/dispatch"
import type { Env } from "@/src/shared/types/env"

/** POST /admin/agent-run — dispatch one agent-runner task. Body:
 *  { owner, repo, installationId, baseBranch?, ticket?:{identifier,title,body,url},
 *    runId?, caps?, model?:{ id?, baseUrl? } }
 *  model defaults to Ollama Turbo (glm-5.2:cloud @ https://ollama.com/v1). */
export async function handleAdminAgentRunRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) return new Response("admin token not configured\n", { status: 503 })
  if (!(await requireBearerToken(request, token))) return new Response("unauthorized\n", { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return new Response("bad json\n", { status: 400 })
  }

  const owner = typeof body.owner === "string" ? body.owner : null
  const repo = typeof body.repo === "string" ? body.repo : null
  const installationId = typeof body.installationId === "number" ? body.installationId : null
  if (!owner || !repo || installationId === null) {
    return new Response("owner (string) + repo (string) + installationId (number) required\n", { status: 400 })
  }
  // The B1 agent-runner defaults to Ollama Turbo (glm-5.2:cloud / OLLAMA_API_KEY)
  // so the ticket→PR proof runs WITHOUT OpenRouter credits. This provider choice is
  // scoped to the agent-runner container — it does NOT touch the PR-review ensemble.
  // A request body may override model.id / model.baseUrl; the provider key is chosen
  // by an EXACT-HOST allow-list so a hostile baseUrl can't exfiltrate a key in the
  // Authorization header to an arbitrary host.
  const OLLAMA_TURBO_BASE = "https://ollama.com/v1"
  const modelIn = (body.model ?? {}) as Record<string, unknown>
  const modelId = typeof modelIn.id === "string" ? modelIn.id : "glm-5.2:cloud"
  // Strip trailing slashes so the loop's `${baseUrl}/chat/completions` never doubles up.
  const baseUrl = (typeof modelIn.baseUrl === "string" ? modelIn.baseUrl : OLLAMA_TURBO_BASE).replace(/\/+$/, "")

  let host: string
  try {
    const u = new URL(baseUrl)
    if (u.protocol !== "https:") throw new Error("non-https")
    host = u.hostname
  } catch {
    return new Response("model.baseUrl must be a valid https URL\n", { status: 400 })
  }
  const KEY_BY_HOST: Record<string, "OPENROUTER_API_KEY" | "OLLAMA_API_KEY"> = {
    "openrouter.ai": "OPENROUTER_API_KEY",
    "ollama.com": "OLLAMA_API_KEY",
  }
  // Object.hasOwn guards against prototype-chain keys ("constructor"/"__proto__"),
  // matching the same precaution in container/src/agent-loop.ts's run_cmd allow-list.
  const keyVar = Object.hasOwn(KEY_BY_HOST, host) ? KEY_BY_HOST[host] : undefined
  if (!keyVar) return new Response("model.baseUrl host not allow-listed\n", { status: 400 })
  const key = env[keyVar]
  if (!key) return new Response(`${keyVar} not set\n`, { status: 503 })

  const ticketIn = (body.ticket ?? {}) as Record<string, unknown>
  const capsIn = (body.caps ?? {}) as Record<string, unknown>
  const grounding = typeof body.grounding === "string" ? body.grounding : undefined

  const result = await dispatchAgentRun(env, {
    runId: typeof body.runId === "string" ? body.runId : crypto.randomUUID(),
    owner,
    repo,
    baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : "main",
    installationId,
    ticket: {
      identifier: typeof ticketIn.identifier === "string" ? ticketIn.identifier : "PROOF-1",
      title: typeof ticketIn.title === "string" ? ticketIn.title : "Sigilix agent-runner proof",
      body: typeof ticketIn.body === "string" ? ticketIn.body : "",
      url: typeof ticketIn.url === "string" ? ticketIn.url : "",
    },
    ...(grounding !== undefined ? { grounding } : {}),
    model: { id: modelId, key, baseUrl },
    caps: {
      maxModelCalls: typeof capsIn.maxModelCalls === "number" ? capsIn.maxModelCalls : 12,
      maxTokens: typeof capsIn.maxTokens === "number" ? capsIn.maxTokens : 800_000,
      timeoutMs: typeof capsIn.timeoutMs === "number" ? capsIn.timeoutMs : 600_000,
    },
  })
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })
}

/** GET /admin/agent-run-status?runId=… — read the run record. */
export async function handleAdminAgentStatusRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) return new Response("admin token not configured\n", { status: 503 })
  if (!(await requireBearerToken(request, token))) return new Response("unauthorized\n", { status: 401 })
  const runId = new URL(request.url).searchParams.get("runId")
  if (!runId) return new Response("runId query param required\n", { status: 400 })
  const record = await getAgentRunStatus(env, runId)
  return new Response(JSON.stringify(record), { status: 200, headers: { "content-type": "application/json" } })
}
