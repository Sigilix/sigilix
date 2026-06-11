// SIG-114 — render an FpRateReport as CSV + markdown (pure).

import type { FpRateReport, RoleRate } from "./compute"

export interface ReportMeta {
  repo: string
  windowDays: number
  maturityDays: number
  generatedIso: string
  totalDismissals: number
}

function pct(x: number | null): string {
  if (x === null) return "n/a"
  return (x * 100).toFixed(1) + "%"
}

function meetsCell(r: RoleRate): string {
  if (!r.sufficientN) return "insufficient-n"
  if (r.observedMeetsTarget === null) return "n/a"
  return r.observedMeetsTarget ? "yes" : "NO"
}

export const FP_RATE_CSV_HEADER =
  "specialist,posted_n,hard_fp,soft_fp,unlabeled,hard_fp_rate,wilson_lower,wilson_upper,sufficient_n,meets_target"

/** CSV: one header + one row per specialist + synth. Pure. */
export function formatCsv(report: FpRateReport): string {
  const lines = [FP_RATE_CSV_HEADER]
  for (const r of report.rows) {
    lines.push(
      [
        r.role,
        r.postedN,
        r.hard,
        r.soft,
        r.unlabeled,
        r.hardFpRate === null ? "n/a" : (r.hardFpRate * 100).toFixed(1),
        (r.wilsonLower * 100).toFixed(1),
        (r.wilsonUpper * 100).toFixed(1),
        r.sufficientN ? "1" : "0",
        meetsCell(r),
      ].join(","),
    )
  }
  return lines.join("\n")
}

/** Human-readable markdown with the honesty caveat baked in. Pure. */
export function formatMarkdown(report: FpRateReport, meta: ReportMeta): string {
  const zeroPct =
    report.reviewsRealFanout > 0
      ? ((report.reviewsZeroPostedFindings / report.reviewsRealFanout) * 100).toFixed(0) + "%"
      : "n/a"

  const out: string[] = []
  out.push(`# Sigilix false-positive rate — ${meta.repo}`)
  out.push("")
  out.push(`Generated: ${meta.generatedIso}`)
  out.push(`Window: last ${meta.windowDays}d (excluding the most recent ${meta.maturityDays}d maturity lag)`)
  out.push("")
  out.push(`- Reviews scanned: ${report.reviewsScanned}`)
  out.push(
    `- Reviews where the ensemble ran (fanout): ${report.reviewsRealFanout} ` +
      `(${report.reviewsScanned - report.reviewsRealFanout} guard-skipped / merged / stale)`,
  )
  out.push(`- Reviews with zero posted score-4+ findings: ${report.reviewsZeroPostedFindings} (${zeroPct} of fanout)`)
  out.push(`- Dismissal signals (FP labels): ${meta.totalDismissals}`)
  out.push(
    `- Unattributed dismissals: ${report.unattributed.notFound} not-found, ` +
      `${report.unattributed.possiblyExpired} likely-TTL-expired`,
  )
  out.push("")
  out.push("| Specialist | Posted (4+) | Hard FP | Soft | Unlabeled | Hard-FP rate | Wilson 95% | Target | Meets? |")
  out.push("|---|---:|---:|---:|---:|---:|---|---:|---|")
  for (const r of report.rows) {
    const rate = r.hardFpRate === null ? "n/a" : pct(r.hardFpRate)
    const ci = `[${pct(r.wilsonLower)}, ${pct(r.wilsonUpper)}]`
    out.push(
      `| ${r.role} | ${r.postedN} | ${r.hard} | ${r.soft} | ${r.unlabeled} | ${rate} | ${ci} | ` +
        `<${(r.target * 100).toFixed(0)}% | ${meetsCell(r)} |`,
    )
  }
  out.push("")
  out.push("> **Honesty caveat.** This is a dismissal-based rate: a LOWER BOUND on the true")
  out.push("> false-positive rate (not every false positive is dismissed). The Wilson interval")
  out.push("> is sampling uncertainty on the *observed* rate. This metric tracks trend and a")
  out.push('> floor; it does NOT prove a ceiling ("FP rate is at most Y%") — that requires the')
  out.push("> curated ground-truth eval set. `unlabeled` dominates today because the dismissal")
  out.push("> capture pipeline does not yet emit a reason. `Meets?` is WORST-CASE: every")
  out.push("> unlabeled dismissal is counted as potentially-hard. `Posted (4+)` is the synth")
  out.push("> verdict's score-4+ findings; some may have been dropped by post-validation")
  out.push("> before posting (a follow-up will narrow it to the final submitted set).")
  return out.join("\n")
}
