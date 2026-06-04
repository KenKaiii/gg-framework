import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Provider-agnostic background self-updater. Each app composes its own instance
 * via `createAutoUpdater` with its npm package name and state-file path, so the
 * update logic (registry poll, version compare, detached install, throttling)
 * lives in exactly one place while branding stays in the apps.
 */

interface UpdateState {
  lastCheckedAt: number;
  latestVersion?: string;
  updatePending?: boolean;
  lastUpdateAttempt?: number;
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

export interface AutoUpdateConfig {
  /** npm package to self-update, e.g. "@kenkaiiii/ggcoder". */
  packageName: string;
  /**
   * Absolute path to this app's update-state.json, or a thunk resolving it.
   * A thunk keeps path resolution lazy so callers can derive it from
   * `os.homedir()` without freezing the value at module-load time (which
   * breaks tests that mock the home directory after import).
   */
  stateFilePath: string | (() => string);
  /** Builds the in-session "update available" notification. */
  periodicMessage?: (args: {
    currentVersion: string;
    latestVersion: string;
    updateCommand: string;
  }) => string;
}

export interface AutoUpdater {
  checkAndAutoUpdate(currentVersion: string): string | null;
  getPendingUpdate(currentVersion: string): { latestVersion: string } | null;
  startPeriodicUpdateCheck(currentVersion: string, onUpdate: (message: string) => void): void;
  stopPeriodicUpdateCheck(): void;
}

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 10_000; // 10s — npm can be slow

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function performUpdateInBackground(command: string): void {
  try {
    const parts = command.split(" ");
    const child = spawn(parts[0]!, parts.slice(1), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, npm_config_loglevel: "silent" },
    });
    child.unref();
  } catch {
    // Non-fatal — will retry next startup
  }
}

export function createAutoUpdater(config: AutoUpdateConfig): AutoUpdater {
  const REGISTRY_URL = `https://registry.npmjs.org/${config.packageName}/latest`;
  const periodicMessage =
    config.periodicMessage ??
    (({ currentVersion, latestVersion, updateCommand }) =>
      `Ken just pushed a fresh update — ${currentVersion} → ${latestVersion}! I'll grab it on next launch (or run ${updateCommand} if you can't wait).`);

  let periodicTimer: ReturnType<typeof setInterval> | null = null;

  function stateFilePath(): string {
    return typeof config.stateFilePath === "function"
      ? config.stateFilePath()
      : config.stateFilePath;
  }

  function readState(): UpdateState | null {
    try {
      const raw = fs.readFileSync(stateFilePath(), "utf-8");
      return JSON.parse(raw) as UpdateState;
    } catch {
      return null;
    }
  }

  function writeState(state: UpdateState): void {
    try {
      const filePath = stateFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, JSON.stringify(state));
    } catch {
      // Non-fatal
    }
  }

  function detectInstallInfo(): InstallInfo {
    const scriptPath = (process.argv[1] ?? "").replace(/\\/g, "/");

    // npx — skip (ephemeral)
    if (scriptPath.includes("/_npx/")) {
      return { packageManager: PackageManager.UNKNOWN, updateCommand: null };
    }

    // pnpm global
    if (scriptPath.includes("/.pnpm") || scriptPath.includes("/pnpm/global")) {
      return {
        packageManager: PackageManager.PNPM,
        updateCommand: `pnpm add -g ${config.packageName}@latest`,
      };
    }

    // yarn global
    if (scriptPath.includes("/.yarn/") || scriptPath.includes("/yarn/global")) {
      return {
        packageManager: PackageManager.YARN,
        updateCommand: `yarn global add ${config.packageName}@latest`,
      };
    }

    // npm global (default)
    return {
      packageManager: PackageManager.NPM,
      updateCommand: `npm install -g ${config.packageName}@latest`,
    };
  }

  async function fetchLatestVersion(): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const response = await fetch(REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timeout);
      const data = (await response.json()) as { version?: string };
      const version = data.version?.trim();
      return version && /^\d+\.\d+\.\d+/.test(version) ? version : null;
    } catch {
      return null;
    }
  }

  function scheduleBackgroundCheck(currentVersion: string): void {
    fetchLatestVersion()
      .then((latestVersion) => {
        const newState: UpdateState = {
          lastCheckedAt: Date.now(),
          latestVersion: latestVersion ?? undefined,
          updatePending: false,
        };
        if (latestVersion && compareVersions(latestVersion, currentVersion) > 0) {
          newState.updatePending = true;
        }
        writeState(newState);
      })
      .catch(() => {
        // Non-fatal — will retry next time
      });
  }

  function checkAndAutoUpdate(currentVersion: string): string | null {
    try {
      const state = readState();
      let message: string | null = null;

      // Phase 1: Apply pending update from previous check
      if (state?.updatePending && state.latestVersion) {
        if (compareVersions(state.latestVersion, currentVersion) > 0) {
          const info = detectInstallInfo();
          if (info.updateCommand) {
            performUpdateInBackground(info.updateCommand);
            message = `Ken just shipped ${state.latestVersion}! Installing in the background — takes effect next launch.`;
            writeState({
              ...state,
              lastCheckedAt: Date.now(),
              updatePending: false,
              lastUpdateAttempt: Date.now(),
            });
          }
        } else {
          // Already on latest (user may have updated manually)
          writeState({ ...state, updatePending: false });
        }
      }

      // Phase 2: Schedule background check for next startup
      const shouldCheck = !state || Date.now() - state.lastCheckedAt > CHECK_INTERVAL_MS;
      if (shouldCheck) scheduleBackgroundCheck(currentVersion);

      return message;
    } catch {
      return null;
    }
  }

  function getPendingUpdate(currentVersion: string): { latestVersion: string } | null {
    try {
      const state = readState();
      if (!state?.latestVersion) return null;
      if (compareVersions(state.latestVersion, currentVersion) <= 0) return null;
      return { latestVersion: state.latestVersion };
    } catch {
      return null;
    }
  }

  function startPeriodicUpdateCheck(
    currentVersion: string,
    onUpdate: (message: string) => void,
  ): void {
    if (periodicTimer) return; // Already running

    periodicTimer = setInterval(() => {
      fetchLatestVersion()
        .then((latestVersion) => {
          if (!latestVersion) return;
          if (compareVersions(latestVersion, currentVersion) <= 0) return;

          const info = detectInstallInfo();
          if (!info.updateCommand) return;

          writeState({ lastCheckedAt: Date.now(), latestVersion, updatePending: true });
          onUpdate(
            periodicMessage({ currentVersion, latestVersion, updateCommand: info.updateCommand }),
          );

          // Stop checking once we've notified
          stopPeriodicUpdateCheck();
        })
        .catch(() => {
          // Non-fatal
        });
    }, CHECK_INTERVAL_MS);

    // Don't keep the process alive just for update checks
    periodicTimer.unref();
  }

  function stopPeriodicUpdateCheck(): void {
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  return {
    checkAndAutoUpdate,
    getPendingUpdate,
    startPeriodicUpdateCheck,
    stopPeriodicUpdateCheck,
  };
}
