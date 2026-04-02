import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PACKAGE_NAME = "@kenkaiiii/ggcoder";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const FETCH_TIMEOUT_MS = 3000;

interface UpdateState {
  lastCheckedAt: number;
  lastSeenVersion?: string;
}

enum PackageManager {
  NPM = "npm",
  PNPM = "pnpm",
  YARN = "yarn",
  UNKNOWN = "unknown",
}

interface InstallInfo {
  packageManager: PackageManager;
  updateCommand: string | null;
}

function getStateFilePath(): string {
  return path.join(os.homedir(), ".gg", "update-state.json");
}

function readState(): UpdateState | null {
  try {
    const raw = fs.readFileSync(getStateFilePath(), "utf-8");
    return JSON.parse(raw) as UpdateState;
  } catch {
    return null;
  }
}

function writeState(state: UpdateState): void {
  try {
    const dir = path.dirname(getStateFilePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getStateFilePath(), JSON.stringify(state));
  } catch {
    // Non-fatal
  }
}

function shouldCheck(): boolean {
  const state = readState();
  if (!state) return true;
  return Date.now() - state.lastCheckedAt > CHECK_INTERVAL_MS;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function detectInstallInfo(): InstallInfo {
  const scriptPath = (process.argv[1] ?? "").replace(/\\/g, "/");

  // npm link / local dev — skip (managed via git pull + pnpm build)
  if (scriptPath.includes("/gg-framework")) {
    return { packageManager: PackageManager.UNKNOWN, updateCommand: null };
  }

  // npx — skip (ephemeral)
  if (scriptPath.includes("/_npx/")) {
    return { packageManager: PackageManager.UNKNOWN, updateCommand: null };
  }

  // pnpm global
  if (scriptPath.includes("/.pnpm") || scriptPath.includes("/pnpm/global")) {
    return {
      packageManager: PackageManager.PNPM,
      updateCommand: `pnpm add -g ${PACKAGE_NAME}@latest`,
    };
  }

  // yarn global
  if (scriptPath.includes("/.yarn/") || scriptPath.includes("/yarn/global")) {
    return {
      packageManager: PackageManager.YARN,
      updateCommand: `yarn global add ${PACKAGE_NAME}@latest`,
    };
  }

  // npm global (default)
  return {
    packageManager: PackageManager.NPM,
    updateCommand: `npm install -g ${PACKAGE_NAME}@latest`,
  };
}

function fetchLatestVersionSync(): string | null {
  // Use a child process to fetch from npm registry with timeout
  // We use node -e to avoid needing fetch in the parent process synchronously
  try {
    const script = `
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ${FETCH_TIMEOUT_MS});
      fetch("${REGISTRY_URL}", { signal: c.signal })
        .then(r => r.json())
        .then(d => { clearTimeout(t); process.stdout.write(d.version || ""); })
        .catch(() => { clearTimeout(t); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf-8",
      timeout: FETCH_TIMEOUT_MS + 1000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const version = result.stdout?.trim();
    return version && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}

function performUpdate(command: string): boolean {
  try {
    execSync(command, {
      stdio: "pipe",
      timeout: 60_000,
      env: { ...process.env, npm_config_loglevel: "silent" },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check for updates and silently auto-update if a newer version is available.
 * Called at CLI startup. Non-blocking on failure — the CLI always proceeds.
 *
 * Returns a message to display if an update happened, or null.
 */
export function checkAndAutoUpdate(currentVersion: string): string | null {
  try {
    if (!shouldCheck()) return null;

    const latestVersion = fetchLatestVersionSync();

    // Always record that we checked
    writeState({
      lastCheckedAt: Date.now(),
      lastSeenVersion: latestVersion ?? undefined,
    });

    if (!latestVersion) return null;
    if (compareVersions(latestVersion, currentVersion) <= 0) return null;

    const info = detectInstallInfo();
    if (!info.updateCommand) return null;

    const success = performUpdate(info.updateCommand);

    if (success) {
      return `Updated ${PACKAGE_NAME} ${currentVersion} \u2192 ${latestVersion}`;
    }

    // Update failed — show manual instructions
    return `Update available: ${currentVersion} \u2192 ${latestVersion}\nRun: ${info.updateCommand}`;
  } catch {
    // Never block CLI startup
    return null;
  }
}
