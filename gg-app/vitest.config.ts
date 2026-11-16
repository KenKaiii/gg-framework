import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // `scripts/**` covers the pure helpers of the packaged Windows smoke: the
    // smoke itself only runs on Windows, but its MSI-selection and
    // PID-ownership logic is safety-critical and must be verified on every OS.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "live-preview/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    // Node 25+ ships its own localStorage, which warns without a backing file
    // and shadows jsdom's. Tests use jsdom's (or stub it), so turn Node's off.
    // The flag exists since Node 22.4, CI's floor.
    execArgv: ["--no-experimental-webstorage"],
    // Vitest hands every CSS import back empty unless it's included here. The
    // stylesheet guards (css-loops.test.ts) read sheets as `?raw` text, so let
    // just those through; component CSS stays empty, as jsdom tests expect.
    css: { include: [/\.css\?raw$/] },
  },
});
