// SIG-243 Phase 3 — admin migration: backfill `githubRepoId` on legacy
// manifests so the new `repo-tenant:{id}` key gets populated for every
// repo that hasn't been re-indexed since Phase 2 deployed.
//
// Why this exists: Phase 2's dual-write only fires when a manifest is
// (re)written. Existing manifests written before Phase 2 deploy lack
// `githubRepoId` and won't dual-write until their next push triggers
// a fresh index run. For repos that don't push frequently — or for
// the post-Phase-2 cutover window where we want every repo migrated
// quickly — this admin endpoint walks the install's repos, fetches
// each one's GitHub repo ID, and re-writes the manifest with the
// field set. The dual-write fires automatically.
//
// Phase 5 cleanup will delete the legacy key after a 7-day safety
// window. Phase 4 flips reads to the new key.

import type { Env } from "../shared/types/env"
import { GitHubClient } from "../shared/adapters/github"
import { getInstallationToken, listInstallationRepoFullNames } from "../shared/adapters/github/github-app"
import { parseFullName } from "./index-producer"
import {
  readRepoIndexManifest,
  writeRepoIndexManifest,
} from "./repo-index-manifest"

async function buildClient(env: Env, installationId: number): Promise<GitHubClient> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("migrate-to-repo-id: GITHUB_APP_ID + GITHUB_PRIVATE_KEY required")
  }
  const token = await getInstallationToken({
    kv: env.OPENCLAW_STATE,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY,
    installationId,
  })
  return new GitHubClient({ token })
}

export interface MigrateRepoOutcome {
  /** Owner / repo on the installation. */
  owner: string
  repo: string
  /** Result classification. */
  status:
    | "migrated"
    | "already-migrated"
    | "manifest-missing"
    | "manifest-invalid"
    | "github-404"
    | "github-no-id"
    | "github-error"
    | "kv-write-failed"
  /** GitHub repo ID if successfully fetched. */
  githubRepoId?: number
  /** Diagnostic detail on failure paths. */
  detail?: string
}

export interface MigrateInstallSummary {
  installationId: number
  reposScanned: number
  migrated: number
  alreadyMigrated: number
  skipped: number
  failed: number
  outcomes: MigrateRepoOutcome[]
}

/**
 * Migrate every repo under one installation. Reads the legacy
 * manifest, fetches the GitHub repo ID, re-writes with the ID set
 * (which fires Phase 2's dual-write). Skips repos that already have
 * `githubRepoId` populated. Per-repo errors don't abort the batch.
 */
export async function migrateInstallToRepoId(
  env: Env,
  installationId: number,
): Promise<MigrateInstallSummary> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    throw new Error("migrate-to-repo-id: GITHUB_APP_ID + GITHUB_PRIVATE_KEY required")
  }

  const listing = await listInstallationRepoFullNames(
    env.OPENCLAW_STATE,
    env.GITHUB_APP_ID,
    env.GITHUB_PRIVATE_KEY,
    installationId,
  )
  // SIG-243 Phase 3 / CR Major: refuse to "succeed" on a partial
  // listing. If the GitHub repos listing was truncated (rate limit,
  // MAX_PAGES cap, transient 5xx mid-pagination), the operator must
  // re-run rather than be misled by a clean-looking summary that
  // skipped the tail. The throw bubbles out as a 500 on the admin
  // endpoint with the diagnostic detail.
  if (!listing.complete) {
    throw new Error(
      `migrate-to-repo-id: repository listing incomplete for installation ${installationId} ` +
        `(${listing.items.length} items observed before truncation); re-run after the underlying ` +
        `pagination issue is resolved`,
    )
  }
  const fullNames = listing.items

  const client = await buildClient(env, installationId)

  const outcomes: MigrateRepoOutcome[] = []
  let migrated = 0
  let alreadyMigrated = 0
  let skipped = 0
  let failed = 0

  for (const fullName of fullNames) {
    const parsed = parseFullName({ full_name: fullName })
    if (!parsed) {
      outcomes.push({ owner: "", repo: fullName, status: "manifest-invalid", detail: "bad full_name" })
      skipped += 1
      continue
    }
    const { owner, repo } = parsed
    const outcome = await migrateOneRepo(env, client, owner, repo)
    outcomes.push(outcome)
    switch (outcome.status) {
      case "migrated":
        migrated += 1
        break
      case "already-migrated":
        alreadyMigrated += 1
        break
      case "github-404":
      case "manifest-missing":
        skipped += 1
        break
      default:
        failed += 1
    }
  }

  console.log(JSON.stringify({
    event: "migration-coverage",
    installation_id: installationId,
    repos_scanned: fullNames.length,
    listing_complete: listing.complete,
    migrated,
    already_migrated: alreadyMigrated,
    skipped,
    failed,
  }))

  return {
    installationId,
    reposScanned: fullNames.length,
    migrated,
    alreadyMigrated,
    skipped,
    failed,
    outcomes,
  }
}

/**
 * Single-repo migration. Exposed for the per-repo admin endpoint flavor
 * + unit tests. Idempotent: re-running on an already-migrated record
 * returns `already-migrated` without re-writing.
 */
export async function migrateOneRepo(
  env: Env,
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<MigrateRepoOutcome> {
  const manifestResult = await readRepoIndexManifest(env, owner, repo)
  if (manifestResult.kind === "missing") {
    return { owner, repo, status: "manifest-missing" }
  }
  if (manifestResult.kind === "invalid") {
    return { owner, repo, status: "manifest-invalid", detail: manifestResult.reason }
  }
  const manifest = manifestResult.manifest
  if (
    typeof manifest.githubRepoId === "number" &&
    Number.isInteger(manifest.githubRepoId) &&
    manifest.githubRepoId > 0
  ) {
    return { owner, repo, status: "already-migrated", githubRepoId: manifest.githubRepoId }
  }

  let repoMeta: { default_branch: string; id: number | undefined } | null
  try {
    repoMeta = await client.getRepository(owner, repo)
  } catch (err) {
    return {
      owner,
      repo,
      status: "github-error",
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  if (repoMeta === null) {
    return { owner, repo, status: "github-404" }
  }
  if (
    typeof repoMeta.id !== "number" ||
    !Number.isInteger(repoMeta.id) ||
    repoMeta.id <= 0
  ) {
    return { owner, repo, status: "github-no-id" }
  }

  // SIG-243 Phase 3 / CR Critical: avoid TOCTOU clobber. Between the
  // initial manifest read above and this write, a concurrent push +
  // index run could have written a newer manifest with a new
  // `headSha`/`runId`/file counts. The naive `{...manifest, githubRepoId}`
  // would discard that newer state. Re-read the latest manifest
  // immediately before the write and patch only the `githubRepoId`
  // field onto the freshest snapshot.
  let latestManifest = manifest
  try {
    const latest = await readRepoIndexManifest(env, owner, repo)
    if (latest.kind === "missing") {
      // Manifest disappeared between the initial read and now (e.g.,
      // uninstall fired mid-migration). Skip rather than re-create.
      return { owner, repo, status: "manifest-missing" }
    }
    if (latest.kind === "invalid") {
      return { owner, repo, status: "manifest-invalid", detail: latest.reason }
    }
    // Already-migrated check on the FRESH manifest — another caller may
    // have stamped the ID in the race window (e.g. concurrent migration
    // run, or a push triggered re-index that landed first).
    if (
      typeof latest.manifest.githubRepoId === "number" &&
      Number.isInteger(latest.manifest.githubRepoId) &&
      latest.manifest.githubRepoId > 0
    ) {
      return {
        owner,
        repo,
        status: "already-migrated",
        githubRepoId: latest.manifest.githubRepoId,
      }
    }
    latestManifest = latest.manifest
  } catch (err) {
    return {
      owner,
      repo,
      status: "kv-write-failed",
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  try {
    await writeRepoIndexManifest(env, { ...latestManifest, githubRepoId: repoMeta.id })
  } catch (err) {
    return {
      owner,
      repo,
      status: "kv-write-failed",
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  return { owner, repo, status: "migrated", githubRepoId: repoMeta.id }
}
