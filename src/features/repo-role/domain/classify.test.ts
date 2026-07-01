// Repo-role classifier tests — the deterministic precedence over cheap
// signals, exercised through the real `computeRepoRole` path (tree paths +
// package.json) plus a few direct `classifyRepoRole` precedence checks.

import { describe, expect, it } from "vitest"
import { classifyRepoRole, computeRepoRole, isRepoRole, REPO_ROLES, type RepoRole } from "@/src/features/repo-role"
import { gatherRepoRoleSignals, type RepoRoleSignals } from "@/src/features/repo-role/domain/signals"

function pkg(obj: Record<string, unknown>): string {
  return JSON.stringify(obj)
}

describe("computeRepoRole — role matrix", () => {
  it("classifies a Next.js app without API routes as frontend", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "next.config.js", "app/page.tsx", "components/Button.tsx", "styles/globals.css"],
      packageJsonRaw: pkg({
        private: true,
        dependencies: { next: "^14", react: "^18", "react-dom": "^18" },
      }),
    })
    expect(role).toBe("frontend")
  })

  it("classifies a Next.js app WITH API routes as fullstack", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "next.config.js", "app/page.tsx", "pages/api/users.ts", "styles/app.css"],
      packageJsonRaw: pkg({ private: true, dependencies: { next: "^14", react: "^18" } }),
    })
    expect(role).toBe("fullstack")
  })

  it("classifies an Express API as backend", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "src/server.ts", "src/routes/users.ts", "src/db.ts"],
      packageJsonRaw: pkg({ dependencies: { express: "^4", pg: "^8" } }),
    })
    expect(role).toBe("backend")
  })

  it("classifies a Fastify API as backend", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "src/app.ts", "src/plugins/db.ts"],
      packageJsonRaw: pkg({ dependencies: { fastify: "^4" } }),
    })
    expect(role).toBe("backend")
  })

  it("classifies a Terraform/k8s repo as infra", () => {
    const role = computeRepoRole({
      treePaths: ["main.tf", "variables.tf", "outputs.tf", "modules/vpc/main.tf", "k8s/deployment.yaml"],
      packageJsonRaw: null,
    })
    expect(role).toBe("infra")
  })

  it("classifies a react-native app as mobile (react dep does not win)", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "App.tsx", "src/screens/Home.tsx"],
      packageJsonRaw: pkg({ dependencies: { "react-native": "0.74", react: "^18" } }),
    })
    expect(role).toBe("mobile")
  })

  it("classifies a Flutter app as mobile from pubspec.yaml", () => {
    const role = computeRepoRole({
      treePaths: ["pubspec.yaml", "lib/main.dart", "lib/widgets/home.dart"],
      packageJsonRaw: null,
    })
    expect(role).toBe("mobile")
  })

  it("classifies a native Android project as mobile", () => {
    const role = computeRepoRole({
      treePaths: ["app/src/main/AndroidManifest.xml", "app/build.gradle", "settings.gradle"],
      packageJsonRaw: null,
    })
    expect(role).toBe("mobile")
  })

  it("classifies a published utility library as library", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "src/index.ts", "src/util.ts", "dist/index.js"],
      packageJsonRaw: pkg({
        name: "@acme/util",
        main: "dist/index.js",
        exports: { ".": "./dist/index.js" },
        dependencies: {},
      }),
    })
    expect(role).toBe("library")
  })

  it("classifies a publishable CLI (bin) with no app framework as library", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "src/index.ts", "bin/cli.js"],
      packageJsonRaw: pkg({ name: "acme-cli", bin: { acme: "bin/cli.js" }, dependencies: { commander: "^12" } }),
    })
    expect(role).toBe("library")
  })

  it("classifies a monorepo with both FE and BE deps as fullstack", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "apps/web/page.tsx", "apps/api/server.ts"],
      packageJsonRaw: pkg({
        private: true,
        dependencies: { react: "^18", express: "^4" },
      }),
    })
    expect(role).toBe("fullstack")
  })

  it("classifies a Django project as backend", () => {
    const role = computeRepoRole({
      treePaths: ["manage.py", "app/models.py", "app/views.py", "requirements.txt"],
      packageJsonRaw: null,
    })
    expect(role).toBe("backend")
  })

  it("returns unknown for an empty repo", () => {
    expect(computeRepoRole({ treePaths: [], packageJsonRaw: null })).toBe("unknown")
  })

  it("returns unknown for an ambiguous docs-only repo", () => {
    expect(computeRepoRole({ treePaths: ["README.md", "LICENSE", "CHANGELOG.md"], packageJsonRaw: null })).toBe(
      "unknown",
    )
  })

  it("returns unknown for a bare go.mod (lib vs service is ambiguous — fail safe)", () => {
    // A lone go.mod could be a library or a service; we do not scan file
    // contents, so we conservatively decline rather than guess.
    expect(computeRepoRole({ treePaths: ["go.mod", "go.sum", "main.go"], packageJsonRaw: null })).toBe("unknown")
  })

  it("does NOT read a normal app repo with a single Dockerfile as infra", () => {
    // A lone Dockerfile is common in app repos — it must not flip the role to
    // infra. The Express dep keeps this backend.
    const role = computeRepoRole({
      treePaths: ["package.json", "Dockerfile", "src/server.ts"],
      packageJsonRaw: pkg({ dependencies: { express: "^4" } }),
    })
    expect(role).toBe("backend")
  })

  it("an app framework present beats infra even with terraform files", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "infra/main.tf", "src/server.ts"],
      packageJsonRaw: pkg({ dependencies: { express: "^4" } }),
    })
    expect(role).toBe("backend")
  })

  it("a React component library reads as frontend (FE surface wins over library)", () => {
    const role = computeRepoRole({
      treePaths: ["package.json", "src/index.tsx", "src/Button.tsx"],
      packageJsonRaw: pkg({
        name: "@acme/ui",
        exports: { ".": "./dist/index.js" },
        peerDependencies: { react: "^18" },
      }),
    })
    expect(role).toBe("frontend")
  })
})

// ---------------------------------------------------------------------
// Direct precedence checks on classifyRepoRole (hand-built signals).
// ---------------------------------------------------------------------

function signals(over: Partial<RepoRoleSignals>): RepoRoleSignals {
  const base = gatherRepoRoleSignals({ treePaths: [], packageJsonRaw: null })
  return {
    ...base,
    ...over,
    markers: { ...base.markers, ...(over.markers ?? {}) },
    packageJson: { ...base.packageJson, ...(over.packageJson ?? {}) },
  }
}

describe("classifyRepoRole — precedence", () => {
  it("mobile is checked before frontend", () => {
    expect(classifyRepoRole(signals({ dependencyNames: ["react-native", "react"] }))).toBe("mobile")
  })

  it("fullstack is checked before frontend and backend", () => {
    expect(classifyRepoRole(signals({ dependencyNames: ["react", "express"] }))).toBe("fullstack")
  })

  it("defaults to unknown on no signal", () => {
    expect(classifyRepoRole(signals({}))).toBe("unknown")
  })
})

describe("isRepoRole / REPO_ROLES", () => {
  it("accepts every declared role and rejects anything else", () => {
    for (const role of REPO_ROLES) expect(isRepoRole(role)).toBe(true)
    for (const bad of ["", "front-end", "FRONTEND", 1, null, undefined, {}]) expect(isRepoRole(bad)).toBe(false)
  })

  it("enumerates exactly the seven roles", () => {
    const expected: RepoRole[] = ["frontend", "backend", "infra", "library", "mobile", "fullstack", "unknown"]
    expect([...REPO_ROLES].sort()).toEqual([...expected].sort())
  })
})
