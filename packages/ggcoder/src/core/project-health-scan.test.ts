import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  churnWeight,
  createProjectHealthScanner,
  findSecret,
  HOTSPOT_CHANGES,
  hotspotThreshold,
  isSecretPath,
  isTestPath,
  OVERSIZED_LINES,
  splitJsSource,
} from "./project-health-scan.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-health-scan-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function put(relative: string, content = ""): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd: root,
  });
}
function lines(count: number, line = "const x = 1;"): string {
  return `${Array.from({ length: count }, () => line).join("\n")}\n`;
}
const NOW = new Date("2026-10-09T12:00:00.000Z");

describe("path classification", () => {
  it.each([
    [".env", true],
    ["config/.env.production", true],
    [".env.example", false],
    ["deploy/server.pem", true],
    ["test/fixtures/server.key", false],
    ["src/key.ts", false],
  ])("%s secret: %s", (rel, expected) => {
    expect(isSecretPath(rel)).toBe(expected);
  });

  it.each([
    ["src/a.test.ts", true],
    ["tests/helpers.py", true],
    ["pkg/handler_test.go", true],
    ["src/contest.ts", false],
    ["scripts/check-auth.mjs", true],
    ["tools/smoke.ts", true],
    ["apps/web/e2e/login.ts", true],
    ["scripts/build.mjs", false],
    ["src/checkout.ts", false],
  ])("%s test: %s", (rel, expected) => {
    expect(isTestPath(rel)).toBe(expected);
  });
});

describe("churnWeight", () => {
  it.each([
    [null, 1],
    [0, 0.5],
    [1, 1],
    [HOTSPOT_CHANGES, 2],
  ])("%s changes weigh %s", (changes, weight) => {
    expect(churnWeight(changes)).toBe(weight);
  });
});

describe("hotspotThreshold", () => {
  it("is the change count of the top 2% most-changed files, never below the floor", () => {
    expect(hotspotThreshold([])).toBe(HOTSPOT_CHANGES);
    expect(hotspotThreshold([3, 2, 1])).toBe(HOTSPOT_CHANGES);
    // 100 changed files: the 3rd-busiest sets the bar.
    const counts = [40, 31, 22, 12, ...Array.from({ length: 96 }, () => 2)];
    expect(hotspotThreshold(counts)).toBe(22);
    expect(churnWeight(12, hotspotThreshold(counts))).toBe(1);
    expect(churnWeight(22, hotspotThreshold(counts))).toBe(2);
  });
});

// Built at runtime so this file never contains a key-shaped literal that a
// secret scanner (or this one) would flag.
const fakeKey = {
  github: `gh${"p_"}${"A1b2C3d4E5f6".repeat(3)}`,
  aws: `AK${"IA"}Q7ZK3M2PV4HJ9TXW`,
  stripe: `sk${"_live_"}${"4eC39HqLyjWDarjtT1zdp7dc".slice(0, 24)}`,
  privateKey: `-----BEGIN ${"RSA PRIVATE"} KEY-----\n${"MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7onLRnrq0"}`,
};

describe("findSecret", () => {
  it("finds real-looking keys and reports the kind and line, not the value", () => {
    expect(findSecret(`const a = 1;\nconst token = "${fakeKey.github}";\n`)).toEqual({
      label: "GitHub token",
      line: 2,
    });
    expect(findSecret(`aws_key: ${fakeKey.aws}`)).toEqual({ label: "AWS access key", line: 1 });
    expect(findSecret(`x\ny\nSTRIPE=${fakeKey.stripe}`)?.label).toBe("Stripe live key");
    expect(findSecret(`const pem = "${fakeKey.privateKey}";`)?.label).toBe("private key");
  });

  it("ignores placeholders, filler and code that only names a key format", () => {
    expect(findSecret(`AK${"IA"}IOSFODNN7EXAMPLE`)).toBeNull();
    expect(findSecret(`gh${"p_"}${"x".repeat(36)}`)).toBeNull();
    expect(findSecret(`sk${"_live_"}${"0".repeat(24)}`)).toBeNull();
    expect(findSecret('const HEADER = "-----BEGIN PRIVATE KEY-----";')).toBeNull();
    expect(findSecret("const re = /gh[pousr]_[A-Za-z0-9]{36}/;")).toBeNull();
  });
});

describe("splitJsSource", () => {
  it("keeps markers in comments and `any` in code, not in strings or regexes", () => {
    const source = [
      'const label = "TODO: any day now";',
      "const tpl = `as any ${value as any} // TODO not a comment`;",
      "const re = /TODO|any/g;",
      "const ok = a / b; // TODO real one",
      "/* eslint-disable no-console */",
      "const x: any = 1;",
      "<p>Don't TODO this</p>;",
    ].join("\n");
    const { code, comments } = splitJsSource(source);
    expect(comments.match(/TODO/g)).toHaveLength(1);
    expect(comments).toContain("eslint-disable");
    expect(code.match(/\bany\b/g)).toHaveLength(2);
    expect(code.split("\n")).toHaveLength(7);
  });
});

describe("createProjectHealthScanner", () => {
  it("returns null outside a Git work tree", async () => {
    expect(await createProjectHealthScanner().scan(root, NOW)).toBeNull();
  });

  it("finds oversized files, secrets, setup gaps and debt without counting ignored or generated files", async () => {
    git("init", "--quiet");
    await put(".gitignore", "ignored/\n");
    await put("package.json", "{}");
    await put("src/huge.ts", lines(OVERSIZED_LINES + 200));
    await put("src/small.ts", "// TODO: tidy\nconst y: any = 1; // eslint-disable-line\n");
    await put("dist/bundle.js", lines(5000));
    await put("ignored/big.ts", lines(5000));
    await put(".env", "TOKEN=secret\n");
    await put(".env.example", "TOKEN=\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "init");
    await put("local.pem", "untracked key\n");

    const scan = await createProjectHealthScanner().scan(root, NOW);
    expect(scan).not.toBeNull();
    if (!scan) return;
    expect(scan.oversized).toEqual([
      { path: "src/huge.ts", lines: OVERSIZED_LINES + 200, changes: 1 },
    ]);
    expect(scan.oversizedWeightedExcess).toBe(200);
    expect(scan.hotspotCount).toBe(0);
    expect(scan.sourceLines).toBe(OVERSIZED_LINES + 202);
    expect(scan.secretFiles).toEqual([
      { path: ".env", tracked: true, found: null, line: null },
      { path: "local.pem", tracked: false, found: null, line: null },
    ]);
    expect(scan).toMatchObject({
      hasGitignore: true,
      missingLockfile: true,
      hasTests: false,
      hasLint: false,
      hasFormat: false,
      hasTypecheck: false,
      hasCIWorkflow: false,
      largeFileCount: 0,
      truncated: false,
    });
    expect(scan.debt).toEqual({
      todos: 1,
      suppressions: 1,
      anyTypes: 1,
      lines: OVERSIZED_LINES + 202,
    });
  });

  it("recognizes tooling, tests and CI, and reuses unchanged files", async () => {
    git("init", "--quiet");
    await put(".gitignore", "node_modules\n");
    await put("package.json", '{"devDependencies":{"eslint":"9","prettier":"3"}}');
    await put("pnpm-lock.yaml", "");
    await put("tsconfig.json", "{}");
    await put(".github/workflows/ci.yml", "on: push\n");
    await put("src/a.ts", "export const a = 1;\n");
    await put("src/a.test.ts", "// TODO in a test is not debt\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "init");

    const scanner = createProjectHealthScanner();
    const first = await scanner.scan(root, NOW);
    expect(first).toMatchObject({
      missingLockfile: false,
      hasTests: true,
      hasLint: true,
      hasFormat: true,
      hasTypecheck: true,
      hasCIWorkflow: true,
      debt: { todos: 0, suppressions: 0, anyTypes: 0, lines: 1 },
    });
    expect(await scanner.scan(root, NOW)).toEqual(first);
  });

  it("counts check scripts and a test script as tests, and leaves them out of size", async () => {
    git("init", "--quiet");
    await put("package.json", '{"scripts":{"check":"node scripts/check-auth.mjs"}}');
    await put("scripts/check-auth.mjs", lines(OVERSIZED_LINES + 500));
    await put("src/app.ts", lines(10));
    git("add", "-A");
    git("commit", "--quiet", "-m", "init");

    const scan = await createProjectHealthScanner().scan(root, NOW);
    expect(scan).toMatchObject({
      hasTests: true,
      oversized: [],
      oversizedCount: 0,
      sourceFiles: 1,
      sourceLines: 10,
    });
  });

  it.each([
    ['{"scripts":{"test":"vitest run"}}', true],
    ['{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}', false],
    ['{"scripts":{"build":"tsc"}}', false],
  ])("package.json %s has tests: %s", async (manifest, expected) => {
    git("init", "--quiet");
    await put("package.json", manifest);
    await put("src/app.ts", lines(10));
    git("add", "-A");
    git("commit", "--quiet", "-m", "init");
    expect((await createProjectHealthScanner().scan(root, NOW))?.hasTests).toBe(expected);
  });

  it("finds keys inside source and config files, but not in tests or lockfiles", async () => {
    git("init", "--quiet");
    await put(".gitignore", "local/\n");
    await put("src/config.ts", `export const a = 1;\nexport const token = "${fakeKey.github}";\n`);
    await put("deploy/app.yml", `env:\n  AWS_KEY: ${fakeKey.aws}\n`);
    await put("src/config.test.ts", `const token = "${fakeKey.github}";\n`);
    await put("package-lock.json", `{"key":"${fakeKey.aws}"}`);
    await put("local/notes.ts", `const t = "${fakeKey.github}";\n`);
    git("add", "-A");
    git("commit", "--quiet", "-m", "init");
    await put("scratch.ts", `const k = "${fakeKey.stripe}";\n`);

    const scan = await createProjectHealthScanner().scan(root, NOW);
    expect(scan?.secretFiles).toEqual([
      { path: "deploy/app.yml", tracked: true, found: "AWS access key", line: 2 },
      { path: "src/config.ts", tracked: true, found: "GitHub token", line: 2 },
      { path: "scratch.ts", tracked: false, found: "Stripe live key", line: 1 },
    ]);
    // Config files are read for keys only: they don't count as source.
    expect(scan?.sourceFiles).toBe(2);
  });

  it("scores only the opened subfolder of a repository", async () => {
    git("init", "--quiet");
    await put("apps/web/src/page.ts", lines(OVERSIZED_LINES + 1));
    await put("apps/api/src/server.ts", lines(OVERSIZED_LINES + 5));
    git("add", "-A");
    git("commit", "--quiet", "-m", "init");

    const scan = await createProjectHealthScanner().scan(path.join(root, "apps", "web"), NOW);
    expect(scan?.oversized).toEqual([
      { path: "src/page.ts", lines: OVERSIZED_LINES + 1, changes: 1 },
    ]);
  });

  it("ranks an oversized file that keeps changing above a bigger stable one", async () => {
    git("init", "--quiet");
    await put("src/stable.ts", lines(OVERSIZED_LINES + 150));
    await put("src/busy.ts", lines(OVERSIZED_LINES + 100));
    git("add", "-A");
    git("commit", "--quiet", "-m", "init");
    for (let i = 1; i < HOTSPOT_CHANGES; i++) {
      await put("src/busy.ts", `${lines(OVERSIZED_LINES + 100)}// ${i}\n`);
      git("commit", "--quiet", "-am", `edit ${i}`);
    }

    const scan = await createProjectHealthScanner().scan(root, NOW);
    expect(scan?.oversized.map((file) => [file.path, file.changes])).toEqual([
      ["src/busy.ts", HOTSPOT_CHANGES],
      ["src/stable.ts", 1],
    ]);
    expect(scan?.hotspotCount).toBe(1);
    // busy: 101 excess lines (one comment line added) × 2; stable: 150 × 1.
    expect(scan?.oversizedWeightedExcess).toBe(101 * 2 + 150);
  });
});
