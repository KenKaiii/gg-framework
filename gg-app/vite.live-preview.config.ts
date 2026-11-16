// Live preview overlay: the chat frame (frame.html, gg-app's own components)
// and the page script (page.js, an IIFE added to the previewed app). Output
// goes to dist-live-preview/, which bundle-sidecar.mjs ships beside the sidecar.
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const shims = here("./live-preview/frame/shims/");
const outDir = here("./dist-live-preview");

// Tauri modules the shared components import: the frame has no Tauri.
const TAURI_SHIMS = [
  { find: /^@tauri-apps\/api\/core$/, replacement: `${shims}tauri-core.ts` },
  {
    find: /^@tauri-apps\/(api\/(app|dpi|event|window|webview|webviewWindow)|plugin-(dialog|log|process|updater|opener))$/,
    replacement: `${shims}tauri-misc.ts`,
  },
];

// The page script runs among the previewed app's own scripts: one small
// self-contained file, no modules, no shared chunks.
function pageScript(): Plugin {
  return {
    name: "gg-live-preview-page",
    apply: "build",
    async closeBundle() {
      await esbuild({
        entryPoints: [here("./live-preview/page.ts")],
        outfile: `${outDir}/page.js`,
        bundle: true,
        format: "iife",
        minify: true,
        target: "es2020",
        legalComments: "none",
        logLevel: "warning",
      });
    },
  };
}

export default defineConfig({
  root: here("./live-preview"),
  base: "/",
  plugins: [react(), pageScript()],
  resolve: { alias: TAURI_SHIMS },
  build: {
    outDir,
    emptyOutDir: true,
    chunkSizeWarningLimit: 2048,
    rolldownOptions: { input: here("./live-preview/frame.html") },
  },
});
