import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      // Fire-and-forget `void asyncFn().catch()` kickoffs in effects setState
      // asynchronously inside a promise, not synchronously — the rule's static
      // analysis can't see that, so it false-positives. Keep the genuinely
      // valuable hook rules (rules-of-hooks, exhaustive-deps) on.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "src-tauri/", "**/*.js", "**/*.mjs"],
  },
);
