import {
  isToolCompatibleWithRuntimeApp,
  resolveRuntimeApp,
  type RuntimeMcpAppDefinition,
} from "@/src/shared/domain/runtime-app-registry"
import { vendorPolicyForUrl } from "./runtime-policy"

export type RuntimeAppSelector =
  | { kind: "generic" }
  | { kind: "invalid" }
  | { kind: "unavailable" }
  | { kind: "resolved"; app: RuntimeMcpAppDefinition }

/** Resolve an untrusted selector without accepting vendor names or URLs. */
export function resolveMcpRuntimeAppSelector(value: unknown): RuntimeAppSelector {
  if (value === undefined) return { kind: "generic" }
  const app = resolveRuntimeApp(value)
  if (!app) return { kind: "invalid" }
  if (!app.executable || app.kind !== "mcp") return { kind: "unavailable" }
  return { kind: "resolved", app }
}

/** Reject non-official endpoints before any owner-vault lookup. */
export function runtimeAppMatchesEndpoint(app: RuntimeMcpAppDefinition, serverUrl: string): boolean {
  return vendorPolicyForUrl(serverUrl)?.vendor === app.vendor
}

/** App-level narrowing is independent from the vendor and tenant policies. */
export function runtimeAppAllowsTool(app: RuntimeMcpAppDefinition, vendor: string, toolName: string): boolean {
  return isToolCompatibleWithRuntimeApp(app.id, vendor, toolName)
}

export function hasRuntimeAppPolicyTool(app: RuntimeMcpAppDefinition, toolNames: readonly string[]): boolean {
  return toolNames.some((toolName) => runtimeAppAllowsTool(app, app.vendor, toolName))
}
