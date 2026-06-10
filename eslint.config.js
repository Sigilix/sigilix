// Minimal ESLint flat-config scaffold for the Sigilix Worker.
//
// Ruleset is deliberately safety-only, tuned to ZERO errors on the
// current codebase so adding lint to the build gate doesn't churn the
// shipped tree. Future PRs can add stricter rules as the team agrees;
// each addition should be its own PR with the fix-up commit alongside.
//
// The build script (`npm run build`) runs `tsc --noEmit && eslint . &&
// vitest run` — a lint error fails CI the same way a type error does.

// @ts-check
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    // Apply to TypeScript source + tests only. Co-located unit tests live
    // beside their subject under `src/**` (so the src glob already covers
    // them); cross-cutting / e2e tests live in `e2e/**`; the evals-tool test
    // lives in `evals/**`. The CLI script `scripts/index-repo.mjs` is a Node
    // ESM module (no types) and gets the recommended JS rules below but not
    // the TS parser.
    files: ["src/**/*.ts", "e2e/**/*.ts", "evals/**/*.test.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        // Non-type-aware to keep `eslint .` fast (~1-2s vs 30s+ on a
        // 100k-line repo with `project: true`). Type-aware rules
        // (e.g., `no-floating-promises`) are valuable but expensive;
        // worth a follow-up PR when the team is ready to wait.
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      // Catch unused variables — common refactor leftover, and the
      // exhaustiveness `_var: never` pattern means real unused
      // variables sneak past `tsc --noEmit`.
      "no-unused-vars": "off", // base rule conflicts with TS; off in favour of the TS-aware one
      "@typescript-eslint/no-unused-vars": ["error", {
        // Underscore-prefixed args / locals are intentional placeholders
        // (e.g., `_args`, `_exhaustive: never`). Matches the existing
        // convention in src/lib/triage-pr-review.ts:1038-1042.
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        // Don't flag arrow-fn rest params that were destructured for clarity.
        ignoreRestSiblings: true,
      }],
      // Block `throw "string"` — almost always a refactor mistake;
      // breaks `instanceof Error` discrimination downstream.
      "no-throw-literal": "error",
      // Enforce `const` where a `let` is never reassigned. Stylistic
      // but cheap to fix and reduces accidental mutation surface.
      "prefer-const": ["error", { destructuring: "all" }],
      // Block accidental `==` / `!=` — the existing codebase already
      // uses strict equality. Catches drift on new code.
      // `smart` permits the idiomatic `x == null` (covers both null
      // and undefined in one check) and `typeof a == "string"` — both
      // already used throughout the codebase as a deliberate style.
      eqeqeq: ["error", "smart"],
      // Block `var` declarations.
      "no-var": "error",
      // Strip trailing whitespace so the auto-fixer doesn't leave
      // empty-ish lines where it removed unused `// eslint-disable…`
      // directives.
      "no-trailing-spaces": "error",
      // File-size budget — COMPLIANCE.md §4. Default ceiling is 1,000
      // physical lines (blank + comment lines counted, matching the
      // `wc -l` number the team reasons about). Single-cohesive-module
      // files that read better whole than split get 1,500 via the
      // explicit allowlist override block below — nothing else does.
      "max-lines": ["error", { max: 1000, skipBlankLines: false, skipComments: false }],
      // Cross-tree imports use the `@/` root alias — COMPLIANCE.md §3. A
      // `../` specifier that climbs out of the current directory is banned:
      // it hides the real dependency and breaks when files move. Same-dir
      // `./sibling` is fine. (TS-aware variant so `import type ... from "../"`
      // is caught too under verbatimModuleSyntax.)
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [{
          regex: "^\\.\\./",
          message: "Climbing imports are banned — use the `@/` root alias (e.g. `@/src/...`). See COMPLIANCE.md §3.",
        }],
      }],
    },
  },
  {
    // ── Class-module allowlist (COMPLIANCE.md §4) ──────────────────────
    // One-class-one-module files where splitting would hurt readability
    // more than the size does. Hard ceiling 1,500. Add a file here ONLY
    // in the same PR that needs it, so the claim is visible in review and
    // a reviewer can judge whether it genuinely meets the one-class bar.
    // Being large, or merely containing a class, does NOT qualify a file.
    files: ["src/shared/adapters/github/client.ts"],
    rules: {
      "max-lines": ["error", { max: 1500, skipBlankLines: false, skipComments: false }],
    },
  },
  {
    // Look-alike rules for the CLI script (plain JS, no TS parser).
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-throw-literal": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      // `smart` permits the idiomatic `x == null` (covers both null
      // and undefined in one check) and `typeof a == "string"` — both
      // already used throughout the codebase as a deliberate style.
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "no-trailing-spaces": "error",
    },
  },
  {
    // Generated / build / vendored files — never lint.
    ignores: [
      "node_modules/**",
      "dist/**",
      ".wrangler/**",
      "worker-configuration.d.ts",
      "src/lib/dep-vulns/db/**",
      // Local-only handoff briefs + research scratch (gitignored, but
      // present in dev checkouts).
      ".claude/**",
    ],
  },
)
