import type { PrReviewMcpResult, PrReviewMcpToolDescriptor } from "@/src/features/pr-review-app-evidence/domain/types"

export interface PrReviewMcpRuntimePort {
  catalog(signal: AbortSignal): Promise<PrReviewMcpToolDescriptor[] | null>
  invoke(
    args: {
      serverId: string
      toolName: string
      arguments: Record<string, unknown>
    },
    signal: AbortSignal,
  ): Promise<PrReviewMcpResult | null>
}
