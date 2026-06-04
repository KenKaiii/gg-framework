import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/model-registry.ts", "src/paths.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep heavy optional, dynamic-imported deps external so they are resolved at
  // runtime by the consuming app (and stay genuinely optional) rather than
  // bundled into gg-core's published tarball.
  external: ["@huggingface/transformers", "ogg-opus-decoder"],
});
