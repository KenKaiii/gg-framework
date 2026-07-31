import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Cap Windows process-fixture contention while preserving parallel coverage.
    maxWorkers: process.platform === "win32" ? 4 : undefined,
    // Ink suppresses incremental frame writes when `is-in-ci` detects CI
    // (CI=true on GitHub Actions), which empties every rendered frame and
    // breaks all TUI rendering assertions. Force non-CI inside test workers.
    env: {
      CI: "false",
      CONTINUOUS_INTEGRATION: "false",
    },
  },
});
