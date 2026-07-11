import { describe, expect, it } from "vitest"
import { renderConnectedAppEvidence } from "./render"

describe("renderConnectedAppEvidence", () => {
  it("uses only fixed Sigilix-authored copy", () => {
    expect(
      renderConnectedAppEvidence([
        { kind: "vercel-deployment-status", state: "ready", matchingDeployments: 1 },
        {
          kind: "supabase-advisors",
          advisorType: "security",
          total: 3,
          errors: 2,
          warnings: 1,
          infos: 0,
        },
      ]),
    ).toBe(
      [
        "### Connected app evidence",
        "",
        "- **Vercel:** 1 exact-match deployment is ready.",
        "- **Supabase security:** 3 advisor lints (2 errors, 1 warning, 0 info).",
      ].join("\n"),
    )
  })

  it("omits an empty section", () => {
    expect(renderConnectedAppEvidence([])).toBeNull()
  })
})
