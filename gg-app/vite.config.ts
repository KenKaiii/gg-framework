import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const configDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(configDir, "..");
const customBuildLabel = "Supah Coder Local Fork";
const localForkBranches = new Set([
  "custom/local-customizations",
  "custom/local-customizations-v2",
]);

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function isLocalForkBranch(branch: string | null): boolean {
  return branch !== null && localForkBranches.has(branch);
}

function isLocalForkCheckout(): boolean {
  const origin = git(["config", "--get", "remote.origin.url"]);
  const branch = git(["branch", "--show-current"]);
  return Boolean(origin?.includes("creativeprofit22/gg-framework") || isLocalForkBranch(branch));
}

function buildEnvDefines(): Record<string, string> {
  const env = process.env;
  const detected = isLocalForkCheckout();
  const localPatched = env.VITE_GG_LOCAL_PATCHED ?? (detected ? "1" : undefined);
  const envSourceRoot = env.VITE_GG_SOURCE_ROOT ?? (detected ? sourceRoot : undefined);
  const label = env.VITE_GG_CUSTOM_BUILD_LABEL ?? (detected ? customBuildLabel : undefined);
  const shortSha =
    env.VITE_GG_GIT_SHA ?? (detected ? git(["rev-parse", "--short", "HEAD"]) : undefined);

  return Object.fromEntries(
    Object.entries({
      "import.meta.env.VITE_GG_LOCAL_PATCHED": localPatched,
      "import.meta.env.VITE_GG_SOURCE_ROOT": envSourceRoot,
      "import.meta.env.VITE_GG_CUSTOM_BUILD_LABEL": label,
      "import.meta.env.VITE_GG_GIT_SHA": shortSha,
    })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, JSON.stringify(value)]),
  );
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  define: buildEnvDefines(),

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
