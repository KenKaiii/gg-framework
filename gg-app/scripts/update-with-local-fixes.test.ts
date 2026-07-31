import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  forceWithLeaseArgs,
  targetedVitestArgs,
  verifyLocalForkIdentity,
} from "./update-with-local-fixes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "update-with-local-fixes.mjs");
const temporaryDirectories: string[] = [];

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function configureRepository(repo: string): void {
  git(repo, "config", "user.email", "local-update-test@example.com");
  git(repo, "config", "user.name", "Local Update Test");
}

function writeIdentityFixture(repo: string): void {
  write(join(repo, ".gitignore"), ".gg/\n");
  write(join(repo, "package.json"), '{"private":true}\n');
  write(join(repo, "gg-app/package.json"), '{"version":"1.2.3"}\n');
  write(join(repo, "gg-app/index.html"), "<title>Supah Coder</title>\n");
  write(
    join(repo, "gg-app/vite.config.ts"),
    'const customBuildLabel = "Supah Coder Local Fork";\n',
  );
  write(join(repo, "gg-app/src/brand.ts"), 'export const PRODUCT_DISPLAY_NAME = "Supah Coder";\n');
  write(
    join(repo, "gg-app/src/update-policy.ts"),
    'const startLocalPatchedUpdate = () => {}; function route() { startLocalPatchedUpdate(); return "local-patched"; }\n',
  );
  write(
    join(repo, "gg-app/src-tauri/Cargo.toml"),
    '[package]\nname = "gg-app"\nversion = "1.2.3"\n',
  );
  write(
    join(repo, "gg-app/src-tauri/Cargo.lock"),
    '[[package]]\nname = "gg-app"\nversion = "1.2.3"\n',
  );
  write(
    join(repo, "gg-app/src-tauri/tauri.conf.json"),
    `${JSON.stringify(
      {
        productName: "GG Coder",
        version: "1.2.3",
        identifier: "com.ggcoder.app",
        bundle: {
          createUpdaterArtifacts: true,
          windows: { nsis: { installerHooks: "windows/nsis-hooks.nsh" } },
        },
        plugins: {
          updater: {
            pubkey: "test-public-key",
            endpoints: [
              "https://github.com/KenKaiii/gg-framework/releases/latest/download/latest.json",
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

interface Fixture {
  root: string;
  repo: string;
  upstream: string;
  origin: string;
  initialDirtyStatus: string;
}

function createUpdateFixture(conflict = false): Fixture {
  const root = tempDir("gg-local-update-");
  const upstream = join(root, "upstream.git");
  const origin = join(root, "origin.git");
  const repo = join(root, "work");
  mkdirSync(repo);
  git(root, "init", "--bare", upstream);
  git(root, "init", "--bare", origin);
  git(repo, "init", "--initial-branch", "main");
  configureRepository(repo);
  writeIdentityFixture(repo);
  write(join(repo, "shared.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "upstream", upstream);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "upstream", "main");
  git(repo, "push", "origin", "main");

  git(repo, "switch", "-c", "custom/local-customizations");
  write(join(repo, conflict ? "shared.txt" : "local-one.txt"), conflict ? "local\n" : "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "local one");
  git(repo, "push", "-u", "origin", "custom/local-customizations");
  write(join(repo, "local-two.txt"), "two\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "local two unpushed");

  git(repo, "switch", "main");
  write(
    join(repo, conflict ? "shared.txt" : "upstream.txt"),
    conflict ? "upstream\n" : "advance\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "upstream advance");
  git(repo, "push", "upstream", "main");
  git(repo, "switch", "custom/local-customizations");

  write(join(repo, "local-two.txt"), "two\ndirty tracked\n");
  write(join(repo, "dirty-untracked.txt"), "dirty untracked\n");
  const initialDirtyStatus = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
  return { root, repo, upstream, origin, initialDirtyStatus };
}

function createLocalOnlyFixture(): Fixture {
  const root = tempDir("gg-local-only-update-");
  const upstream = join(root, "upstream.git");
  const origin = join(root, "origin.git");
  const repo = join(root, "work");
  mkdirSync(repo);
  git(root, "init", "--bare", upstream);
  git(root, "init", "--bare", origin);
  git(repo, "init", "--initial-branch", "main");
  configureRepository(repo);
  writeIdentityFixture(repo);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "upstream", upstream);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "upstream", "main");
  git(repo, "push", "origin", "main");
  git(repo, "switch", "-c", "custom/local-only");

  return { root, repo, upstream, origin, initialDirtyStatus: "" };
}

function runUpdater(repo: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GG_LOCAL_UPDATE_REPO_ROOT: repo, ...env },
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("local-fixes updater", () => {
  it("generates a direct Vitest command limited to the requested files", () => {
    const requestedFiles = ["src/first.test.ts", "src/second.test.ts"];

    const args = targetedVitestArgs("gg-app", requestedFiles);

    expect(args).toEqual(["--filter", "gg-app", "exec", "vitest", "run", ...requestedFiles]);
    expect(args).not.toContain("test");
    expect(args).not.toContain("--");
    expect(args.slice(5)).toEqual(requestedFiles);
    expect(() => targetedVitestArgs("gg-app", [])).toThrow("without explicit test files");
  });

  it("dry-runs without changing a named-branch checkout", () => {
    const fixture = createLocalOnlyFixture();
    const before = {
      head: git(fixture.repo, "rev-parse", "HEAD"),
      refs: git(fixture.repo, "for-each-ref", "--format=%(refname) %(objectname)"),
      status: git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all"),
    };
    const result = runUpdater(fixture.repo, [
      "--dry-run",
      "--no-install",
      "--no-build",
      "--check",
      "--allow-other-branch",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Push: disabled");
    expect(result.stdout).toContain("git rebase --reapply-cherry-picks --empty=keep upstream/main");
    expect(result.stdout).not.toContain("git merge");
    expect({
      head: git(fixture.repo, "rev-parse", "HEAD"),
      refs: git(fixture.repo, "for-each-ref", "--format=%(refname) %(objectname)"),
      status: git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all"),
    }).toEqual(before);
  }, 15_000);

  // This integration path performs multiple synchronous Git operations under parallel suite load.
  it("allows a local-only override branch when origin has no matching ref", () => {
    const fixture = createLocalOnlyFixture();
    const result = runUpdater(fixture.repo, [
      "--allow-other-branch",
      "--no-install",
      "--no-build",
      "--no-check",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("continuing without push eligibility");
    expect(result.stdout).not.toContain("git push");
  }, 15_000);

  it("does not print nonexistent recovery artifacts when the source fetch fails", () => {
    const fixture = createUpdateFixture();
    git(fixture.repo, "remote", "set-url", "upstream", join(fixture.root, "missing.git"));
    const result = runUpdater(fixture.repo, ["--no-install", "--no-build", "--no-check"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to fetch upstream/main");
    expect(result.stderr).not.toContain("Backup branch:");
    expect(result.stderr).not.toContain("Manifest:");
  }, 30_000);

  it("rebases all local commits and restores tracked and untracked dirt", () => {
    const fixture = createUpdateFixture();
    const result = runUpdater(fixture.repo, ["--no-install", "--no-build", "--no-check"]);

    expect(result.status, result.stderr).toBe(0);
    expect(
      git(fixture.repo, "log", "--reverse", "--format=%s", "upstream/main..HEAD").split(/\r?\n/),
    ).toEqual(["local one", "local two unpushed"]);
    expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
      fixture.initialDirtyStatus,
    );
    expect(readFileSync(join(fixture.repo, "dirty-untracked.txt"), "utf8")).toBe(
      "dirty untracked\n",
    );
    expect(git(fixture.repo, "stash", "list")).toBe("");
    const backupBranches = git(fixture.repo, "branch", "--format=%(refname:short)")
      .split(/\r?\n/)
      .filter((name) => name.startsWith("gg-local-before-update-"));
    expect(backupBranches).toHaveLength(1);
    const backupRoot = join(fixture.repo, ".gg", "local-fixes", "backups");
    const manifest = JSON.parse(
      readFileSync(join(backupRoot, readdirSync(backupRoot)[0], "manifest.json"), "utf8"),
    );
    expect(manifest.verified).toBe(true);
    expect(manifest.phase).toBe("verified");
    expect(manifest.dirtyWorkApplied).toBe(true);
    expect(manifest.localCommits.map((commit: { subject: string }) => commit.subject)).toEqual([
      "local one",
      "local two unpushed",
    ]);
  }, 30_000);

  it("stops on conflicts with the backup branch and dirty-work stash intact", () => {
    const fixture = createUpdateFixture(true);
    const result = runUpdater(fixture.repo, ["--no-install", "--no-build", "--no-check"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Rebase stopped for manual conflict review");
    expect(result.stderr).toContain("Backup branch:");
    expect(git(fixture.repo, "status", "--porcelain=v1")).toContain("UU shared.txt");
    expect(git(fixture.repo, "stash", "list")).toContain("gg local update");
    expect(
      git(fixture.repo, "branch", "--format=%(refname:short)")
        .split(/\r?\n/)
        .some((name) => name.startsWith("gg-local-before-update-")),
    ).toBe(true);
  }, 30_000);

  it("stops after a failed check without building or pushing", () => {
    const fixture = createUpdateFixture();
    const bin = join(fixture.root, "bin");
    mkdirSync(bin);
    if (process.platform === "win32") {
      write(join(bin, "pnpm.cmd"), "@echo off\r\nexit /b 7\r\n");
    } else {
      const fakePnpm = join(bin, "pnpm");
      write(fakePnpm, "#!/bin/sh\nexit 7\n");
      chmodSync(fakePnpm, 0o755);
    }
    const result = runUpdater(fixture.repo, ["--no-install", "--no-build"], {
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build failed");
    expect(result.stderr).toContain("Backup branch:");
    expect(result.stdout).not.toContain("build:local-patched");
    expect(result.stdout).not.toContain("git push");
    expect(git(fixture.repo, "stash", "list")).toContain("gg local update");
    const backupRoot = join(fixture.repo, ".gg", "local-fixes", "backups");
    const manifest = JSON.parse(
      readFileSync(join(backupRoot, readdirSync(backupRoot)[0], "manifest.json"), "utf8"),
    );
    expect(manifest.phase).toBe("source-verified");
    expect(manifest.dirtyWorkApplied).toBe(true);
  }, 30_000);

  it("rejects push when checks or build are disabled", () => {
    const result = runUpdater(repoRoot, ["--dry-run", "--push", "--no-build"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--push requires checks and installer build");
  });

  it("uses an exact expected-OID lease that rejects a concurrent remote update", () => {
    const root = tempDir("gg-local-lease-");
    const origin = join(root, "origin.git");
    const local = join(root, "local");
    const other = join(root, "other");
    git(root, "init", "--bare", origin);
    mkdirSync(local);
    git(local, "init", "--initial-branch", "custom/local-customizations");
    configureRepository(local);
    write(join(local, "file.txt"), "base\n");
    git(local, "add", ".");
    git(local, "commit", "-m", "base");
    git(local, "remote", "add", "origin", origin);
    git(local, "push", "-u", "origin", "custom/local-customizations");
    const capturedOid = git(local, "rev-parse", "HEAD");

    git(root, "clone", "--branch", "custom/local-customizations", origin, other);
    configureRepository(other);
    write(join(other, "other.txt"), "concurrent\n");
    git(other, "add", ".");
    git(other, "commit", "-m", "concurrent update");
    git(other, "push", "origin", "custom/local-customizations");

    write(join(local, "local.txt"), "verified local\n");
    git(local, "add", ".");
    git(local, "commit", "-m", "verified local update");
    const rejected = spawnSync(
      "git",
      forceWithLeaseArgs("custom/local-customizations", capturedOid),
      { cwd: local, encoding: "utf8" },
    );
    expect(rejected.status).not.toBe(0);
    expect(git(other, "rev-parse", "HEAD")).toBe(
      git(root, `--git-dir=${origin}`, "rev-parse", "refs/heads/custom/local-customizations"),
    );
  });
});

describe("local fork identity", () => {
  it("pins branding, native identity, updater feed, and version lockstep", () => {
    const { version } = JSON.parse(readFileSync(join(repoRoot, "gg-app/package.json"), "utf8")) as {
      version: string;
    };
    expect(verifyLocalForkIdentity(repoRoot)).toEqual({
      version,
      productName: "GG Coder",
      identifier: "com.ggcoder.app",
    });
  });
});
