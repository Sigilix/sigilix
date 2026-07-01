// SIG — repo-role classifier (pure, deterministic).
//
// Maps a repo's cheap index-time signals (`RepoRoleSignals`) to one of seven
// roles. The rules are a fixed, documented precedence over explicit signals —
// no model, no network, no randomness. The default is `unknown`: we FAIL SAFE
// rather than guess wildly, because a later slice will re-rank retrieval/review
// by this field and a confident-but-wrong role is worse than "don't know".
//
// This is additive metadata — nothing reads `role` yet. The classifier exists
// so the index job can stamp it; behavior is unchanged until a consumer ships.

import { gatherRepoRoleSignals, type RepoRoleSignals } from "@/src/features/repo-role/domain/signals"

/** The repo-role taxonomy. `unknown` is the fail-safe default. */
export type RepoRole = "frontend" | "backend" | "infra" | "library" | "mobile" | "fullstack" | "unknown"

/** Every role, for exhaustiveness/totality checks and validation. */
export const REPO_ROLES: readonly RepoRole[] = [
  "frontend",
  "backend",
  "infra",
  "library",
  "mobile",
  "fullstack",
  "unknown",
]

const REPO_ROLE_SET: ReadonlySet<string> = new Set(REPO_ROLES)

/** Runtime type-guard — used by the manifest parser to validate a stored role. */
export function isRepoRole(value: unknown): value is RepoRole {
  return typeof value === "string" && REPO_ROLE_SET.has(value)
}

// ---------------------------------------------------------------------
// Dependency vocabularies (lowercased). Membership is exact per package name.
// ---------------------------------------------------------------------

/** Frontend UI frameworks / build tools that signal a browser-facing surface. */
const FRONTEND_DEPS: ReadonlySet<string> = new Set([
  "react",
  "react-dom",
  "vue",
  "@vue/runtime-core",
  "svelte",
  "@angular/core",
  "@angular/common",
  "solid-js",
  "preact",
  "next",
  "nuxt",
  "gatsby",
  "remix",
  "@remix-run/react",
  "astro",
  "@sveltejs/kit",
  "vite",
  "@builder.io/qwik",
])

/** JS/TS server frameworks — a backend surface. */
const BACKEND_JS_DEPS: ReadonlySet<string> = new Set([
  "express",
  "fastify",
  "@nestjs/core",
  "koa",
  "hapi",
  "@hapi/hapi",
  "hono",
  "restify",
  "sails",
  "@adonisjs/core",
  "@feathersjs/feathers",
  "apollo-server",
  "@apollo/server",
])

/** Meta-frameworks that are fullstack-capable (FE with a server half). */
const META_FRAMEWORK_DEPS: ReadonlySet<string> = new Set([
  "next",
  "nuxt",
  "@sveltejs/kit",
  "remix",
  "@remix-run/node",
  "@redwoodjs/core",
  "blitz",
])

/** React-Native / Flutter mobile stacks (dep-driven). */
const MOBILE_DEPS: ReadonlySet<string> = new Set([
  "react-native",
  "expo",
  "@react-native/metro-config",
  "nativescript",
  "@ionic/react",
  "@ionic/angular",
  "@ionic/vue",
])

/** Frontend-surface file extensions (used for the FE file-share ratio). */
const FRONTEND_EXTENSIONS: readonly string[] = [".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss", ".less"]

function anyDep(deps: readonly string[], vocab: ReadonlySet<string>): boolean {
  for (const d of deps) {
    if (vocab.has(d)) return true
  }
  return false
}

function extShare(signals: RepoRoleSignals, extensions: readonly string[]): number {
  if (signals.countedFileCount <= 0) return 0
  let hit = 0
  for (const ext of extensions) hit += signals.extensionCounts[ext] ?? 0
  return hit / signals.countedFileCount
}

// ---------------------------------------------------------------------
// Derived predicates
// ---------------------------------------------------------------------

/** Minimum counted files before a file-ratio signal is trusted at all. */
const MIN_FILES_FOR_RATIO = 3
/** FE file-share at/above which the tree alone implies a frontend surface. */
const FRONTEND_FILE_SHARE = 0.4

function hasFrontend(signals: RepoRoleSignals): boolean {
  if (anyDep(signals.dependencyNames, FRONTEND_DEPS)) return true
  if (signals.markers.frontendConfig || signals.markers.htmlEntry) return true
  return (
    signals.countedFileCount >= MIN_FILES_FOR_RATIO && extShare(signals, FRONTEND_EXTENSIONS) >= FRONTEND_FILE_SHARE
  )
}

function hasBackendJs(signals: RepoRoleSignals): boolean {
  return anyDep(signals.dependencyNames, BACKEND_JS_DEPS)
}

function hasBackendNonJs(signals: RepoRoleSignals): boolean {
  const m = signals.markers
  // `go.mod` / `Cargo.toml` alone are ambiguous (lib vs service) and are NOT
  // treated as backend on their own — a `main.go` / `main.rs` presence would
  // be needed, which we don't scan for. The rest are unambiguous server/app
  // markers.
  return m.djangoManage || m.rubyGemfile || m.javaBuild || m.dotnetProject
}

function hasMetaFramework(signals: RepoRoleSignals): boolean {
  return anyDep(signals.dependencyNames, META_FRAMEWORK_DEPS)
}

function isMobile(signals: RepoRoleSignals): boolean {
  const m = signals.markers
  return anyDep(signals.dependencyNames, MOBILE_DEPS) || m.flutter || m.androidNative || m.iosNative
}

/** Infra file extensions used for the infra-dominance ratio. */
const INFRA_EXTENSIONS: readonly string[] = [".tf", ".yaml", ".yml", ".tpl"]
/** Share of infra-ish files at/above which an ops repo is "infra-dominated". */
const INFRA_FILE_SHARE = 0.5

function isInfraDominated(signals: RepoRoleSignals): boolean {
  const m = signals.markers
  // A strong IaC/orchestration marker is required — a lone Dockerfile is too
  // common in ordinary app repos to imply an infra repo.
  const strongInfra = m.terraform || m.pulumi || m.cloudformation || m.kubernetes || m.helm
  if (!strongInfra) return false
  // Must not also be an app: an app surface present (FE, JS or non-JS BE, or an
  // FE meta-framework) means it's an app that happens to carry infra, not an
  // infra repo.
  if (hasFrontend(signals) || hasBackendJs(signals) || hasBackendNonJs(signals) || hasMetaFramework(signals))
    return false
  return extShare(signals, INFRA_EXTENSIONS) >= INFRA_FILE_SHARE || signals.countedFileCount < MIN_FILES_FOR_RATIO
}

function isPublishableLibrary(signals: RepoRoleSignals): boolean {
  const p = signals.packageJson
  if (!p.present) return false
  // A publishable package exposes an entrypoint and is not marked private.
  // `exports`/`bin` are strong publish signals on their own; `main` counts
  // only when the package is not private (private apps often set `main` too).
  return p.hasExports || p.hasBin || (p.hasMain && !p.isPrivate)
}

// ---------------------------------------------------------------------
// The classifier — fixed precedence, first match wins.
// ---------------------------------------------------------------------

/**
 * Classify a repo's role from its gathered signals.
 *
 * Precedence (first match wins) — ordered by signal specificity/confidence:
 *
 *   1. mobile     — react-native/expo/flutter/native android|ios shell.
 *   2. infra      — dominated by IaC/orchestration (terraform/pulumi/cfn/k8s/
 *                   helm) with no app framework.
 *   3. fullstack  — BOTH a frontend and a backend surface (FE+BE deps, a
 *                   monorepo with both, or an FE meta-framework with API routes
 *                   / a server dep).
 *   4. frontend   — a frontend surface and no backend surface.
 *   5. backend    — a backend surface and no frontend surface.
 *   6. library    — a publishable package with none of the above app surfaces.
 *   7. unknown    — insufficient signal (FAIL-SAFE default).
 */
export function classifyRepoRole(signals: RepoRoleSignals): RepoRole {
  // 1. mobile — checked first: a react-native app also depends on `react`,
  //    which would otherwise read as frontend.
  if (isMobile(signals)) return "mobile"

  // 2. infra — an ops/deploy repo dominated by IaC, not an app.
  if (isInfraDominated(signals)) return "infra"

  const fe = hasFrontend(signals)
  const beJs = hasBackendJs(signals)
  const beNonJs = hasBackendNonJs(signals)
  const be = beJs || beNonJs
  const metaWithServer = hasMetaFramework(signals) && (signals.markers.metaFrameworkApiRoutes || beJs)

  // 3. fullstack — both halves present.
  if ((fe && be) || metaWithServer) return "fullstack"

  // 4. frontend — FE surface, no BE surface.
  if (fe) return "frontend"

  // 5. backend — BE surface, no FE surface.
  if (be) return "backend"

  // 6. library — publishable package with no app/service/mobile/infra surface.
  if (isPublishableLibrary(signals)) return "library"

  // 7. unknown — fail safe.
  return "unknown"
}

/**
 * Convenience: gather signals from the raw index-time inputs and classify in
 * one call. This is the path the indexer uses.
 */
export function computeRepoRole(input: { treePaths: readonly string[]; packageJsonRaw: string | null }): RepoRole {
  return classifyRepoRole(gatherRepoRoleSignals(input))
}
