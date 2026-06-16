import type { LearningsMode } from "./types"

export function resolveLearningsMode(raw: string | undefined): LearningsMode {
  switch (raw) {
    case "shadow":
      return "shadow"
    case "on":
      return "on"
    default:
      return "off"
  }
}
