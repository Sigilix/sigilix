import { describe, expect, it } from "vitest"

import {
  buildDispatchMonitorReport,
  formatDispatchMonitorMarkdown,
  parseDispatchMonitorJsonl,
} from "@/src/lib/dispatch-monitor"

describe("dispatch monitor report", () => {
  it("summarizes actual and shadow dispatcher savings from flat JSONL", () => {
    const input = [
      JSON.stringify({
        event: "dispatcher-savings-summary",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 10,
        headSha: "abc1234",
        reviewKey: "Sigilix/sigilix#10@abc1234",
        mode: "enforce_rules",
        savingsType: "actual",
        baselineSpecialists: ["logic", "security", "performance", "tests"],
        dispatcherSpecialists: ["security"],
        actualSpecialists: ["security"],
        projectedSkippedRoles: ["logic", "performance", "tests"],
        actualNotInvokedRoles: ["logic", "performance", "tests"],
        projectedSpecialistCallsAvoided: 3,
        actualSpecialistCallsAvoided: 3,
        layerVotes: { llmOutcome: "skipped_rules_only_mode" },
      }),
      JSON.stringify({
        event: "dispatcher-savings-summary",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 11,
        headSha: "def5678",
        reviewKey: "Sigilix/sigilix#11@def5678",
        mode: "shadow",
        savingsType: "shadow",
        baselineSpecialists: ["logic", "security", "performance", "tests"],
        dispatcherSpecialists: ["logic", "security", "tests"],
        actualSpecialists: ["logic", "security", "performance", "tests"],
        projectedSkippedRoles: ["performance"],
        actualNotInvokedRoles: [],
        projectedSpecialistCallsAvoided: 1,
        actualSpecialistCallsAvoided: 0,
        layerVotes: { llmOutcome: "ok" },
      }),
      JSON.stringify({
        event: "model-attempt-completed",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 12,
        headSha: "9999999",
        phase: "specialist",
        role: "performance",
        inputTokens: 1200,
        outputTokens: 300,
      }),
      "not json",
    ].join("\n")

    const parsed = parseDispatchMonitorJsonl(input)
    expect(parsed.badLines).toBe(1)
    const report = buildDispatchMonitorReport(parsed.events)

    expect(report.dispatchReviews).toBe(2)
    expect(report.actualSpecialistCallsAvoided).toBe(3)
    expect(report.projectedSpecialistCallsAvoided).toBe(4)
    expect(report.byMode.enforce_rules?.reviews).toBe(1)
    expect(report.byMode.shadow?.reviews).toBe(1)
    expect(report.roleSavings.logic?.actualSkips).toBe(1)
    expect(report.roleSavings.performance?.actualSkips).toBe(1)
    expect(report.roleSavings.performance?.projectedSkips).toBe(2)
    expect(report.estimatedActualTokensAvoided).toBe(1500)
    expect(report.unknownTokenEstimateSkips).toEqual({ logic: 1, tests: 1 })
  })

  it("unwraps Cloudflare Logpush envelopes and handles missing fanout summaries", () => {
    const input = JSON.stringify({
      EventTimestampMs: 1760000000000,
      Logs: [
        {
          Message: [
            "prefix",
            JSON.stringify({
              event: "dispatcher-savings-summary",
              owner: "Sigilix",
              repo: "sigilix",
              prNumber: 20,
              headSha: "abc9999",
              mode: "enforce",
              savingsType: "actual",
              baselineSpecialists: ["logic", "security", "performance", "tests"],
              dispatcherSpecialists: ["logic", "security"],
              actualSpecialists: ["logic", "security"],
              projectedSkippedRoles: ["performance", "tests"],
              actualNotInvokedRoles: ["performance", "tests"],
              projectedSpecialistCallsAvoided: 2,
              actualSpecialistCallsAvoided: 2,
              layerVotes: { llmOutcome: "ok" },
            }),
          ],
        },
      ],
    })

    const parsed = parseDispatchMonitorJsonl(input)
    expect(parsed.events).toHaveLength(1)
    const report = buildDispatchMonitorReport(parsed.events)
    expect(report.reviewsMissingFanoutSummary).toBe(1)

    const md = formatDispatchMonitorMarkdown(report)
    expect(md).toContain("Dispatch Monitor")
    expect(md).toContain("Actual specialist calls avoided")
    expect(md).toContain("performance")
    expect(md).toContain("Missing fanout summaries")
    expect(md).toContain("Token savings are estimates")
  })

  it("parses top-level JSON arrays from batched exports", () => {
    const input = JSON.stringify([
      {
        event: "dispatcher-savings-summary",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 30,
        headSha: "aaa1111",
        mode: "enforce",
        savingsType: "actual",
        baselineSpecialists: ["logic", "security", "performance", "tests"],
        dispatcherSpecialists: ["logic", "security"],
        actualSpecialists: ["logic", "security"],
        projectedSkippedRoles: ["performance", "tests"],
        actualNotInvokedRoles: ["performance", "tests"],
        projectedSpecialistCallsAvoided: 2,
        actualSpecialistCallsAvoided: 2,
        layerVotes: { llmOutcome: "ok" },
      },
      {
        event: "specialist-fanout-summary",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 30,
        headSha: "aaa1111",
        dispatchedRoles: ["logic", "security"],
      },
    ])

    const parsed = parseDispatchMonitorJsonl(input)
    expect(parsed.badLines).toBe(0)
    expect(parsed.skippedLines).toBe(0)
    expect(parsed.events).toHaveLength(2)
    const report = buildDispatchMonitorReport(parsed.events)
    expect(report.dispatchReviews).toBe(1)
    expect(report.reviewsMissingFanoutSummary).toBe(0)
  })

  it("parses pretty multi-line wrangler tail JSON captures", () => {
    const input = [
      JSON.stringify(
        {
          logs: [
            {
              message: [
                JSON.stringify({
                  event: "dispatcher-savings-summary",
                  owner: "Sigilix",
                  repo: "sigilix",
                  prNumber: 40,
                  headSha: "bbb2222",
                  mode: "enforce",
                  savingsType: "actual",
                  baselineSpecialists: ["logic", "security", "performance", "tests"],
                  dispatcherSpecialists: ["logic", "security"],
                  actualSpecialists: ["logic", "security"],
                  projectedSkippedRoles: ["performance", "tests"],
                  actualNotInvokedRoles: ["performance", "tests"],
                  projectedSpecialistCallsAvoided: 2,
                  actualSpecialistCallsAvoided: 2,
                  layerVotes: { llmOutcome: "ok" },
                }),
              ],
            },
          ],
        },
        null,
        2,
      ),
      JSON.stringify(
        {
          logs: [
            {
              message: [
                JSON.stringify({
                  event: "specialist-fanout-summary",
                  owner: "Sigilix",
                  repo: "sigilix",
                  prNumber: 40,
                  headSha: "bbb2222",
                  dispatchedRoles: ["logic", "security"],
                }),
              ],
            },
          ],
        },
        null,
        2,
      ),
    ].join("\n")

    const parsed = parseDispatchMonitorJsonl(input)
    expect(parsed.badLines).toBe(0)
    expect(parsed.skippedLines).toBe(0)
    expect(parsed.events).toHaveLength(2)
    const report = buildDispatchMonitorReport(parsed.events)
    expect(report.dispatchReviews).toBe(1)
    expect(report.reviewsMissingFanoutSummary).toBe(0)
    expect(report.actualSpecialistCallsAvoided).toBe(2)
  })

  it("strips a UTF-8 BOM from the first JSON record", () => {
    const parsed = parseDispatchMonitorJsonl(
      `\uFEFF${JSON.stringify({
        event: "specialist-fanout-summary",
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 41,
        headSha: "ccc3333",
        dispatchedRoles: ["logic"],
      })}`,
    )

    expect(parsed.badLines).toBe(0)
    expect(parsed.events).toHaveLength(1)
  })

  it("fails closed on an oversized unterminated JSON record", () => {
    expect(() =>
      parseDispatchMonitorJsonl('{\n  "event": "dispatcher-savings-summary"', { maxRecordChars: 12 }),
    ).toThrow(/JSON record exceeds/)
  })
})
