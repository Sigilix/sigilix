// SIG-184 (CodeRabbit): the runner-evidence identity contract is split across
// two files — the worker's `wrangler.toml` [vars] and the dogfood caller
// workflow `.github/workflows/sigilix-runner.yml`. If they drift, the OIDC
// provenance gate silently rejects every receipt at RUNTIME with no build-time
// signal. This guard fails the build the moment the two diverge.
//
// Dependency-free on purpose (no yaml/toml parser is a direct dep): the four
// contract values are extracted with targeted regexes.

import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const readRepo = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8")

const wrangler = readRepo("wrangler.toml")
const workflow = readRepo(".github/workflows/sigilix-runner.yml")

// Worker side (wrangler.toml [vars]).
const audienceVar = /OPENCLAW_RUNNER_OIDC_AUDIENCE\s*=\s*"([^"]+)"/.exec(wrangler)?.[1]
const workflowRefVar = /OPENCLAW_RUNNER_WORKFLOW_REF\s*=\s*"([^"]+)"/.exec(wrangler)?.[1]
// Caller side (the dogfood workflow). The `uses:` carries an `@<sha>` pin the
// worker's WORKFLOW_REF does not (the provenance gate matches the path, not the
// ref), so strip it before comparing.
const usesPath = /uses:\s*(\S+)/.exec(workflow)?.[1]?.replace(/@[0-9a-fA-F]+$/, "")
const audienceInput = /oidc-audience:\s*(\S+)/.exec(workflow)?.[1]

// Mirror the provenance gate: owner/repo compared case-INSENSITIVELY, the rest
// of the path case-SENSITIVELY (GitHub paths are case-sensitive).
const ownerRepo = (ref: string): string => ref.split("/").slice(0, 2).join("/").toLowerCase()
const pathPart = (ref: string): string => ref.split("/").slice(2).join("/")

describe("runner-evidence identity contract (wrangler.toml ↔ dogfood workflow)", () => {
  it("all four contract values are present in their files", () => {
    expect(audienceVar, "OPENCLAW_RUNNER_OIDC_AUDIENCE in wrangler.toml").toBeTruthy()
    expect(workflowRefVar, "OPENCLAW_RUNNER_WORKFLOW_REF in wrangler.toml").toBeTruthy()
    expect(usesPath, "jobs.evidence.uses in sigilix-runner.yml").toBeTruthy()
    expect(audienceInput, "oidc-audience input in sigilix-runner.yml").toBeTruthy()
  })

  it("OPENCLAW_RUNNER_WORKFLOW_REF matches the workflow `uses:` path (the provenance gate's owner/repo + path rules)", () => {
    expect(ownerRepo(workflowRefVar!)).toBe(ownerRepo(usesPath!)) // case-insensitive
    expect(pathPart(workflowRefVar!)).toBe(pathPart(usesPath!)) // case-sensitive
  })

  it("OPENCLAW_RUNNER_OIDC_AUDIENCE matches the workflow `oidc-audience` input exactly", () => {
    // The ingest route requires the token's `aud` (== this input) to equal the
    // configured audience byte-for-byte.
    expect(audienceVar).toBe(audienceInput)
  })
})
