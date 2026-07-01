// SIG — repo-role signal gathering (pure).
//
// Distils the cheap, index-time inputs a repo-role classifier needs into an
// explicit, named signal set. The inputs are deliberately cheap to gather at
// index time — the flattened git tree paths (already in memory during the
// index-repo job) plus the raw `package.json` body (one file fetch) — so
// classification never deep-scans file contents.
//
// This module is PURE: tree paths + a package.json string in, a structured
// `RepoRoleSignals` out. No IO, no env, no clock. The classifier
// (`classify.ts`) consumes this and nothing else.

/** Publishable-package markers read off the root `package.json`. */
export interface RepoRolePackageJsonSignals {
  /** A parseable object `package.json` was present. */
  present: boolean
  /** `main` entrypoint declared. */
  hasMain: boolean
  /** `exports` map declared. */
  hasExports: boolean
  /** `bin` declared (a publishable CLI). */
  hasBin: boolean
  /** `private: true` — an app/workspace, not a publishable package. */
  isPrivate: boolean
}

/** Marker-file presence flags derived from the tree paths. */
export interface RepoRoleMarkers {
  // ── infra ────────────────────────────────────────────────────────
  terraform: boolean
  pulumi: boolean
  cloudformation: boolean
  kubernetes: boolean
  helm: boolean
  dockerfile: boolean
  // ── mobile (native shells) ───────────────────────────────────────
  flutter: boolean
  androidNative: boolean
  iosNative: boolean
  // ── frontend app shell ───────────────────────────────────────────
  htmlEntry: boolean
  frontendConfig: boolean
  /** Server route dir inside an FE meta-framework (`pages/api/`, `app/api/`). */
  metaFrameworkApiRoutes: boolean
  // ── non-JS backend / language markers ────────────────────────────
  djangoManage: boolean
  rubyGemfile: boolean
  goMod: boolean
  cargoToml: boolean
  javaBuild: boolean
  dotnetProject: boolean
  pythonPackaging: boolean
}

/**
 * The complete, explicit signal set the classifier reasons over. Everything
 * here is derivable from the flattened tree paths + one `package.json`.
 */
export interface RepoRoleSignals {
  /**
   * Union of dependency names (`dependencies` ∪ `devDependencies` ∪
   * `peerDependencies` ∪ `optionalDependencies`) from the root
   * `package.json`, lowercased + deduped. Empty when there is no
   * parseable `package.json`.
   */
  dependencyNames: readonly string[]
  /** Publishable-package markers from `package.json`. */
  packageJson: RepoRolePackageJsonSignals
  /**
   * File-extension histogram over the tree paths (lowercased extension
   * including the leading dot → count). Vendor/build dirs are excluded.
   */
  extensionCounts: Readonly<Record<string, number>>
  /** Total counted (non-vendor) files — the denominator for ratio rules. */
  countedFileCount: number
  /** Marker-file presence derived from the tree paths. */
  markers: RepoRoleMarkers
}

/** Directory segments whose contents are vendored/generated, not repo source. */
const VENDOR_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  ".next",
  ".nuxt",
  ".vercel",
  ".turbo",
  ".cache",
  "__pycache__",
])

/** True when any non-leaf segment of the path is a vendor/build dir. */
function isVendorPath(path: string): boolean {
  const segments = path.split("/")
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    if (seg && VENDOR_DIRS.has(seg)) return true
  }
  return false
}

/** Basename (segment after the final slash), lowercased. */
function baseName(path: string): string {
  const slash = path.lastIndexOf("/")
  return (slash >= 0 ? path.slice(slash + 1) : path).toLowerCase()
}

/** Lowercased extension including the leading dot, or "" when none. */
function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return "" // no dot, or a leading-dot dotfile like ".gitignore"
  return base.slice(dot)
}

const FRONTEND_CONFIG_BASENAMES = new Set(["angular.json", "svelte.config.js", "svelte.config.ts", "svelte.config.mjs"])

const FRONTEND_CONFIG_PREFIXES = [
  "next.config.",
  "nuxt.config.",
  "vite.config.",
  "gatsby-config.",
  "astro.config.",
  "remix.config.",
  "webpack.config.",
]

const PYTHON_PACKAGING_BASENAMES = new Set(["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "pipfile"])

/** Parse the union of dependency names off a raw `package.json` body. */
function parsePackageJsonSignals(raw: string | null): {
  dependencyNames: string[]
  packageJson: RepoRolePackageJsonSignals
} {
  const absent: RepoRolePackageJsonSignals = {
    present: false,
    hasMain: false,
    hasExports: false,
    hasBin: false,
    isPrivate: false,
  }
  if (raw === null) return { dependencyNames: [], packageJson: absent }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { dependencyNames: [], packageJson: absent }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { dependencyNames: [], packageJson: absent }
  }
  const obj = parsed as Record<string, unknown>
  const names = new Set<string>()
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const v = obj[key]
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const name of Object.keys(v)) names.add(name.toLowerCase())
    }
  }
  const packageJson: RepoRolePackageJsonSignals = {
    present: true,
    hasMain: typeof obj.main === "string" && obj.main.length > 0,
    hasExports: obj.exports !== undefined && obj.exports !== null,
    hasBin: obj.bin !== undefined && obj.bin !== null,
    isPrivate: obj.private === true,
  }
  return { dependencyNames: [...names], packageJson }
}

/**
 * Gather the pure signal set from the two cheap index-time inputs.
 *
 * @param input.treePaths     Flattened git-tree file paths (repo-relative).
 * @param input.packageJsonRaw Raw root `package.json` body, or null when absent
 *                             or unfetchable — signals degrade, never throw.
 */
export function gatherRepoRoleSignals(input: {
  treePaths: readonly string[]
  packageJsonRaw: string | null
}): RepoRoleSignals {
  const { dependencyNames, packageJson } = parsePackageJsonSignals(input.packageJsonRaw)

  const extensionCounts: Record<string, number> = {}
  let countedFileCount = 0
  const markers: RepoRoleMarkers = {
    terraform: false,
    pulumi: false,
    cloudformation: false,
    kubernetes: false,
    helm: false,
    dockerfile: false,
    flutter: false,
    androidNative: false,
    iosNative: false,
    htmlEntry: false,
    frontendConfig: false,
    metaFrameworkApiRoutes: false,
    djangoManage: false,
    rubyGemfile: false,
    goMod: false,
    cargoToml: false,
    javaBuild: false,
    dotnetProject: false,
    pythonPackaging: false,
  }

  for (const rawPath of input.treePaths) {
    if (typeof rawPath !== "string" || rawPath.length === 0) continue
    if (isVendorPath(rawPath)) continue
    const lowerPath = rawPath.toLowerCase()
    const base = baseName(rawPath)
    const ext = extensionOf(base)

    countedFileCount += 1
    if (ext.length > 0) extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1

    // ── infra ────────────────────────────────────────────────────
    if (ext === ".tf" || base.endsWith(".tf.json")) markers.terraform = true
    if (base === "pulumi.yaml" || base === "pulumi.yml" || base.startsWith("pulumi.")) markers.pulumi = true
    if (base === "cloudformation.yaml" || base === "cloudformation.yml" || lowerPath.includes("cloudformation/"))
      markers.cloudformation = true
    if (
      lowerPath.includes("k8s/") ||
      lowerPath.includes("kubernetes/") ||
      base === "kustomization.yaml" ||
      base === "kustomization.yml"
    )
      markers.kubernetes = true
    if (base === "chart.yaml" || (base === "values.yaml" && lowerPath.includes("charts/"))) markers.helm = true
    if (base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile"))
      markers.dockerfile = true

    // ── mobile (native shells) ────────────────────────────────────
    if (base === "pubspec.yaml") markers.flutter = true
    if (base === "androidmanifest.xml") markers.androidNative = true
    if (base === "podfile" || segmentEndsWith(lowerPath, ".xcodeproj") || segmentEndsWith(lowerPath, ".xcworkspace"))
      markers.iosNative = true

    // ── frontend app shell ────────────────────────────────────────
    if (base === "index.html") markers.htmlEntry = true
    if (FRONTEND_CONFIG_BASENAMES.has(base) || FRONTEND_CONFIG_PREFIXES.some((p) => base.startsWith(p)))
      markers.frontendConfig = true
    if (lowerPath.includes("pages/api/") || lowerPath.includes("app/api/")) markers.metaFrameworkApiRoutes = true

    // ── non-JS backend / language markers ─────────────────────────
    if (base === "manage.py") markers.djangoManage = true
    if (base === "gemfile") markers.rubyGemfile = true
    if (base === "go.mod") markers.goMod = true
    if (base === "cargo.toml") markers.cargoToml = true
    if (base === "pom.xml" || base.startsWith("build.gradle")) markers.javaBuild = true
    if (ext === ".csproj" || ext === ".sln" || ext === ".fsproj") markers.dotnetProject = true
    if (PYTHON_PACKAGING_BASENAMES.has(base)) markers.pythonPackaging = true
  }

  return { dependencyNames, packageJson, extensionCounts, countedFileCount, markers }
}

/** True when any slash-delimited segment of `path` ends with `suffix`. */
function segmentEndsWith(path: string, suffix: string): boolean {
  for (const seg of path.split("/")) {
    if (seg.endsWith(suffix)) return true
  }
  return false
}
