// Windows PACKAGED-app smoke: build an MSI, administratively extract it into a
// temporary directory, launch the extracted app with a throwaway user profile,
// and prove the packaged WebView shell and the bundled Node sidecar come up
// together with a visible window. Nothing is installed, no existing user
// profile is touched, and the whole process tree is reaped afterwards.
//
// Why this exists: `smoke-sidecar.mjs` proves the bundled RUNTIME loads, but it
// runs the sidecar directly. It cannot catch the failures Windows users
// actually hit after installing — the shell not finding `ggnode.exe` beside the
// exe, the sidecar resource missing from the MSI, a console window flashing, or
// the app starting with no window at all. Only launching real packaged output
// exercises that path.
//
// Usage:
//   node gg-app/scripts/smoke-packaged-windows.mjs                 # builds the MSI
//   node gg-app/scripts/smoke-packaged-windows.mjs --artifact x.msi # reuses one
//
// Exits non-zero on any failure so it can gate CI. The pure helpers are
// exported and unit-tested cross-platform in smoke-packaged-windows.test.mjs.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const bundleDir = join(appDir, "src-tauri", "target", "release", "bundle", "msi");
const require = createRequire(import.meta.url);
const tauriCli = join(dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");

// MSI only (fast, and the one format we can extract without installing), and no
// updater artifacts so the build needs no signing key.
const PACKAGED_BUILD_ARGS = [
  tauriCli,
  "build",
  "--ci",
  "--bundles",
  "msi",
  "--config",
  JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
];

function fail(message) {
  throw new Error(message);
}

/** Thrown by a probe to abort `waitFor` immediately instead of retrying. */
class StopWaitingError extends Error {}

/**
 * Compare Windows paths the way the OS does: one separator, one case, and
 * resolved through any symlink/8.3 short name (`RUNNER~1`) that PowerShell and
 * Node can disagree about for the very same file.
 */
function normalizePath(path) {
  const absolute = resolve(path);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // Command lines can name paths that vanished between snapshots.
  }
  return canonical.replaceAll("/", "\\").toLowerCase();
}

function normalizeEvidence(value) {
  return value.replaceAll("/", "\\").toLowerCase();
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

export function snapshotMsiArtifacts(root) {
  return new Map(
    walkFiles(root)
      .filter((path) => extname(path).toLowerCase() === ".msi")
      .map((path) => {
        const stat = statSync(path);
        return [normalizePath(path), { path, size: stat.size, mtimeMs: stat.mtimeMs }];
      }),
  );
}

/**
 * The MSI THIS build produced — never just "the newest .msi in the folder",
 * which on a developer machine silently smokes a stale artifact from an
 * unrelated build and reports a pass for code that was never packaged.
 */
export function discoverChangedMsi(before, after) {
  const changed = [...after.values()].filter((artifact) => {
    const previous = before.get(normalizePath(artifact.path));
    return !previous || previous.size !== artifact.size || previous.mtimeMs !== artifact.mtimeMs;
  });
  if (changed.length !== 1) {
    fail(
      `expected one newly built MSI, found ${changed.length}: ` +
        `${changed.map((item) => item.path).join(", ") || "none"}`,
    );
  }
  return changed[0].path;
}

function findNamedFiles(root, expectedName) {
  const lowerName = expectedName.toLowerCase();
  return walkFiles(root).filter((path) => basename(path).toLowerCase() === lowerName);
}

/**
 * Locate the extracted install layout and assert the three files that must ship
 * together. A missing `ggnode.exe` or `sidecar/app-sidecar.mjs` is exactly the
 * "app installs but does nothing" bug this smoke exists to catch.
 */
export function discoverPackagedLayout(extractRoot) {
  const apps = findNamedFiles(extractRoot, "gg-app.exe");
  if (apps.length !== 1) fail(`expected one extracted gg-app.exe, found ${apps.length}`);
  const executable = realpathSync.native(apps[0]);
  const installDir = dirname(executable);
  const node = join(installDir, "ggnode.exe");
  const sidecar = join(installDir, "sidecar", "app-sidecar.mjs");
  if (!existsSync(node)) fail(`packaged Node runtime missing beside app: ${node}`);
  if (!existsSync(sidecar)) fail(`packaged sidecar resource missing: ${sidecar}`);
  return {
    executable,
    installDir,
    node: realpathSync.native(node),
    sidecar: realpathSync.native(sidecar),
  };
}

export async function waitFor(description, probe, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const intervalMs = options.intervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
    } catch (error) {
      if (error instanceof StopWaitingError) throw error;
      lastError = error;
    }
    await sleep(intervalMs);
  }
  fail(`${description} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`);
}

function powershell(script) {
  const encoded = Buffer.from(
    `$ErrorActionPreference = "Stop"\n$ProgressPreference = "SilentlyContinue"\n${script}`,
    "utf16le",
  ).toString("base64");
  return execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

function asArray(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function processSnapshot() {
  const output = powershell(`
    Get-CimInstance Win32_Process |
      Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine |
      ConvertTo-Json -Compress
  `);
  return asArray(output ? JSON.parse(output) : []);
}

/**
 * PIDs owning a VISIBLE top-level window. A Tauri app that starts but never
 * paints (the failure mode of a broken WebView2 or a panicking setup hook)
 * still shows up as a running process, so process liveness alone is not proof
 * the user would see anything.
 */
function visibleWindowPids() {
  const output = powershell(`
    Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PackagedSmokeWindows {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
}
'@
    $owners = [System.Collections.Generic.HashSet[uint32]]::new()
    [PackagedSmokeWindows]::EnumWindows({
      param($hwnd, $unused)
      if ([PackagedSmokeWindows]::IsWindowVisible($hwnd)) {
        [uint32]$owner = 0
        [void][PackagedSmokeWindows]::GetWindowThreadProcessId($hwnd, [ref]$owner)
        [void]$owners.Add($owner)
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    $owners | ConvertTo-Json -Compress
  `);
  return new Set(asArray(output ? JSON.parse(output) : []).map(Number));
}

/**
 * Every PID belonging to this smoke run, found by walking parent links AND by
 * matching our temporary paths.
 *
 * Never trust a bare PID after a process exits: Windows recycles PIDs
 * aggressively, so killing "the pid we launched" can kill an unrelated process
 * on a busy CI runner. Ownership therefore requires path evidence.
 */
export function collectOwnedProcessIds(processes, rootPid, ownedRoots) {
  const owned = new Set();
  const normalizedRoots = ownedRoots.flatMap((root) => [
    normalizeEvidence(root),
    normalizePath(root),
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      const pathEvidence = [entry.ExecutablePath, entry.CommandLine]
        .filter((value) => typeof value === "string")
        .some((value) => normalizedRoots.some((root) => normalizeEvidence(value).includes(root)));
      const isVerifiedRoot = entry.ProcessId === rootPid && pathEvidence;
      if (isVerifiedRoot || owned.has(entry.ParentProcessId) || pathEvidence) {
        if (!owned.has(entry.ProcessId)) changed = true;
        owned.add(entry.ProcessId);
      }
    }
  }
  return [...owned].filter((pid) => Number.isInteger(pid) && pid > 0);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function removeTemporaryDirectory(directory, options = {}) {
  const remove = options.remove ?? (() => rmSync(directory, { recursive: true, force: true }));
  const exists = options.exists ?? (() => existsSync(directory));
  const sleep =
    options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const attempts = options.attempts ?? 40;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      remove();
      if (!exists()) return;
    } catch {
      // WebView2 can retain profile handles briefly after its process exits.
    }
    await sleep(250);
  }
  fail(`temporary packaged smoke directory survived: ${directory}`);
}

export async function cleanupOwnedProcesses(options) {
  const snapshot = options.snapshot ?? processSnapshot;
  const kill =
    options.kill ??
    ((pid) => {
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        // A process can exit between the snapshot and the taskkill.
      }
    });
  const exists = options.exists ?? processExists;
  const timeoutMs = options.timeoutMs ?? 15000;
  const startedAt = Date.now();
  for (;;) {
    const lastOwned = collectOwnedProcessIds(
      await snapshot(),
      options.rootPid,
      options.ownedRoots,
    ).filter(exists);
    if (lastOwned.length === 0) return;
    if (Date.now() - startedAt >= timeoutMs) {
      fail(`packaged smoke processes survived cleanup: ${lastOwned.join(", ")}`);
    }
    // Children before parents; taskkill /T covers the rest of the race.
    for (const pid of lastOwned.toReversed()) await kill(pid);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

/**
 * A throwaway user profile so the smoke can never read or write the real
 * `~/.gg` (auth tokens, settings, session store) and never collides with a
 * GG Coder the developer already has open.
 */
function isolatedEnvironment(root, projectDir) {
  const home = join(root, "home");
  // SHGetKnownFolderPath expects the conventional profile-relative layout;
  // arbitrary APPDATA paths make Tauri's log plugin fail with UnknownPath.
  const appData = join(home, "AppData", "Roaming");
  const localAppData = join(home, "AppData", "Local");
  const temp = join(root, "temp");
  const webview = join(root, "webview2");
  for (const directory of [home, appData, localAppData, temp, webview, projectDir]) {
    mkdirSync(directory, { recursive: true });
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    WEBVIEW2_USER_DATA_FOLDER: webview,
    GG_APP_CWD: projectDir,
  };
  // Dev-only overrides must never leak in: they would point the packaged app
  // back at workspace files and hide a broken bundle.
  delete env.GG_NODE_BIN;
  delete env.GG_SIDECAR_PATH;
  delete env.GG_APP_WORKSPACE_PATH;
  return env;
}

/** `msiexec /a` = administrative install: unpack the payload, install nothing. */
function extractMsi(msi, extractRoot, logPath) {
  mkdirSync(extractRoot, { recursive: true });
  execFileSync("msiexec.exe", ["/a", msi, "/qn", `TARGETDIR=${extractRoot}`, "/L*v", logPath], {
    stdio: "inherit",
    windowsHide: true,
  });
}

async function main() {
  if (process.platform !== "win32") fail("packaged launch smoke only supports Windows");
  const smokeRoot = mkdtempSync(join(tmpdir(), "gg-app-packaged-smoke-"));
  const extractRoot = join(smokeRoot, "package");
  const projectDir = join(smokeRoot, "project");
  const msiLog = join(smokeRoot, "msi-extract.log");
  let appPid;
  let packagedNode;

  try {
    const artifactArgument = process.argv.indexOf("--artifact");
    let msi;
    if (artifactArgument >= 0) {
      const artifactPath = process.argv[artifactArgument + 1];
      if (!artifactPath) fail("--artifact requires an MSI path");
      msi = resolve(artifactPath);
      if (!existsSync(msi) || extname(msi).toLowerCase() !== ".msi") {
        fail(`packaged smoke MSI does not exist: ${msi}`);
      }
    } else {
      const before = snapshotMsiArtifacts(bundleDir);
      console.log(`BUILD: ${process.execPath} ${PACKAGED_BUILD_ARGS.join(" ")}`);
      execFileSync(process.execPath, PACKAGED_BUILD_ARGS, {
        cwd: appDir,
        env: process.env,
        stdio: "inherit",
        windowsHide: false,
      });
      msi = discoverChangedMsi(before, snapshotMsiArtifacts(bundleDir));
    }

    extractMsi(msi, extractRoot, msiLog);
    const layout = discoverPackagedLayout(extractRoot);
    console.log(`PACKAGE: ${relative(appDir, msi)} -> ${layout.installDir}`);

    const child = spawn(layout.executable, [], {
      cwd: projectDir,
      env: isolatedEnvironment(smokeRoot, projectDir),
      // Inherited pipe handles can be retained by WebView2 descendants and keep
      // this runner alive after the owned tree has been terminated.
      stdio: "ignore",
      windowsHide: false,
    });
    appPid = child.pid;
    packagedNode = layout.node;
    // stdio is ignored (see above), so the exit code is the only crash evidence
    // this runner can report. Without it a flaky launch and a real startup
    // crash produce the same one-line failure.
    let exited = null;
    child.on("exit", (code, signal) => {
      exited = { code, signal };
    });

    await waitFor("packaged app window and bundled sidecar", () => {
      if (!processExists(appPid)) {
        const how = exited
          ? `code ${exited.code === null ? "null" : `0x${(exited.code >>> 0).toString(16)}`}, signal ${exited.signal}`
          : "exit status unknown";
        throw new StopWaitingError(`packaged app exited early (${how})`);
      }
      const processes = processSnapshot();
      const app = processes.find(
        (entry) =>
          entry.ProcessId === appPid &&
          entry.ExecutablePath &&
          normalizePath(entry.ExecutablePath) === normalizePath(layout.executable),
      );
      // The sidecar must be the PACKAGED ggnode running the PACKAGED bundle,
      // as a child of the app — not some node the runner happened to have.
      const node = processes.find(
        (entry) =>
          entry.ParentProcessId === appPid &&
          entry.ExecutablePath &&
          normalizePath(entry.ExecutablePath) === normalizePath(layout.node) &&
          normalizeEvidence(entry.CommandLine ?? "").includes(normalizeEvidence(layout.sidecar)),
      );
      return app && node && visibleWindowPids().has(appPid);
    });
  } finally {
    let processCleanupError;
    try {
      if (appPid) {
        await cleanupOwnedProcesses({ rootPid: appPid, ownedRoots: [smokeRoot, extractRoot] });
      }
    } catch (error) {
      processCleanupError = error;
    }
    try {
      await removeTemporaryDirectory(smokeRoot);
    } catch (directoryCleanupError) {
      if (processCleanupError) {
        throw new AggregateError(
          [processCleanupError, directoryCleanupError],
          "packaged smoke process and directory cleanup failed",
        );
      }
      throw directoryCleanupError;
    }
    if (processCleanupError) throw processCleanupError;
  }

  console.log(`SMOKE PASS: pid=${appPid} packagedNode=${packagedNode}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`SMOKE FAIL: ${error.message}`);
    process.exitCode = 1;
  });
}
