import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Split big libraries so no chunk exceeds Vite's 500 kB advisory. Groups keep
// their dependencies (the default), which avoids circular chunks; react gets
// the highest priority so no other group can absorb it. Paths match / and \
// (Windows).
const VENDOR_CHUNKS = [
  { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 100 },
  { name: "highlight", test: /node_modules[\\/]highlight\.js[\\/]/, priority: 90 },
  {
    name: "markdown",
    test: /node_modules[\\/](marked|micromark|mdast-|hast-|unist-|unified|remark-|rehype-)/,
    priority: 80,
  },
];

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  build: {
    manifest: true, // Lets CI budget initial JS separately from lazy chunks.
    rolldownOptions: {
      output: {
        codeSplitting: { groups: VENDOR_CHUNKS },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
