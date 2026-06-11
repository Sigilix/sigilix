// SIG-280 PR C: the calibration CONSUME contract — the params shape, the
// `shouldKeepSoften` veto rule, and the KV-blob parser the ensemble's warm
// veto reads. Believability-dominant: every ambiguous / malformed / missing
// case must resolve to VETO (don't soften), never to "keep softening".

import { describe, it, expect } from "vitest"
import {
  CLAIM_SOFTEN_TRUSTWORTHY_N,
  CLAIM_SOFTEN_LOWER_BOUND,
  CALIBRATION_PARAMS_KV_KEY,
  parseCalibrationBlob,
  readCalibrationParams,
  shouldKeepSoften,
  decideWarmSoftenSurvival,
  type ClaimCalibrationParams,
  type WarmSoftenCandidate,
  type CalibrationBlob,
} from "@/src/lib/review-memory/calibration"

const usable: ClaimCalibrationParams = {
  lowerBound: 0.85,
  n: 140,
  s: 130,
  trustworthyN: true,
  cold: false,
}

describe("SIG-280 PR C calibration thresholds", () => {
  it("pins the trustworthy-N floor and lower-bound threshold (believability)", () => {
    expect(CLAIM_SOFTEN_TRUSTWORTHY_N).toBe(100)
    expect(CLAIM_SOFTEN_LOWER_BOUND).toBe(0.8)
  })
  it("pins the params KV key", () => {
    expect(CALIBRATION_PARAMS_KV_KEY).toBe("calibration-params:v1:claim-types")
  })
})

describe("shouldKeepSoften — VETO unless ALL conditions hold", () => {
  it("keeps soften only when warm + trustworthy + lower-bound >= 0.80", () => {
    expect(shouldKeepSoften(usable)).toBe(true)
  })
  it("vetoes when params are undefined (claim type absent from blob)", () => {
    expect(shouldKeepSoften(undefined)).toBe(false)
  })
  it("vetoes when the fit marked the type cold even if the bound looks good", () => {
    expect(shouldKeepSoften({ ...usable, cold: true })).toBe(false)
  })
  it("vetoes when n is below the trustworthy floor", () => {
    expect(shouldKeepSoften({ ...usable, trustworthyN: false })).toBe(false)
  })
  it("vetoes when the 95% lower bound is below 0.80", () => {
    expect(shouldKeepSoften({ ...usable, lowerBound: 0.79 })).toBe(false)
  })
  it("keeps soften exactly at the 0.80 boundary (>=)", () => {
    expect(shouldKeepSoften({ ...usable, lowerBound: 0.8 })).toBe(true)
  })
  it("vetoes on a NaN/garbage lower bound", () => {
    expect(shouldKeepSoften({ ...usable, lowerBound: Number.NaN })).toBe(false)
  })
})

describe("parseCalibrationBlob", () => {
  it("returns null on null / empty / non-JSON input", () => {
    expect(parseCalibrationBlob(null)).toBeNull()
    expect(parseCalibrationBlob("")).toBeNull()
    expect(parseCalibrationBlob("not json{")).toBeNull()
  })
  it("returns null when the top level is not an object", () => {
    expect(parseCalibrationBlob("[]")).toBeNull()
    expect(parseCalibrationBlob("42")).toBeNull()
  })
  it("parses a well-formed blob keyed by known claim type", () => {
    const blob = parseCalibrationBlob(
      JSON.stringify({
        "auth-gate-is-boundary": usable,
      }),
    )
    expect(blob).not.toBeNull()
    expect(blob?.["auth-gate-is-boundary"]).toEqual(usable)
    expect(shouldKeepSoften(blob?.["auth-gate-is-boundary"])).toBe(true)
  })
  it("drops unknown claim types (forward-compat with future enum values)", () => {
    const blob = parseCalibrationBlob(
      JSON.stringify({
        "auth-gate-is-boundary": usable,
        "some-future-claim-type": usable,
      }),
    )
    expect(blob).not.toBeNull()
    expect(blob?.["auth-gate-is-boundary"]).toBeDefined()
    expect((blob as Record<string, unknown>)["some-future-claim-type"]).toBeUndefined()
  })
  it("drops entries with the wrong field types (→ that type vetoes)", () => {
    const blob = parseCalibrationBlob(
      JSON.stringify({
        "auth-gate-is-boundary": {
          lowerBound: "high",
          n: 140,
          s: 130,
          trustworthyN: true,
          cold: false,
        },
        "rethrowing-catch-not-swallowed": usable,
      }),
    )
    expect(blob?.["auth-gate-is-boundary"]).toBeUndefined()
    expect(blob?.["rethrowing-catch-not-swallowed"]).toBeDefined()
  })
  it("drops out-of-range / corrupt entries that could otherwise authorize soften (Codex P2)", () => {
    const corruptCases: Record<string, unknown> = {
      // lowerBound > 1 with trustworthy+warm would otherwise pass shouldKeepSoften
      "auth-gate-is-boundary": { lowerBound: 2, n: 200, s: 200, trustworthyN: true, cold: false },
      // successes exceed denominator → impossible → drop
      "structural-glue-not-test-target": {
        lowerBound: 0.9,
        n: 100,
        s: 999,
        trustworthyN: true,
        cold: false,
      },
      // negative / non-integer counts
      "globally-unique-id-is-tenant-isolation": {
        lowerBound: 0.9,
        n: -5,
        s: 0,
        trustworthyN: true,
        cold: false,
      },
      // a valid control that must SURVIVE
      "rethrowing-catch-not-swallowed": usable,
    }
    const blob = parseCalibrationBlob(JSON.stringify(corruptCases))
    expect(blob?.["auth-gate-is-boundary"]).toBeUndefined()
    expect(blob?.["structural-glue-not-test-target"]).toBeUndefined()
    expect(blob?.["globally-unique-id-is-tenant-isolation"]).toBeUndefined()
    expect(blob?.["rethrowing-catch-not-swallowed"]).toBeDefined()
  })
  it("shouldKeepSoften independently rejects a lowerBound above 1", () => {
    expect(shouldKeepSoften({ ...usable, lowerBound: 1.5 })).toBe(false)
  })
})

describe("readCalibrationParams — fail-safe KV read", () => {
  it("reads + parses the blob from the configured key", async () => {
    const kv = {
      get: async (key: string) =>
        key === CALIBRATION_PARAMS_KV_KEY ? JSON.stringify({ "auth-gate-is-boundary": usable }) : null,
    }
    const blob = await readCalibrationParams(kv)
    expect(blob?.["auth-gate-is-boundary"]).toBeDefined()
  })
  it("returns null on a KV miss (→ cold regime)", async () => {
    expect(await readCalibrationParams({ get: async () => null })).toBeNull()
  })
  it("returns null when the KV get throws (never propagates onto the review path)", async () => {
    const kv = {
      get: async () => {
        throw new Error("kv down")
      },
    }
    expect(await readCalibrationParams(kv)).toBeNull()
  })
})

describe("decideWarmSoftenSurvival — believability-dominant per-finding veto", () => {
  const blob: CalibrationBlob = {
    "auth-gate-is-boundary": usable, // warm + trustworthy + bound>=0.80
    "structural-glue-not-test-target": { ...usable, cold: true }, // cold → veto
    "rethrowing-catch-not-swallowed": { ...usable, lowerBound: 0.5 }, // low bound → veto
  }
  function cand(over: Partial<WarmSoftenCandidate>): WarmSoftenCandidate {
    return { index: 0, fid: "f", matchedTypes: [], ...over }
  }

  it("keeps a soften that matched a trustworthy, high-bound claim type", () => {
    const decisions = decideWarmSoftenSurvival({
      candidates: [cand({ index: 3, matchedTypes: ["auth-gate-is-boundary"] })],
      blob,
    })
    expect(decisions[0]?.kept).toBe(true)
    expect(decisions[0]?.index).toBe(3)
    expect(decisions[0]?.keepingTypes).toEqual(["auth-gate-is-boundary"])
  })

  it("VETOES a finding with NO matched claim type (synth softened on category only)", () => {
    const decisions = decideWarmSoftenSurvival({ candidates: [cand({ matchedTypes: [] })], blob })
    expect(decisions[0]?.kept).toBe(false)
  })

  it("VETOES when matched types are only cold or low-bound", () => {
    const decisions = decideWarmSoftenSurvival({
      candidates: [
        cand({
          matchedTypes: ["structural-glue-not-test-target", "rethrowing-catch-not-swallowed"],
        }),
      ],
      blob,
    })
    expect(decisions[0]?.kept).toBe(false)
  })

  it("keeps when ANY matched type is trustworthy (mixed cold + warm)", () => {
    const decisions = decideWarmSoftenSurvival({
      candidates: [cand({ matchedTypes: ["structural-glue-not-test-target", "auth-gate-is-boundary"] })],
      blob,
    })
    expect(decisions[0]?.kept).toBe(true)
  })

  it("decides PER candidate index — a kept finding never marks a sibling kept", () => {
    const decisions = decideWarmSoftenSurvival({
      candidates: [
        cand({ index: 0, matchedTypes: ["auth-gate-is-boundary"] }), // keep
        cand({ index: 1, matchedTypes: [] }), // veto — must stay vetoed
      ],
      blob,
    })
    expect(decisions.find((d) => d.index === 0)?.kept).toBe(true)
    expect(decisions.find((d) => d.index === 1)?.kept).toBe(false)
  })

  it("VETOES every candidate against an empty blob (cold regime safety)", () => {
    const decisions = decideWarmSoftenSurvival({
      candidates: [cand({ matchedTypes: ["auth-gate-is-boundary"] })],
      blob: {},
    })
    expect(decisions.every((d) => !d.kept)).toBe(true)
  })
})
