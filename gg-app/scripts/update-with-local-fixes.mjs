#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const defaultRepoRoot = join(appDir, "..");
const repoRoot = realpathSync(resolve(process.env.GG_LOCAL_UPDATE_REPO_ROOT || defaultRepoRoot));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const SAFE_LOCAL_BRANCH = "custom/local-customizations";
const LEGACY_LOCAL_BRANCH = "custom/local-customizations-v2";
const READ_ONLY_SAFETY_BRANCH = "custom/local-customizations-safety";
const ALLOWED_LOCAL_BRANCHES = new Set([SAFE_LOCAL_BRANCH, LEGACY_LOCAL_BRANCH]);
const DEFAULT_REMOTE = "upstream";
const DEFAULT_PUSH_REMOTE = "origin";
const DEFAULT_BRANCH = "main";
const OFFICIAL_UPDATER_ENDPOINT =
  "https://github.com/KenKaiii/gg-framework/releases/latest/download/latest.json";
let activeRecoveryManifest = null;
let recoveryPrinted = false;

function usage() {
  return `Usage: node gg-app/scripts/update-with-local-fixes.mjs [options]

Safely rebases ${SAFE_LOCAL_BRANCH}, restores dirty work, verifies the local fork,
and builds a local-patched installer. It never pushes unless --push is explicit.

Options:
  --remote <name>        Source remote (default: upstream, then origin)
  --branch <name>        Source branch (default: main)
  --push                 Push the verified branch to origin with an exact lease
  --allow-other-branch   Allow a noncanonical local branch (never pushable)
  --no-install           Skip dependency refresh
  --no-build             Skip installer build (incompatible with --push)
  --check                Run required checks (default)
  --no-check             Skip checks (incompatible with --push)
  --dry-run              Print the workflow without changing Git or files
  -h, --help             Show this help
`;
}

function parseArgs(args) {
  const options = {
    remote: null,
    branch: null,
    push: false,
    allowOtherBranch: false,
    install: true,
    build: true,
    check: true,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--remote" || arg === "--branch") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (arg === "--push") options.push = true;
    else if (arg === "--allow-other-branch") options.allowOtherBranch = true;
    else if (arg === "--no-install") options.install = false;
    else if (arg === "--no-build") options.build = false;
    else if (arg === "--check") options.check = true;
    else if (arg === "--no-check") options.check = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.push && (!options.check || !options.build)) {
    throw new Error("--push requires checks and installer build; remove --no-check/--no-build.");
  }
  return options;
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args, options = {}) {
  if (options.dryRun) {
    console.log(`[dry-run] ${formatCommand(command, args)}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  console.log(`> ${formatCommand(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function capture(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${formatCommand(command, args)} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function requireSuccess(result, message) {
  if (result.status !== 0) throw new Error(message);
}

function currentBranch() {
  return capture("git", ["branch", "--show-current"]).stdout.trim();
}

function ensureSafeBranch(options) {
  const branch = currentBranch();
  if (branch === READ_ONLY_SAFETY_BRANCH) {
    throw new Error(`${READ_ONLY_SAFETY_BRANCH} is read-only and can never be updated.`);
  }
  if (!branch) throw new Error("Detached HEAD cannot be updated.");
  if (options.push && branch !== SAFE_LOCAL_BRANCH) {
    throw new Error(`Push is allowed only from ${SAFE_LOCAL_BRANCH}.`);
  }
  if (!options.allowOtherBranch && !ALLOWED_LOCAL_BRANCHES.has(branch)) {
    throw new Error(`Refusing to update ${branch}. Switch to ${SAFE_LOCAL_BRANCH}.`);
  }
  return branch;
}

function gitRemotes() {
  const result = capture("git", ["remote"], { allowFailure: true });
  return result.status === 0
    ? result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function defaultUpdateTarget() {
  const remotes = gitRemotes();
  const remote = remotes.includes(DEFAULT_REMOTE)
    ? DEFAULT_REMOTE
    : remotes.includes(DEFAULT_PUSH_REMOTE)
      ? DEFAULT_PUSH_REMOTE
      : null;
  if (!remote) throw new Error("No git remote found. Pass --remote and --branch explicitly.");
  return { remote, branch: DEFAULT_BRANCH };
}

function resolveGitPath(path) {
  return isAbsolute(path) ? path : join(repoRoot, path);
}

function gitPathExists(name) {
  const result = capture("git", ["rev-parse", "--git-path", name], { allowFailure: true });
  return (
    result.status === 0 && result.stdout.trim() && existsSync(resolveGitPath(result.stdout.trim()))
  );
}

function rebaseInProgress() {
  return (
    gitPathExists("rebase-merge") ||
    gitPathExists("rebase-apply") ||
    capture("git", ["rev-parse", "--verify", "REBASE_HEAD"], { allowFailure: true }).status === 0
  );
}

function operationInProgress() {
  if (rebaseInProgress()) return "rebase";
  for (const [name, ref] of [
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
  ]) {
    if (capture("git", ["rev-parse", "--verify", ref], { allowFailure: true }).status === 0)
      return name;
  }
  return null;
}

function hasUnresolvedConflicts() {
  return capture("git", ["diff", "--name-only", "--diff-filter=U"]).stdout.trim().length > 0;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function nullSeparatedPaths(args) {
  const output = capture("git", args).stdout;
  return output.split("\0").filter(Boolean);
}

function captureDirtyFileBytes() {
  const paths = new Set([
    ...nullSeparatedPaths(["diff", "--name-only", "-z", "HEAD"]),
    ...nullSeparatedPaths(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files = new Map();
  for (const relativePath of paths) {
    const absolutePath = join(repoRoot, relativePath);
    if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
      files.set(relativePath, readFileSync(absolutePath));
    }
  }
  return files;
}

function persistDirtyFileBytes(backupDir, files) {
  for (const [relativePath, contents] of files) {
    const backupPath = join(backupDir, "worktree", relativePath);
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, contents);
  }
}

function restoreDirtyFileBytes(files) {
  for (const [relativePath, contents] of files) {
    const absolutePath = join(repoRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
}

function cargoVersion(text) {
  return text.match(/^version = "(\d+\.\d+\.\d+)"/m)?.[1] ?? "";
}

function cargoLockAppVersion(text) {
  return text.match(/name = "gg-app"\r?\nversion = "(\d+\.\d+\.\d+)"/)?.[1] ?? "";
}

export function verifyLocalForkIdentity(root = repoRoot) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const brand = read("gg-app/src/brand.ts");
  const index = read("gg-app/index.html");
  const vite = read("gg-app/vite.config.ts");
  const policy = read("gg-app/src/update-policy.ts");
  const config = JSON.parse(read("gg-app/src-tauri/tauri.conf.json"));
  const pkg = JSON.parse(read("gg-app/package.json"));
  const cargo = cargoVersion(read("gg-app/src-tauri/Cargo.toml"));
  const lock = cargoLockAppVersion(read("gg-app/src-tauri/Cargo.lock"));
  const failures = [];
  if (!brand.includes('PRODUCT_DISPLAY_NAME = "Supah Coder"')) failures.push("Supah Coder brand");
  if (!index.includes("<title>Supah Coder</title>")) failures.push("document title");
  if (!vite.includes('customBuildLabel = "Supah Coder Local Fork"'))
    failures.push("local build label");
  if (!policy.includes('return "local-patched"') || !policy.includes("startLocalPatchedUpdate")) {
    failures.push("source-update routing");
  }
  if (config.productName !== "GG Coder") failures.push("Tauri productName");
  if (config.identifier !== "com.ggcoder.app") failures.push("Tauri identifier");
  if (config.bundle?.windows?.nsis?.installerHooks !== "windows/nsis-hooks.nsh") {
    failures.push("NSIS installer hook");
  }
  if (config.bundle?.createUpdaterArtifacts !== true) failures.push("official updater artifacts");
  if (!String(config.plugins?.updater?.pubkey ?? "").trim()) failures.push("updater public key");
  if (!config.plugins?.updater?.endpoints?.includes(OFFICIAL_UPDATER_ENDPOINT)) {
    failures.push("official updater endpoint");
  }
  const versions = [pkg.version, config.version, cargo, lock];
  if (
    new Set(versions).size !== 1 ||
    versions.some((version) => !/^\d+\.\d+\.\d+$/.test(version))
  ) {
    failures.push(`version lockstep (${versions.join(", ")})`);
  }
  if (failures.length > 0) {
    throw new Error(`Local fork identity verification failed: ${failures.join(", ")}.`);
  }
  return { version: versions[0], productName: config.productName, identifier: config.identifier };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function newestFreshWindowsInstaller(startedAt) {
  const directory = join(repoRoot, "gg-app", "src-tauri", "target", "release", "bundle", "nsis");
  if (!existsSync(directory)) return null;
  const candidates = readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).mtimeMs >= startedAt)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (candidates.length === 0) return null;
  const path = candidates[0];
  const stats = statSync(path);
  return { path, size: stats.size, mtimeMs: stats.mtimeMs, sha256: sha256(path) };
}

function commitList(range) {
  const output = capture("git", ["log", "--reverse", "--format=%H%x09%s", range]).stdout.trim();
  return output
    ? output.split(/\r?\n/).map((line) => {
        const [oid, ...subject] = line.split("\t");
        return { oid, subject: subject.join("\t") };
      })
    : [];
}

export function forceWithLeaseArgs(branch, expectedOid) {
  const destination = `refs/heads/${branch}`;
  return [
    "push",
    `--force-with-lease=${destination}:${expectedOid}`,
    DEFAULT_PUSH_REMOTE,
    `HEAD:${destination}`,
  ];
}

export function targetedVitestArgs(packageName, paths) {
  if (paths.length === 0) {
    throw new Error(`Refusing to run the ${packageName} Vitest suite without explicit test files.`);
  }
  return ["--filter", packageName, "exec", "vitest", "run", ...paths];
}

function runWorkspaceChecks(options) {
  for (const packageName of ["@kenkaiiii/gg-ai", "@kenkaiiii/gg-agent", "@kenkaiiii/gg-core"]) {
    requireSuccess(
      run(pnpm, ["--filter", packageName, "build"], options),
      `${packageName} build failed.`,
    );
  }
  for (const packageName of ["gg-app", "@kenkaiiii/ggcoder"]) {
    requireSuccess(
      run(pnpm, ["--filter", packageName, "check"], options),
      `${packageName} check failed.`,
    );
  }
  requireSuccess(
    run(
      pnpm,
      targetedVitestArgs("gg-app", [
        "scripts/update-with-local-fixes.test.ts",
        "scripts/build-local-hotfix.test.ts",
        "src/brand-static.test.ts",
        "src/local-update-confirmation.test.ts",
        "src/update-policy.test.ts",
      ]),
      options,
    ),
    "gg-app targeted tests failed.",
  );
  const timeoutTest = join(repoRoot, "packages/ggcoder/src/tools/bash-timeout.test.ts");
  if (existsSync(timeoutTest)) {
    requireSuccess(
      run(
        pnpm,
        targetedVitestArgs("@kenkaiiii/ggcoder", ["src/tools/bash-timeout.test.ts"]),
        options,
      ),
      "ggcoder timeout regression test failed.",
    );
  }
  requireSuccess(
    run("cargo", ["test", "--manifest-path", "gg-app/src-tauri/Cargo.toml", "--locked"], options),
    "Rust backend tests failed.",
  );
  requireSuccess(run(pnpm, ["--filter", "gg-app", "lint"], options), "gg-app lint failed.");
  requireSuccess(
    run(pnpm, ["--filter", "gg-app", "format:check"], options),
    "gg-app format check failed.",
  );
}

function printRecovery(manifest) {
  recoveryPrinted = true;
  console.error(`Backup branch: ${manifest.backupBranch}`);
  if (manifest.stashOid) {
    console.error(`Dirty-work stash: ${manifest.stashOid}`);
    console.error(
      manifest.dirtyWorkApplied
        ? "Dirty work is already applied; keep the stash as a recovery copy."
        : "Dirty work remains protected by the stash; inspect Git state before applying it.",
    );
  }
  if (existsSync(manifest.manifestPath)) {
    console.error(`Manifest: ${manifest.manifestPath}`);
  }
  console.error(
    "Resolve and continue the current Git operation, or abort and recover from the backup.",
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootResult = capture("git", ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (rootResult.status !== 0) throw new Error("This script must run inside a git worktree.");
  const detectedRoot = realpathSync(resolve(rootResult.stdout.trim()));
  const expectedStats = statSync(repoRoot);
  const detectedStats = statSync(detectedRoot);
  if (expectedStats.dev !== detectedStats.dev || expectedStats.ino !== detectedStats.ino) {
    throw new Error(
      `Repository root mismatch: expected ${repoRoot}, found ${rootResult.stdout.trim()}.`,
    );
  }
  const defaults = defaultUpdateTarget();
  const remote = options.remote ?? defaults.remote;
  const branch = options.branch ?? defaults.branch;
  if (branch === READ_ONLY_SAFETY_BRANCH)
    throw new Error(`${READ_ONLY_SAFETY_BRANCH} is read-only.`);
  const target = `${remote}/${branch}`;
  const localBranch = ensureSafeBranch(options);
  const inProgress = operationInProgress();
  if (inProgress)
    throw new Error(`A git ${inProgress} is already in progress. Finish or abort it first.`);
  if (hasUnresolvedConflicts()) throw new Error("Resolve existing conflicts before updating.");

  console.log("GG local-fixes protected update");
  console.log(`Repository: ${repoRoot}`);
  console.log(`Update target: ${target}`);
  console.log(`Local branch: ${localBranch}`);
  console.log(`Checks: ${options.check ? "required" : "skipped (no push allowed)"}`);
  console.log(`Build: ${options.build ? "enabled" : "skipped"}`);
  console.log(`Push: ${options.push ? "explicit exact-lease push" : "disabled"}`);

  const initialStatus = capture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).stdout;
  const trackedPatch = capture("git", ["diff", "--binary", "HEAD"]).stdout;
  const dirtyFileBytes = options.dryRun ? new Map() : captureDirtyFileBytes();
  const startingHead = capture("git", ["rev-parse", "HEAD"]).stdout.trim();
  const backupBranch = `gg-local-before-update-${timestamp.replace(/[^0-9A-Za-z-]/g, "-")}`;
  const backupDir = join(repoRoot, ".gg", "local-fixes", "backups", timestamp);
  const manifestPath = join(backupDir, "manifest.json");
  const manifest = {
    timestamp,
    repoRoot,
    localBranch,
    source: target,
    startingHead,
    backupBranch,
    stashOid: null,
    initialStatus,
    sourceOid: null,
    originOid: null,
    mergeBase: null,
    localCommits: [],
    rebasedHead: null,
    installer: null,
    dirtyFilePaths: [...dirtyFileBytes.keys()],
    dirtyWorkApplied: false,
    phase: "initialized",
    verified: false,
    manifestPath,
  };

  if (options.dryRun) {
    console.log(`[dry-run] create backup directory ${backupDir}`);
    console.log(`[dry-run] git branch ${backupBranch} HEAD`);
  }

  requireSuccess(
    run(
      "git",
      ["fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      options,
    ),
    `Failed to fetch ${target}.`,
  );
  let originFetched = false;
  if (gitRemotes().includes(DEFAULT_PUSH_REMOTE)) {
    const originFetch = run(
      "git",
      [
        "fetch",
        DEFAULT_PUSH_REMOTE,
        `+refs/heads/${localBranch}:refs/remotes/${DEFAULT_PUSH_REMOTE}/${localBranch}`,
      ],
      options,
    );
    originFetched = originFetch.status === 0;
    if (!originFetched && options.push) {
      throw new Error(`Failed to fetch ${DEFAULT_PUSH_REMOTE}/${localBranch}.`);
    }
    if (!originFetched) {
      console.warn(
        `Could not fetch ${DEFAULT_PUSH_REMOTE}/${localBranch}; continuing without push eligibility.`,
      );
    }
  } else if (options.push) throw new Error(`Missing push remote ${DEFAULT_PUSH_REMOTE}.`);

  if (!options.dryRun) {
    manifest.sourceOid = capture("git", ["rev-parse", target]).stdout.trim();
    const originResult = originFetched
      ? capture("git", ["rev-parse", `refs/remotes/${DEFAULT_PUSH_REMOTE}/${localBranch}`], {
          allowFailure: true,
        })
      : { status: 1, stdout: "" };
    manifest.originOid = originResult.status === 0 ? originResult.stdout.trim() : null;
    manifest.mergeBase = capture("git", ["merge-base", startingHead, target]).stdout.trim();
    manifest.localCommits = commitList(`${manifest.mergeBase}..${startingHead}`);
    const merges = capture("git", [
      "rev-list",
      "--merges",
      `${manifest.mergeBase}..${startingHead}`,
    ]).stdout.trim();
    if (merges)
      throw new Error(
        "Local commit range contains merge commits; manual rebase review is required.",
      );
    requireSuccess(
      run("git", ["branch", backupBranch, startingHead]),
      `Failed to create ${backupBranch}.`,
    );
    activeRecoveryManifest = manifest;
  }

  const hasDirtyWork = initialStatus.trim().length > 0;
  if (hasDirtyWork) {
    requireSuccess(
      run(
        "git",
        ["stash", "push", "--include-untracked", "-m", `gg local update ${timestamp}`],
        options,
      ),
      "Failed to stash dirty work. No rebase was attempted.",
    );
    if (!options.dryRun) {
      manifest.stashOid = capture("git", ["rev-parse", "stash@{0}"]).stdout.trim();
    }
  }
  if (!options.dryRun) {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "tracked.patch"), trackedPatch);
    writeFileSync(join(backupDir, "status.txt"), initialStatus);
    persistDirtyFileBytes(backupDir, dirtyFileBytes);
    manifest.phase = "backed-up";
    writeJson(manifestPath, manifest);
  }

  try {
    const rebase = run(
      "git",
      ["rebase", "--reapply-cherry-picks", "--empty=keep", target],
      options,
    );
    if (rebase.status !== 0) throw new Error("Rebase stopped for manual conflict review.");
    if (hasDirtyWork) {
      const stashRef = options.dryRun ? "<saved-stash>" : manifest.stashOid;
      requireSuccess(
        run("git", ["stash", "apply", "--index", stashRef], options),
        "Dirty work conflicted while restoring; the saved stash remains intact.",
      );
      if (!options.dryRun) {
        restoreDirtyFileBytes(dirtyFileBytes);
        manifest.dirtyWorkApplied = true;
      }
    }
    if (!options.dryRun) {
      manifest.phase = "rebased-and-restored";
      writeJson(manifestPath, manifest);
    }
  } catch (error) {
    if (!options.dryRun) printRecovery(manifest);
    throw error;
  }

  if (!options.dryRun) {
    manifest.rebasedHead = capture("git", ["rev-parse", "HEAD"]).stdout.trim();
    const rebased = commitList(`${target}..HEAD`);
    const oldSubjects = manifest.localCommits.map(({ subject }) => subject);
    const newSubjects = rebased.map(({ subject }) => subject);
    const rangeDiff = capture(
      "git",
      ["range-diff", `${manifest.mergeBase}..${backupBranch}`, `${target}..HEAD`],
      { allowFailure: true },
    );
    writeFileSync(join(backupDir, "range-diff.txt"), rangeDiff.stdout || rangeDiff.stderr);
    manifest.phase = "rebase-reviewed";
    writeJson(manifestPath, manifest);
    if (JSON.stringify(oldSubjects) !== JSON.stringify(newSubjects)) {
      printRecovery(manifest);
      throw new Error("Rebased commit sequence changed; review range-diff.txt manually.");
    }
    const restoredStatus = capture("git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).stdout;
    if (restoredStatus !== initialStatus) {
      printRecovery(manifest);
      throw new Error("Dirty work was not restored byte-for-byte at the status level.");
    }
    verifyLocalForkIdentity();
    manifest.phase = "source-verified";
    writeJson(manifestPath, manifest);
  } else {
    console.log("[dry-run] verify commit sequence, dirty status, branding, updater, and versions");
  }

  if (options.install) {
    requireSuccess(
      run(pnpm, ["install", "--frozen-lockfile", "--ignore-scripts"], {
        ...options,
        env: { CI: "true" },
      }),
      "Dependency refresh failed.",
    );
  }
  if (options.check) {
    runWorkspaceChecks(options);
    if (!options.dryRun) {
      manifest.phase = "checks-passed";
      writeJson(manifestPath, manifest);
    }
  }

  if (options.build) {
    if (process.platform !== "win32" && !options.dryRun) {
      throw new Error(
        "This protected flow currently requires a Windows host for NSIS verification.",
      );
    }
    const buildStartedAt = Date.now();
    requireSuccess(
      run(pnpm, ["--filter", "gg-app", "build:local-patched"], options),
      "Local-patched installer build failed.",
    );
    if (!options.dryRun) {
      const installer = newestFreshWindowsInstaller(buildStartedAt);
      if (!installer) throw new Error("Build did not produce a fresh Windows NSIS installer.");
      manifest.installer = installer;
      verifyLocalForkIdentity();
      manifest.phase = "installer-verified";
      writeJson(manifestPath, manifest);
    }
  }

  if (!options.dryRun) {
    if (capture("git", ["rev-parse", "HEAD"]).stdout.trim() !== manifest.rebasedHead) {
      throw new Error("HEAD changed during verification/build; refusing to continue.");
    }
    const finalStatus = capture("git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).stdout;
    if (finalStatus !== initialStatus)
      throw new Error("Build/checks changed the worktree; refusing to push.");
    manifest.verified = true;
    manifest.phase = "verified";
    writeJson(manifestPath, manifest);
  }

  if (options.push) {
    const expectedOriginOid = options.dryRun ? "<captured-origin-oid>" : manifest.originOid;
    if (!expectedOriginOid) {
      throw new Error("The fork branch did not exist before rebase; refusing forced creation.");
    }
    requireSuccess(
      run("git", forceWithLeaseArgs(SAFE_LOCAL_BRANCH, expectedOriginOid), options),
      "Exact force-with-lease push rejected; origin moved or verification is stale.",
    );
    if (!options.dryRun) {
      const pushedRef = `refs/heads/${SAFE_LOCAL_BRANCH}`;
      requireSuccess(
        run("git", [
          "fetch",
          DEFAULT_PUSH_REMOTE,
          `+${pushedRef}:refs/remotes/${DEFAULT_PUSH_REMOTE}/${SAFE_LOCAL_BRANCH}`,
        ]),
        "Push completed but remote verification fetch failed.",
      );
      const remoteHead = capture("git", [
        "rev-parse",
        `refs/remotes/${DEFAULT_PUSH_REMOTE}/${SAFE_LOCAL_BRANCH}`,
      ]).stdout.trim();
      if (remoteHead !== manifest.rebasedHead)
        throw new Error("Remote branch does not match verified HEAD.");
      manifest.phase = "pushed";
      writeJson(manifestPath, manifest);
    }
  }

  if (hasDirtyWork && !options.dryRun) {
    const currentStash = capture("git", ["rev-parse", "stash@{0}"], { allowFailure: true });
    if (currentStash.status === 0 && currentStash.stdout.trim() === manifest.stashOid) {
      requireSuccess(
        run("git", ["stash", "drop", "stash@{0}"]),
        "Verified update succeeded, but backup stash cleanup failed.",
      );
    } else {
      console.log(
        `Retained dirty-work stash ${manifest.stashOid}; the stash stack changed during update.`,
      );
    }
  }
  console.log(`Verified local update complete. Backup branch retained: ${backupBranch}`);
  if (!options.push)
    console.log("Push disabled. Review the manifest and range-diff before an explicit --push run.");
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    if (activeRecoveryManifest && !recoveryPrinted) printRecovery(activeRecoveryManifest);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
