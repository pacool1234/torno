// @ts-check
// ESLint "flat config": an array of config objects, applied in order. Later
// entries override earlier ones for the files they match.

import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig([
  // Never lint generated output or coverage reports.
  { ignores: ["dist/", "coverage/"] },

  // ESLint's own recommended rules for JavaScript.
  js.configs.recommended,

  // typescript-eslint's recommended rules that use type information. They can
  // tell, for example, that a function returns a Promise, which plain syntax
  // rules can't. It also switches off base ESLint rules that clash with TypeScript.
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Ask the TypeScript compiler for type information, using tsconfig.json.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ADR-0002: required from day one. Both are already in the recommended set;
      // listing them here makes the decision visible and protects it from changes.
      // A promise that is neither awaited nor handled: its errors vanish silently.
      "@typescript-eslint/no-floating-promises": "error",
      // A promise passed where a plain value is expected (e.g. `if (asyncFn())`,
      // which is always true because a promise object is truthy).
      "@typescript-eslint/no-misused-promises": "error",
    },
  },

  // ADR-0001: the core must never depend on adapters. This rule turns the
  // architecture into something the linter enforces.
  {
    files: ["src/core/**/*.ts"],
    // Tests are exempt: they may use test doubles that live with the adapters
    // (ScriptedProvider), which is how ADR-0001 says the loop is tested. The
    // rule protects what the core depends on at runtime, and tests never ship.
    ignores: ["src/core/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/adapters/**"],
              message:
                "src/core must not import from src/adapters (ADR-0001). Depend on a port in src/core/ports instead.",
            },
          ],
        },
      ],
    },
  },

  // Plain .js files (like this one) are outside tsconfig, so type-aware rules
  // can't run on them. Lint them with syntax-only rules.
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must be last: turns off every ESLint rule that's about formatting, because
  // Prettier owns formatting. Without it, the two tools contradict each other.
  prettier,
]);
