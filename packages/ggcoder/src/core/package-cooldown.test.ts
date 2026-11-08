import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bunCooldownCommand,
  cooldownFailureHint,
  hasNativeCooldown,
  mayInstall,
  packageCooldownEnv,
  scopeCooldown,
  usesCustomNpmRegistry,
  usesCustomPypiIndex,
  versionSpawn,
} from "./package-cooldown.js";

const NOW = Date.parse("2026-10-19T12:00:00Z");
let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cooldown-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const env = (command: string, days: number, versions: Record<string, string>) =>
  packageCooldownEnv(command, { days, now: NOW, cwd: dir, versions });

describe("packageCooldownEnv", () => {
  it("npm >= 11.10 gets min-release-age in days; older npm does not", () => {
    expect(env("npm i x", 2, { npm: "11.12.1" }).npm_config_min_release_age).toBe("2");
    expect(env("npm i x", 2, { npm: "10.9.0" }).npm_config_min_release_age).toBeUndefined();
  });

  it("pnpm key (minutes) only for pnpm commands", () => {
    const v = { npm: "11.12.1", pnpm: "10.17.1" };
    expect(env("pnpm add x", 2, v).npm_config_minimum_release_age).toBe("2880");
    expect(env("npm i x", 2, v).npm_config_minimum_release_age).toBeUndefined();
    expect(
      env("pnpm add x", 2, { pnpm: "10.15.0" }).npm_config_minimum_release_age,
    ).toBeUndefined();
  });

  it("pip relative, uv absolute; with uv.lock only resolving uv commands", () => {
    expect(env("pip install x", 2, {}).PIP_UPLOADED_PRIOR_TO).toBe("P2D");
    expect(env("uv sync", 2, {}).UV_EXCLUDE_NEWER).toBe("2026-10-17T12:00:00Z");
    fs.writeFileSync(path.join(dir, "uv.lock"), "version = 1\n");
    for (const c of ["uv sync", "uv run main.py", "uv sync --frozen"]) {
      expect(env(c, 2, {}).UV_EXCLUDE_NEWER, c).toBeUndefined();
    }
    for (const c of [
      "uv add httpx",
      "uv lock",
      "uv lock --upgrade",
      "uv sync --upgrade",
      "uv sync --upgrade-package httpx",
      "uv pip install x",
      "uv pip compile requirements.in",
      "uvx ruff",
      "uv tool run ruff",
      "uv tool install ruff",
    ]) {
      expect(env(c, 2, {}).UV_EXCLUDE_NEWER, c).toBe("2026-10-17T12:00:00Z");
    }
  });

  it("yarn berry >= 4.10 gets the age gate in minutes; 4.9 and classic do not", () => {
    expect(env("yarn add x", 2, { yarn: "4.10.3" }).YARN_NPM_MINIMAL_AGE_GATE).toBe("2880");
    expect(env("yarn add x", 2, { yarn: "4.9.4" }).YARN_NPM_MINIMAL_AGE_GATE).toBeUndefined();
    expect(env("yarn add x", 2, { yarn: "1.22.22" }).YARN_NPM_MINIMAL_AGE_GATE).toBeUndefined();
    expect(env("npm i x", 2, { yarn: "4.10.3" }).YARN_NPM_MINIMAL_AGE_GATE).toBeUndefined();
  });

  it("0 disables everything", () => {
    expect(env("pnpm add x", 0, { npm: "11.12.1", pnpm: "10.17.1" })).toEqual({});
  });

  it("native cooldown version gates", () => {
    expect(hasNativeCooldown("pnpm", "10.16.0")).toBe(true);
    expect(hasNativeCooldown("pnpm", "10.15.9")).toBe(false);
    expect(hasNativeCooldown("bun", "1.3.14")).toBe(true);
    expect(hasNativeCooldown("bun", "1.2.23")).toBe(false);
    expect(hasNativeCooldown("yarn", "4.10.0")).toBe(true);
    expect(hasNativeCooldown("yarn", "1.22.22")).toBe(false);
    expect(hasNativeCooldown("npm", null)).toBe(false);
  });
});

describe("bunCooldownCommand", () => {
  it("appends the seconds flag to resolving bun commands (bun >= 1.3)", () => {
    expect(bunCooldownCommand("bun add zod && bun run build", 2, "1.3.14")).toBe(
      "bun add --minimum-release-age=172800 zod && bun run build",
    );
    expect(bunCooldownCommand("bun install", 2, "1.3.14")).toBe(
      "bun install --minimum-release-age=172800",
    );
    expect(bunCooldownCommand("bunx cowsay hi", 2, "1.3.14")).toBe(
      "bunx --minimum-release-age=172800 cowsay hi",
    );
  });

  it("leaves it alone when given, disabled, unsupported or not resolving", () => {
    const given = "bun add --minimum-release-age=60 zod";
    expect(bunCooldownCommand(given, 2, "1.3.14")).toBe(given);
    expect(bunCooldownCommand("bun add zod", 0, "1.3.14")).toBe("bun add zod");
    expect(bunCooldownCommand("bun add zod", 2, "1.2.23")).toBe("bun add zod");
    expect(bunCooldownCommand("bun add zod", 2, null)).toBe("bun add zod");
    expect(bunCooldownCommand("bun run test", 2, "1.3.14")).toBe("bun run test");
  });
});

describe("scopeCooldown (persistent shell)", () => {
  it("prefixes each manager with only its own variable", () => {
    const e = {
      npm_config_min_release_age: "2",
      npm_config_minimum_release_age: "2880",
      UV_EXCLUDE_NEWER: "2026-10-17T12:00:00Z",
    };
    expect(scopeCooldown("cd a && pnpm add zod; npm i react; uv add httpx; yarn add vue", e)).toBe(
      "cd a && npm_config_minimum_release_age=2880 pnpm add zod; npm_config_min_release_age=2 npm i react; UV_EXCLUDE_NEWER=2026-10-17T12:00:00Z uv add httpx; yarn add vue",
    );
    expect(scopeCooldown("ls", e)).toBe("ls");
  });
});

describe("mayInstall", () => {
  it("is false for everyday commands, true for installs", () => {
    for (const c of ["ls", "npm test", "pnpm build", "git status", "bun run dev", "pip list"]) {
      expect(mayInstall(c), c).toBe(false);
    }
    for (const c of ["npm ci", "pnpm i", "yarn", "yarn --immutable", "bunx tsc", "uv sync"]) {
      expect(mayInstall(c), c).toBe(true);
    }
  });
});

describe("versionSpawn", () => {
  it("uses a shell on Windows (npm/pnpm/yarn are .cmd shims) and none elsewhere", () => {
    expect(versionSpawn("npm", "win32")).toEqual({ file: "npm --version", args: [], shell: true });
    expect(versionSpawn("pnpm", "darwin")).toEqual({
      file: "pnpm",
      args: ["--version"],
      shell: false,
    });
  });
});

describe("cooldownFailureHint", () => {
  it.each([
    [
      "npm error notarget No matching version found for openai@7.39.0 with a date before 10/17/2026",
      "openai@7.39.0",
    ],
    [
      " ERR_PNPM_NO_MATCHING_VERSION  No matching version found for zod@3.9.9 published by Sat Oct 17",
      "zod@3.9.9",
    ],
    [
      'error: No version matching "zod" found for specifier "3.9.9" (blocked by minimum-release-age: 172800 seconds)',
      "zod@3.9.9",
    ],
  ])("names the cooldown for %s", (out, pkg) => {
    const hint = cooldownFailureHint(out, 2);
    expect(hint).toContain(pkg);
    expect(hint).toContain("2-day release-age cooldown");
    expect(hint?.split("\n")).toHaveLength(1);
  });

  it("is conditional for generic not-found errors and silent otherwise", () => {
    expect(
      cooldownFailureHint("ERROR: No matching distribution found for openai==9.9.9", 2),
    ).toMatch(/^If openai==9\.9\.9 was published in the last 2 days/);
    expect(cooldownFailureHint("npm error code E404", 2)).toBeNull();
    expect(
      cooldownFailureHint("No matching version found for a@1 with a date before x", 0),
    ).toBeNull();
  });
});

describe("custom registries", () => {
  it("pnpm gets no cooldown when a private registry may serve no publish times", () => {
    const base = { days: 2, now: 0, cwd: dir, versions: { pnpm: "10.17.1" }, env: {} };
    expect(packageCooldownEnv("pnpm add x", base).npm_config_minimum_release_age).toBe("2880");
    fs.writeFileSync(path.join(dir, ".npmrc"), "@corp:registry=https://npm.corp.example/\n");
    expect(packageCooldownEnv("pnpm add x", base).npm_config_minimum_release_age).toBeUndefined();
  });

  it("detects registries from flags, env and .npmrc, ignoring auth-only lines", () => {
    fs.writeFileSync(path.join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=abc\n");
    expect(usesCustomNpmRegistry("npm i x", dir, {})).toBe(false);
    expect(usesCustomNpmRegistry("npm i x --registry=https://r.example", dir, {})).toBe(true);
    expect(
      usesCustomNpmRegistry("npm i x", dir, { npm_config_registry: "https://r.example" }),
    ).toBe(true);
    expect(usesCustomPypiIndex("pip install x -i https://p.example/simple", {})).toBe(true);
    expect(usesCustomPypiIndex("pip install x", {})).toBe(false);
  });
});
