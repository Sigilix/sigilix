// SIG-318 capstone — "the lock". Machine-enforces COMPLIANCE.md §1 (the
// dependency rule) and §2 (barrel-only cross-feature imports). The rules
// lock the *migrated* clean-architecture units — the four `src/features/*`
// islands and the `src/shared/*` foundation — without imposing layering on
// the still-flat `src/lib/*` migration zone (SIG-318 is incremental; that
// zone, including the partially-migrated `src/lib/ensemble/*`, is not done).
//
// The inward rule is scoped by its *source*: only a migrated-unit layer is
// held to it (`from`). Its *target* is global (`to` matches any unit's outer
// layer), so a cross-unit escape — `features/a/app → shared/adapters` or
// `features/a/domain → features/b/app` — is caught, not just same-unit edges.
//
// `src/lib/ensemble/*` is deliberately NOT a source unit: it carries the
// layer sub-dirs but its app layer still wires concrete adapters/render
// directly (20 inward edges) — it is mid-migration, locked later.

/** Source trees held to the inward rule (a migrated-unit layer is `<UNIT>/<layer>/`). */
const UNIT = "(^src/features/[^/]+|^src/shared)"

/** Any unit's layer dir, matched anywhere in the path — makes `to` cross-unit. */
const L = (...names) => `/(${names.join("|")})/`

/** A feature's private internals — everything under it except its barrel. */
const FEATURE_INTERNAL = "^src/features/[^/]+/(?!index\\.ts$).+"

/**
 * Tests are exempt from the structural rules: a domain unit test legitimately
 * imports the adapter/render it exercises, or a sibling feature's internals,
 * to set up or assert. The rules govern production wiring, not test wiring.
 */
const TEST = ["\\.test\\.ts$", "\\.test-helpers\\.ts$"]

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── §2 — cross-feature imports go through the barrel ──────────────
    // Two halves give full coverage: (A) non-feature code (lib/, do/, the
    // entrypoints) reaching into a feature internal, and (B) one feature
    // reaching into *another* feature's internal. Both must use the barrel
    // (src/features/<name>/index.ts). A feature importing its OWN internals
    // is fine. Tests are exempt.
    {
      name: "external-into-feature-internal",
      comment: "Non-feature code must import a feature only through its barrel (index.ts). COMPLIANCE.md §2.",
      severity: "error",
      from: { pathNot: ["^src/features/", ...TEST] },
      to: { path: FEATURE_INTERNAL, pathNot: TEST },
    },
    {
      // SIG-304 Phase 2: the moat guard. The hosted thin-client driver is bundled
      // into the PUBLISHED client (Phase 2.3), so it must ship NO engine — it may
      // import the `DryRunReview` TYPE only, never value-import the ensemble engine.
      name: "thin-client-ships-no-engine",
      comment:
        "The published thin-client graph (bin-remote → cli-main-remote → run-review-remote + the renderers + ansi) may NOT value-import the engine/IP: the ensemble app|adapters, the specialist PROMPTS, or the model adapters. Pure ensemble/domain + types are fine (DryRunReview is type-only). The bundle moat-gate (thin-client-policy) is the artifact backstop. SIG-304 Phase 2.",
      severity: "error",
      from: {
        path: "^src/cli/(bin-remote\\.ts|app/(cli-main-remote|run-review-remote)\\.ts|render/|ansi/)",
        pathNot: TEST,
      },
      to: {
        path: ["^src/lib/ensemble/app/", "^src/lib/ensemble/adapters/", "^src/prompts/", "^src/shared/adapters/"],
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "cross-feature-barrel-only",
      comment:
        "A feature may import another feature only through its barrel (index.ts), never an internal path. COMPLIANCE.md §2.",
      severity: "error",
      from: { path: "^src/features/([^/]+)/", pathNot: TEST },
      // `$1` = the importing feature; importing its own internals is allowed.
      to: { path: FEATURE_INTERNAL, pathNot: ["^src/features/$1/", ...TEST] },
    },

    // ── §1 — the dependency rule, imports point inward only ───────────
    // domain is pure: it may reference NO outer layer (not even a type) —
    // this is the believability core, kept provably free of IO concerns.
    {
      name: "domain-is-pure",
      comment: "domain/ is pure — it may not import app/, adapters/, or render/ (type or value). COMPLIANCE.md §1.",
      severity: "error",
      from: { path: `${UNIT}/domain/`, pathNot: TEST },
      to: { path: L("app", "adapters", "render") },
    },
    // app depends on domain + ports only — never a concrete adapter or render
    // (type or value). Adapters are injected at the composition root, typed by
    // a port (src/shared/ports/), so an app layer never names a concrete
    // adapter even in a parameter type.
    {
      name: "app-not-adapters-render",
      comment:
        "app/ depends on domain + ports only — never a concrete adapter or render. Adapters are injected, typed by a port (src/shared/ports/). COMPLIANCE.md §1.",
      severity: "error",
      from: { path: `${UNIT}/app/`, pathNot: TEST },
      to: { path: L("adapters", "render") },
    },
    // adapters implement ports against the world; they must not import app/render.
    {
      name: "adapters-not-app",
      comment:
        "adapters/ implement ports; they may import domain + ports but must not import app/ or render/. COMPLIANCE.md §1.",
      severity: "error",
      from: { path: `${UNIT}/adapters/`, pathNot: TEST },
      to: { path: L("app", "render") },
    },
    // ports are the type-only seams — every import out of a port is type-only.
    {
      name: "ports-are-type-only-seams",
      comment:
        "ports/ are type-only seams — a port may not value-import anything (it declares types). COMPLIANCE.md §1.",
      severity: "error",
      from: { path: `${UNIT}/ports/`, pathNot: TEST },
      to: { dependencyTypesNot: ["type-only"], pathNot: "node_modules" },
    },
    // render turns a finished result into output from domain types only —
    // strict on types too (COMPLIANCE.md §1 names render type-explicitly).
    {
      name: "render-from-domain-only",
      comment: "render/ imports domain types only — not app/, adapters/, or ports/ (type or value). COMPLIANCE.md §1.",
      severity: "error",
      from: { path: `${UNIT}/render/`, pathNot: TEST },
      to: { path: L("app", "adapters", "ports") },
    },

    // ── §1 — no new feature → lib/god-file edges ──────────────────────
    // A migrated feature must not reach back into the flat `src/lib/*`
    // migration zone, except through the two sanctioned façade barrels
    // (extract to shared/ first — COMPLIANCE.md §1). Tests are exempt.
    {
      name: "feature-no-lib-godfile",
      comment:
        "A feature must not import a src/lib god-file — extract the shared type/helper to shared/ first. Sanctioned façades only. COMPLIANCE.md §1.",
      severity: "error",
      from: { path: "^src/features/", pathNot: TEST },
      to: {
        path: "^src/lib/",
        pathNot: [
          "^src/lib/sigilix-config\\.ts$", // sanctioned config façade
          "^src/lib/triage-pr-review-ensemble\\.ts$", // sanctioned ensemble façade
          "^src/lib/[^/]+/index\\.ts$", // sub-package barrels
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true, // see type-only edges (so the rules can judge them)
  },
}
