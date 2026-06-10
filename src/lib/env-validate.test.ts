import { describe, expect, it, vi, afterEach } from "vitest"
import { parseValidateMode, validateEnv } from "@/lib/env-validate"
import type { Env } from "@/shared/types/env"

afterEach(() => {
  vi.restoreAllMocks()
})

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: {} as KVNamespace,
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
    AI: {} as Ai,
    OPENCLAW_JOBS: {} as Queue<never>,
    LINEAR_API_KEY: "x",
    LINEAR_WEBHOOK_SECRET: "x",
    OLLAMA_API_KEY: "x",
    ...overrides,
  } as Env
}

describe("parseValidateMode", () => {
  it("returns 'strict' for the exact lowercase string", () => {
    expect(parseValidateMode("strict")).toBe("strict")
  })

  it("returns 'warn' for the exact lowercase string", () => {
    expect(parseValidateMode("warn")).toBe("warn")
  })

  it("defaults case-mismatched 'STRICT' to 'warn' (no silent promotion)", () => {
    expect(parseValidateMode("STRICT")).toBe("warn")
    expect(parseValidateMode("Strict")).toBe("warn")
  })

  it("defaults typos like 'strict-ish' to 'warn'", () => {
    expect(parseValidateMode("strict-ish")).toBe("warn")
  })

  it("defaults boolean-ish strings to 'warn'", () => {
    expect(parseValidateMode("true")).toBe("warn")
    expect(parseValidateMode("error")).toBe("warn")
    expect(parseValidateMode("off")).toBe("warn")
  })

  it("defaults undefined to 'warn'", () => {
    expect(parseValidateMode(undefined)).toBe("warn")
  })

  it("defaults empty string to 'warn'", () => {
    expect(parseValidateMode("")).toBe("warn")
  })
})

describe("validateEnv", () => {
  it("does nothing when team-repo map is unset (Phase 1 not configured)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(() => validateEnv(makeEnv(), "strict")).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it("does nothing when both maps are consistent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = makeEnv({
      OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({
        ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
      }),
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({
        "Arc-and-Anchor/rema-portal": "12345",
      }),
    })
    expect(() => validateEnv(env, "strict")).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it("throws a generic error in strict mode when a team-repo references a missing install", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const env = makeEnv({
      OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({
        ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
        RFD: { owner: "Arc-and-Anchor", repo: "rubberfit-desktop" },
      }),
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({
        "Arc-and-Anchor/rema-portal": "12345",
      }),
    })
    // Thrown error must NOT include team / repo names (those reach the
    // public 500 response in strict mode) — full diagnostic stays in logs.
    expect(() => validateEnv(env, "strict")).toThrow("GitHub installation mapping validation failed")
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0]?.[0] ?? "")).toMatch(/RFD → Arc-and-Anchor\/rubberfit-desktop/)
  })

  it("warns (does not throw) in warn mode when entries are missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = makeEnv({
      OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({
        ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
      }),
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({}),
    })
    expect(() => validateEnv(env, "warn")).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    // warn-mode keeps full detail in the warning (only the strict-mode
    // throw is sanitized — the warn console output is server-side only).
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toMatch(/ARC → Arc-and-Anchor\/rema-portal/)
  })

  it("warns when team-repo present but install map missing entirely", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = makeEnv({
      OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({
        ARC: { owner: "Arc-and-Anchor", repo: "rema-portal" },
      }),
      // OPENCLAW_GITHUB_INSTALLATION_MAP unset → resolveInstallation returns
      // no_installation, which we DO surface as a warning so operators see it.
    })
    expect(() => validateEnv(env, "warn")).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("strict mode throws when team-repo map is set but malformed JSON (not silently no-op)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const env = makeEnv({
      OPENCLAW_TEAM_GITHUB_REPO_MAP: "{not json",
    })
    // Without this distinction, malformed JSON would silently disable
    // Phase 1 — strict-mode contract says "loud failure on misconfig".
    expect(() => validateEnv(env, "strict")).toThrow("GitHub installation mapping validation failed")
    expect(error).toHaveBeenCalled()
  })

  it("warn mode warns (does not throw) when team-repo map is set but malformed JSON", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const env = makeEnv({
      OPENCLAW_TEAM_GITHUB_REPO_MAP: "{not json",
    })
    expect(() => validateEnv(env, "warn")).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toMatch(/produced no usable team→repo mappings/)
  })

  it("strict mode throws when team-repo map is set but wrong shape (e.g. array)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const env = makeEnv({
      OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify(["not", "an", "object"]),
    })
    expect(() => validateEnv(env, "strict")).toThrow("GitHub installation mapping validation failed")
    expect(error).toHaveBeenCalled()
  })
})
