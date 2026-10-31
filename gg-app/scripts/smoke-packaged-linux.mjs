// Linux PACKAGED-app smoke: build a .deb, unpack it with `dpkg-deb -x` into a
// temporary directory, launch the unpacked app with a throwaway user profile,
// and prove the packaged WebKitGTK shell and the bundled Node sidecar come up
// together with a visible window. Nothing is installed, no existing user
// profile is touched, and every owned process is reaped afterwards.
//
// The Linux twin of smoke-packaged-windows.mjs: `smoke-sidecar.mjs` runs the
// sidecar directly, so it cannot catch a .deb that ships without `ggnode`, a
// sidecar resource Tauri can't resolve from `usr/lib/<productName>`, or an app
// that starts with no window.
//
// Needs an X display (CI wraps it in `xvfb-run`) and `xdotool`.
//
// Usage:
//   node gg-app/scripts/smoke-packaged-linux.mjs                 # builds the .deb
//   node gg-app/scripts/smoke-packaged-linux.mjs --artifact x.deb # reuses one
//
// Exits non-zero on any failure so it can gate CI. The pure helpers are
// exported and unit-tested cross-platform in smoke-packaged-linux.test.mjs.
import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  findDiagnosticLogs,
  removeTemporaryDirectory,
  tailLines,
  waitFor,
} from "./smoke-packaged-windows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const bundleDir = join(appDir, "src-tauri", "target", "release", "bundle", "deb");
const require = createRequire(import.meta.url);
const tauriCli = join(dirname(require.resolve("@tauri-apps/cli/package.json")), "tauri.js");

// .deb only (fast, and unpackable without root), and no updater artifacts so
// the build needs no signing key.
const PACKAGED_BUILD_ARGS = [
  tauriCli,
  "build",
  "--ci",
  "--bundles",
  "deb",
  "--config",
  JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
];

function fail(message) {
  throw new Error(message);
}

let stage = "starting";
let failureReported = false;

function enterStage(next) {
  stage = next;
  console.log(`STAGE: ${next}`);
}

function reportFailure(error) {
  failureReported = true;
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : `non-Error thrown: ${String(error)}`;
  writeSync(2, `SMOKE FAIL (stage: ${stage}): ${detail}\n`);
}

/** Thrown by a probe to abort `waitFor` immediately instead of retrying. */
class StopWaitingError extends Error {}

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

export function snapshotDebArtifacts(root) {
  return new Map(
    walkFiles(root)
      .filter((path) => extname(path) === ".deb")
      .map((path) => {
        const stat = statSync(path);
        return [resolve(path), { path, size: stat.size, mtimeMs: stat.mtimeMs }];
      }),
  );
}

/**
 * The .deb THIS build produced — never just "the newest .deb in the folder",
 * which on a developer machine would smoke a stale artifact and pass.
 */
export function discoverChangedDeb(before, after) {
  const changed = [...after.values()].filter((artifact) => {
    const previous = before.get(resolve(artifact.path));
    return !previous || previous.size !== artifact.size || previous.mtimeMs !== artifact.mtimeMs;
  });
  if (changed.length !== 1) {
    fail(
      `expected one newly built .deb, found ${changed.length}: ` +
        `${changed.map((item) => item.path).join(", ") || "none"}`,
    );
  }
  return changed[0].path;
}

/**
 * Locate the unpacked layout and assert the three files that must ship
 * together. Tauri resolves resources on Linux as `<exe dir>/../lib/<productName>`,
 * so the sidecar must sit exactly there for the app to find it.
 */
export function discoverPackagedLayout(extractRoot, productName, binaryName = "gg-app") {
  const binDir = join(extractRoot, "usr", "bin");
  const executable = join(binDir, binaryName);
  const node = join(binDir, "ggnode");
  const sidecar = join(extractRoot, "usr", "lib", productName, "sidecar", "app-sidecar.mjs");
  if (!existsSync(executable)) fail(`packaged app executable missing: ${executable}`);
  if (!existsSync(node)) fail(`packaged Node runtime missing beside app: ${node}`);
  if (!existsSync(sidecar)) fail(`packaged sidecar resource missing: ${sidecar}`);
  return {
    executable: realpathSync(executable),
    installDir: realpathSync(binDir),
    node: realpathSync(node),
    sidecar: realpathSync(sidecar),
  };
}

/** Parse `/proc/<pid>/stat`; the comm field may itself contain spaces and parens. */
export function parseProcStat(text) {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? { ppid } : undefined;
}

function processSnapshot() {
  const processes = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      if (!stat) continue;
      let exe = "";
      try {
        exe = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        // Kernel threads and other users' processes have no readable exe.
      }
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      processes.push({ pid, ppid: stat.ppid, exe, cmdline });
    } catch {
      // The process exited between readdir and read.
    }
  }
  return processes;
}

/**
 * Every PID belonging to this smoke run: anything whose exe or command line
 * points into our temporary directories, plus its descendants. Never a bare
 * PID — it may have been recycled after our app exited. Path evidence also
 * catches the sidecar's MCP/LSP children, which run in their own process group
 * and are reparented to init if the app dies first.
 */
export function collectOwnedProcessIds(processes, ownedRoots) {
  const owned = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      const pathEvidence = [entry.exe, entry.cmdline].some(
        (value) => typeof value === "string" && ownedRoots.some((root) => value.includes(root)),
      );
      if (pathEvidence || owned.has(entry.ppid)) {
        if (!owned.has(entry.pid)) changed = true;
        owned.add(entry.pid);
      }
    }
  }
  return [...owned].filter((pid) => Number.isInteger(pid) && pid > 0).sort((a, b) => a - b);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupOwnedProcesses(ownedRoots, timeoutMs = 15000) {
  const startedAt = Date.now();
  for (;;) {
    const owned = collectOwnedProcessIds(processSnapshot(), ownedRoots).filter(processExists);
    if (owned.length === 0) return;
    if (Date.now() - startedAt >= timeoutMs) {
      fail(`packaged smoke processes survived cleanup: ${owned.join(", ")}`);
    }
    for (const pid of owned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Exited between the snapshot and the kill.
      }
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
}

/** True when the X server has a mapped, visible window owned by `pid`. */
function hasVisibleWindow(pid) {
  try {
    const out = execFileSync("xdotool", ["search", "--onlyvisible", "--pid", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    // xdotool exits 1 when nothing matches yet.
    return false;
  }
}

/**
 * A throwaway user profile so the smoke can never read or write the real
 * `~/.gg` (auth tokens, settings, session store).
 */
function isolatedEnvironment(root, projectDir) {
  const home = join(root, "home");
  const temp = join(root, "temp");
  for (const directory of [home, temp, projectDir]) mkdirSync(directory, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: temp,
    GG_APP_CWD: projectDir,
  };
  // Dev-only overrides would point the packaged app back at workspace files
  // and hide a broken bundle.
  delete env.GG_NODE_BIN;
  delete env.GG_SIDECAR_PATH;
  delete env.GG_APP_WORKSPACE_PATH;
  return env;
}

function printDiagnostics(profileRoot, appLog) {
  const logs = [...findDiagnosticLogs(profileRoot), appLog].filter((path) => existsSync(path));
  writeSync(2, `DIAGNOSTICS: ${logs.length} log file(s)\n`);
  for (const path of logs) {
    try {
      writeSync(
        2,
        `--- ${path} (last 60 lines) ---\n${tailLines(readFileSync(path, "utf8"), 60)}\n`,
      );
    } catch (error) {
      writeSync(2, `--- ${path}: unreadable (${error.message}) ---\n`);
    }
  }
}

async function main() {
  if (process.platform !== "linux") fail("packaged launch smoke only supports Linux");
  if (!process.env.DISPLAY) fail("no X display: run under `xvfb-run -a`");
  const { productName } = JSON.parse(
    readFileSync(join(appDir, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const smokeRoot = mkdtempSync(join(tmpdir(), "gg-app-packaged-smoke-"));
  const extractRoot = join(smokeRoot, "package");
  const projectDir = join(smokeRoot, "project");
  const appLog = join(smokeRoot, "app-output.log");
  let appPid;
  let packagedNode;

  try {
    const artifactArgument = process.argv.indexOf("--artifact");
    let deb;
    if (artifactArgument >= 0) {
      const artifactPath = process.argv[artifactArgument + 1];
      if (!artifactPath) fail("--artifact requires a .deb path");
      deb = resolve(artifactPath);
      if (!existsSync(deb) || extname(deb) !== ".deb") {
        fail(`packaged smoke .deb does not exist: ${deb}`);
      }
    } else {
      const before = snapshotDebArtifacts(bundleDir);
      enterStage("building .deb");
      console.log(`BUILD: ${process.execPath} ${PACKAGED_BUILD_ARGS.join(" ")}`);
      execFileSync(process.execPath, PACKAGED_BUILD_ARGS, {
        cwd: appDir,
        env: process.env,
        stdio: "inherit",
      });
      deb = discoverChangedDeb(before, snapshotDebArtifacts(bundleDir));
    }

    enterStage("unpacking .deb");
    mkdirSync(extractRoot, { recursive: true });
    execFileSync("dpkg-deb", ["-x", deb, extractRoot], { stdio: "inherit" });
    const layout = discoverPackagedLayout(extractRoot, productName);
    console.log(`PACKAGE: ${relative(appDir, deb)} -> ${layout.installDir}`);

    enterStage("launching packaged app");
    const output = openSync(appLog, "w");
    const child = spawn(layout.executable, [], {
      cwd: projectDir,
      env: isolatedEnvironment(smokeRoot, projectDir),
      stdio: ["ignore", output, output],
    });
    closeSync(output);
    appPid = child.pid;
    packagedNode = layout.node;
    let exited = null;
    let spawnError = null;
    child.on("exit", (code, signal) => {
      exited = { code, signal };
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    console.log(`LAUNCHED: pid=${appPid}`);

    enterStage("waiting for packaged app window and bundled sidecar");
    await waitFor("packaged app window and bundled sidecar", () => {
      if (spawnError) {
        throw new StopWaitingError(`packaged app failed to spawn: ${spawnError.message}`);
      }
      if (exited || !processExists(appPid)) {
        const how = exited ? `code ${exited.code}, signal ${exited.signal}` : "exit status unknown";
        throw new StopWaitingError(`packaged app exited early (${how})`);
      }
      const processes = processSnapshot();
      const app = processes.find(
        (entry) => entry.pid === appPid && entry.exe === layout.executable,
      );
      // The PACKAGED ggnode running the PACKAGED bundle, as a child of the app.
      const node = processes.find(
        (entry) =>
          entry.ppid === appPid &&
          entry.exe === layout.node &&
          entry.cmdline.includes(layout.sidecar),
      );
      return app && node && hasVisibleWindow(appPid);
    });
  } catch (error) {
    reportFailure(error);
    printDiagnostics(join(smokeRoot, "home"), appLog);
    throw error;
  } finally {
    enterStage("cleaning up");
    let processCleanupError;
    try {
      if (appPid) await cleanupOwnedProcesses([smokeRoot, realpathSync(smokeRoot)]);
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
  process.on("uncaughtException", (error) => {
    reportFailure(error);
    process.exitCode = 1;
  });
  process.on("unhandledRejection", (reason) => {
    reportFailure(reason);
    process.exitCode = 1;
  });
  process.on("exit", (code) => {
    if (code !== 0 && !failureReported) {
      writeSync(2, `SMOKE FAIL (stage: ${stage}): exited with code ${code} and no error report\n`);
    }
  });
  main().catch((error) => {
    if (!failureReported) reportFailure(error);
    process.exitCode = 1;
  });
}
