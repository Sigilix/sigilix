#!/usr/bin/env node
// Summarizes the 15 paired shadow telemetry records.
// Schema (corrected after seeing the real records):
//   specialistVerdicts[i] = {
//     role, model, modelUsed, attemptsUsed,
//     verdict: { summary, confidence, findings: [...] } | null,
//     failureReason?: string,
//     elapsedMs, timedOut
//   }
//   synthesizer = { model, modelUsed, attemptsUsed, verdict, provenance,
//                   retrievalCallsUsed, elapsedMs, timedOut } | null

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const RAW = ".claude/research/phase4b-shadow/raw"
const records = readdirSync(RAW)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, data: JSON.parse(readFileSync(join(RAW, f), "utf8")) }))

const N = records.length
const ROLES = ["logic", "security", "performance", "tests"]

// per-record summaries
const perPR = records.map(({ file, data }) => {
  const sv = Array.isArray(data.specialistVerdicts) ? data.specialistVerdicts : []
  const specialists = sv.map((s) => ({
    role: s.role,
    success: s.verdict !== null && s.verdict !== undefined,
    timedOut: s.timedOut === true,
    failureReason: s.failureReason ?? null,
    modelPrimary: s.model,
    modelUsed: s.modelUsed,
    attemptsUsed: s.attemptsUsed,
    elapsedMs: s.elapsedMs,
    findingsCount: s.verdict?.findings?.length ?? 0,
    confidence: s.verdict?.confidence ?? null,
  }))
  const successCount = specialists.filter((s) => s.success).length
  const synth = data.synthesizer
    ? {
        success: data.synthesizer.verdict !== null && data.synthesizer.verdict !== undefined,
        timedOut: data.synthesizer.timedOut === true,
        elapsedMs: data.synthesizer.elapsedMs,
        attemptsUsed: data.synthesizer.attemptsUsed,
        modelUsed: data.synthesizer.modelUsed,
        finalFindings: data.synthesizer.verdict?.findings?.length ?? 0,
        droppedByPostVal: data.postValidation?.droppedForHallucination
          ?? data.postValidation?.droppedForInvalidLine
          ?? 0,
      }
    : null
  return {
    file,
    pr: `${data.owner}/${data.repo}#${data.prNumber}`,
    sha: data.headSha?.slice(0, 7),
    mode: data.mode,
    totalMs: data.totalMs,
    fellBackToPhase3: data.fellBackToPhase3,
    fellBackReason: data.fellBackReason,
    internalError: data.internalError,
    routerDecision: data.routerDecision?.reason,
    quorum: `${successCount}/4`,
    quorumOK: successCount >= 2,
    specialists,
    synth,
    postValidation: data.postValidation,
    retrievalCacheStats: data.retrievalCacheStats,
    startMs: data.startMs,
  }
})

// aggregates
const wallTimes = perPR.map((p) => p.totalMs).filter((v) => typeof v === "number").sort((a, b) => a - b)
const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null)
const p95 = (arr) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))] : null)

const fellBack = perPR.filter((p) => p.fellBackToPhase3).length
const synthRan = perPR.filter((p) => p.synth).length
const synthSucceeded = perPR.filter((p) => p.synth?.success).length
const fullyHealthy = perPR.filter((p) => p.quorum === "4/4" && p.synth?.success).length

const fellBackReasons = {}
for (const p of perPR) {
  if (p.fellBackReason) fellBackReasons[p.fellBackReason] = (fellBackReasons[p.fellBackReason] ?? 0) + 1
}

// per-specialist
const perRole = {}
for (const role of ROLES) {
  const all = perPR.flatMap((p) => p.specialists.filter((s) => s.role === role))
  const succ = all.filter((s) => s.success)
  const fail = all.filter((s) => !s.success)
  const lat = succ.map((s) => s.elapsedMs).filter((v) => typeof v === "number").sort((a, b) => a - b)
  const findings = succ.map((s) => s.findingsCount)
  const reasonCounts = {}
  for (const s of fail) {
    const key = s.failureReason ?? (s.timedOut ? "timeout" : "unknown")
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1
  }
  const fellToFallback = succ.filter((s) => s.modelUsed !== s.modelPrimary).length
  perRole[role] = {
    runs: all.length,
    successes: succ.length,
    successRate: all.length ? +((succ.length / all.length) * 100).toFixed(0) : null,
    meanFindings: findings.length ? +(findings.reduce((a, b) => a + b, 0) / findings.length).toFixed(2) : null,
    medianLatencyMs: median(lat),
    p95LatencyMs: p95(lat),
    fellToFallbackCount: fellToFallback,
    failureReasons: Object.fromEntries(Object.entries(reasonCounts).sort(([, a], [, b]) => b - a)),
  }
}

const summary = {
  totalRecords: N,
  fullyHealthy,
  partiallyHealthy: perPR.filter((p) => p.quorumOK && !p.synth?.success).length,
  quorumLost: perPR.filter((p) => !p.quorumOK).length,
  wallClock: { medianMs: median(wallTimes), p95Ms: p95(wallTimes), maxMs: wallTimes[wallTimes.length - 1] },
  fellBack,
  fellBackReasons,
  synthRan,
  synthSucceeded,
  perSpecialist: perRole,
  perPR: perPR.map((p) => ({
    ts: new Date(p.startMs).toISOString().slice(0, 19),
    pr: p.pr,
    sha: p.sha,
    quorum: p.quorum,
    synth: p.synth?.success ? "ok" : (p.synth ? "fail" : "—"),
    finalFindings: p.synth?.finalFindings ?? "—",
    totalS: +(p.totalMs / 1000).toFixed(0),
    fellBack: p.fellBackToPhase3,
    fellBackReason: p.fellBackReason,
    perSpec: p.specialists.reduce((acc, s) => {
      acc[s.role] = s.success ? `${(s.elapsedMs / 1000).toFixed(0)}s` : (s.failureReason ?? (s.timedOut ? "timeout" : "—")).slice(0, 18)
      return acc
    }, {}),
  })),
}

writeFileSync(".claude/research/phase4b-shadow/_summary.json", JSON.stringify(summary, null, 2))

// human report
let md = `# Phase 4b shadow data — corrected summary

**Total records:** ${N}
**Fully healthy (4/4 specialists + synth ok):** ${fullyHealthy} / ${N}
**Partially healthy (≥2 specialists ok but synth failed):** ${summary.partiallyHealthy} / ${N}
**Quorum lost (<2 specialists succeeded):** ${summary.quorumLost} / ${N}
**Fell back to Phase 3:** ${fellBack} / ${N}

## Mechanical health

- Wall-clock: median **${(median(wallTimes) / 1000).toFixed(1)}s** · p95 **${(p95(wallTimes) / 1000).toFixed(1)}s** · max **${(wallTimes[wallTimes.length - 1] / 1000).toFixed(1)}s**
- Synthesizer: ran on **${synthRan}/${N}** · succeeded on **${synthSucceeded}/${synthRan}**
- Fell-back reasons: ${Object.entries(fellBackReasons).map(([k, v]) => `\`${k}\` × ${v}`).join(", ") || "none"}

## Per-specialist

| Role | Runs | Success rate | Fell to fallback | Median latency | p95 latency | Mean findings | Top failure reasons |
|------|------|--------------|------------------|----------------|-------------|---------------|----------------------|
${ROLES.map((r) => {
  const x = perRole[r]
  // Provider error strings can contain raw newlines and pipe characters
  // that break Markdown table cells. Single-line + escape pipes before
  // interpolating (CR catch on PR #42).
  const safe = (s) => String(s).replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim()
  const reasons = Object.entries(x.failureReasons).slice(0, 2).map(([k, v]) => `${safe(k)}×${v}`).join(", ") || "—"
  return `| ${r} | ${x.runs} | ${x.successRate}% | ${x.fellToFallbackCount} | ${x.medianLatencyMs ? (x.medianLatencyMs / 1000).toFixed(1) + "s" : "—"} | ${x.p95LatencyMs ? (x.p95LatencyMs / 1000).toFixed(1) + "s" : "—"} | ${x.meanFindings ?? "—"} | ${reasons} |`
}).join("\n")}

## Per-record (chronological)

| Time (UTC) | PR | SHA | Quorum | Synth | Findings | Total | FellBack | Logic | Security | Perf | Tests |
|------------|----|-----|--------|-------|----------|-------|----------|-------|----------|------|-------|
${summary.perPR.sort((a, b) => a.ts.localeCompare(b.ts)).map((p) => {
  // Same defensive escape — failure strings in per-spec cells can carry
  // newlines + pipes from upstream provider errors.
  const safe = (s) => String(s ?? "—").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|").trim()
  return `| ${p.ts.slice(11)} | ${safe(p.pr.split("/")[1])} | ${p.sha} | ${p.quorum} | ${p.synth} | ${p.finalFindings} | ${p.totalS}s | ${safe(p.fellBackReason ?? "—")} | ${safe(p.perSpec.logic)} | ${safe(p.perSpec.security)} | ${safe(p.perSpec.performance)} | ${safe(p.perSpec.tests)} |`
}).join("\n")}
`

writeFileSync(".claude/research/phase4b-shadow/_report.md", md)
console.log(md)
