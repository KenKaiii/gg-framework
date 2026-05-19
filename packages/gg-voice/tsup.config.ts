import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/providers/openai-realtime.ts",
    "src/providers/openai-codex-realtime.ts",
    "src/bridges/ggcoder-rpc.ts",
    "src/bridges/ggboss.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
