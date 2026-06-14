import type { McpToolId } from "@/src/shared/domain/config/types"
import { pathMatchesAny } from "@/src/shared/util/path-glob"
import type { SpecialistRuntimeTool } from "./specialist-tool-loop"

const DEFAULT_FILE_GREP_MAX_MATCHES = 20
const DEFAULT_FETCH_CHAR_LIMIT = 12_000

export interface SpecialistMcpToolsContext {
  toolIds: McpToolId[]
  reviewCorpus: string
  fileGrepMaxMatches?: number
  docsAllowedHosts?: string[]
  browserAllowedHosts?: string[]
  observabilityAllowedHosts?: string[]
  observabilityEndpoint?: string
}

export function createSpecialistMcpTools(ctx: SpecialistMcpToolsContext): SpecialistRuntimeTool[] {
  const tools: SpecialistRuntimeTool[] = []
  for (const id of ctx.toolIds) {
    if (id === "file_grep") tools.push(makeFileGrep(ctx))
    if (id === "docs_fetch") tools.push(makeDocsFetch(ctx))
    if (id === "observability_lookup") tools.push(makeObservabilityLookup(ctx))
    if (id === "browser_check") tools.push(makeBrowserCheck(ctx))
  }
  return tools
}

function makeFileGrep(ctx: SpecialistMcpToolsContext): SpecialistRuntimeTool {
  const corpusEntries = parseCorpus(ctx.reviewCorpus)
  return {
    id: "file_grep",
    description:
      "Search review-corpus paths and text for a literal string. Returns path, line, and snippet. Results may be truncated; truncated results are not exhaustive proof of absence.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text to search for." },
        pathGlob: { type: "string", description: "Optional path glob, for example src/auth/**." },
      },
      required: ["query"],
    },
    async execute(args): Promise<unknown> {
      const query = typeof args.query === "string" ? args.query.trim() : ""
      const pathGlob = typeof args.pathGlob === "string" ? args.pathGlob.trim() : ""
      if (!query) return toolError("invalid_args", "file_grep requires a non-empty query string.")
      const maxMatches = ctx.fileGrepMaxMatches ?? DEFAULT_FILE_GREP_MAX_MATCHES
      const matches: Array<{ path: string; line: number; snippet: string }> = []
      let total = 0
      for (const entry of corpusEntries) {
        if (pathGlob && !pathMatchesAny(entry.path, [pathGlob])) continue
        if (!entryMatches(entry, query)) continue
        total += 1
        if (matches.length < maxMatches) {
          matches.push({ path: entry.path, line: entry.line, snippet: entry.text.slice(0, 500) })
        }
      }
      const truncated = total > matches.length
      return {
        ok: true,
        status: truncated ? "truncated" : matches.length === 0 ? "empty" : "complete",
        query,
        matchCount: matches.length,
        totalMatches: total,
        truncated,
        matches,
      }
    },
  }
}

function makeDocsFetch(ctx: SpecialistMcpToolsContext): SpecialistRuntimeTool {
  return {
    id: "docs_fetch",
    description: "Fetch a bounded HTTP(S) documentation page snapshot. Only public http/https URLs are allowed.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Public http/https documentation URL." } },
      required: ["url"],
    },
    async execute(args, signal): Promise<unknown> {
      const url = parsePublicUrl(args.url)
      if (!url) return toolError("invalid_url", "docs_fetch requires an http or https URL.")
      const hostError = validateFetchHost(url, ctx.docsAllowedHosts, "docs_fetch")
      if (hostError) return hostError
      return fetchTextSnapshot(url, signal)
    },
  }
}

function makeObservabilityLookup(ctx: SpecialistMcpToolsContext): SpecialistRuntimeTool {
  return {
    id: "observability_lookup",
    description: "Look up bounded observability context from the configured endpoint when available.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Metric, trace, or log query to look up." } },
      required: ["query"],
    },
    async execute(args, signal): Promise<unknown> {
      if (!ctx.observabilityEndpoint) {
        return {
          ok: false,
          status: "unavailable",
          message: "No observability endpoint configured.",
          error: { code: "not_configured" },
        }
      }
      const query = typeof args.query === "string" ? args.query.trim() : ""
      if (!query) return toolError("invalid_args", "observability_lookup requires a non-empty query.")
      const url = parsePublicUrl(ctx.observabilityEndpoint)
      if (!url) return toolError("invalid_url", "Configured observability endpoint is not an http/https URL.")
      const hostError = validateFetchHost(url, ctx.observabilityAllowedHosts, "observability_lookup")
      if (hostError) return hostError
      url.searchParams.set("q", query)
      return fetchTextSnapshot(url, signal)
    },
  }
}

function makeBrowserCheck(ctx: SpecialistMcpToolsContext): SpecialistRuntimeTool {
  return {
    id: "browser_check",
    description:
      "HTTP page fetch for status, title, and text snapshot. This Worker-safe check does not execute JavaScript or render a page.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Public http/https URL to fetch." } },
      required: ["url"],
    },
    async execute(args, signal): Promise<unknown> {
      const url = parsePublicUrl(args.url)
      if (!url) return toolError("invalid_url", "browser_check requires an http or https URL.")
      const hostError = validateFetchHost(url, ctx.browserAllowedHosts, "browser_check")
      if (hostError) return hostError
      const snapshot = await fetchTextSnapshot(url, signal)
      if (!snapshot.ok || typeof snapshot.text !== "string") return snapshot
      return { ...snapshot, title: extractTitle(snapshot.text) }
    },
  }
}

interface CorpusEntry {
  path: string
  line: number
  text: string
}

function parseCorpus(corpus: string): CorpusEntry[] {
  return corpus.split("\n").map((raw, index) => {
    const match = /^(?<path>.+):(?<line>\d+)(?:\s+(?<text>.*))?$/.exec(raw)
    if (match?.groups) {
      return {
        path: match.groups.path ?? "review-corpus",
        line: Number(match.groups.line),
        text: match.groups.text ?? "",
      }
    }
    return { path: "review-corpus", line: index + 1, text: raw }
  })
}

function entryMatches(entry: CorpusEntry, query: string): boolean {
  return entry.path.includes(query) || entry.text.includes(query)
}

function parsePublicUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1") return true
  if (host.startsWith("::ffff:")) return isBlockedIpv4MappedHost(host.slice("::ffff:".length))
  if (host.includes(":")) {
    if (host.startsWith("2002:") || host.startsWith("2001:0:") || host.startsWith("2001:0000:")) return true
    return (
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("fc") ||
      host.startsWith("fd")
    )
  }
  const parts = host.split(".").map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return isBlockedIpv4Parts(parts as [number, number, number, number])
}

function isBlockedIpv4MappedHost(mapped: string): boolean {
  if (mapped.includes(".")) return isBlockedHost(mapped)
  const words = mapped.split(":")
  if (words.length !== 2) return true
  if (!words.every((word) => /^[0-9a-f]{1,4}$/.test(word))) return true
  const high = Number.parseInt(words[0]!, 16)
  const low = Number.parseInt(words[1]!, 16)
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || high > 0xffff || low < 0 || low > 0xffff) {
    return true
  }
  return isBlockedIpv4Parts([high >> 8, high & 0xff, low >> 8, low & 0xff])
}

function isBlockedIpv4Parts([a, b, c]: [number, number, number, number]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

function validateFetchHost(
  url: URL,
  allowedHosts: string[] | undefined,
  toolId: string,
): Record<string, unknown> | null {
  if (isBlockedHost(url.hostname)) return toolError("host_not_allowed", `Host ${url.hostname} is not allowed.`)
  if (!allowedHosts?.length) {
    return {
      ok: false,
      status: "unavailable",
      message: `${toolId} requires a runtime-owned host allowlist.`,
      error: { code: "not_configured" },
    }
  }
  const host = url.hostname.toLowerCase()
  const allowedHostSet = new Set(allowedHosts.map((allowedHost) => allowedHost.toLowerCase()))
  if (!allowedHostSet.has(host)) {
    return toolError("host_not_allowed", `Host ${url.hostname} is not allowed for ${toolId}.`)
  }
  return null
}

async function fetchTextSnapshot(url: URL, signal: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(url, { redirect: "manual", signal })
    if (response.status >= 300 && response.status < 400) {
      return toolError("redirect_not_followed", "URL fetch tools do not follow redirects.")
    }
    const { text, truncated } = await readBoundedText(response, DEFAULT_FETCH_CHAR_LIMIT)
    if (!response.ok) {
      return {
        ok: false,
        status: "error",
        httpStatus: response.status,
        url: url.toString(),
        text,
        truncated,
        error: { code: "http_error", message: `HTTP ${response.status}` },
      }
    }
    return {
      ok: response.ok,
      status: truncated ? "truncated" : "complete",
      httpStatus: response.status,
      url: url.toString(),
      text,
      truncated,
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error
    return toolError("fetch_failed", error instanceof Error ? error.message : String(error))
  }
}

async function readBoundedText(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text()
    return { text: text.slice(0, limit), truncated: text.length > limit }
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ""
  let shouldCancel = false
  try {
    while (out.length <= limit) {
      const chunk = await reader.read()
      if (chunk.done) break
      out += decoder.decode(chunk.value, { stream: true })
    }
    out += decoder.decode()
    shouldCancel = out.length > limit
  } finally {
    if (shouldCancel) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    if (shouldCancel) await response.body.cancel().catch(() => undefined)
  }
  return { text: out.length > limit ? out.slice(0, limit) : out, truncated: out.length > limit }
}

function extractTitle(html: string): string | undefined {
  return /<title[^>]*>(?<title>[^<]*)<\/title>/i.exec(html)?.groups?.title?.trim()
}

function toolError(code: string, message: string): Record<string, unknown> {
  return { ok: false, status: "error", error: { code, message } }
}
