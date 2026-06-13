import { unwrapLogpushEnvelope } from "@/src/lib/bakeoff-logpush-unwrap"
import { computeReviewCost, type TokenUsageByModel } from "@/src/lib/ensemble-slo-telemetry"

const SPECIALIST_ROLES = ["logic", "security", "performance", "tests"] as const
type Specialist = (typeof SPECIALIST_ROLES)[number]

export type DispatchMonitorEvent = DispatchSavingsEvent | ModelAttemptEvent | FanoutSummaryEvent

export interface DispatchSavingsEvent {
  kind: "dispatch"
  reviewKey: string
  mode: string
  savingsType: "actual" | "shadow"
  baselineSpecialists: string[]
  dispatcherSpecialists: string[]
  actualSpecialists: string[]
  projectedSkippedRoles: string[]
  actualNotInvokedRoles: string[]
  projectedSpecialistCallsAvoided: number
  actualSpecialistCallsAvoided: number
  llmOutcome: string
}

export interface ModelAttemptEvent {
  kind: "model-attempt"
  reviewKey: string
  phase: string
  role: string
  model?: string
  inputTokens?: number
  outputTokens?: number
}

export interface FanoutSummaryEvent {
  kind: "fanout"
  reviewKey: string
  dispatchedRoles: string[]
}

export interface ParseDispatchMonitorResult {
  events: DispatchMonitorEvent[]
  badLines: number
  skippedLines: number
}

export interface DispatchMonitorReport {
  parsedEvents: number
  dispatchReviews: number
  reviewsMissingFanoutSummary: number
  actualSpecialistCallsAvoided: number
  projectedSpecialistCallsAvoided: number
  observedInputTokens: number
  observedOutputTokens: number
  observedCostUsd: number
  estimatedActualTokensAvoided: number
  estimatedProjectedTokensAvoided: number
  unknownTokenEstimateSkips: Partial<Record<Specialist, number>>
  byMode: Record<string, ModeSummary>
  byLlmOutcome: Record<string, number>
  roleSavings: Partial<Record<Specialist, RoleSavings>>
  reviews: ReviewDispatchSummary[]
}

export interface ModeSummary {
  reviews: number
  actualSpecialistCallsAvoided: number
  projectedSpecialistCallsAvoided: number
}

export interface RoleSavings {
  actualSkips: number
  projectedSkips: number
}

export interface ReviewDispatchSummary {
  reviewKey: string
  mode: string
  savingsType: "actual" | "shadow"
  baselineSpecialists: string[]
  actualSpecialists: string[]
  actualNotInvokedRoles: string[]
  projectedSkippedRoles: string[]
  actualSpecialistCallsAvoided: number
  projectedSpecialistCallsAvoided: number
}

export function parseDispatchMonitorJsonl(text: string): ParseDispatchMonitorResult {
  const events: DispatchMonitorEvent[] = []
  let badLines = 0
  let skippedLines = 0
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      badLines++
      continue
    }
    const normalized = normalizeParsedValue(parsed)
    events.push(...normalized.events)
    skippedLines += normalized.skippedLines
  }
  return { events, badLines, skippedLines }
}

export function buildDispatchMonitorReport(events: readonly DispatchMonitorEvent[]): DispatchMonitorReport {
  const dispatches = events.filter((e): e is DispatchSavingsEvent => e.kind === "dispatch")
  const fanoutKeys = new Set(events.filter((e): e is FanoutSummaryEvent => e.kind === "fanout").map((e) => e.reviewKey))
  const roleTokens: Partial<Record<Specialist, { tokens: number; attempts: number }>> = {}
  const usage: TokenUsageByModel = {}
  let observedInputTokens = 0
  let observedOutputTokens = 0

  for (const e of events) {
    if (e.kind !== "model-attempt") continue
    const input = e.inputTokens ?? 0
    const output = e.outputTokens ?? 0
    observedInputTokens += input
    observedOutputTokens += output
    if (e.model && (e.inputTokens !== undefined || e.outputTokens !== undefined)) {
      const bucket = usage[e.model] ?? { inputTokens: 0, outputTokens: 0 }
      bucket.inputTokens += input
      bucket.outputTokens += output
      usage[e.model] = bucket
    }
    if (
      e.phase === "specialist" &&
      isSpecialist(e.role) &&
      (e.inputTokens !== undefined || e.outputTokens !== undefined)
    ) {
      const bucket = roleTokens[e.role] ?? { tokens: 0, attempts: 0 }
      bucket.tokens += input + output
      bucket.attempts++
      roleTokens[e.role] = bucket
    }
  }

  const byMode: Record<string, ModeSummary> = {}
  const byLlmOutcome: Record<string, number> = {}
  const roleSavings: Partial<Record<Specialist, RoleSavings>> = {}
  const unknownTokenEstimateSkips: Partial<Record<Specialist, number>> = {}
  let actualSpecialistCallsAvoided = 0
  let projectedSpecialistCallsAvoided = 0
  let estimatedActualTokensAvoided = 0
  let estimatedProjectedTokensAvoided = 0

  for (const e of dispatches) {
    const mode = byMode[e.mode] ?? {
      reviews: 0,
      actualSpecialistCallsAvoided: 0,
      projectedSpecialistCallsAvoided: 0,
    }
    mode.reviews++
    mode.actualSpecialistCallsAvoided += e.actualSpecialistCallsAvoided
    mode.projectedSpecialistCallsAvoided += e.projectedSpecialistCallsAvoided
    byMode[e.mode] = mode
    byLlmOutcome[e.llmOutcome] = (byLlmOutcome[e.llmOutcome] ?? 0) + 1
    actualSpecialistCallsAvoided += e.actualSpecialistCallsAvoided
    projectedSpecialistCallsAvoided += e.projectedSpecialistCallsAvoided
    for (const role of e.projectedSkippedRoles) {
      if (isSpecialist(role)) {
        const r = roleSavings[role] ?? { actualSkips: 0, projectedSkips: 0 }
        r.projectedSkips++
        roleSavings[role] = r
        estimatedProjectedTokensAvoided += averageTokens(roleTokens[role]) ?? 0
      }
    }
    for (const role of e.actualNotInvokedRoles) {
      if (!isSpecialist(role)) continue
      const r = roleSavings[role] ?? { actualSkips: 0, projectedSkips: 0 }
      r.actualSkips++
      roleSavings[role] = r
      const avg = averageTokens(roleTokens[role])
      if (avg === null) {
        unknownTokenEstimateSkips[role] = (unknownTokenEstimateSkips[role] ?? 0) + 1
      } else {
        estimatedActualTokensAvoided += avg
      }
    }
  }

  const reviews = dispatches.map((e) => ({
    reviewKey: e.reviewKey,
    mode: e.mode,
    savingsType: e.savingsType,
    baselineSpecialists: e.baselineSpecialists,
    actualSpecialists: e.actualSpecialists,
    actualNotInvokedRoles: e.actualNotInvokedRoles,
    projectedSkippedRoles: e.projectedSkippedRoles,
    actualSpecialistCallsAvoided: e.actualSpecialistCallsAvoided,
    projectedSpecialistCallsAvoided: e.projectedSpecialistCallsAvoided,
  }))

  return {
    parsedEvents: events.length,
    dispatchReviews: dispatches.length,
    reviewsMissingFanoutSummary: dispatches.filter((e) => !fanoutKeys.has(e.reviewKey)).length,
    actualSpecialistCallsAvoided,
    projectedSpecialistCallsAvoided,
    observedInputTokens,
    observedOutputTokens,
    observedCostUsd: computeReviewCost(usage).totalUsd,
    estimatedActualTokensAvoided: Math.round(estimatedActualTokensAvoided),
    estimatedProjectedTokensAvoided: Math.round(estimatedProjectedTokensAvoided),
    unknownTokenEstimateSkips,
    byMode,
    byLlmOutcome,
    roleSavings,
    reviews,
  }
}

export function formatDispatchMonitorMarkdown(report: DispatchMonitorReport): string {
  const lines = [
    "# Dispatch Monitor",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Dispatcher reviews | ${report.dispatchReviews} |`,
    `| Actual specialist calls avoided | ${report.actualSpecialistCallsAvoided} |`,
    `| Projected specialist calls avoided | ${report.projectedSpecialistCallsAvoided} |`,
    `| Observed input tokens | ${report.observedInputTokens} |`,
    `| Observed output tokens | ${report.observedOutputTokens} |`,
    `| Estimated actual tokens avoided | ${report.estimatedActualTokensAvoided} |`,
    `| Estimated projected tokens avoided | ${report.estimatedProjectedTokensAvoided} |`,
    `| Missing fanout summaries | ${report.reviewsMissingFanoutSummary} |`,
    "",
    "Token savings are estimates from observed per-role model-attempt averages in this input. Treat the specialist call counts as the primary fact when samples are small.",
    "",
    "## Modes",
    "",
    "| Mode | Reviews | Actual avoided | Projected avoided |",
    "| --- | ---: | ---: | ---: |",
  ]
  for (const [mode, s] of Object.entries(report.byMode).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${mode} | ${s.reviews} | ${s.actualSpecialistCallsAvoided} | ${s.projectedSpecialistCallsAvoided} |`)
  }
  lines.push("", "## Skipped Roles", "", "| Role | Actual skips | Projected skips |", "| --- | ---: | ---: |")
  for (const role of SPECIALIST_ROLES) {
    const s = report.roleSavings[role] ?? { actualSkips: 0, projectedSkips: 0 }
    lines.push(`| ${role} | ${s.actualSkips} | ${s.projectedSkips} |`)
  }
  lines.push(
    "",
    "## Recent Reviews",
    "",
    "| Review | Mode | Type | Actual | Projected | Not invoked |",
    "| --- | --- | --- | ---: | ---: | --- |",
  )
  for (const r of report.reviews.slice(0, 20)) {
    lines.push(
      `| ${r.reviewKey} | ${r.mode} | ${r.savingsType} | ${r.actualSpecialistCallsAvoided} | ${r.projectedSpecialistCallsAvoided} | ${emptyDash(r.actualNotInvokedRoles.join(", "))} |`,
    )
  }
  return lines.join("\n")
}

function normalizeParsedValue(parsed: unknown): { events: DispatchMonitorEvent[]; skippedLines: number } {
  const events: DispatchMonitorEvent[] = []
  let skippedLines = 0
  const inputs = Array.isArray(parsed) ? parsed : [parsed]
  for (const input of inputs) {
    const unwrapped = unwrapLogpushEnvelope(input)
    const candidates = Array.isArray(unwrapped) ? unwrapped : [unwrapped]
    for (const obj of candidates) {
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
        skippedLines++
        continue
      }
      const event = normalizeEvent(obj as Record<string, unknown>)
      if (event) events.push(event)
      else skippedLines++
    }
  }
  return { events, skippedLines }
}

function normalizeEvent(obj: Record<string, unknown>): DispatchMonitorEvent | null {
  const event = stringValue(obj.event)
  if (event === "dispatcher-savings-summary") return normalizeSavings(obj)
  if (event === "model-attempt-completed") return normalizeModelAttempt(obj)
  if (event === "specialist-fanout-summary") return normalizeFanout(obj)
  return null
}

function normalizeSavings(obj: Record<string, unknown>): DispatchSavingsEvent | null {
  const reviewKey = reviewKeyFrom(obj)
  if (!reviewKey) return null
  return {
    kind: "dispatch",
    reviewKey,
    mode: stringValue(obj.mode) ?? "unknown",
    savingsType: obj.savingsType === "shadow" ? "shadow" : "actual",
    baselineSpecialists: stringArray(obj.baselineSpecialists),
    dispatcherSpecialists: stringArray(obj.dispatcherSpecialists),
    actualSpecialists: stringArray(obj.actualSpecialists),
    projectedSkippedRoles: stringArray(obj.projectedSkippedRoles),
    actualNotInvokedRoles: stringArray(obj.actualNotInvokedRoles),
    projectedSpecialistCallsAvoided: numberValue(obj.projectedSpecialistCallsAvoided) ?? 0,
    actualSpecialistCallsAvoided: numberValue(obj.actualSpecialistCallsAvoided) ?? 0,
    llmOutcome: stringValue(recordValue(obj.layerVotes)?.llmOutcome) ?? "unknown",
  }
}

function normalizeModelAttempt(obj: Record<string, unknown>): ModelAttemptEvent | null {
  const reviewKey = reviewKeyFrom(obj)
  if (!reviewKey) return null
  const out: ModelAttemptEvent = {
    kind: "model-attempt",
    reviewKey,
    phase: stringValue(obj.phase) ?? "unknown",
    role: stringValue(obj.role) ?? "unknown",
  }
  const model = stringValue(obj.model)
  if (model !== undefined) out.model = model
  const inputTokens = numberValue(obj.inputTokens)
  if (inputTokens !== undefined) out.inputTokens = inputTokens
  const outputTokens = numberValue(obj.outputTokens)
  if (outputTokens !== undefined) out.outputTokens = outputTokens
  return out
}

function normalizeFanout(obj: Record<string, unknown>): FanoutSummaryEvent | null {
  const reviewKey = reviewKeyFrom(obj)
  if (!reviewKey) return null
  return { kind: "fanout", reviewKey, dispatchedRoles: stringArray(obj.dispatchedRoles) }
}

function reviewKeyFrom(obj: Record<string, unknown>): string | null {
  const explicit = stringValue(obj.reviewKey)
  if (explicit) return explicit
  const owner = stringValue(obj.owner)
  const repo = stringValue(obj.repo)
  const prNumber = numberValue(obj.prNumber)
  const headSha = stringValue(obj.headSha)
  if (!owner || !repo || prNumber === undefined || !headSha) return null
  return `${owner}/${repo}#${prNumber}@${headSha.slice(0, 7)}`
}

function averageTokens(bucket: { tokens: number; attempts: number } | undefined): number | null {
  if (!bucket || bucket.attempts === 0) return null
  return bucket.tokens / bucket.attempts
}

function isSpecialist(role: string): role is Specialist {
  return (SPECIALIST_ROLES as readonly string[]).includes(role)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string")
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function emptyDash(value: string): string {
  return value.length > 0 ? value : "-"
}
