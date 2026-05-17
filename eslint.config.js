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
    // Apply to TypeScript source + tests only. The CLI script
    // `scripts/index-repo.mjs` is a Node ESM module (no types) and
    // gets the recommended JS rules below but not the TS parser.
    files: ["src/**/*.ts", "tests/**/*.ts"],
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
