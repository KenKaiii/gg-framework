import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectNewCommits } from "../core/progress/git-xp.js";
import { checkDestructiveGit } from "../core/destructive-git-guard.js";
import { captureVerificationSnapshot } from "../core/verification-snapshot.js";
import {
  buildDriverOverrides,
  getGitBranch,
  getGitDirtyFileCount,
  hardenedGitArgs,
  isGitRepo,
  runBackgroundGit,
} from "./git.js";
import { getGitHubRepoSlug } from "./github.js";

/**
 * GitSpawn regression: a repo's own `.git/config` names programs git would run
 * during GG's background inspection calls. Every vector points at one marker
 * script that records its name in `markers/`; the hardened helpers must leave
 * that directory empty while still returning the right answers.
 */

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "GG Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "GG Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Plain, unhardened git — used only for fixture setup before the payload is armed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=", ...args], {
    cwd,
    env,
    encoding: "utf8",
  }).trim();
}

/** Forward slashes keep the paths intact inside git's `sh -c` on Windows too. */
const slash = (p: string): string => p.split(path.sep).join("/");

let base: string;
let markers: string;
let markerCommand: (name: string, passthrough?: boolean) => string;

async function fired(): Promise<string[]> {
  return (await readdir(markers)).sort();
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "gg-gitspawn-")));
  markers = path.join(base, "markers");
  await mkdir(markers);
  const script = path.join(base, "payload.cjs");
  await writeFile(
    script,
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      `fs.writeFileSync(path.join(${JSON.stringify(markers)}, process.argv[2]), "ran");`,
      // Filters / textconv must still produce output for git to continue.
      'if (process.argv[3] === "cat") process.stdin.pipe(process.stdout);',
    ].join("\n"),
  );
  markerCommand = (name, passthrough = false) =>
    `"${slash(process.execPath)}" "${slash(script)}" ${name}${passthrough ? " cat" : ""}`;
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** An executable (not shell-interpreted) wrapper, for `gpg.program` and hooks. */
async function wrapper(file: string, name: string): Promise<string> {
  await writeFile(file, `#!/bin/sh\nexec ${markerCommand(name)}\n`);
  await chmod(file, 0o755);
  return file;
}

interface EvilRepo {
  repo: string;
  baseHead: string;
}

/**
 * Repo with a committed `a.txt`, one later signed commit, an origin remote,
 * then every execution vector armed in `.git/config` and `a.txt` left
 * modified at the same size (so `git status` must re-hash it through the
 * clean filter).
 */
async function evilRepo(): Promise<EvilRepo> {
  const repo = path.join(base, "repo");
  await mkdir(repo);
  git(repo, "init", "--quiet");
  await writeFile(path.join(repo, ".gitattributes"), "*.txt filter=evil diff=evil\n");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "initial");
  const baseHead = git(repo, "rev-parse", "HEAD");

  // A second commit carrying a (bogus) signature, so showing it would invoke
  // gpg.program under log.showSignature.
  await writeFile(path.join(repo, "a.txt"), "two\n");
  git(repo, "add", "a.txt");
  const tree = git(repo, "write-tree");
  const now = Math.floor(Date.now() / 1000);
  const body =
    `tree ${tree}\nparent ${baseHead}\n` +
    `author GG Test <test@example.com> ${now} +0000\n` +
    `committer GG Test <test@example.com> ${now} +0000\n` +
    "gpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n\nsigned\n";
  const signed = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd: repo,
    input: body,
    encoding: "utf8",
  }).trim();
  git(repo, "update-ref", "HEAD", signed);
  git(repo, "config", "remote.origin.url", "https://github.com/owner/repo.git");

  const hooks = path.join(base, "hooks");
  await mkdir(hooks);
  await wrapper(path.join(hooks, "post-index-change"), "hook");
  const config: [string, string][] = [
    ["core.fsmonitor", markerCommand("fsmonitor")],
    ["core.hooksPath", slash(hooks)],
    ["filter.evil.clean", markerCommand("filter-clean", true)],
    ["filter.evil.smudge", markerCommand("filter-smudge", true)],
    ["filter.evil.process", markerCommand("filter-process", true)],
    ["filter.evil.required", "true"],
    ["diff.evil.textconv", markerCommand("textconv", true)],
    ["diff.evil.command", markerCommand("diff-driver")],
    ["diff.external", markerCommand("diff-external")],
    ["log.showSignature", "true"],
    ["gpg.program", slash(await wrapper(path.join(base, "gpg"), "gpg"))],
    ["core.pager", markerCommand("pager")],
    ["credential.helper", `!${markerCommand("credential")}`],
    ["core.sshCommand", markerCommand("ssh")],
  ];
  for (const [key, value] of config) git(repo, "config", key, value);

  await writeFile(path.join(repo, "a.txt"), "six\n"); // same size as "two\n"
  return { repo, baseHead };
}

describe("GitSpawn: the payload is real", () => {
  it.skipIf(process.platform === "win32")(
    // Windows: Git for Windows' fsmonitor/hook launch of a quoted node command
    // is not exercised on CI here; the hardened assertions below still run.
    "plain `git status` in the fixture runs the repo's fsmonitor and clean filter",
    async () => {
      const { repo } = await evilRepo();
      // The payload runs before git notices the fake filter does not speak the
      // long-running filter protocol, so git may then exit non-zero. The point
      // here is that the repo's code ran at all; the markers prove it.
      try {
        execFileSync("git", ["status", "--porcelain"], { cwd: repo, env, stdio: "pipe" });
      } catch {
        // expected on some git versions; see above
      }
      expect(await fired()).toEqual(expect.arrayContaining(["fsmonitor", "filter-process"]));
    },
  );
});

describe("GitSpawn: hardened background git", () => {
  it("project-open helpers return the right answers without running anything", async () => {
    const { repo } = await evilRepo();
    expect(await getGitDirtyFileCount(repo)).toBe(1);
    expect(await getGitBranch(repo)).toMatch(/^(main|master)$/);
    expect(await isGitRepo(repo)).toBe(true);
    expect(await getGitHubRepoSlug(repo)).toBe("owner/repo");
    // github-ci.ts context()
    const head = await runBackgroundGit(["rev-parse", "--verify", "HEAD"], { cwd: repo });
    expect(head.stdout.trim()).toMatch(/^[a-f0-9]{40,64}$/);
    expect(await fired()).toEqual([]);
  });

  it("git-xp scores the new (signed, textconv-attributed) commit without running anything", async () => {
    const { repo, baseHead } = await evilRepo();
    const result = await detectNewCommits(repo, baseHead, Date.now());
    expect(result?.commits).toHaveLength(1);
    expect(result?.commits[0]?.linesChanged).toBe(2);
    expect(result?.commits[0]?.patchId).toMatch(/^[a-f0-9]{40,64}$/);
    // `git show` paths explicitly, with the diff family's own vectors in play.
    const shown = await runBackgroundGit(["show", "HEAD"], { cwd: repo });
    expect(shown.stdout).toContain("+two");
    expect(await fired()).toEqual([]);
  });

  it("verification snapshot hashes the workspace without running anything", async () => {
    const { repo } = await evilRepo();
    expect(await captureVerificationSnapshot(repo)).toMatch(/^[a-f0-9]{64}$/);
    expect(await fired()).toEqual([]);
  });

  it("destructive-git guard inspects repo state without running anything", async () => {
    const { repo } = await evilRepo();
    const blocked = await checkDestructiveGit("git reset --hard", { cwd: repo });
    expect(blocked).toContain("a.txt");
    expect(await checkDestructiveGit("git stash clear", { cwd: repo })).toBeNull();
    expect(await fired()).toEqual([]);
  });

  it("does not enter a submodule's work tree, where its own filters would run", async () => {
    const sub = path.join(base, "sub");
    await mkdir(sub);
    git(sub, "init", "--quiet");
    await writeFile(path.join(sub, ".gitattributes"), "*.txt filter=subevil\n");
    await writeFile(path.join(sub, "s.txt"), "one\n");
    git(sub, "add", ".");
    git(sub, "commit", "--quiet", "-m", "sub");
    const repo = path.join(base, "super");
    await mkdir(repo);
    git(repo, "init", "--quiet");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", slash(sub), "sub");
    git(repo, "commit", "--quiet", "-m", "add sub");
    git(path.join(repo, "sub"), "config", "filter.subevil.clean", markerCommand("sub-clean", true));
    git(path.join(repo, "sub"), "config", "core.fsmonitor", markerCommand("sub-fsmonitor"));
    await writeFile(path.join(repo, "sub", "s.txt"), "two\n");

    expect(await getGitDirtyFileCount(repo)).toBe(0);
    expect(await fired()).toEqual([]);
  });

  it("never lazy-fetches through a partial clone's repo-configured upload-pack", async () => {
    const origin = path.join(base, "origin");
    await mkdir(origin);
    git(origin, "init", "--quiet");
    git(origin, "config", "uploadpack.allowFilter", "true");
    await writeFile(path.join(origin, "f.txt"), "1\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "1");
    await writeFile(path.join(origin, "f.txt"), "2\n");
    git(origin, "commit", "--quiet", "-am", "2");
    const url = `file://${process.platform === "win32" ? "/" : ""}${slash(origin)}`;
    git(base, "clone", "--quiet", "--filter=blob:none", "--no-checkout", url, "partial");
    const repo = path.join(base, "partial");
    git(repo, "config", "remote.origin.uploadpack", markerCommand("upload-pack"));

    await expect(
      runBackgroundGit(["show", "--numstat", "--format=", "HEAD"], { cwd: repo }),
    ).rejects.toBeDefined();
    expect(await fired()).toEqual([]);
  });
});

describe("hardened argv", () => {
  it("blanks every repo-local filter/merge driver, including ones from include.path", async () => {
    const repo = path.join(base, "inc");
    await mkdir(repo);
    git(repo, "init", "--quiet");
    await writeFile(
      path.join(repo, ".git", "extra.cfg"),
      '[filter "Included"]\n\tclean = evil\n[merge "m"]\n\tdriver = evil\n',
    );
    git(repo, "config", "include.path", "extra.cfg");
    git(repo, "config", "filter.local.process", "evil");

    const args = await hardenedGitArgs(["status", "--porcelain"], { cwd: repo });
    for (const override of [
      "core.fsmonitor=false",
      "filter.local.process=",
      "filter.local.clean=",
      "filter.Included.clean=",
      "filter.Included.required=false",
      "merge.m.driver=",
    ]) {
      expect(args[args.indexOf(override) - 1]).toBe("-c");
    }
    expect(args.slice(-3)).toEqual(["status", "--ignore-submodules=dirty", "--porcelain"]);

    const show = await hardenedGitArgs(["show", "HEAD"], { cwd: repo });
    expect(show.slice(-4)).toEqual(["show", "--no-ext-diff", "--no-textconv", "HEAD"]);
    // Read-only plumbing that never touches work-tree content skips the probe.
    expect(show.some((arg) => arg.startsWith("filter."))).toBe(false);
  });

  it("refuses driver names an `-c` override cannot express", () => {
    expect(buildDriverOverrides(["filter.a=b.clean\0"])).toBeNull();
    expect(buildDriverOverrides(["filter.ok.clean\0merge.m.driver\0core.x\0"])).toEqual([
      "-c",
      "filter.ok.clean=",
      "-c",
      "filter.ok.smudge=",
      "-c",
      "filter.ok.process=",
      "-c",
      "filter.ok.required=false",
      "-c",
      "merge.m.driver=",
    ]);
  });
});
