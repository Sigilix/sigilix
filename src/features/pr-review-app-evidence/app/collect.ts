import { parsePrReviewAppManifest } from "@/src/features/pr-review-app-evidence/domain/manifest"
import {
  parseSupabaseAdvisorEvidence,
  parseVercelDeploymentEvidence,
} from "@/src/features/pr-review-app-evidence/domain/provider-results"
import type {
  PrReviewAppEvidence,
  PrReviewAppManifestEntry,
  PrReviewMcpToolDescriptor,
} from "@/src/features/pr-review-app-evidence/domain/types"
import type { PrReviewMcpRuntimePort } from "@/src/features/pr-review-app-evidence/ports/runtime"

const MANIFEST_PATH = "sigilix.mcp.json"
const TOTAL_DEADLINE_MS = 5_000

interface ManifestReader {
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | null>
}

export async function collectPrReviewAppEvidence(args: {
  client: ManifestReader
  runtime: PrReviewMcpRuntimePort | undefined
  owner: string
  repo: string
  baseSha: string
  headSha: string
}): Promise<PrReviewAppEvidence[]> {
  if (!args.runtime || !safeSha(args.baseSha) || !safeSha(args.headSha)) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("connected-app-evidence-timeout")), TOTAL_DEADLINE_MS)
  try {
    const raw = await raceAbort(
      args.client
        .getFileContent(args.owner, args.repo, MANIFEST_PATH, args.baseSha, { signal: controller.signal })
        .catch(() => null),
      controller.signal,
    )
    if (raw === null || controller.signal.aborted) return []
    const manifest = parsePrReviewAppManifest(raw)
    if (!manifest) return []
    const catalog = await raceAbort(args.runtime.catalog(controller.signal), controller.signal)
    if (!catalog || controller.signal.aborted) return []
    const settled = await raceAbort(
      Promise.all(
        manifest.evidence.map((entry) => collectEntry(entry, catalog, args.runtime!, args.headSha, controller.signal)),
      ),
      controller.signal,
    )
    return settled.filter((entry): entry is PrReviewAppEvidence => entry !== null)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function collectEntry(
  entry: PrReviewAppManifestEntry,
  catalog: readonly PrReviewMcpToolDescriptor[],
  runtime: PrReviewMcpRuntimePort,
  headSha: string,
  signal: AbortSignal,
): Promise<PrReviewAppEvidence | null> {
  const vendor = entry.adapter === "vercel-deployment-status" ? "vercel" : "supabase"
  const toolName = entry.adapter === "vercel-deployment-status" ? "list_deployments" : "get_advisors"
  const matches = catalog.filter(
    (tool) => tool.serverId === entry.serverId && tool.vendor === vendor && tool.name === toolName,
  )
  if (matches.length !== 1) {
    emitTelemetry(entry.adapter, vendor, toolName, matches.length > 1 ? "server_ambiguous" : "server_missing", 0)
    return null
  }
  const invokeArguments =
    entry.adapter === "vercel-deployment-status"
      ? { teamId: entry.teamId, projectId: entry.projectId }
      : { project_id: entry.projectId, type: entry.advisorType }
  const result = await runtime.invoke({ serverId: entry.serverId, toolName, arguments: invokeArguments }, signal)
  if (!result) {
    emitTelemetry(entry.adapter, vendor, toolName, signal.aborted ? "timeout" : "invoke_failed", 0)
    return null
  }
  const evidence =
    entry.adapter === "vercel-deployment-status"
      ? parseVercelDeploymentEvidence(result, headSha)
      : parseSupabaseAdvisorEvidence(result, entry.advisorType)
  if (!evidence) {
    emitTelemetry(entry.adapter, vendor, toolName, "parse_failed", 0)
    return null
  }
  const count = evidence.kind === "vercel-deployment-status" ? evidence.matchingDeployments : evidence.total
  emitTelemetry(entry.adapter, vendor, toolName, "ok", count)
  return evidence
}

function emitTelemetry(adapter: string, vendor: string, tool: string, outcome: string, count: number): void {
  console.log(JSON.stringify({ event: "pr-review-connected-app-evidence", adapter, vendor, tool, outcome, count }))
}

function safeSha(value: string): boolean {
  return /^[0-9a-f]{40,64}$/.test(value)
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => {
      cleanup()
      reject(Object.assign(new Error("connected-app-evidence-timeout"), { name: "AbortError" }))
    }
    void operation.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
