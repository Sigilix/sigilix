// Ollama Turbo client — replaces the LAN HTTP call to the Windows box.
// Endpoint: https://ollama.com/api/generate
// Auth:     Authorization: Bearer <OLLAMA_API_KEY>
// Same request shape as the local Ollama API, so the prompt builder
// and response parser carry over from the Node daemon unchanged.

const OLLAMA_TURBO_URL = "https://ollama.com/api/generate"

interface GenerateArgs {
  model: string
  prompt: string
  apiKey: string
  temperature?: number
  /** Wall-clock timeout. Cloud routes can take 30-90s; default 5min. */
  timeoutMs?: number
}

export async function generate({
  model,
  prompt,
  apiKey,
  temperature = 0.2,
  timeoutMs = 300_000,
}: GenerateArgs): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(OLLAMA_TURBO_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature },
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 500)}`)
    }

    const json = (await res.json()) as { response?: unknown }
    if (typeof json.response !== "string") {
      throw new Error("Ollama response missing 'response' string field")
    }
    return json.response
  } finally {
    clearTimeout(timer)
  }
}
